import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
  defineDoc, defineEntry, InboxDoc, LiveDoc,
  type Conversation, type ConversationId, type EntryId, type Harness, type HarnessInspection,
  type SettledSubmissionRecord, type SubmissionId, type Tx,
} from "@earendil-works/pi-durable";
import { buildHandoff } from "../history/handoff.js";
import { logError } from "../logging.js";
import { roomHandoffTranscript, roomInput } from "../rooms/context.js";
import type { RoomMembership, RoomStore } from "../rooms/store.js";

const context = BACKGROUND_CONTEXT;

const RoomMap = defineDoc<{ conversations: Record<string, { id: ConversationId; owner: string }> }>({
  kind: "yoplai.rooms",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {} }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

const RoomProgress = defineDoc<{
  generation: number | null;
  delivered: number;
  published: EntryId | null;
  pending: { id: SubmissionId; mentioned: boolean }[];
}>({
  kind: "yoplai.room-progress",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ generation: null, delivered: 0, published: null, pending: [] }),
  checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= 100,
});

const RoomInput = defineEntry<{ roomId: string; firstSeq: number; lastSeq: number; eventIds: string[] }>("yoplai.room-input");
const RoomSeed = defineEntry("yoplai.room-seed");

export type RoomDelivery = { roomId: string; agentId: string; lastSeq: number };

type RoomIdentity = { roomId: string; id: ConversationId; owner: string; generation: number | null };

type RoomHost = {
  active(): boolean;
  name(): string;
  holdsReplies(): boolean;
  handoffMaxChars(): number;
  register(id: ConversationId, owner: string): Promise<void>;
  mutate<T>(id: ConversationId, action: () => Promise<T>): Promise<T>;
  configure(conversation: Conversation): Promise<(tx: Tx) => Promise<void>>;
  restore(conversation: Conversation): Promise<void>;
  answer(conversation: Conversation, id: EntryId): Promise<{ text: string } | undefined>;
  failure(conversation: Conversation, id: SubmissionId, result: Extract<SettledSubmissionRecord, { status: "unanswered" }>): Promise<unknown>;
  afterCommit?(delivery: RoomDelivery, signal: AbortSignal): void | Promise<void>;
};

export class RoomConversations {
  private readonly byRoom = new Map<string, RoomIdentity>();
  private readonly byConversation = new Map<ConversationId, RoomIdentity>();
  private readonly work = new Map<string, { again: boolean; done?: Promise<void> }>();
  private readonly waiting = new Set<SubmissionId>();
  private readonly waitingForIdle = new Set<ConversationId>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly harness: Harness,
    private readonly store: RoomStore,
    private readonly agentId: string,
    private readonly host: RoomHost,
  ) {}

  sessionRef(id: ConversationId) {
    const room = this.byConversation.get(id);
    return room && "room:" + room.roomId;
  }

  mayRun(id: ConversationId): boolean | undefined {
    const room = this.byConversation.get(id);
    return room && this.current(room) && this.host.active();
  }

  private current(room: RoomIdentity) {
    return room.generation !== null && this.store.membership(room.roomId, this.agentId)?.generation === room.generation;
  }

  private async register(room: RoomIdentity) {
    this.byRoom.set(room.roomId, room);
    this.byConversation.set(room.id, room);
    await this.host.register(room.id, room.owner);
    return room;
  }

  async prepareRecovery(inspection: HarnessInspection) {
    const map = await this.harness.snapshot(RoomMap, context);
    for (const [key, { id, owner }] of Object.entries(map?.conversations ?? {})) {
      const roomId = key.slice("room:".length);
      const progress = await this.harness.snapshot(RoomProgress, id, context);
      await this.register({ id, roomId, owner, generation: progress?.generation ?? null });
    }
    for (const room of this.byRoom.values()) {
      const conversation = await this.conversation(room.id);
      if (this.current(room) && this.host.active() &&
          inspection.submissions.some((item) => item.conversationId === room.id && item.type !== "write")) {
        try {
          await this.host.restore(conversation);
        } catch (error) {
          if (this.current(room) && this.host.active()) throw error;
        }
      }
      if (!this.current(room) || !this.host.active()) {
        await this.withdraw(conversation);
        // Conversation.abort() also resumes the harness. Mark stale work while
        // scheduling is paused so no pre-removal generation or tool can resume.
        for (const { record: task } of inspection.tasks) {
          if (task.conversationId === room.id) await this.harness.abortTask(task.id, context);
        }
        if (!this.current(room)) await this.clearProgress(room, conversation);
      }
    }
  }

  resume() {
    for (const roomId of new Set([
      ...this.byRoom.keys(), ...this.store.roomsForAgent(this.agentId).map((room) => room.roomId),
    ])) this.wake(roomId);
  }

  wake(roomId: string) {
    if (this.shutdown.signal.aborted) return;
    const existing = this.work.get(roomId);
    if (existing) {
      existing.again = true;
      return;
    }
    const work = { again: false, done: undefined as Promise<void> | undefined };
    this.work.set(roomId, work);
    work.done = this.drain(roomId, work);
  }

  private async drain(roomId: string, work: { again: boolean }) {
    try {
      do {
        work.again = false;
        try {
          let room = this.byRoom.get(roomId);
          if (!room) {
            const membership = this.store.membership(roomId, this.agentId);
            if (!membership || !this.host.active()) return;
            room = await this.open(membership);
          }
          const identity = room;
          await this.host.mutate(room.id, async () => {
            if (!this.shutdown.signal.aborted) await this.sync(identity);
          });
        } catch (error) {
          this.report(error, roomId);
        }
      } while (work.again && !this.shutdown.signal.aborted);
    } finally {
      this.work.delete(roomId);
    }
  }

  private async open({ roomId, ownerUserId: owner }: RoomMembership) {
    const id = await this.harness.commit(async (tx) => {
      const map = await tx.doc(RoomMap);
      const key = "room:" + roomId;
      const existing = map.conversations[key];
      if (existing) return existing.id;
      const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
      map.conversations[key] = { id: created.id, owner };
      return created.id;
    }, context);
    return this.register({ id, roomId, owner, generation: null });
  }

  private async conversation(id: ConversationId) {
    const conversation = await this.harness.conversation(id, context);
    if (!conversation) throw new Error("Could not open Durable room conversation.");
    return conversation;
  }

  private async sync(room: RoomIdentity) {
    const conversation = await this.conversation(room.id);
    const membership = this.store.membership(room.roomId, this.agentId);
    if (!membership || membership.generation !== room.generation) {
      await this.invalidate(room, conversation);
      if (!membership || !this.host.active() || this.shutdown.signal.aborted) return;
      if (this.store.membership(room.roomId, this.agentId)?.generation !== membership.generation) return;
      await this.seed(room, conversation, membership);
    }
    if (!this.current(room) || !this.host.active()) return;
    await this.publishSettlements(room, conversation);
    if (this.current(room) && this.host.active() && !this.shutdown.signal.aborted) {
      await this.deliver(room, conversation);
    }
  }

  private async withdraw(conversation: Conversation) {
    const inbox = await this.harness.snapshot(InboxDoc, conversation.id, context);
    for (const item of inbox?.items ?? []) {
      if (item.mode !== "write") await (await this.harness.submission(item.id, context))?.abort(context);
    }
  }

  private async invalidate(room: RoomIdentity, conversation: Conversation) {
    room.generation = null;
    // Mark the run before withdrawing kept inputs, so the current generation
    // cannot place a queued steer during cleanup.
    await conversation.abort(context);
    await this.withdraw(conversation);
    await this.clearProgress(room, conversation);
  }

  private async clearProgress(room: RoomIdentity, conversation: Conversation) {
    room.generation = null;
    await conversation.commit(async (tx) => {
      const progress = await tx.doc(RoomProgress, room.id);
      progress.published = (await tx.latestEntryId(room.id)) ?? null;
      progress.generation = null;
      progress.pending = [];
    }, context);
  }

  private async seed(room: RoomIdentity, conversation: Conversation, membership: RoomMembership) {
    const { generation, joinSeq } = membership;
    const transcript = roomHandoffTranscript(this.store.events(room.roomId, 0, joinSeq), this.agentId);
    const seed = transcript.length ? buildHandoff({ transcript, maxChars: this.host.handoffMaxChars() }).text : "";
    await conversation.commit(async (tx) => {
      const progress = await tx.doc(RoomProgress, room.id);
      if (seed) await conversation.submit(tx, {
        type: "write", requestId: `room:${room.roomId}:${this.agentId}:seed:${generation}`,
        entry: { kind: RoomSeed.kind, model: [{ role: "user", content: seed, timestamp: Date.now() }] },
      });
      progress.generation = generation;
      progress.delivered = joinSeq;
    }, context);
    room.generation = generation;
  }

  private async deliver(room: RoomIdentity, conversation: Conversation) {
    let configure: ((tx: Tx) => Promise<void>) | undefined;
    const admit = () => conversation.commit(async (tx) => {
      const progress = await tx.doc(RoomProgress, room.id);
      const lastSeq = this.store.lastSeq(room.roomId);
      if (!this.current(room) || lastSeq <= progress.delivered) return;
      const batch = roomInput(this.store.events(room.roomId, progress.delivered, lastSeq), this.agentId);
      if (!batch) {
        progress.delivered = lastSeq;
        return;
      }
      const { mentioned, content, eventIds } = batch;
      const { run } = await tx.doc(LiveDoc, room.id);
      if (run && (this.host.holdsReplies() || (run.afterRun && !mentioned))) return { idle: true } as const;
      if (!run && !mentioned && (await tx.doc(InboxDoc, room.id)).items.some(({ mode }) => mode !== "write")) return;
      if (!this.current(room) || !this.host.active()) return;
      if (!run && mentioned) {
        if (!configure) return { configure: true } as const;
        await configure(tx);
      }
      const data = { roomId: room.roomId, firstSeq: progress.delivered + 1, lastSeq, eventIds };
      const requestId = `room:${room.roomId}:${this.agentId}:${lastSeq}`;
      const entry = { kind: RoomInput.kind, data };
      const id = await conversation.submit(tx, mentioned || run
        ? { type: "input", requestId, content, whenBusy: "steer", onAbort: "keep", entry }
        : { type: "write", requestId, entry: { ...entry, model: [{ role: "user", content, timestamp: Date.now() }] } });
      if (mentioned || run) progress.pending.push({ id, mentioned });
      progress.delivered = lastSeq;
      return { id, lastSeq, input: Boolean(mentioned || run), idle: Boolean(run?.afterRun) };
    }, context);

    let admitted = await admit();
    if (admitted?.configure) {
      configure = await this.host.configure(conversation);
      admitted = await admit();
    }
    if (admitted?.id !== undefined) {
      await this.host.afterCommit?.({ roomId: room.roomId, agentId: this.agentId, lastSeq: admitted.lastSeq }, this.shutdown.signal);
      if (admitted.input) this.waitForSettlement(room, admitted.id);
    }
    if (admitted?.idle) this.waitForIdle(room, conversation);
  }

  async finishTurn(id: ConversationId) {
    const room = this.byConversation.get(id);
    if (!room || !this.current(room)) return;
    const conversation = await this.conversation(id);
    await conversation.commit(async (tx) => {
      const inbox = await tx.doc(InboxDoc, id);
      const progress = await tx.doc(RoomProgress, id);
      const contextOnly = new Set(progress.pending.filter(({ mentioned }) => !mentioned).map(({ id }) => id));
      const steers = inbox.items.filter((item) => item.mode !== "write");
      if (!steers.length || steers.length !== inbox.items.length || !this.current(room) ||
          steers.some((item) => item.mode !== "steer" || !contextOnly.has(item.id))) return;

      // Pi consumes leftover steers at the final boundary and starts another
      // run. When none mentions the agent, retain their context at this safe
      // boundary, once, after the answer and before any later admission.
      const retained = new Set<SubmissionId>();
      for (const item of steers) {
        if (!item.entry || typeof item.content !== "string") throw new Error("Invalid queued room entry.");
        await tx.appendEntry(id, {
          ...item.entry, model: [{ role: "user", content: item.content, timestamp: Date.now() }],
        });
        tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
        retained.add(item.id);
      }
      inbox.items = [];
      progress.pending = progress.pending.filter((item) => !retained.has(item.id));
    }, context);
  }

  private waitForSettlement(room: RoomIdentity, id: SubmissionId) {
    if (this.waiting.has(id) || this.shutdown.signal.aborted) return;
    this.waiting.add(id);
    void (async () => {
      const submission = await this.harness.submission(id, context);
      await submission?.wait(withAbortSignal(this.shutdown.signal, context));
      this.wake(room.roomId);
    })().catch((error: unknown) => this.report(error, room.roomId)).finally(() => { this.waiting.delete(id); });
  }

  private waitForIdle(room: RoomIdentity, conversation: Conversation) {
    if (this.waitingForIdle.has(room.id) || this.shutdown.signal.aborted) return;
    this.waitingForIdle.add(room.id);
    void conversation.waitForIdle(withAbortSignal(this.shutdown.signal, context))
      .then(() => {
        this.waitingForIdle.delete(room.id);
        this.wake(room.roomId);
      }, (error: unknown) => {
        this.waitingForIdle.delete(room.id);
        this.report(error, room.roomId);
      });
  }

  private async publishSettlements(room: RoomIdentity, conversation: Conversation) {
    const progress = await this.harness.snapshot(RoomProgress, room.id, context);
    if (!progress?.pending.length) return;
    const records = await conversation.commit((tx) => Promise.all(progress.pending.map(({ id }) => tx.submission(id))), context);
    const finished = new Set<SubmissionId>();
    let published = progress.published;
    for (const record of records) {
      if (!record || !this.current(room) || this.shutdown.signal.aborted) return;
      if (record.status === "queued" || record.status === "placed") {
        this.waitForSettlement(room, record.id);
        continue;
      }
      finished.add(record.id);
      if (record.status === "unanswered") {
        if (record.reason !== "aborted") await this.host.failure(conversation, record.id, record);
        continue;
      }
      if (record.type === "write" || (published !== null && record.answer <= published)) continue;
      const answer = await this.host.answer(conversation, record.answer);
      published = record.answer;
      if (answer?.text && this.current(room)) {
        this.store.append(room.roomId, `agent:${this.agentId}:${room.id}:${record.answer}`,
          { id: this.agentId, name: this.host.name() }, answer.text,
          { kind: "agent", agentId: this.agentId, ref: { conversationId: room.id, answerId: record.answer } });
      }
    }
    if (finished.size) await conversation.commit(async (tx) => {
      const state = await tx.doc(RoomProgress, room.id);
      state.published = published;
      state.pending = state.pending.filter(({ id }) => !finished.has(id));
    }, context);
    if (finished.size && (await this.harness.snapshot(LiveDoc, room.id, context))?.run?.afterRun) {
      this.waitForIdle(room, conversation);
    }
  }

  private report(error: unknown, roomId: string) {
    if (!this.shutdown.signal.aborted) logError("Could not deliver Durable room conversation", error, { roomId, agentId: this.agentId });
  }

  async close() {
    this.shutdown.abort();
    await Promise.all([...this.work.values()].map(({ done }) => done));
  }
}
