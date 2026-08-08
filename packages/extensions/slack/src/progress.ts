import type { SlackWebClient } from "./types.js";
import type { SlackProgressStore } from "./progress-store.js";

const HEARTBEAT_MS = 30_000;
const UPDATE_MS = 1_000;

export type SlackProgressDisplay = {
  publish: () => Promise<void>;
  milestone: (label: string) => void;
  finish: (state: "completed" | "failed" | "interrupted") => Promise<void>;
};

export function createSlackProgressDisplay(options: {
  client: SlackWebClient;
  channel: string;
  threadTs: string;
  logPrefix: string;
  now?: () => number;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  store?: SlackProgressStore;
  owner?: string;
}): SlackProgressDisplay {
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  const clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  const setTimeoutFn = options.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  let ts: string | undefined;
  let latest = "Working on it…";
  let lastVisibleAt = now();
  let lastUpdateAt = 0;
  let pending = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let terminalRequested = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let publishRetry: ReturnType<typeof setTimeout> | undefined;

  const touch = (): void => {
    if (!ts) return;
    void options.store?.touch(ts, now()).catch((error) =>
      console.debug(`${options.logPrefix} Progress activity persistence failed:`, error)
    );
  };

  const update = async (terminal = false): Promise<void> => {
    if (!ts) return;
    if (pending) {
      if (terminal) terminalRequested = true;
      return;
    }
    if (!terminal && now() - lastUpdateAt < UPDATE_MS) {
      if (!retry) retry = setTimeoutFn(() => { retry = undefined; void update(); }, UPDATE_MS);
      return;
    }
    pending = true;
    const text = latest;
    touch();
    try {
      await options.client.chat.update({
        channel: options.channel,
        ts,
        text,
        mrkdwn: true,
      });
      lastUpdateAt = now();
      if (closed && text === latest && terminalRequested) {
        await options.store?.remove(ts).catch((error) =>
          console.debug(`${options.logPrefix} Progress removal failed:`, error)
        );
      }
    } catch (error) {
      console.debug(`${options.logPrefix} Progress update failed:`, error);
      if (!retry) {
        retry = setTimeoutFn(() => {
          retry = undefined;
          void update(closed);
        }, UPDATE_MS);
      }
    } finally {
      pending = false;
      if (terminalRequested && text !== latest) void update(true);
      else if (!closed && text !== latest) void update();
    }
  };

  const tick = (): void => {
    if (closed || now() - lastVisibleAt < HEARTBEAT_MS) return;
    latest = "Still working…";
    lastVisibleAt = now();
    void update();
  };

  return {
    async publish() {
      if (ts) return;
      try {
        const result = await options.client.chat.postMessage({
          channel: options.channel,
          thread_ts: options.threadTs,
          text: latest,
          mrkdwn: true,
        });
        ts = result.ts;
        if (ts) {
          heartbeat = setIntervalFn(tick, HEARTBEAT_MS);
          await options.store?.add({
            owner: options.owner ?? options.logPrefix,
            channel: options.channel,
            ts,
            updatedAt: now(),
          });
          if (closed) await update(true);
        }
      } catch (error) {
        console.debug(
          `${options.logPrefix} Progress message post failed:`,
          error
        );
        if (!publishRetry) {
          publishRetry = setTimeoutFn(() => {
            publishRetry = undefined;
            void this.publish();
          }, UPDATE_MS);
        }
      }
    },
    milestone(label) {
      if (closed || !label.trim()) return;
      latest = "Progress updated.";
      lastVisibleAt = now();
      void update();
    },
    async finish(state) {
      if (closed) return;
      closed = true;
      terminalRequested = true;
      if (heartbeat) clearIntervalFn(heartbeat);
      if (retry) {
        clearTimeoutFn(retry);
        retry = undefined;
      }
      const text =
        state === "completed"
          ? "Completed."
          : state === "interrupted"
            ? "Interrupted."
            : "Failed.";
      latest = text;
      await update(true);
    },
  };
}
