import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc, AssistantEntry, configure, defineDoc, LiveDoc,
  type Conversation, type ConversationId, type Harness, type ModelRef, type SettledSubmissionRecord, type SubmissionId, type Tx,
} from "@earendil-works/pi-durable";
import { classifyRunFailure, getProviderErrorCategory, isFallbackEligibleError, isReplayableFailedTurn, isSafetyRefusal, type AgentConfig, type ModelSource } from "@yoplai/shared";
import { logWarn } from "../logging.js";
import { InputEntry, ThreadMap } from "./state.js";

type Attempt = {
  submissionId: SubmissionId;
  inputs: SubmissionId[];
  primary: ModelRef;
  fallback: ModelRef;
  category?: string;
  startedAt: number;
  primaryDurationMs?: number;
  logged?: boolean;
};

type ModelSelection = ModelRef & { source?: ModelSource; mode?: NonNullable<AgentConfig["auth"]>["mode"] };
const FallbackDoc = defineDoc<{ model?: ModelRef; primary?: ModelSelection; attempts: Record<string, Attempt>; cancelled?: boolean }>({
  kind: "yoplai.fallback",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ attempts: {} }),
  checkpointWhen: () => true,
});

const context = BACKGROUND_CONTEXT;

// These safe messages stop Durable retrying the fallback request while retaining the gateway failure category.
const fallbackErrors = {
  rate_limit: "The fallback provider throttled the request.",
  overloaded: "The fallback provider reached capacity.",
  context_overflow: "The fallback context window was exceeded.",
  quota: "The fallback provider exhausted its quota.",
  generic: "The fallback model request failed.",
};

export function fallbackFailureMessage(detail: string) {
  const kind = classifyRunFailure(detail);
  return kind in fallbackErrors ? fallbackErrors[kind as keyof typeof fallbackErrors] : fallbackErrors.generic;
}

export function durableFailureKind(detail: unknown) {
  const fallback = (Object.entries(fallbackErrors) as [keyof typeof fallbackErrors, string][])
    .find(([, message]) => message === detail);
  return fallback?.[0] ?? classifyRunFailure(detail);
}

export function canReplayOnFallback(error: string, messages: Parameters<typeof isReplayableFailedTurn>[0]) {
  return !isSafetyRefusal(undefined, error) && isFallbackEligibleError(undefined, error) && isReplayableFailedTurn(messages);
}

export async function setModelPolicy(tx: Tx, id: ConversationId, primary: ModelSelection, fallback?: ModelRef) {
  const state = await tx.doc(FallbackDoc, id);
  state.primary = primary;
  if (fallback) state.model = fallback;
  else delete state.model;
}

export async function getModelPolicy(harness: Harness, id: ConversationId) {
  const [state, live] = await Promise.all([
    harness.snapshot(FallbackDoc, id, context),
    harness.snapshot(LiveDoc, id, context),
  ]);
  return { primary: state?.primary, fallback: live?.run?.inputs.some((input) => state?.attempts[input] !== undefined) ?? false };
}

export async function originalFallbackInput(harness: Harness, conversation: Conversation, id: SubmissionId) {
  const state = await harness.snapshot(FallbackDoc, conversation.id, context);
  return state?.attempts[id]?.inputs[0];
}

export async function abortWithoutFallback(conversation: Conversation) {
  try {
    await conversation.commit(async (tx) => {
      (await tx.doc(FallbackDoc, conversation.id)).cancelled = true;
    }, context);
  } finally {
    await conversation.abort(context);
  }
}

export async function reserveFallback(conversation: Conversation, id: SubmissionId, threadId?: string): Promise<SubmissionId | undefined> {
  const last = (await conversation.entries({ order: "descending" }, 1, undefined, context)).items[0];
  return conversation.commit(async (tx) => {
    const state = await tx.doc(FallbackDoc, conversation.id);
    const existing = Object.values(state.attempts).find(({ inputs }) => inputs.includes(id));
    if (existing) return existing.submissionId;
    if (state.cancelled) return;
    if (threadId !== undefined && (await tx.doc(ThreadMap)).threads[threadId]?.closed) return;
    const live = await tx.doc(LiveDoc, conversation.id);
    const failed = live.runFailure;
    const error = failed?.detail;
    if (!state.model || live.run || failed?.reason !== "model_error" || !failed.inputs.includes(id) || !error) return;
    if (failed.inputs.some((input) => state.attempts[input] !== undefined)) return;
    if (!AssistantEntry.is(last) || last.byTaskId !== failed.taskId || !canReplayOnFallback(error, last.model ?? [])) return;
    const primary = (await tx.doc(AgentDoc, conversation.id)).model;
    if (!primary) return;
    const input = failed.first === undefined ? undefined : await tx.entry(failed.first);
    const startedAt = Date.now();
    const fallback = { ...state.model };
    const submissionId = await conversation.submit(tx, { type: "continue", requestId: "fallback:" + failed.taskId });
    await configure(tx, conversation.id, { model: fallback });
    const category = getProviderErrorCategory(undefined, error);
    const next: Attempt = {
      submissionId, inputs: [...failed.inputs], primary: { ...primary }, fallback, startedAt,
      ...(category ? { category } : {}),
      ...(InputEntry.is(input) ? { primaryDurationMs: startedAt - input.data.timestamp } : {}),
    };
    state.attempts[submissionId] = next;
    return submissionId;
  }, context);
}

export async function settleFallback(harness: Harness, conversation: Conversation, id: SubmissionId, agentId: string, wait: boolean, threadId?: string): Promise<SettledSubmissionRecord | "waiting" | undefined> {
  const fallbackId = await reserveFallback(conversation, id, threadId);
  if (fallbackId === undefined) return;
  const submission = await harness.submission(fallbackId, context);
  if (!submission) throw new Error("Could not find the Durable fallback.");
  const outcome = wait ? await submission.wait(context) : await submission.status(context);
  if (outcome.status === "placed" || outcome.status === "queued") return "waiting";
  const attempt = (await harness.snapshot(FallbackDoc, conversation.id, context))?.attempts[fallbackId];
  if (!attempt) return outcome;
  const log = await conversation.commit(async (tx) => {
    const stored = (await tx.doc(FallbackDoc, conversation.id)).attempts[fallbackId];
    if (stored.logged) return false;
    stored.logged = true;
    return true;
  }, context);
  if (log) logWarn("[agent] fallback model attempt completed", {
    agentId,
    primaryProvider: attempt.primary.provider, primaryModel: attempt.primary.modelId,
    primaryFailureCategory: attempt.category, primaryDurationMs: attempt.primaryDurationMs,
    fallbackProvider: attempt.fallback.provider, fallbackModel: attempt.fallback.modelId,
    fallbackOutcome: outcome.status === "done" ? "success" : "failure",
    fallbackDurationMs: Date.now() - attempt.startedAt,
  });
  return outcome;
}
