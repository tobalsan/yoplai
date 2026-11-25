import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, LiveDoc, type Conversation, type ConversationView, type Cursor, type EntryId, type EntryQuery, type EntryRecord, type Harness, type LiveState } from "@earendil-works/pi-durable";
import type { AgentConfig, FeedWindow } from "@yoplai/shared";
import { feedBoundary, feedItems, projectLive, projectRecords, projectReplyRounds } from "./feed-projection.js";
import { AbortedRuns, ReviewDoc } from "./state.js";
import type { DeliveryQueue } from "./outbox.js";

export const emptyFeedWindow: FeedWindow = { items: [], hasBefore: false, hasAfter: false, live: null };

export function entryId(id: string): EntryId | undefined {
  if (!/^m_(?:0|[1-9]\d*)$/.test(id)) return;
  const value = Number(id.slice(2));
  if (Number.isSafeInteger(value)) return value as EntryId;
}

export type FeedSelector = { direction: "before" | "after" | "around"; id: string };

export async function runIdFor(harness: Harness, conversation: Conversation, run: NonNullable<LiveState["run"]>) {
  if (run.first === undefined) return;
  const stopped = await harness.snapshot(AbortedRuns, conversation.id, context);
  // An older watch revision can still be projected after an abort. Count only
  // the aborts that preceded this generation, even when the first entry is reused.
  const count = stopped?.byFirst[run.first]?.filter((lastTask) => lastTask < run.taskId).length ?? 0;
  return `${run.first}-${count}`;
}

export function observeFeed(view: ConversationView) {
  const selected = view.docs[AgentDoc.definition.kind]?.extensions;
  return {
    through: view.entries.at(-1)?.id ?? null,
    live: view.docs[LiveDoc.definition.kind] as LiveState | undefined,
    selected: Array.isArray(selected) ? selected.filter((name): name is string => typeof name === "string") : [],
  };
}

type FeedObservation = ReturnType<typeof observeFeed>;

export class DurableFeed {
  constructor(
    private readonly harness: Harness,
    private readonly agent: AgentConfig,
    private readonly invisibleNames: (selected: readonly string[]) => ReadonlySet<string>,
    private readonly viewFor: (conversation: Conversation, id: string) => unknown,
    private readonly deliveries: DeliveryQueue,
  ) {}

  private async scan(conversation: Conversation, query: Omit<EntryQuery, "conversationId">, boundaries?: number) {
    const entries: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries(query, 200, cursor, context);
      for (const entry of page.items) {
        entries.push(entry);
        // A complete boundary closes the adjacent answer and counts as an item.
        if (boundaries !== undefined && feedBoundary(entry) && --boundaries === 0) return entries;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return entries;
  }

  async observe(conversation: Conversation) {
    const watch = await conversation.watch(context, { min: 1, max: 1 });
    try {
      return observeFeed(watch.value);
    } finally {
      await watch.stop();
    }
  }

  async replyRounds(conversation: Conversation, after: EntryId, through: EntryId) {
    const entries = await this.scan(conversation, { order: "ascending", minEntryId: after, maxEntryId: through });
    const review = await this.harness.snapshot(ReviewDoc, conversation.id, context);
    return projectReplyRounds(entries.filter(({ id }) => id > after), review?.byTask ?? {});
  }

  async read(conversation: Conversation, window?: { limit: number; id?: EntryId }, observation?: FeedObservation) {
    // Watch entries supply a high-water mark only. Page the transcript at that
    // revision so a stored answer and its earlier partial cannot coexist.
    const through = observation?.through;
    const upper = through === null ? undefined
      : window?.id === undefined || (through !== undefined && through < window.id) ? through : window.id;
    const older = through === null ? [] : await this.scan(conversation, { order: "descending", maxEntryId: upper },
      window && window.limit + 2);
    const entries = older.reverse();
    if (window?.id !== undefined && through !== null && (through === undefined || through >= window.id)) {
      const newer = await this.scan(conversation, { order: "ascending", minEntryId: window.id, maxEntryId: through }, window.limit + 2);
      for (const entry of newer) {
        if (entry.id !== window.id || entries.at(-1)?.id !== window.id) entries.push(entry);
      }
    }
    const selected = observation?.selected ?? (await this.harness.snapshot(AgentDoc, conversation.id, context))?.extensions;
    const hiddenNames = this.invisibleNames(Array.isArray(selected) ? selected : []);
    const review = await this.harness.snapshot(ReviewDoc, conversation.id, context);
    const records = projectRecords(entries, review?.byTask ?? {},
      hiddenNames, this.agent.language ?? "en");
    return { records, review, hiddenNames };
  }

  async window(conversation: Conversation, limit: number, selector?: FeedSelector, observation?: FeedObservation): Promise<FeedWindow | undefined> {
    const id = selector && entryId(selector.id);
    if (selector && id === undefined) return;
    const observed = observation ?? await this.observe(conversation);
    const projection = await this.read(conversation, { limit, id }, observed);
    const { records } = projection;
    const items = feedItems(records, await this.deliveries.forFeed(conversation.id));
    let start = Math.max(0, items.length - limit);
    let end = items.length;
    if (selector) {
      const index = items.findIndex(({ id }) => id === selector.id);
      if (index < 0) return undefined;
      switch (selector.direction) {
        case "before":
          end = index;
          start = Math.max(0, end - limit);
          break;
        case "after":
          start = index + 1;
          end = Math.min(items.length, start + limit);
          break;
        case "around":
          start = Math.max(0, Math.min(items.length - limit, index - Math.floor(limit / 2)));
          end = Math.min(items.length, start + limit);
          break;
      }
    }
    return {
      items: items.slice(start, end), hasBefore: start > 0, hasAfter: end < items.length,
      live: await this.live(conversation, observed, selector ? undefined : projection),
    };
  }

  async live(conversation: Conversation, observed: FeedObservation, projection?: Awaited<ReturnType<DurableFeed["read"]>>) {
    const { live } = observed;
    if (!live?.run) return null;
    const source = projection ?? (live.tools?.length ? await this.read(conversation, { limit: 1 }, observed) : undefined);
    const review = source ? source.review : await this.harness.snapshot(ReviewDoc, conversation.id, context);
    return {
      ...projectLive(live, source?.records ?? [], review?.byTask ?? {}, source?.hiddenNames ?? new Set(),
        (id) => this.viewFor(conversation, id)),
      runId: await runIdFor(this.harness, conversation, live.run),
    };
  }
}
