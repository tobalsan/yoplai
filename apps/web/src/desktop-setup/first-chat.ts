import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import { request, SetupError } from "./api";
import { useOptionalSetup } from "./SetupGate";
import type { ChatSession } from "../components/chat/createChatSession";

export const FIRST_GREETING = "Hi! Introduce yourself in two sentences and tell me how you can help.";
type TurnState = "none" | "running" | "answered" | "failed";

export function createFirstChat(input: {
  agentId: Accessor<string>;
  sessionId: Accessor<string | undefined>;
  ready: () => boolean;
  chat: ChatSession;
}) {
  const setup = useOptionalSetup();
  const pending = createMemo(() => {
    const state = setup?.state();
    const first = state?.firstChat;
    return !state?.completed && first && first.agentId === input.agentId() && first.sessionId === input.sessionId()
      ? first : undefined;
  }, undefined, { equals: (a, b) => a?.agentId === b?.agentId && a?.sessionId === b?.sessionId && a?.turnId === b?.turnId });
  const [failed, setFailed] = createSignal(false);
  const [readError, setReadError] = createSignal(false);
  createEffect(() => {
    const first = pending();
    setFailed(false);
    setReadError(false);
    if (!first || !setup) return;
    const address = [first.agentId, first.sessionId, first.turnId].map(encodeURIComponent).join("/");
    let active = true;
    let sent = false;
    let sendFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => { active = false; clearTimeout(timer); });
    const current = () => active && pending()?.turnId === first.turnId;
    const check = async () => {
      try {
        const { state } = await request<{ state: TurnState }>(`desktop-setup/turns/${address}`);
        if (!current()) return;
        setReadError(false);
        if (state === "answered") {
          try {
            await setup.save({ completed: true, firstChat: first }, current);
          } catch (error) {
            if (!(error instanceof SetupError) || error.code !== "turn_conflict") throw error;
            active = false;
            await setup.refresh();
          }
          return;
        }
        if (state === "failed" || (state === "none" && sendFailed)) {
          setFailed(true);
          return;
        }
        if (state === "none" && !sent && input.ready()) {
          const result = await input.chat.send({
            text: FIRST_GREETING, pendingFiles: [], turnId: first.turnId,
            onTaggedError: () => { sendFailed = true; },
          });
          sent = result.kind === "sent";
        }
      } catch {
        if (current()) setReadError(true);
      }
      if (current()) timer = setTimeout(() => void check(), 750);
    };
    void check();
  });
  return { failed: () => !!pending() && failed(), readError: () => !!pending() && readError() };
}
