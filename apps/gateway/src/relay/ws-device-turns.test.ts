import { afterEach, expect, it, vi } from "vitest";
import { DEVICE_PROTOCOL_VERSION } from "@yoplai/shared";
import type { DeviceExecutor } from "./device-exec.js";
type Socket = { sent: Array<Record<string, unknown>>; emit(event: string, ...args: unknown[]): boolean; readyState: number };
const state = vi.hoisted(() => ({ sockets: [] as Socket[], generation: "remote-1", enabled: true }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class WebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    constructor() { super(); state.sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { this.close(); }
  }
  return { WebSocket };
});
vi.mock("../config/index.js", () => ({ getAgent: () => undefined }));
vi.mock("./state.js", () => ({
  isTrustedRequest: () => true, isRelayEnabled: () => state.enabled,
  getLinkedGateways: () => state.enabled ? [{ name: "remote", url: "http://synthetic.invalid", generation: state.generation }] : [],
  resolveRemoteAgent: (agentId: string) => agentId === "pom@remote"
    ? { agentId: "pom", gateway: "remote" }
    : { agentId },
}));
vi.mock("./remote.js", () => ({
  remoteDeviceUrl: () => "ws://synthetic.invalid/device",
  remoteWsUrl: () => "ws://synthetic.invalid",
  remoteWsHeaders: () => ({}),
}));
import { DeviceLinkManager } from "./device-link-client.js";
import { RelayWsBridge } from "./ws.js";
import { getDeviceTurns, TURN_TOKEN_TTL_MS } from "./device-turns.js";
import { getLinkedGateways, isRelayEnabled } from "./state.js";
afterEach(() => { vi.useRealTimers(); state.sockets.length = 0; state.generation = "remote-1"; state.enabled = true; });

it("relays a linked agent's feed without replacing the session subscription", () => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const dropLocalSession = vi.fn();
  const bridge = new RelayWsBridge(page as never, {}, dropLocalSession);
  try {
    const session = { type: "subscribe", agentId: "pom@remote", sessionId: "durable-main" };
    const feed = { type: "subscribeFeed", agentId: "pom@remote", limit: 30 };
    const unsubscribe = { type: "unsubscribeFeed" };
    expect(bridge.handle(JSON.stringify({ ...feed, agentId: "cedar" }))).toBe(false);
    expect(state.sockets.flatMap((socket) => socket.sent)).toEqual([]);
    expect(bridge.handle(JSON.stringify(session))).toBe(true);
    expect(bridge.handle(JSON.stringify(feed))).toBe(true);
    for (const socket of state.sockets) socket.emit("open");
    expect(state.sockets.flatMap((socket) => socket.sent)).toEqual(expect.arrayContaining([
      { ...session, agentId: "pom" },
      { ...feed, agentId: "pom" },
    ]));
    expect(dropLocalSession).toHaveBeenCalledTimes(1);
    const upstream = state.sockets.find((socket) => socket.sent.some((frame) => frame.type === "subscribeFeed"))!;
    const snapshot = { type: "feed_snapshot", agentId: "pom", items: [], live: null };
    upstream.emit("message", Buffer.from(JSON.stringify(snapshot)));
    expect(page.send).toHaveBeenCalledWith(JSON.stringify({ ...snapshot, agentId: "pom@remote" }));
    expect(bridge.handle(JSON.stringify(unsubscribe))).toBe(false);
    expect(upstream.sent.at(-1)).toEqual(unsubscribe);
    expect(page.close).not.toHaveBeenCalled();
  } finally {
    bridge.close();
  }
});

it.each([
  ["still subscribed", undefined, true],
  ["unsubscribed", { type: "unsubscribeFeed" }, false],
  ["switched to local", { type: "subscribeFeed", agentId: "cedar" }, false],
  ["switched to a room", { type: "subscribeRoomFeed", roomId: "project" }, false],
] as const)("handles a feed-only link closing while %s", (_, switchTo, closesPage) => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  try {
    expect(bridge.handle(JSON.stringify({ type: "subscribeFeed", agentId: "pom@remote" }))).toBe(true);
    const upstream = state.sockets[0];
    upstream.emit("open");
    if (switchTo) {
      expect(bridge.handle(JSON.stringify(switchTo))).toBe(false);
      expect(upstream.sent.at(-1)).toEqual({ type: "unsubscribeFeed" });
    }
    upstream.emit("close");
    expect(page.close).toHaveBeenCalledTimes(closesPage ? 1 : 0);
  } finally {
    bridge.close();
  }
});

it("discards a pending subscription when the relay is disabled before open", () => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  try {
    expect(bridge.handle(JSON.stringify({ type: "subscribe", agentId: "pom@remote" }))).toBe(true);
    const socket = state.sockets[0];
    expect(socket.sent).toEqual([]);
    state.enabled = false;
    socket.emit("open");
    expect(socket.sent).toEqual([]);
  } finally {
    bridge.close();
  }
});

it("stops forwarding events and close notifications from an established subscription when disabled", () => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  try {
    bridge.handle(JSON.stringify({ type: "subscribe", agentId: "pom@remote" }));
    const socket = state.sockets[0];
    socket.emit("open");
    const event = JSON.stringify({ type: "text", data: "fixture" });
    socket.emit("message", Buffer.from(event));
    expect(page.send).toHaveBeenCalledWith(event);
    page.send.mockClear();
    state.enabled = false;
    socket.emit("message", Buffer.from(event));
    socket.emit("close");
    expect(page.send).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  } finally {
    bridge.close();
  }
});

it("stops dispatching calls on an established device link before reconciliation", () => {
  vi.useFakeTimers();
  const execute = vi.fn(async () => ({ content: [] }));
  const options = { executor: { execute } as unknown as DeviceExecutor, getGateways: getLinkedGateways, isRelayEnabled };
  const manager = new DeviceLinkManager(options);
  manager.start();
  try {
    const socket = state.sockets[0];
    socket.emit("open");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION })));
    expect(manager.states()[0]?.connected).toBe(true);
    const call = { type: "call", agentId: "pom", tool: "device_read", arguments: {}, toolCallId: "fixture" };
    socket.emit("message", Buffer.from(JSON.stringify({ ...call, callId: "before" })));
    expect(execute).toHaveBeenCalledTimes(1);
    state.enabled = false;
    socket.emit("message", Buffer.from(JSON.stringify({ ...call, callId: "after" })));
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    manager.stop();
  }
});

it("ends only the matching turn after an out-of-order error, queued marker, and duplicate terminal event", () => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  bridge.handle(JSON.stringify({ type: "send", agentId: "pom@remote", sessionId: "running-A", message: "hold" }));
  const remote = state.sockets[0]; remote.emit("open");
  bridge.handle(JSON.stringify({ type: "send", agentId: "pom@remote", sessionId: "rejected-B", message: null }));
  const rejected = state.sockets[1] ?? remote; rejected.emit("open");
  const a = remote.sent[0].deviceTurnToken as string;
  const b = rejected.sent.at(-1)!.deviceTurnToken as string;
  rejected.emit("message", Buffer.from(JSON.stringify({ type: "error", message: "Invalid message" })));
  rejected.emit("message", Buffer.from(JSON.stringify({ type: "done" })));
  expect(getDeviceTurns().find(a)?.chat).toBe("session:running-A");
  expect(getDeviceTurns().find(b)).toBeUndefined();
  remote.emit("message", Buffer.from(JSON.stringify({ type: "done", meta: { queued: true } })));
  expect(getDeviceTurns().find(a)).toBeDefined();
  remote.emit("message", Buffer.from(JSON.stringify({ type: "done" })));
  remote.emit("message", Buffer.from(JSON.stringify({ type: "error", message: "duplicate" })));
  expect(getDeviceTurns().find(a)).toBeUndefined();
  expect(page.send.mock.calls.map(call => JSON.parse(call[0]).type)).toEqual(["error", "done", "done"]);
  expect(JSON.stringify(page.send.mock.calls)).not.toContain(a);
  expect(JSON.stringify(page.send.mock.calls)).not.toContain(b);
  getDeviceTurns().end(b); bridge.close();
});

it("expires token records, keeps the chat stream, and refuses sends at the pending limit", () => {
  vi.useFakeTimers();
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  const send = () => bridge.handle(JSON.stringify({ type: "send", agentId: "pom@remote", message: "hold" }));
  for (let i = 0; i < 20; i++) send();
  send();
  expect(state.sockets).toHaveLength(20);
  expect(page.send).toHaveBeenCalledWith(expect.stringContaining("Too many pending device turns"));
  for (const socket of state.sockets) socket.emit("open");
  const tokens = state.sockets.map(socket => socket.sent[0].deviceTurnToken as string);
  vi.advanceTimersByTime(TURN_TOKEN_TTL_MS);
  expect(tokens.every(token => getDeviceTurns().find(token) === undefined)).toBe(true);
  state.sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "text", data: "Late answer" })));
  expect(page.send).toHaveBeenCalledWith(JSON.stringify({ type: "text", data: "Late answer" }));
  for (const socket of state.sockets) socket.emit("message", Buffer.from(JSON.stringify({ type: "done" })));
  expect(state.sockets.every(socket => socket.readyState === 3)).toBe(true);
  send();
  expect(state.sockets).toHaveLength(21);
  state.sockets[20].emit("open");
  getDeviceTurns().end(state.sockets[20].sent[0].deviceTurnToken as string);
  bridge.close();
});

it("keeps subscription events and cancellation completions separate from the active turn", () => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  bridge.handle(JSON.stringify({ type: "subscribe", agentId: "pom@remote", sessionKey: "main" }));
  const subscription = state.sockets[0]; subscription.emit("open");
  bridge.handle(JSON.stringify({ type: "send", agentId: "pom@remote", message: "hold" }));
  const active = state.sockets[1]; active.emit("open");
  const token = active.sent[0].deviceTurnToken as string;
  subscription.emit("message", Buffer.from(JSON.stringify({ type: "done" })));
  expect(getDeviceTurns().find(token)).toBeDefined();
  bridge.handle(JSON.stringify({ type: "send", agentId: "pom@remote", message: "/abort" }));
  const cancel = state.sockets[2]; cancel.emit("open");
  const cancelToken = cancel.sent[0].deviceTurnToken as string;
  cancel.emit("message", Buffer.from(JSON.stringify({ type: "done", meta: { aborted: true } })));
  expect(getDeviceTurns().find(token)).toBeDefined();
  expect(getDeviceTurns().find(cancelToken)).toBeUndefined();
  active.emit("message", Buffer.from(JSON.stringify({ type: "done", meta: { aborted: true } })));
  expect(getDeviceTurns().find(token)).toBeUndefined();
  expect(page.close).not.toHaveBeenCalled();
  bridge.close();
});

it("opens a new status link for a link that replaced the name, and ends the old one without closing the page", () => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  bridge.handle(JSON.stringify({ type: "subscribeStatus" }));
  const old = state.sockets[0]; old.emit("open");
  bridge.handle(JSON.stringify({ type: "subscribeStatus" }));
  expect(state.sockets).toHaveLength(1);
  expect(old.sent).toHaveLength(2);
  state.generation = "remote-2";
  bridge.handle(JSON.stringify({ type: "subscribeStatus" }));
  expect(old.readyState).toBe(3);
  expect(state.sockets).toHaveLength(2);
  state.sockets[1].emit("open");
  expect(state.sockets[1].sent).toEqual([{ type: "subscribeStatus" }]);
  expect(old.sent).toHaveLength(2);
  expect(page.close).not.toHaveBeenCalled();
  bridge.close();
});

it("tags a turn with the generation of the link that carried it", () => {
  const page = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const bridge = new RelayWsBridge(page as never, {}, () => {});
  bridge.handle(JSON.stringify({ type: "send", agentId: "pom@remote", message: "hold" }));
  state.sockets[0].emit("open");
  const token = state.sockets[0].sent[0].deviceTurnToken as string;
  expect(getDeviceTurns().find(token)).toMatchObject({ gateway: "remote", generation: "remote-1" });
  getDeviceTurns().end(token);
  bridge.close();
});
