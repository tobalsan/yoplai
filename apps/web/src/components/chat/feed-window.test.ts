import { describe, expect, it, vi } from "vitest";
import type { FeedItem, FeedWindow } from "@yoplai/shared/types";
import { createFeedWindow } from "./feed-window";

const user = (id: string): FeedItem => ({
  id, role: "user", sender: "Avery", text: "Count the pears", timestamp: 10,
});
const answer: FeedItem = {
  id: "m_9", role: "assistant", text: "Four pears", timestamp: 20, toolCallCount: 0,
};
const seam: FeedItem = {
  id: "m_12", role: "seam", text: "Context compacted", timestamp: 19,
  reason: "threshold", carried: { firstKept: "m_7", indexed: 2 },
};
const windowOf = (items: FeedItem[], hasBefore = false, hasAfter = false): FeedWindow =>
  ({ items, hasBefore, hasAfter, live: null });
const ids = (items: FeedItem[]) => items.map(({ id }) => id);
const snapshot = (items: FeedItem[], hasBefore = false) => ({
  type: "feed_snapshot" as const, agentId: "pear-agent", seq: 1, items, hasBefore, live: null,
});

describe("Durable feed window", () => {
  it("keeps the loaded prefix when a snapshot inserts a seam above its answer", async () => {
    const read = vi.fn().mockResolvedValue(windowOf([user("m_7"), user("m_8"), answer]));
    const feed = createFeedWindow(read);
    await feed.openTail();
    expect(read).toHaveBeenCalledWith({});
    feed.onFrame(snapshot([seam, answer], true));
    expect(ids(feed.items())).toEqual(["m_7", "m_8", "m_12", "m_9"]);
    expect(feed.hasBefore()).toBe(false);
  });
});

it("counts unique message arrivals across tail rollover after opening an older link", async () => {
  const feed = createFeedWindow(vi.fn().mockResolvedValue(windowOf([user("m_1")], false, true)));
  await feed.openAround("m_1");
  feed.onFrame(snapshot([user("m_50")], true));
  expect(feed.newCount()).toBe(0);

  for (let id = 51; id <= 101; id++) {
    feed.onFrame({
      type: "feed_delta", agentId: "pear-agent", seq: id, hasBefore: true, live: null,
      upsert: [user(`m_${id}`)], dropBefore: `m_${id}`,
    });
  }
  feed.onFrame(snapshot([seam, user("m_101")], true));
  expect(feed.newCount()).toBe(51);
  expect(ids(feed.items())).toEqual(["m_1"]);

  await feed.jumpToLatest();
  expect(ids(feed.items())).toEqual(["m_12", "m_101"]);
  expect(feed.newCount()).toBe(0);
  expect(feed.detached()).toBe(false);
});

it("drops the far edge while paging and reattaches at the latest page", async () => {
  const page = (start: number) => Array.from({ length: 50 }, (_, index) => user(`m_${start + index}`));
  const read = vi.fn()
    .mockResolvedValueOnce(windowOf(page(201), true))
    .mockResolvedValueOnce(windowOf(page(151), true, true))
    .mockResolvedValueOnce(windowOf(page(101), true, true))
    .mockResolvedValueOnce(windowOf(page(51), true, true))
    .mockResolvedValueOnce(windowOf(page(1), false, true))
    .mockResolvedValueOnce(windowOf(page(201), true));
  const feed = createFeedWindow(read);
  await feed.openTail();
  for (let index = 0; index < 4; index++) await feed.loadBefore();
  expect(feed.items()).toHaveLength(200);
  expect(feed.items()[0]?.id).toBe("m_1");
  expect(feed.items().at(-1)?.id).toBe("m_200");
  expect(feed.detached()).toBe(true);
  expect(read).toHaveBeenLastCalledWith({ before: "m_51" });

  await feed.loadAfter();
  expect(read).toHaveBeenLastCalledWith({ after: "m_200" });
  expect(feed.items()).toHaveLength(200);
  expect(feed.items()[0]?.id).toBe("m_51");
  expect(feed.items().at(-1)?.id).toBe("m_250");
  expect(feed.hasBefore()).toBe(true);
  expect(feed.detached()).toBe(false);
});

it("ignores an earlier anchor and an older page that finish after navigation", async () => {
  let resolveOld!: (page: FeedWindow) => void;
  let resolveBefore!: (page: FeedWindow) => void;
  const read = vi.fn()
    .mockResolvedValueOnce(windowOf([answer], true))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce(windowOf([user("m_3")], true, true))
    .mockImplementationOnce(() => new Promise((resolve) => { resolveBefore = resolve; }));
  const feed = createFeedWindow(read);
  await feed.openTail();
  const first = feed.openAround("m_1");
  await feed.openAround("m_3");
  resolveOld(windowOf([user("m_1")], false, true));
  await first;
  expect(ids(feed.items())).toEqual(["m_3"]);

  const page = feed.loadBefore();
  await feed.jumpToLatest();
  resolveBefore(windowOf([user("m_2")]));
  await page;
  expect(ids(feed.items())).toEqual(["m_9"]);
});

it("keeps a newer HTTP page if a socket snapshot has yet to catch up", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce(windowOf([user("m_17")], true, true))
    .mockResolvedValueOnce(windowOf([user("m_18"), user("m_19"), user("m_20")], true));
  const feed = createFeedWindow(read);
  feed.onFrame(snapshot([user("m_18"), user("m_19")], true));
  await feed.openAround("m_17");
  await feed.loadAfter();
  expect(ids(feed.items())).toEqual(["m_17", "m_18", "m_19", "m_20"]);
  expect(feed.detached()).toBe(false);
});

it("returns to the tail from a socket snapshot while the HTTP tail request hangs", async () => {
  const read = vi.fn()
    .mockResolvedValueOnce(windowOf([user("m_3")], false, true))
    .mockImplementationOnce(() => new Promise(() => {}));
  const feed = createFeedWindow(read);
  await feed.openAround("m_3");
  const jumped = feed.jumpToLatest();
  feed.onFrame(snapshot([user("m_50")], true));
  await Promise.resolve();
  expect(feed.detached()).toBe(false);
  expect(ids(feed.items())).toEqual(["m_50"]);
  await jumped;
});
