import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type Conversation, type ConversationId, type EntryId, type Harness, type Submission, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import type { ChannelInput, ChannelRoute, DeliverySink, FeedDelivery } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import type { GatewayExtensionContext } from "../extensions/context.js";
import { logWarn } from "../logging.js";
import { mayUseChannel } from "./delivery.js";

type PendingRoute = Pick<ChannelInput, "actor" | "owner" | "route"> & { conversationId: ConversationId; queuedAt: number };
type Effect = PendingRoute & {
  answerId: EntryId;
  submissions: SubmissionId[];
  state: "pending" | "sending" | "sent" | "uncertain" | "dropped";
  updatedAt: number;
  receipt?: string;
};

export type DeliveryFixture = {
  suppressWake?: boolean;
  beforeSend?: (signal: AbortSignal) => Promise<void>;
  afterSend?: (signal: AbortSignal) => Promise<void>;
};

const DeliveryDoc = defineDoc<{ routes: Record<string, PendingRoute>; effects: Record<string, Effect> }>({
  kind: "yoplai.channel-delivery",
  scope: "session",
  version: 1,
  initial: () => ({ routes: {}, effects: {} }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

function effectKey(answerId: EntryId, { ingress }: ChannelRoute) {
  return JSON.stringify([answerId, ingress.surface, ingress.surface === "slack" ? ingress.team : ingress.server, ingress.botKey, ingress.channel]);
}

async function sendOnce(sink: DeliverySink, input: Parameters<DeliverySink>[0]) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      sink(input),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 15_000).unref(); }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export class DeliveryQueue {
  constructor(
    private readonly harness: Harness,
    private readonly agentId: string,
    private readonly settledAnswer: (conversation: Conversation, submission: Submission) => Promise<EntryId | "waiting" | undefined>,
    private readonly answerText: (conversation: Conversation, id: EntryId) => Promise<string | undefined>,
    private readonly changed: (conversationId: ConversationId) => void,
    private readonly fixture?: DeliveryFixture,
  ) {}

  async forFeed(conversationId: ConversationId) {
    const effects = (await this.harness.snapshot(DeliveryDoc, context))?.effects ?? {};
    const byAnswer = new Map<EntryId, FeedDelivery[]>();
    for (const effect of Object.values(effects)) {
      if (effect.conversationId !== conversationId || effect.state === "dropped") continue;
      const id = effect.answerId;
      const deliveries = byAnswer.get(id) ?? [];
      deliveries.push({ surface: effect.actor.surface, state: effect.state === "sending" ? "pending" : effect.state });
      byAnswer.set(id, deliveries);
    }
    return byAnswer;
  }

  async metrics() {
    const queue = await this.harness.snapshot(DeliveryDoc, context);
    let pending = 0;
    let uncertain = 0;
    let oldest = Infinity;
    for (const route of Object.values(queue?.routes ?? {})) {
      pending++;
      oldest = Math.min(oldest, route.queuedAt);
    }
    for (const effect of Object.values(queue?.effects ?? {})) {
      if (effect.state === "pending") {
        pending++;
        oldest = Math.min(oldest, effect.queuedAt);
      } else if (effect.state === "uncertain") uncertain++;
    }
    return { pending, uncertain, oldest };
  }

  async enqueue(tx: Tx, conversationId: ConversationId, id: SubmissionId, { owner, actor, route }: ChannelInput, queuedAt: number) {
    const queue = await tx.doc(DeliveryDoc);
    queue.routes[id] = { conversationId, owner, actor, route, queuedAt };
  }

  async scan(channels: GatewayExtensionContext, signal: AbortSignal) {
    const queue = await this.harness.snapshot(DeliveryDoc, context);
    if (!queue) return;
    for (const [id, item] of Object.entries(queue.routes)) {
      if (signal.aborted) return;
      const submission = await this.harness.submission(Number(id) as SubmissionId, context);
      const conversation = await this.harness.conversation(item.conversationId, context);
      if (!submission || !conversation) throw new Error("Could not read queued Durable submission.");
      const answerId = await this.settledAnswer(conversation, submission);
      if (answerId === "waiting") continue;
      await this.harness.commit(async (tx) => {
        const current = await tx.doc(DeliveryDoc);
        if (!current.routes[id]) return;
        if (answerId !== undefined) {
          const key = effectKey(answerId, item.route);
          const effect = current.effects[key];
          if (effect) effect.submissions.push(submission.id);
          else current.effects[key] = {
            ...item, answerId, submissions: [submission.id], state: "pending", updatedAt: Date.now(),
          };
        }
        delete current.routes[id];
      }, context);
      if (answerId !== undefined) this.changed(item.conversationId);
    }
    const effects = (await this.harness.snapshot(DeliveryDoc, context))?.effects ?? {};
    for (const [key, effect] of Object.entries(effects)) {
      if (effect.state === "sending") await this.transition(key, "sending", "uncertain");
      if (signal.aborted) return;
      if (effect.state === "pending") await this.send(channels, key, effect, signal);
    }
  }

  private async send(channels: GatewayExtensionContext, key: string, effect: Effect, signal: AbortSignal) {
    await this.fixture?.beforeSend?.(signal);
    if (signal.aborted) return;
    const { route, owner, actor, answerId, conversationId } = effect;
    const conversation = await this.harness.conversation(conversationId, context);
    const text = conversation && await this.answerText(conversation, answerId);
    const allowed = text && await mayUseChannel(this.agentId, owner, actor, route, channels, true).catch(() => false);
    const agent = getAgent(this.agentId);
    const sink = channels.getDeliverySink(route.sink);
    if (!text || !allowed || !agent || !sink) {
      await this.transition(key, "pending", "dropped");
      return;
    }
    if (signal.aborted) return;
    const config = loadConfig();
    const base = config.server?.baseUrl ?? config.web?.baseUrl;
    const feedPath = "/chat/" + encodeURIComponent(agent.id);
    const url = base && URL.canParse(feedPath, base) ? new URL(feedPath, base) : undefined;
    const feedUrl = url && (url.protocol === "http:" || url.protocol === "https:") ? url.href : undefined;
    if (!await this.transition(key, "pending", "sending")) return;
    const result = await sendOnce(sink, {
      agent, text, destination: route.destination, durable: { ingress: route.ingress, feedUrl },
    });
    if (this.fixture?.afterSend) {
      await this.fixture.afterSend(signal);
      if (signal.aborted) return;
    }
    const receipt = typeof result?.receipt === "string" && result.receipt.trim() ? result.receipt : undefined;
    await this.transition(key, "sending", receipt ? "sent" : "uncertain", receipt);
  }

  private async transition(key: string, from: Effect["state"], state: Effect["state"], receipt?: string) {
    const changed = await this.harness.commit(async (tx) => {
      const { effects } = await tx.doc(DeliveryDoc);
      const effect = effects[key];
      if (effect?.state !== from) return undefined;
      effect.state = state;
      effect.updatedAt = Date.now();
      if (receipt) effect.receipt = receipt;
      return { conversationId: effect.conversationId, answerId: effect.answerId, surface: effect.actor.surface };
    }, context);
    if (!changed) return false;
    if (state === "uncertain") logWarn("Durable channel delivery is uncertain", { agentId: this.agentId, ...changed });
    if (state !== "sending") this.changed(changed.conversationId);
    return true;
  }
}
