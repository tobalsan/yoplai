import { z } from "zod";
import type { FeedDetail, FeedItem } from "@yoplai/shared";
import { DEFAULT_OUTPUT_BUDGET, DEFAULT_TEXT_LIMIT, formatTime, FULL_MESSAGE_CAP, truncateMessageText } from "../history/condense.js";
import { day, invalidResult, parseDate, SessionHistoryArgsSchema } from "../session-history/arguments.js";
import { isFeedMessage, searchFeedMessages } from "./feed-projection.js";
import type { ThreadRecord } from "./state.js";
import { describeThread, firstLine, threadMessages } from "./threads.js";
import { entryId } from "./feed.js";

const CURRENT_NOTE =
  "[current conversation — older messages may have been cut out of your context; every message can be read here]";
const CURRENT_MARK = " ★ CURRENT CONVERSATION";

function historyMessageIds(example: string, parse: (id: string) => number | undefined) {
  const messageId = z.string()
    .refine((id) => parse(id) !== undefined, `Expected a message ID like ${example}`)
    .optional();
  const args = SessionHistoryArgsSchema.extend({
    from: messageId, to: messageId, around: messageId, full: messageId,
  });
  return { args, parse };
}

export const durableHistoryIds = historyMessageIds("m_123", entryId);
export const roomHistoryIds = historyMessageIds("r_123", (id) => {
  if (!/^r_[1-9]\d*$/.test(id)) return;
  const sequence = Number(id.slice(2));
  if (Number.isSafeInteger(sequence)) return sequence;
});

export type ReadableConversation = {
  ref: string;
  current: boolean;
  messageIds: ReturnType<typeof historyMessageIds>;
  thread?: { id: string; record: ThreadRecord };
  read: () => Promise<{ items: FeedItem[]; detail?: (id: string) => FeedDetail | undefined }>;
};

export async function durableSessionHistory(raw: unknown, audience: ReadableConversation[]) {
  const ids = audience[0]?.messageIds ?? durableHistoryIds;
  const parsed = ids.args.safeParse(raw);
  if (!parsed.success) return invalidResult(parsed.error.message);
  const args = parsed.data;
  const scoped = args.session === undefined ? audience : audience.filter(({ ref }) => ref === args.session);
  if (args.session !== undefined && !scoped.length) return `no such session: ${args.session}`;
  if (args.action === "read") {
    const target = args.session === undefined ? scoped.find(({ current }) => current) : scoped[0];
    if (!target) return args.session === undefined ? "no conversations" : `no such session: ${args.session}`;
    return readConversation(args, target);
  }
  let since: number;
  let until: number;
  try {
    since = parseDate(args.since, "since") ?? -Infinity;
    until = parseDate(args.until, "until") ?? Infinity;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "invalid_input") return invalidResult(error.message);
    throw error;
  }
  if (args.action === "search") {
    if (args.tool) return invalidResult("The tool filter is unavailable in Durable conversations.");
    const query = args.query;
    if (!query) return invalidResult("search requires `query`");
    const limit = args.limit ?? 15;
    const byConversation = await Promise.all(scoped.map(async ({ ref, current, thread, read, messageIds }) => {
      const { items } = await read();
      const messages = thread && scoped.length > 1 ? threadMessages(thread.record, items) : items.filter(isFeedMessage);
      const matching = messages.filter(({ role, timestamp }) =>
        (!args.role || role === args.role) && timestamp >= since && timestamp <= until);
      return searchFeedMessages(matching, query, Infinity).map((hit) => ({ ref, current, hit, position: messageIds.parse(hit.id) ?? 0 }));
    }));
    const hits = byConversation.flat().sort((a, b) =>
      b.hit.timestamp - a.hit.timestamp || b.position - a.position);
    const lines: string[] = [];
    let previous: string | undefined;
    for (const { ref, current, hit: { id, role, timestamp, snippet } } of hits.slice(0, limit)) {
      if (previous !== ref) {
        lines.push(`conversation ${ref}${current ? CURRENT_MARK : ""}`);
        if (current) lines.push(CURRENT_NOTE);
        previous = ref;
      }
      lines.push(`[${id}] ${role === "assistant" ? "asst" : role} ${day(timestamp)}  ${snippet}`);
    }
    if (!hits.length) {
      const current = scoped.find((conversation) => conversation.current);
      if (current) lines.push(`conversation ${current.ref}${CURRENT_MARK}`, CURRENT_NOTE);
      lines.push("no matches");
    }
    if (hits.length >= limit) lines.push(`more: results capped at limit=${limit}; narrow the query or raise limit`);
    return lines.join("\n");
  }
  const offset = Math.max(0, Number.parseInt(args.cursor ?? "", 10) || 0);
  const limit = args.limit ?? 10;
  const rows = await Promise.all(scoped.map(async ({ ref, current, thread, read }) => {
    const { items } = await read();
    if (thread) {
      const { title, lastActivityAt, closed } = describeThread(thread.id, thread.record, items);
      const count = threadMessages(thread.record, items).length;
      return {
        activity: lastActivityAt,
        line: `${ref} · ${day(lastActivityAt)} · ${count} msgs · ${firstLine(title, 80)}${closed ? " · closed" : ""}${current ? CURRENT_MARK : ""}`,
      };
    }
    const messages = items.filter(isFeedMessage);
    const activity = messages.reduce((latest, { timestamp }) => Math.max(latest, timestamp), 0);
    const title = messages.find(({ role }) => role === "user")?.text.trim().split(/\r?\n/, 1)[0] ?? "";
    const clipped = title.length > 80 ? title.slice(0, 80) + "…" : title;
    return {
      activity,
      line: `${ref} · ${day(activity)} · ${messages.length} msgs · ${clipped}${current ? CURRENT_MARK : ""}`,
    };
  }));
  const matching = rows.filter(({ activity }) => activity >= since && activity <= until)
    .sort((a, b) => b.activity - a.activity);
  const page = matching.slice(offset, offset + limit).map(({ line }) => line);
  if (offset + limit < matching.length) page.push(`more: list cursor=${offset + limit}`);
  return page.join("\n") || "no conversations";
}

type ReadArgs = ReturnType<typeof durableHistoryIds.args.parse>;
type Message = Extract<FeedItem, { role: "user" | "assistant" }>;
const SEAM = "— context was cut here —";

function messageLine(item: Message, text: string) {
  const role = item.role === "assistant" ? "asst" : "user";
  const tools = item.role === "assistant" && item.toolCallCount ? ` · ${item.toolCallCount} tool calls` : "";
  return `[${item.id}] ${role} ${formatTime(item.timestamp)}  ${text}${tools}`.trimEnd();
}

async function readConversation(args: ReadArgs, { ref, current, read }: ReadableConversation) {
  const { items, detail } = await read();
  const messages = items.flatMap((item, position) => isFeedMessage(item) ? [{ item, position }] : []);
  const indexes = new Map(messages.map(({ item }, index) => [item.id, index]));
  const header = (shown: string) => [
    ...(current ? [CURRENT_NOTE] : []),
    `conversation ${ref} · ${messages.length} msgs · showing ${shown}`,
  ];

  for (const id of [args.around, args.from, args.to, args.full]) {
    if (id !== undefined && !indexes.has(id)) return [...header("none"), `no message ${id}`].join("\n");
  }
  if (args.full !== undefined) {
    const item = messages[indexes.get(args.full)!]!.item;
    const text = item.text.trim();
    const body = text.length > FULL_MESSAGE_CAP
      ? `${text.slice(0, FULL_MESSAGE_CAP)}… [truncated at ${FULL_MESSAGE_CAP} chars]` : text;
    const tools = (detail?.(item.id)?.toolCalls ?? []).map(({ name }) => `    → ${name}`);
    return [...header(`[${item.id}]`), messageLine(item, body), ...tools].join("\n");
  }

  const around = args.around === undefined ? undefined : indexes.get(args.around);
  const n = args.n ?? 5;
  const from = around === undefined ? indexes.get(args.from ?? "") ?? 0 : Math.max(0, around - n);
  const to = around === undefined ? indexes.get(args.to ?? "") ?? messages.length - 1 : Math.min(messages.length - 1, around + n);
  const newest = around === undefined && args.from === undefined;
  const window = items.slice(messages[from]?.position ?? items.length, (messages[to]?.position ?? -1) + 1);
  const rows: { id: string; line: string; seamsBefore: number }[] = [];
  let seams = 0;
  for (const item of window) {
    if (item.role === "seam") seams++;
    if (!isFeedMessage(item) || (args.role && item.role !== args.role)) continue;
    const line = messageLine(item, truncateMessageText(item.text.trim(), DEFAULT_TEXT_LIMIT, item.id));
    rows.push({ id: item.id, line, seamsBefore: seams });
    seams = 0;
  }
  if (!rows.length) return header("none").join("\n");

  // Start at the anchor for around, then make room for its closest neighbors.
  // When the role filter excludes the anchor, start at the next matching row.
  const pivot = around === undefined ? -1 : rows.findIndex(({ id }) => indexes.get(id)! >= around);
  const start = around === undefined ? (newest ? rows.length - 1 : 0) : (pivot < 0 ? rows.length - 1 : pivot);
  let first = start;
  let last = start;
  let remaining = DEFAULT_OUTPUT_BUDGET - rows[start]!.line.length - 1;
  const seamSize = SEAM.length + 1;
  while (true) {
    const before = rows[first - 1];
    const after = rows[last + 1];
    const beforeSize = before ? before.line.length + 1 + rows[first]!.seamsBefore * seamSize : Infinity;
    const afterSize = after ? after.line.length + 1 + after.seamsBefore * seamSize : Infinity;
    if (beforeSize <= remaining && (start - first <= last - start || afterSize > remaining)) {
      first--;
      remaining -= beforeSize;
    } else if (afterSize <= remaining) {
      last++;
      remaining -= afterSize;
    } else {
      break;
    }
  }

  const lines: string[] = [];
  for (let index = first; index <= last; index++) {
    const row = rows[index]!;
    const count = index > first ? row.seamsBefore
      : first === 0 ? Math.min(row.seamsBefore, Math.floor(remaining / seamSize)) : 0;
    if (index === first) remaining -= count * seamSize;
    lines.push(...Array<string>(count).fill(SEAM), row.line);
  }
  if (last === rows.length - 1) {
    lines.push(...Array<string>(Math.min(seams, Math.floor(remaining / seamSize))).fill(SEAM));
  }

  const next = [];
  if (first > 0) {
    const lower = around === undefined ? "" : `from=${messages[from]!.item.id} `;
    next.push(`${lower}to=${rows[first - 1]!.id}`);
  }
  if (last + 1 < rows.length) next.push(`from=${rows[last + 1]!.id} to=${messages[to]!.item.id}`);
  if (next.length) {
    const role = args.role ? ` role=${args.role}` : "";
    lines.push("more: " + next.map((range) => `read session=${ref} ${range}${role}`).join(" | "));
  }
  return [...header(`[${rows[first]!.id}]–[${rows[last]!.id}]`), ...lines].join("\n");
}
