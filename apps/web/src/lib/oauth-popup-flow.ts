import { createSignal, getOwner, onCleanup } from "solid-js";

const POPUP_FEATURES = "width=520,height=640";
/** Total time of one flow, from the click to the verdict. */
export const OAUTH_FLOW_TIMEOUT_MS = 5 * 60_000;
export const OAUTH_POLL_INTERVAL_MS = 2_000;
/** Time for the baseline read and for the start request. Each one has its own deadline. */
export const OAUTH_PREPARE_TIMEOUT_MS = 30_000;
const MAX_POLL_FAILURES = 3;

export type OAuthFlowFailure = "popup_blocked" | "start_failed" | "status_failed" | "closed" | "timed_out" | "denied" | "unconfirmed";

export type OAuthFlowState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "waiting" }
  | { phase: "connected" }
  | { phase: "failed"; reason: OAuthFlowFailure; message: string };

/** What the page reads from the remote after each poll. */
export type OAuthVerdict = "connected" | "denied" | "pending";

export type OAuthFlowRequest<Snapshot> = {
  /** Reads the remote status. A failed read must throw. */
  read: (signal: AbortSignal) => Promise<Snapshot>;
  /** Returns the provider URL. `undefined` means that the remote needs no authorization. */
  start: (signal: AbortSignal) => Promise<string | undefined>;
  /** Deadline of `start`. A slow call, such as an MCP add, can need more than the default. */
  startTimeoutMs?: number;
  /** Compares a fresh status with the status before the start. */
  verdict: (before: Snapshot, now: Snapshot) => OAuthVerdict;
  /** False when the status cannot tell a new grant from an old grant. */
  canProve: (before: Snapshot) => boolean;
  /** Runs once after a proven success. */
  onConnected: () => void | Promise<void>;
};

const MESSAGES: Record<OAuthFlowFailure, string> = {
  popup_blocked: "The browser blocked the sign-in window. Allow pop-ups for this page and try again.",
  start_failed: "Failed to start the connection.",
  status_failed: "Could not read the connection status. Check the gateway and try again.",
  closed: "The sign-in window closed before the connection finished.",
  timed_out: "The connection did not finish in time. Try again.",
  denied: "The provider did not grant the required access.",
  unconfirmed: "The gateway cannot confirm a new connection. Check the connection status.",
};

/** The deadline rejects even when `run` ignores its signal. */
function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, parent: AbortSignal, ms: number): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    const forward = () => controller.abort(parent.reason);
    const stop = () => reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
    parent.addEventListener("abort", forward, { once: true });
    controller.signal.addEventListener("abort", stop, { once: true });
    run(controller.signal).then(resolve, reject).finally(() => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forward);
    });
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

let flowCounter = 0;

/**
 * One sign-in flow at a time for one control. Call `begin` from the click
 * handler: it opens the blank popup before any asynchronous work. The flow
 * trusts no message from the popup. It decides only from fresh remote status
 * that it reads through the relay. A newer `begin`, `cancel`, or disposal ends
 * the older flow, and the older flow changes nothing after that.
 */
export function createOAuthPopupFlow() {
  const [state, setState] = createSignal<OAuthFlowState>({ phase: "idle" });
  let generation = 0;
  let abort: AbortController | undefined;
  let popup: Window | null = null;

  const closePopup = () => {
    try { popup?.close(); } catch { /* A closed or foreign window needs no cleanup. */ }
    popup = null;
  };
  const cancel = () => {
    generation++;
    abort?.abort();
    abort = undefined;
    closePopup();
    setState({ phase: "idle" });
  };
  if (getOwner()) onCleanup(() => { generation++; abort?.abort(); closePopup(); });

  async function begin<Snapshot>(request: OAuthFlowRequest<Snapshot>): Promise<OAuthFlowState> {
    // One budget runs from the click. The first read, the start, every pause, and every poll share it.
    const deadline = Date.now() + OAUTH_FLOW_TIMEOUT_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    cancel();
    const mine = generation;
    const current = () => mine === generation;
    const controller = new AbortController();
    abort = controller;
    flowCounter += 1;
    // The blank window opens inside the click event. Later steps only navigate it.
    const opened = window.open("", `yoplai-oauth-${flowCounter}`, POPUP_FEATURES);
    if (!opened) return finish({ phase: "failed", reason: "popup_blocked", message: MESSAGES.popup_blocked });
    popup = opened;
    setState({ phase: "preparing" });
    const fail = (reason: OAuthFlowFailure, message = MESSAGES[reason]): OAuthFlowState => {
      closePopup();
      return finish({ phase: "failed", reason, message });
    };
    function finish(next: OAuthFlowState): OAuthFlowState {
      if (current()) setState(next);
      return next;
    }
    let before: Snapshot;
    try {
      before = await withDeadline(request.read, controller.signal, Math.min(OAUTH_PREPARE_TIMEOUT_MS, remaining()));
    } catch {
      if (!current()) return state();
      return fail(remaining() === 0 ? "timed_out" : "status_failed");
    }
    if (!current()) return state();
    if (remaining() === 0) return fail("timed_out");
    let url: string | undefined;
    try {
      url = await withDeadline(request.start, controller.signal, Math.min(request.startTimeoutMs ?? OAUTH_PREPARE_TIMEOUT_MS, remaining()));
    } catch (cause) {
      if (!current()) return state();
      return remaining() === 0 ? fail("timed_out") : fail("start_failed", cause instanceof Error && cause.message ? cause.message : MESSAGES.start_failed);
    }
    if (!current()) return state();
    if (remaining() === 0) return fail("timed_out");
    if (url === undefined) {
      closePopup();
      return finish({ phase: "idle" });
    }
    try {
      // The relay checks the URL. The popup still opens only a web address.
      if (!["http:", "https:"].includes(new URL(url).protocol)) return fail("start_failed", "The remote gateway returned an unsafe authorization address.");
    } catch {
      return fail("start_failed", "The remote gateway returned an unusable authorization address.");
    }
    try {
      if (opened.closed) return fail("closed");
      opened.location.href = url;
    } catch {
      return fail("closed");
    }
    setState({ phase: "waiting" });
    let failures = 0;
    while (current()) {
      const closed = opened.closed;
      try {
        const now = await withDeadline((signal) => request.read(signal), controller.signal, Math.min(OAUTH_PREPARE_TIMEOUT_MS, remaining()));
        if (!current()) return state();
        // An answer that arrives after the budget ended must not report success.
        if (remaining() === 0) return fail(request.canProve(before) ? "timed_out" : "unconfirmed");
        failures = 0;
        const verdict = request.verdict(before, now);
        if (verdict === "connected") {
          closePopup();
          finish({ phase: "connected" });
          await request.onConnected();
          return state();
        }
        if (verdict === "denied") return fail("denied");
      } catch {
        if (!current()) return state();
        failures += 1;
        if (remaining() === 0) return fail(request.canProve(before) ? "timed_out" : "unconfirmed");
        if (failures >= MAX_POLL_FAILURES || closed) return fail("status_failed");
      }
      // The read above ran after the popup closed. Closure alone proves nothing.
      if (closed) return fail(request.canProve(before) ? "closed" : "unconfirmed");
      if (remaining() === 0) return fail(request.canProve(before) ? "timed_out" : "unconfirmed");
      await pause(Math.min(OAUTH_POLL_INTERVAL_MS, remaining()), controller.signal);
    }
    return state();
  }

  return { state, begin, cancel };
}
