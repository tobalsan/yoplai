// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { OAUTH_FLOW_TIMEOUT_MS, OAUTH_POLL_INTERVAL_MS, OAUTH_PREPARE_TIMEOUT_MS, createOAuthPopupFlow, type OAuthFlowRequest } from "./oauth-popup-flow";
import { createFakePopup } from "../remote-gateway.fixture";

type Snapshot = { connected: boolean; at?: number };

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function setup(overrides: Partial<OAuthFlowRequest<Snapshot>> = {}) {
  const popup = createFakePopup();
  const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  let current: Snapshot = { connected: false };
  const onConnected = vi.fn();
  const request: OAuthFlowRequest<Snapshot> = {
    read: vi.fn(async () => current),
    start: vi.fn(async () => "https://provider.example.test/authorize?state=abc"),
    verdict: (before, now) => (now.connected && (!before.connected || now.at !== before.at) ? "connected" : "pending"),
    canProve: (before) => !before.connected || before.at !== undefined,
    onConnected,
    ...overrides,
  };
  let flow!: ReturnType<typeof createOAuthPopupFlow>;
  const dispose = createRoot((disposeRoot) => { flow = createOAuthPopupFlow(); return disposeRoot; });
  return { popup, open, request, onConnected, flow, dispose, setStatus: (next: Snapshot) => { current = next; } };
}

describe("OAuth popup flow", () => {
  it("opens the blank window in the click, before any asynchronous work", () => {
    const { open, request, flow } = setup();
    void flow.begin(request);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe("");
    // The first status read and the start request run after the window exists.
    expect(open.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(request.read).mock.invocationCallOrder[0]);
    expect(request.start).not.toHaveBeenCalled();
  });

  it("shows a blocked popup and starts no grant", async () => {
    const { open, request, flow } = setup();
    open.mockReturnValue(null);
    const state = await flow.begin(request);
    expect(state).toMatchObject({ phase: "failed", reason: "popup_blocked" });
    expect(request.read).not.toHaveBeenCalled();
    expect(request.start).not.toHaveBeenCalled();
  });

  it("navigates the popup to the provider URL and finishes on fresh connected status", async () => {
    const { popup, request, flow, onConnected, setStatus } = setup();
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.location.href).toBe("https://provider.example.test/authorize?state=abc");
    expect(flow.state()).toEqual({ phase: "waiting" });
    setStatus({ connected: true, at: 1 });
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    expect(await done).toEqual({ phase: "connected" });
    expect(popup.closed).toBe(true);
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it("does not take an old connection as a new grant when the status has a connection time", async () => {
    const { popup, request, flow, onConnected, setStatus } = setup();
    setStatus({ connected: true, at: 1 });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS * 3);
    expect(onConnected).not.toHaveBeenCalled();
    setStatus({ connected: true, at: 2 });
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    expect(await done).toEqual({ phase: "connected" });
    expect(popup.closed).toBe(true);
  });

  it("reports an unconfirmed reconnect when the status cannot tell an old grant from a new one", async () => {
    const { popup, request, flow, setStatus } = setup();
    setStatus({ connected: true });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    expect(await done).toMatchObject({ phase: "failed", reason: "unconfirmed" });
  });

  it("treats a closed window as a failure after one more status read, never as success", async () => {
    const { popup, request, flow } = setup();
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(0);
    const reads = vi.mocked(request.read).mock.calls.length;
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    expect(await done).toMatchObject({ phase: "failed", reason: "closed" });
    expect(vi.mocked(request.read).mock.calls.length).toBeGreaterThan(reads);
  });

  it("counts a grant that finished at the moment of closure", async () => {
    const { popup, request, flow, setStatus } = setup();
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    setStatus({ connected: true, at: 5 });
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    expect(await done).toEqual({ phase: "connected" });
  });

  it("times out after the flow limit and closes the popup", async () => {
    const { popup, request, flow } = setup();
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS + OAUTH_POLL_INTERVAL_MS * 2);
    expect(await done).toMatchObject({ phase: "failed", reason: "timed_out" });
    expect(popup.closed).toBe(true);
  });

  it("shows a denied grant when the new connection lacks the required access", async () => {
    const { popup, request, flow, setStatus } = setup({ verdict: (_before, now) => (now.connected ? "denied" : "pending") });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(0);
    setStatus({ connected: true, at: 1 });
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    expect(await done).toMatchObject({ phase: "failed", reason: "denied" });
    expect(popup.closed).toBe(true);
  });

  it("shows a start failure with its message and closes the blank popup", async () => {
    const { popup, request, flow } = setup({ start: vi.fn(async () => { throw new Error("The remote gateway refused this action."); }) });
    const state = await flow.begin(request);
    expect(state).toEqual({ phase: "failed", reason: "start_failed", message: "The remote gateway refused this action." });
    expect(popup.closed).toBe(true);
  });

  it("stops a start call that ignores its signal at the deadline", async () => {
    const { popup, request, flow } = setup({ start: vi.fn(() => new Promise<string>(() => undefined)) });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(OAUTH_PREPARE_TIMEOUT_MS + 1);
    expect(await done).toMatchObject({ phase: "failed", reason: "start_failed" });
    expect(popup.closed).toBe(true);
  });

  it("fails before the start when the first status read fails", async () => {
    const { popup, request, flow } = setup({ read: vi.fn(async () => { throw new Error("offline"); }) });
    expect(await flow.begin(request)).toMatchObject({ phase: "failed", reason: "status_failed" });
    expect(request.start).not.toHaveBeenCalled();
    expect(popup.closed).toBe(true);
  });

  it("fails after repeated status failures during the wait", async () => {
    let calls = 0;
    const { request, flow } = setup({ read: vi.fn(async () => { calls += 1; if (calls > 1) throw new Error("offline"); return { connected: false }; }) });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS * 4);
    expect(await done).toMatchObject({ phase: "failed", reason: "status_failed" });
  });

  it("refuses a provider address that is not a web address", async () => {
    const { popup, request, flow } = setup({ start: vi.fn(async () => "javascript:alert(1)") });
    expect(await flow.begin(request)).toMatchObject({ phase: "failed", reason: "start_failed" });
    expect(popup.location.href).toBe("");
    expect(popup.closed).toBe(true);
  });

  it("closes the popup and starts no grant when the remote needs no authorization", async () => {
    const { popup, request, flow } = setup({ start: vi.fn(async () => undefined) });
    expect(await flow.begin(request)).toEqual({ phase: "idle" });
    expect(popup.location.href).toBe("");
    expect(popup.closed).toBe(true);
  });

  it("lets a newer flow end the older one, which then changes nothing", async () => {
    const first = setup();
    const second = createFakePopup();
    const done = first.flow.begin(first.request);
    await vi.advanceTimersByTimeAsync(0);
    first.open.mockReturnValue(second as unknown as Window);
    const secondRequest = { ...first.request, onConnected: vi.fn() };
    const secondDone = first.flow.begin(secondRequest);
    first.setStatus({ connected: true, at: 9 });
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    await secondDone;
    await done;
    expect(first.popup.closed).toBe(true);
    expect(first.onConnected).not.toHaveBeenCalled();
    expect(secondRequest.onConnected).toHaveBeenCalledTimes(1);
  });

  it("ends the flow and closes the popup on cancel and on disposal", async () => {
    const one = setup();
    const done = one.flow.begin(one.request);
    await vi.advanceTimersByTimeAsync(0);
    one.flow.cancel();
    expect(one.popup.closed).toBe(true);
    expect(one.flow.state()).toEqual({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS * 2);
    await done;
    expect(one.onConnected).not.toHaveBeenCalled();
    const two = setup();
    void two.flow.begin(two.request);
    await vi.advanceTimersByTimeAsync(0);
    two.dispose();
    expect(two.popup.closed).toBe(true);
  });

  it("trusts no message from any window", async () => {
    const { request, flow, onConnected } = setup();
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "yoplai-oauth", status: "connected" }, origin: "https://elsewhere.example.test" }));
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    expect(onConnected).not.toHaveBeenCalled();
    flow.cancel();
    await done;
  });

  it("counts the baseline read and the start request in the total budget from the click", async () => {
    let first = true;
    const { flow, request, popup } = setup({
      read: async () => {
        if (first) { first = false; await new Promise((resolve) => setTimeout(resolve, 20_000)); }
        return { connected: false };
      },
      start: async () => { await new Promise((resolve) => setTimeout(resolve, 20_000)); return "https://provider.example.test/authorize"; },
    });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS + 1);
    expect(await done).toMatchObject({ phase: "failed", reason: "timed_out" });
    expect(popup.closed).toBe(true);
  });

  it("never reports success for a poll that finishes after the budget", async () => {
    const started = Date.now();
    let polls = 0;
    const { flow, request, popup, onConnected } = setup({
      read: async () => {
        polls += 1;
        if (polls === 1) return { connected: false };
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        // The grant finishes only at the end of the budget, so the answer comes too late.
        return { connected: Date.now() - started >= OAUTH_FLOW_TIMEOUT_MS, at: 7 };
      },
    });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(OAUTH_FLOW_TIMEOUT_MS + 30_000);
    expect(await done).toMatchObject({ phase: "failed", reason: "timed_out" });
    expect(onConnected).not.toHaveBeenCalled();
    expect(popup.closed).toBe(true);
  });

  it("does not report success for a poll that answers after the deadline, and a cancel still ends the flow", async () => {
    let release: (() => void) | undefined;
    let polls = 0;
    const { flow, request, onConnected } = setup({
      read: () => {
        polls += 1;
        if (polls === 1) return Promise.resolve({ connected: false });
        return new Promise<Snapshot>((resolve) => { release = () => resolve({ connected: true, at: 3 }); });
      },
    });
    const done = flow.begin(request);
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS + 1);
    flow.cancel();
    release?.();
    await vi.advanceTimersByTimeAsync(OAUTH_POLL_INTERVAL_MS);
    await done;
    expect(onConnected).not.toHaveBeenCalled();
    expect(flow.state()).toEqual({ phase: "idle" });
  });
});
