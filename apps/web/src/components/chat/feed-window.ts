import { batch, createSignal } from "solid-js";
import type { FeedItem, FeedWindow, WsFeedMessage } from "@yoplai/shared/types";

import type { FeedSelector } from "../../api/feed";
export const FEED_PAGE_SIZE = 50;
const WINDOW_LIMIT = 200;

const empty: FeedWindow = { items: [], hasBefore: false, hasAfter: false, live: null };

function mergeSnapshot(window: FeedWindow, tail: FeedWindow): FeedWindow {
  const existing = new Map(window.items.map((item, index) => [item.id, index]));
  const overlap = tail.items.find((item) => existing.has(item.id));
  if (!overlap) return tail;
  const prefix = window.items.slice(0, existing.get(overlap.id));
  const snapshotIds = new Set(tail.items.map(({ id }) => id));
  return {
    ...tail,
    items: [...prefix.filter(({ id }) => !snapshotIds.has(id)), ...tail.items],
    hasBefore: window.hasBefore && (prefix.length > 0 || tail.hasBefore),
  };
}

function upsert(items: FeedItem[], updated: FeedItem[]): FeedItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of updated) byId.set(item.id, item);
  return [...byId.values()];
}

export function createFeedWindow(read: (selector: FeedSelector) => Promise<FeedWindow>, beforeChange?: () => void) {
  const [view, setView] = createSignal(empty);
  const [live, setLive] = createSignal<FeedWindow["live"]>(null);
  const [status, setStatus] = createSignal<"loading" | "ready" | "error" | "not-found">("loading");
  const [flash, setFlash] = createSignal<{ id: string }>();
  const [newCount, setNewCount] = createSignal(0);
  let tail: FeedWindow | undefined;
  let receivedSnapshot = false;
  let ended = false;
  let tailCurrent = false;
  let generation = 0;
  let openingAround = false;
  let followNextTail = false;
  let resolveTailFromSocket: (() => void) | undefined;
  const paging = { before: -1, after: -1 };
  let baseline: Set<string> | undefined;
  const arrivals = new Set<string>();

  const show = (window: FeedWindow, preserve: "before" | "after" = "after") => {
    if (window.items.length > WINDOW_LIMIT) {
      window = preserve === "before"
        ? { ...window, items: window.items.slice(0, WINDOW_LIMIT), hasAfter: true }
        : { ...window, items: window.items.slice(-WINDOW_LIMIT), hasBefore: true };
    }
    if (!window.hasAfter || !view().hasAfter) {
      baseline = window.hasAfter && receivedSnapshot
        ? new Set(tail?.items.map(({ id }) => id))
        : undefined;
      arrivals.clear();
      setNewCount(0);
    }
    beforeChange?.();
    setView(window);
  };

  const reconcileTail = (window: FeedWindow, live: FeedWindow["live"]) => {
    const last = window.items.at(-1)?.id;
    if (receivedSnapshot && tail && tail.items.some(({ id }) => id === last)) {
      return mergeSnapshot(window, tail);
    }
    tail = {
      ...window, live,
      items: window.items.slice(-FEED_PAGE_SIZE),
      hasBefore: window.hasBefore || window.items.length > FEED_PAGE_SIZE,
    };
    tailCurrent = true;
    setLive(live);
    return window;
  };

  const finishTailRead = () => {
    const resolve = resolveTailFromSocket;
    resolveTailFromSocket = undefined;
    resolve?.();
  };

  const openTail = async () => {
    const request = ++generation;
    finishTailRead();
    openingAround = false;
    followNextTail = false;
    setFlash(undefined);
    if (ended) return;
    if (tail) {
      const cached = tail;
      batch(() => {
        show(cached);
        setStatus("ready");
      });
      if (tailCurrent) return;
    } else {
      setStatus("loading");
    }
    followNextTail = true;
    const socket = new Promise<void>((resolve) => { resolveTailFromSocket = resolve; });
    try {
      const page = await Promise.race([read({}), socket]);
      if (!page || request !== generation || ended || !resolveTailFromSocket) return;
      batch(() => {
        followNextTail = false;
        tail = page;
        tailCurrent = true;
        show(page);
        setLive(page.live);
        setStatus("ready");
      });
    } catch {
      if (request === generation && !ended && resolveTailFromSocket) setStatus("error");
    } finally {
      if (request === generation) finishTailRead();
    }
  };

  const openAround = async (id: string) => {
    const request = ++generation;
    finishTailRead();
    followNextTail = false;
    openingAround = true;
    setFlash(undefined);
    if (ended) return;
    setStatus("loading");
    try {
      const page = await read({ around: id });
      if (request !== generation || ended) return;
      openingAround = false;
      batch(() => {
        const merged = page.hasAfter ? page : reconcileTail(page, page.live);
        show(merged.items.some((item) => item.id === id) ? merged : page);
        if (page.hasAfter && !receivedSnapshot) setLive(page.live);
        setFlash({ id });
        setStatus("ready");
      });
    } catch (error) {
      if (request !== generation || ended) return;
      openingAround = false;
      if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
        const fallback = openTail();
        const fallbackGeneration = generation;
        await fallback;
        if (generation === fallbackGeneration && !ended && tail) setStatus("not-found");
      } else {
        setStatus("error");
      }
    }
  };

  const load = async (direction: "before" | "after") => {
    const request = generation;
    const before = direction === "before";
    const current = view();
    const anchor = (before ? current.items[0] : current.items.at(-1))?.id;
    if (ended || openingAround || !anchor || paging[direction] === request ||
      !(before ? current.hasBefore : current.hasAfter)) return;
    paging[direction] = request;
    try {
      const page = await read({ [direction]: anchor });
      if (request !== generation || ended) return;
      const latest = view();
      if ((before ? latest.items[0] : latest.items.at(-1))?.id !== anchor) return;
      batch(() => {
        let combined = {
          ...latest,
          items: before ? upsert(page.items, latest.items) : upsert(latest.items, page.items),
          hasBefore: before ? page.hasBefore : latest.hasBefore,
          hasAfter: before ? latest.hasAfter : page.hasAfter,
        };
        if (!before && !page.hasAfter) combined = reconcileTail(combined, page.live);
        show(combined, direction);
        setStatus("ready");
      });
    } catch {
      if (request === generation && !ended) setStatus("error");
    } finally {
      if (paging[direction] === request) paging[direction] = -1;
    }
  };

  const onFrame = (frame: WsFeedMessage) => {
    if (ended) return;
    if (frame.type === "feed_end") {
      ended = true;
      finishTailRead();
      batch(() => {
        setLive(null);
        setStatus("error");
      });
      return;
    }

    let items = frame.type === "feed_snapshot" ? frame.items : upsert(tail?.items ?? [], frame.upsert);
    if (frame.type === "feed_delta" && frame.dropBefore) {
      const index = items.findIndex(({ id }) => id === frame.dropBefore);
      if (index >= 0) items = items.slice(index);
    }
    tailCurrent = true;
    tail = { items, hasBefore: frame.hasBefore, hasAfter: false, live: frame.live };
    if (frame.type === "feed_snapshot") receivedSnapshot = true;

    batch(() => {
      setLive(frame.live);
      if (followNextTail) {
        followNextTail = false;
        finishTailRead();
        show(tail!);
        setStatus("ready");
        return;
      }
      if (!openingAround && (status() === "loading" || (status() === "error" && !view().items.length))) {
        setStatus("ready");
      }
      if (view().hasAfter) {
        if (!baseline) {
          baseline = new Set(items.map(({ id }) => id));
        } else {
          for (const item of frame.type === "feed_snapshot" ? frame.items : frame.upsert) {
            if ((item.role === "user" || item.role === "assistant") && !baseline.has(item.id)) arrivals.add(item.id);
          }
          setNewCount(arrivals.size);
        }
      } else if (!openingAround) {
        const current = view();
        if (frame.type === "feed_delta" && !frame.upsert.length && (current.hasBefore || !frame.hasBefore)) return;
        show(frame.type === "feed_snapshot" ? mergeSnapshot(current, tail!) : {
          ...current, items: upsert(current.items, frame.upsert),
          hasBefore: current.hasBefore || frame.hasBefore,
        });
      }
    });
  };

  return {
    items: () => view().items,
    hasBefore: () => view().hasBefore,
    hasAfter: () => view().hasAfter,
    detached: () => view().hasAfter,
    live,
    status,
    flash,
    newCount,
    openTail,
    openAround,
    jumpToLatest: openTail,
    loadBefore: () => load("before"),
    loadAfter: () => load("after"),
    onFrame,
    disconnected: () => { tailCurrent = false; },
    dispose: () => {
      ended = true;
      finishTailRead();
    },
  };
}
