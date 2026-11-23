import { defineDoc, defineEntry, type SubmissionId } from "@earendil-works/pi-durable";
import type { RunFailureKind } from "@yoplai/shared";
import type { WebSender } from "./contract.js";

type WebInput = { timestamp: number; sender: WebSender; surface: "web"; route: { surface: "web"; user: string }; text: string };

export const MainMap = defineDoc<{ conversations: Record<string, number> }>({
  kind: "yoplai.main",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

export const InputEntry = defineEntry<WebInput>("yoplai.web-input");
export const FailureNoteEntry = defineEntry<{ submissionId: SubmissionId; kind: RunFailureKind }>("yoplai.failure-note");

type ReviewDecision = { state: "stream" | "held" | "approved" | "rejected"; hint?: string; digest?: string; answeredAt?: number };

export const ReviewDoc = defineDoc<{
  byTask: Record<string, ReviewDecision>;
  rewriteFor?: number;
}>({
  kind: "yoplai.reply-review",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ byTask: {} }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});
