import type { SlackWebClient } from "./types.js";
import type { SlackProgressStore } from "./progress-store.js";

const HEARTBEAT_MS = 30_000;
const UPDATE_MS = 1_000;
const MAX_MILESTONE_LENGTH = 100;
const PUBLISH_DELAY_MS = 30_000;

const unsafeMilestonePatterns = [
  /[\r\n\t]/,
  /\b(?:api[-_ ]?key|authorization|cookie|credential|password|private[-_ ]?key|secret|token)\b/i,
  /\b(?:gh[pousr]|sk|xox[baprs])[-_][a-z0-9_-]{8,}\b/i,
  /\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/i,
  /\b[A-Z][A-Z0-9_]{2,}\s*=/,
  /(?:https?|file|ssh):\/\//i,
  /(?:^|\s)(?:\/(?:Users|etc|home|private|tmp|var|workspace)\/|[A-Z]:\\)/i,
  /[`{}[\]<>|]/,
];

function genericMilestone(label: string): string {
  const normalized = label.toLowerCase();
  if (/test/.test(normalized)) return "Running tests…";
  if (/review/.test(normalized)) return "Reviewing changes…";
  if (/implement|edit|code|build/.test(normalized)) return "Implementing changes…";
  if (/investigat|debug|diagnos/.test(normalized)) return "Investigating…";
  if (/check|inspect|read/.test(normalized)) return "Checking progress…";
  if (/wait/.test(normalized)) return "Waiting…";
  return "Progress updated.";
}

function safeMilestone(label: string): string {
  const cleaned = label.replace(/\s+/g, " ").trim();
  const fallback = genericMilestone(cleaned);
  if (
    !cleaned ||
    cleaned.length > MAX_MILESTONE_LENGTH ||
    !/^[\p{L}\p{N}\s.,:;!?()'’&+\-–—]+$/u.test(cleaned) ||
    unsafeMilestonePatterns.some((pattern) => pattern.test(label))
  ) {
    return fallback;
  }
  return `${cleaned.replace(/[.!?…]+$/, "")}…`;
}

export type SlackProgressDisplay = {
  start: () => void;
  publish: () => Promise<void>;
  milestone: (label: string) => void;
  // Resolves true if a terminal Slack edit was made (a bubble existed),
  // false if nothing was ever posted.
  finish: (state: "completed" | "failed" | "interrupted" | "waiting") => Promise<boolean>;
};

export function createSlackProgressDisplay(options: {
  client: SlackWebClient;
  channel: string;
  threadTs?: string;
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
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let publishPromise: Promise<void> | undefined;

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

  // No `this` dependency: called from timer callbacks and from within
  // `publish` itself, so it must not rely on method-call binding.
  const doPublish = async (): Promise<void> => {
    try {
      const result = await options.client.chat.postMessage({
        channel: options.channel,
        thread_ts: options.threadTs,
        text: latest,
        mrkdwn: true,
      });
      ts = result.ts;
      if (ts) {
        // Reset the heartbeat clock to the post time, not construction time,
        // so the next heartbeat fires a full interval after the bubble
        // actually became visible rather than instantly.
        lastVisibleAt = now();
        scheduleHeartbeat();
        await options.store?.add({
          owner: options.owner ?? options.logPrefix,
          channel: options.channel,
          ts,
          updatedAt: now(),
        });
      }
    } catch (error) {
      console.debug(
        `${options.logPrefix} Progress message post failed:`,
        error
      );
      if (!publishRetry) {
        publishRetry = setTimeoutFn(() => {
          publishRetry = undefined;
          void publish();
        }, UPDATE_MS);
      }
    }
  };

  // Memoizes the in-flight publish so two callers within the same tick (e.g.
  // two rapid milestone() calls, or a milestone during a pending
  // publishRetry) share one postMessage/store.add instead of each posting
  // an orphaned bubble.
  const publish = (): Promise<void> => {
    if (ts || closed) return Promise.resolve();
    if (publishPromise) return publishPromise;
    publishPromise = doPublish().finally(() => {
      publishPromise = undefined;
    });
    return publishPromise;
  };

  return {
    start() {
      if (ts || closed || startTimer) return;
      startTimer = setTimeoutFn(() => {
        startTimer = undefined;
        void publish();
      }, PUBLISH_DELAY_MS);
    },
    publish,
    milestone(label) {
      const safe = safeMilestone(label);
      if (closed) return;
      if (!ts) {
        if (startTimer) {
          clearTimeoutFn(startTimer);
          startTimer = undefined;
        }
        latest = safe;
        lastVisibleAt = now();
        void publish();
        return;
      }
      latest = safe;
      lastVisibleAt = now();
      scheduleHeartbeat();
      void update();
    },
    async finish(state) {
      if (closed) return false;
      closed = true;
      terminalRequested = true;
      if (heartbeat) clearTimeoutFn(heartbeat);
      if (retry) {
        clearTimeoutFn(retry);
        retry = undefined;
      }
      if (startTimer) {
        clearTimeoutFn(startTimer);
        startTimer = undefined;
      }
      if (publishRetry) {
        clearTimeoutFn(publishRetry);
        publishRetry = undefined;
      }
      // A publish may already be in flight (e.g. the delayed start() timer
      // just fired, or a milestone triggered an immediate publish). Wait for
      // it to settle so we know whether a bubble exists before deciding
      // whether there's anything left to terminal-edit.
      if (publishPromise) await publishPromise;
      if (!ts) return false;
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
      return true;
    },
  };
}
