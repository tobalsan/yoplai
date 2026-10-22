import { createEffect, onCleanup } from "solid-js";
import { fetchAgentSessions, UnauthenticatedError } from "../api/chat";
import {
  subscribeToRealtime,
  type RealtimeEvent,
} from "../api/realtime-client";
import type { SessionSummary } from "../api/types";
import { capabilities } from "../lib/capabilities";
import {
  acceptChatCompletion,
  bufferChatCompletion,
  captureChatReads,
  observeChatSessions,
  playCompletionSound,
} from "../lib/chat-notifications";

export function TurnNotifier(props: { enabled: boolean }) {
  createEffect(() => {
    const userId = capabilities.multiUser ? capabilities.user?.id : "local";
    if (!props.enabled || !userId) return;
    let active = true;
    let sessions: SessionSummary[] = [];
    const pending = new Map<
      string,
      Extract<RealtimeEvent, { type: "status" }>
    >();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let refreshQueued = false;
    const processPending = () => {
      for (const [id, event] of pending) {
        const session = sessions.find(
          (s) =>
            s.agentId === event.agentId &&
            s.sessionId === event.sessionId &&
            !s.archived
        );
        if (!session || !event.completion) continue;
        pending.delete(id);
        if (
          acceptChatCompletion({
            ...session,
            lastWebCompletion: event.completion,
          })
        )
          scheduleRefresh();
        playCompletionSound(id, () => active);
      }
    };
    const refresh = async () => {
      if (!active) return;
      if (controller) {
        refreshQueued = true;
        return;
      }
      controller = new AbortController();
      const readsAtStart = captureChatReads();
      const timeout = setTimeout(() => controller?.abort(), 10_000);
      try {
        const result = await fetchAgentSessions({
          strict: true,
          signal: controller.signal,
        });
        if (!active) return;
        sessions = result.items;
        observeChatSessions(sessions, readsAtStart);
        processPending();
      } catch (error) {
        if (error instanceof UnauthenticatedError) stop();
      } finally {
        clearTimeout(timeout);
        controller = undefined;
        if (active && refreshQueued) {
          refreshQueued = false;
          scheduleRefresh();
        }
      }
    };
    const scheduleRefresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refresh();
      }, 100);
    };
    const cleanup = subscribeToRealtime({
      interests: [{ type: "status" }],
      onReconnect: () => {
        void refresh();
      },
      onEvent: (event) => {
        if (!active || event.type !== "status" || !event.completion) return;
        bufferChatCompletion(event.completion.id);
        pending.set(event.completion.id, event);
        processPending();
        if (pending.size) scheduleRefresh();
      },
    });
    const stop = () => {
      active = false;
      clearTimeout(timer);
      controller?.abort();
      pending.clear();
      cleanup();
    };
    void refresh();
    onCleanup(stop);
  });
  return null;
}
