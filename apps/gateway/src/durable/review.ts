import { createHash } from "node:crypto";
import {
  defineExtension, GenerationTask, hook, LiveDoc,
  type ConversationId, type EntryId, type Harness, type HookApi,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { AgentConfig } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import type { ExtensionRuntime, LoadedReplyReviewer } from "../extensions/runtime.js";
import { logWarn } from "../logging.js";
import { InputEntry, ReviewDoc } from "./state.js";

export function draftDigest(content: unknown): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

export const WITHHELD_REPLY = "The reply was withheld by review.";

async function untilAbort<T>(work: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work();
  signal.throwIfAborted();
  let cancel!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(signal.reason); });
  signal.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([Promise.resolve().then(work), aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

export function createReplyReview(
  agent: AgentConfig,
  workspaceDir: string,
  runtime: ExtensionRuntime,
  getHarness: () => Harness,
) {
  const active = new Map<ConversationId, { first: EntryId; reviewers: LoadedReplyReviewer[] }>();

  function end(conversationId: ConversationId) {
    const entries = active.get(conversationId)?.reviewers;
    active.delete(conversationId);
    for (const { reviewer, extensionId } of entries ?? []) {
      try {
        reviewer.end();
      } catch {
        logWarn("[durable] Reply reviewer cleanup failed", { extensionId, agentId: agent.id });
      }
    }
  }

  function loadReviewers(user: string, conversationId: ConversationId) {
    const userId = user === "local" ? undefined : user;
    return runtime.getReplyReviewers(
      getAgent(agent.id) ?? agent, loadConfig(), workspaceDir, "durable-main:" + conversationId,
      userId, { source: "web", sessionOwnerId: userId, requesterId: userId },
    );
  }

  async function begin(api: HookApi, context: Context) {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const first = live?.run?.first;
    if (first === undefined) throw new Error("Reply review could not identify the input.");
    const existing = active.get(api.conversationId);
    if (existing?.first === first) return existing.reviewers;
    end(api.conversationId);
    const input = await api.entry(InputEntry, first, context);
    if (!input) throw new Error("Reply review could not identify the input.");
    const reviewers = await untilAbort(() => loadReviewers(input.data.sender.id, api.conversationId), context.abortSignal);
    const started: LoadedReplyReviewer[] = [];
    active.set(api.conversationId, { first, reviewers: started });
    for (const item of reviewers) {
      started.push(item);
      item.reviewer.begin();
    }
    return started;
  }

  const extension = defineExtension({
    name: "yoplai-web-reply-review",
    hooks: [hook(GenerationTask, {
      async beforeRequest(request, api, context) {
        try {
          const reviewers = await begin(api, context);
          await getHarness().commit(async (tx) => {
            const doc = await tx.doc(ReviewDoc, api.conversationId);
            const previous = doc.byTask[api.taskId]?.state;
            if (previous === "approved" || previous === "rejected") return;
            doc.byTask[api.taskId] = { state: reviewers.length || previous === "held" ? "held" : "stream" };
          }, context);
          const nudge = reviewers.map(({ reviewer }) => reviewer.nudge).filter(Boolean).join("\n\n");
          if (!nudge) return;
          const last = request.messages.at(-1);
          if (last?.role === "user" && typeof last.content === "string") {
            return { messages: [...request.messages.slice(0, -1), { ...last, content: last.content + "\n\n" + nudge }] };
          }
        } catch {
          context.abortSignal?.throwIfAborted();
          // Streaming and history both require an affirmative stored decision.
          // When reviewer initialization fails, the generation remains private.
          await getHarness().commit(async (tx) => {
            (await tx.doc(ReviewDoc, api.conversationId)).byTask[api.taskId] = { state: "held" };
          }, context);
          end(api.conversationId);
        }
      },
      afterResponse(message, api) {
        if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "toolUse") {
          end(api.conversationId);
        }
      },
      async onYield(answer, api, context) {
        const digest = draftDigest(answer.content);
        let continuing = false;
        try {
          const doc = await api.snapshot(ReviewDoc, api.conversationId, context);
          const prior = doc?.byTask[api.taskId];
          if (prior?.state === "stream") {
            if (prior.answeredAt === undefined) {
              await getHarness().commit(async (tx) => {
                (await tx.doc(ReviewDoc, api.conversationId)).byTask[api.taskId] = { state: "stream", answeredAt: api.now() };
              }, context);
            }
            return;
          }
          if (prior?.digest === digest && prior.state === "approved") return;
          if (prior?.digest === digest && prior.state === "rejected") {
            continuing = prior.hint !== undefined;
            return prior.hint ? { continue: prior.hint } : undefined;
          }

          const reviewers = await begin(api, context);
          const live = await api.snapshot(LiveDoc, api.conversationId, context);
          const first = live?.run?.first;
          const rewritten = first !== undefined && doc?.rewriteFor === first && !prior?.hint;
          const draft = answer.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
          const verdicts = await untilAbort(() => Promise.all(reviewers.map(({ reviewer }) => reviewer.review(draft))), context.abortSignal);
          const hints = verdicts.flatMap((verdict, index) =>
            verdict.ok ? [] : ["[" + reviewers[index].extensionId + "] " + verdict.rewriteHint]);
          const approved = reviewers.length > 0 && hints.length === 0;
          const hint = !rewritten && first !== undefined && hints.length
            ? "Rewrite your last reply using this feedback:\n" + hints.join("\n\n")
            : undefined;

          await getHarness().commit(async (tx) => {
            const stored = await tx.doc(ReviewDoc, api.conversationId);
            stored.byTask[api.taskId] = approved
              ? { state: "approved", digest, answeredAt: api.now() }
              : { state: "rejected", digest, ...(hint ? { hint } : {}) };
            if (hint !== undefined) stored.rewriteFor = first;
          }, context);

          if (!hint) {
            for (const [index, { reviewer, extensionId }] of reviewers.entries()) {
              try {
                await untilAbort(() => reviewer.done?.(verdicts[index], { rewritten }), context.abortSignal);
              } catch {
                context.abortSignal?.throwIfAborted();
                logWarn("[durable] Reply reviewer completion failed", { extensionId, agentId: agent.id });
              }
            }
          }
          continuing = hint !== undefined;
          return hint ? { continue: hint } : undefined;
        } finally {
          if (!continuing) end(api.conversationId);
        }
      },
    })],
  });
  return {
    extension,
    holdsReplies() {
      const current = getAgent(agent.id) ?? agent;
      const config = loadConfig();
      return runtime.getLoadedExtensions().some((entry) => entry.getReplyReviewer &&
        runtime.isEnabled(entry.id, config) && current.extensions?.[entry.id]?.enabled !== false &&
        entry.reviewsReplies?.(current) !== false);
    },
    close() { for (const task of active.keys()) end(task); },
  };
}
