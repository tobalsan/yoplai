import { defineDoc, defineEntry, type ConversationId, type EntryId, type SubmissionId } from "@earendil-works/pi-durable";
import type { ChannelActor, ChannelRoute, RunFailureKind } from "@yoplai/shared";
import type { WebSender } from "./contract.js";

type WebInput = { timestamp: number; sender: WebSender; surface?: "web"; route: { surface: "web"; user: string }; text: string };
type ChannelEntry = Pick<WebInput, "timestamp" | "text"> & {
  surface: ChannelActor["surface"];
  actor: ChannelActor;
  owner: string;
  route: ChannelRoute;
};

export type BackgroundChild = {
  id: ConversationId;
  owner: string;
  name: string;
  kind: "job" | "webhook";
};

export type MainIdentityMap = { conversations: Record<string, number>; children?: Record<string, BackgroundChild> };

export const MainMap = defineDoc<MainIdentityMap>({
  kind: "yoplai.main",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

export const InputEntry = defineEntry<WebInput | ChannelEntry>("yoplai.web-input");
export const ChildSeedEntry = defineEntry("yoplai.child-seed");
export const ChildInputEntry = defineEntry<{
  timestamp: number;
  text: string;
  surface: BackgroundChild["kind"];
  name: string;
  owner: string;
  deliveryId?: string;
}>("yoplai.child-input");
export const ChildDigestEntry = defineEntry<{
  timestamp: number;
  text: string;
  surface: "job" | "webhook";
  name: string;
  key: string;
  status: "done" | "unanswered" | "aborted";
}>("yoplai.child-digest");
export const FailureNoteEntry = defineEntry<{ submissionId: SubmissionId; kind: RunFailureKind; accessError?: string }>("yoplai.failure-note");

export const AbortedRuns = defineDoc<{ byFirst: Record<string, number[]> }>({
  kind: "yoplai.aborted-runs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ byFirst: {} }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

export type ReviewDecision = { state: "stream" | "held" | "approved" | "rejected"; hint?: string; digest?: string; answeredAt?: number; hiddenTools?: string[] };

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

export type ThreadRecord = {
  conversationId: ConversationId;
  owner: string;
  createdAt: number;
  title?: string;
  dashboardId?: string;
  forkedAt?: EntryId;
  forkedFrom?: string;
  generation: number;
  closed: boolean;
  seeded?: boolean;
  digestedGeneration?: number;
};

export const ThreadMap = defineDoc<{ threads: Record<string, ThreadRecord> }>({
  kind: "yoplai.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

export const ThreadSeedEntry = defineEntry("yoplai.thread-seed");
export const ThreadNoteEntry = defineEntry("yoplai.thread-note");
