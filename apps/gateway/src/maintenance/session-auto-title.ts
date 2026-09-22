import type { FullHistoryMessage } from "@yoplai/shared";
import {
  appendSessionMetaIfAbsent,
  getFullHistory,
  hasSessionMeta,
  invalidateResolvedHistoryFile,
} from "../history/store.js";
import { logWarn } from "../logging.js";
import { MaintenanceCompletion } from "./completion.js";

const TITLE_PROMPT =
  "Return a concise 3-6 word title summarizing this chat in the conversation's language. No quotes. No punctuation at the end.";
// Fire-and-forget after the reply, so a generous budget costs the user nothing;
// reasoning models over OpenRouter occasionally exceed 10s.
const TITLE_TIMEOUT_MS = 30_000;
// Reasoning models (e.g. GLM Flash) spend output tokens on thinking before the
// title text and cannot always turn thinking off; leave headroom for both.
const TITLE_MAX_TOKENS = 512;

type SessionAutoTitleDeps = {
  getHistory?: typeof getFullHistory;
  hasTitle?: typeof hasSessionMeta;
  complete?: typeof MaintenanceCompletion.complete;
  appendMetaIfAbsent?: typeof appendSessionMetaIfAbsent;
  invalidate?: typeof invalidateResolvedHistoryFile;
};

let testDeps: SessionAutoTitleDeps = {};

export function setSessionAutoTitleDepsForTests(deps: SessionAutoTitleDeps): void {
  testDeps = deps;
}

export function resetSessionAutoTitleDepsForTests(): void {
  testDeps = {};
}

export function normalizeGeneratedTitle(title: string): string {
  const cleaned = title
    .trim()
    .replace(/^["'`]+|["'`.!?:;,\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 60) return cleaned;
  const truncated = cleaned.slice(0, 60);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
}

function messageText(message: FullHistoryMessage): string {
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function firstText(
  history: FullHistoryMessage[],
  role: "user" | "assistant"
): string {
  const message = history.find((item) => item.role === role);
  return message ? messageText(message) : "";
}

/** A tool-using turn stores one assistant message per step; the answer is the last one with text. */
function lastAssistantText(history: FullHistoryMessage[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role !== "assistant") continue;
    const text = messageText(message);
    if (text) return text;
  }
  return "";
}

/** Title a core Pi session once its first assistant response is durable. */
export async function autoTitleSession(
  params: { agentId: string; sessionId: string; userId?: string },
  deps: SessionAutoTitleDeps = {}
): Promise<string | null> {
  const activeDeps = { ...testDeps, ...deps };
  const getHistory = activeDeps.getHistory ?? getFullHistory;
  const hasTitle = activeDeps.hasTitle ?? hasSessionMeta;
  const history = await getHistory(params.agentId, params.sessionId, params.userId);
  if (await hasTitle(params.agentId, params.sessionId, "title", params.userId)) {
    return null;
  }
  // hasTitle already makes this once per session; an untitled later turn
  // (e.g. the first one was aborted) still deserves a title.
  const userText = firstText(history, "user");
  const assistantText = lastAssistantText(history);
  if (!userText || !assistantText) return null;

  const generated = await (activeDeps.complete ?? MaintenanceCompletion.complete)({
    agentId: params.agentId,
    userId: params.userId,
    system: TITLE_PROMPT,
    prompt: `User: ${userText}\n\nAssistant: ${assistantText}`,
    sessionId: params.sessionId,
    maxTokens: TITLE_MAX_TOKENS,
    timeoutMs: TITLE_TIMEOUT_MS,
  });
  const title = generated ? normalizeGeneratedTitle(generated) : "";
  if (!title) return null;
  const appended = await (
    activeDeps.appendMetaIfAbsent ?? appendSessionMetaIfAbsent
  )(
    params.agentId,
    params.sessionId,
    "title",
    title,
    params.userId
  );
  if (!appended) return null;
  (activeDeps.invalidate ?? invalidateResolvedHistoryFile)(
    params.agentId,
    params.sessionId,
    params.userId
  );
  return title;
}

/** The runner calls this only after sending done, so it can never delay chat. */
export function maybeAutoTitleSession(params: {
  agentId: string;
  sessionId: string;
  userId?: string;
}): void {
  void autoTitleSession(params).catch((error: unknown) => {
    logWarn("[maintenance] auto-title failed", {
      agentId: params.agentId,
      sessionId: params.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
