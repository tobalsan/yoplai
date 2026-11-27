import type { FeedWindow, WsFeedMessage } from "@yoplai/shared/types";

/** Refreshes a thread tail through HTTP when its owner subscription reports activity. */
export function watchThreadFeed(
  agentId: string,
  read: () => Promise<FeedWindow>,
  onFrame: (frame: WsFeedMessage) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  let disposed = false;
  let sequence = 0;
  let failures = 0;

  async function refreshNow() {
    timer = undefined;
    if (disposed || running) return;
    running = true;
    pending = false;
    try {
      const page = await read();
      failures = 0;
      if (!disposed) onFrame({
        type: "feed_snapshot", agentId, seq: ++sequence,
        items: page.items, hasBefore: page.hasBefore, live: page.live,
      });
    } catch {
      // A failed settlement read has no later activity to wake the client.
      if (!disposed && !pending && ++failures <= 3) {
        timer = setTimeout(() => void refreshNow(), 250 * failures);
      }
    }
    finally {
      running = false;
      if (pending && !disposed) schedule(false);
    }
  }

  function schedule(immediate: boolean) {
    if (disposed) return;
    pending = true;
    failures = 0;
    if (running) return;
    if (immediate) {
      clearTimeout(timer);
      void refreshNow();
    } else {
      timer ??= setTimeout(() => void refreshNow(), 250);
    }
  }

  const refreshOnFocus = () => schedule(true);
  window.addEventListener("focus", refreshOnFocus);
  return {
    refresh: schedule,
    stop() {
      disposed = true;
      window.removeEventListener("focus", refreshOnFocus);
      clearTimeout(timer);
    },
  };
}
