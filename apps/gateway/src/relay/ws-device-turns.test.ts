import { afterEach, expect, it, vi } from "vitest";
type Socket = { sent: Array<Record<string, unknown>>; emit(event: string, ...args: unknown[]): boolean; readyState: number };
const state = vi.hoisted(() => ({ sockets: [] as Socket[], generation: "remote-1" }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class WebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: Array<Record<string, unknown>> = [];
    constructor() { super(); state.sockets.push(this); }
    send(raw: string) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; this.emit("close"); }
  }
  return { WebSocket };
});
vi.mock("../config/index.js", () => ({ getAgent: () => undefined }));
vi.mock("./state.js", () => ({
  isTrustedRequest: () => true, isRelayEnabled: () => true,
  getLinkedGateways: () => [{ name: "remote", url: "http://synthetic.invalid", generation: state.generation }],
  resolveRemoteAgent: () => ({ agentId: "pom", gateway: "remote" }),
}));
vi.mock("./remote.js", () => ({ remoteWsUrl: () => "ws://synthetic.invalid", remoteWsHeaders: () => ({}) }));
import { RelayWsBridge } from "./ws.js";
import { getDeviceTurns, TURN_TOKEN_TTL_MS } from "./device-turns.js";
afterEach(() => { vi.useRealTimers(); state.sockets.length = 0; state.generation = "remote-1"; });

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
