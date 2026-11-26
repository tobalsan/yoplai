import type { FeedItem } from "@yoplai/shared";
import { isFeedMessage } from "./feed-projection.js";
import { entryId } from "./feed.js";
import type { ThreadRecord } from "./state.js";

export function threadRef(id: string) {
  return "thread:" + id;
}

export function firstLine(text: string, limit = Infinity) {
  return (text.split(/[\r\n]/, 1)[0] ?? "").trim().slice(0, limit);
}

export function threadMessages(thread: ThreadRecord, items: readonly FeedItem[]) {
  const before = thread.forkedAt;
  return items.filter(isFeedMessage).filter((item) => before === undefined || (entryId(item.id) ?? 0) > before);
}

export function describeThread(id: string, thread: ThreadRecord, items: readonly FeedItem[] = []) {
  const own = threadMessages(thread, items);
  const first = own.find(({ role }) => role === "user");
  const last = own.at(-1);
  const fork = items.find(({ id }) => id === thread.forkedFrom);
  const title = thread.title ?? (firstLine(first?.text ?? "", 80) || firstLine(fork?.text ?? "", 80) || "New thread");
  return {
    id, title, preview: firstLine((last ?? fork)?.text ?? "", 120),
    createdAt: thread.createdAt, lastActivityAt: last?.timestamp ?? thread.createdAt,
    closed: thread.closed, generation: thread.generation,
    ...(thread.dashboardId !== undefined && { dashboardId: thread.dashboardId }),
    ...(thread.forkedFrom !== undefined && { forkedFrom: thread.forkedFrom }),
  };
}
