import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: unknown[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
}

describe("session subscription for device approvals", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost" }, setTimeout, clearTimeout });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("subscribes for the agent, passes approval messages on, and sends an answer on the same socket", async () => {
    const { subscribeToSession } = await import("./realtime");
    const requests: unknown[] = [];
    const resolved: unknown[] = [];
    const subscription = subscribeToSession("pom@ams", "main", {
      onDeviceApprovalRequest: (request) => requests.push(request),
      onDeviceApprovalResolved: (message) => resolved.push(message),
    });
    const socket = FakeSocket.instances[0];
    expect(subscription.send({ type: "x" })).toBe(false);
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
    expect(socket.sent[0]).toEqual({ type: "subscribe", agentId: "pom@ams", sessionKey: "main" });

    const request = { type: "device_approval_request", approvalId: "a1", sessionId: "s1" };
    socket.onmessage?.({ data: JSON.stringify(request) });
    socket.onmessage?.({ data: JSON.stringify({ type: "device_approval_resolved", approvalId: "a1" }) });
    expect(requests).toEqual([request]);
    expect(resolved).toHaveLength(1);

    expect(subscription.send({ type: "device_approval_answer", approvalId: "a1", approve: true })).toBe(true);
    expect(socket.sent[1]).toEqual({ type: "device_approval_answer", approvalId: "a1", approve: true });
  });
});
