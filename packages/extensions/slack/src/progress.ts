import type { SlackWebClient } from "./types.js";
import type { SlackProgressStore } from "./progress-store.js";

const HEARTBEAT_MS = 30_000;
const UPDATE_MS = 1_000;

function safeMilestone(label: string): string {
  const normalized = label.toLowerCase();
  if (/test/.test(normalized)) return "Running tests…";
  if (/review/.test(normalized)) return "Reviewing changes…";
  if (/implement|edit|code|build/.test(normalized)) return "Implementing changes…";
  if (/investigat|debug|diagnos/.test(normalized)) return "Investigating…";
  if (/check|inspect|read/.test(normalized)) return "Checking progress…";
  if (/wait/.test(normalized)) return "Waiting…";
  return "Progress updated.";
}

export type SlackProgressDisplay = {
  publish: () => Promise<void>;
  milestone: (label: string) => void;
  finish: (state: "completed" | "failed" | "interrupted" | "waiting") => Promise<void>;
};

export function createSlackProgressDisplay(options: {
  client: SlackWebClient;
  channel: string;
  threadTs: string;
  logPrefix: string;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  store?: SlackProgressStore;
  owner?: string;
}): SlackProgressDisplay {
  const now = options.now ?? Date.now;
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
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
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
    if (closed) return;
    if (now() - lastVisibleAt < HEARTBEAT_MS) {
      scheduleHeartbeat();
      return;
    }
    latest = "Still working…";
    lastVisibleAt = now();
    void update();
    scheduleHeartbeat();
  };

  const scheduleHeartbeat = (): void => {
    if (closed || !ts) return;
    if (heartbeat) clearTimeoutFn(heartbeat);
    heartbeat = setTimeoutFn(tick, Math.max(0, HEARTBEAT_MS - (now() - lastVisibleAt)));
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
          scheduleHeartbeat();
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
      const safe = safeMilestone(label);
      if (closed) return;
      latest = safe;
      lastVisibleAt = now();
      scheduleHeartbeat();
      void update();
    },
    async finish(state) {
      if (closed) return;
      closed = true;
      terminalRequested = true;
      if (heartbeat) clearTimeoutFn(heartbeat);
      if (retry) {
        clearTimeoutFn(retry);
        retry = undefined;
      }
      const text =
        state === "completed"
          ? "Completed."
          : state === "interrupted"
            ? "Interrupted."
            : state === "waiting"
              ? "Waiting for current work."
              : "Failed.";
      latest = text;
      await update(true);
    },
  };
}
