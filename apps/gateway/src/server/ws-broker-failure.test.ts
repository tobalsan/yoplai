import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { AgentEventBus, type StreamEvent } from "@yoplai/shared";
import type { ExtensionRuntime } from "../extensions/runtime.js";

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock("../config/index.js", () => ({ getAgent: () => ({ id: "alpha" }), isAgentActive: () => true }));
vi.mock("../agents/index.js", () => ({
  runAgent, agentEventBus: new AgentEventBus(), isStreaming: () => false, getSessionCurrentTurn: () => null,
}));
vi.mock("../sessions/index.js", () => ({ getSessionEntry: vi.fn() }));
vi.mock("./run-request.js", () => ({
  normalizeRunRequest: async (params: { onEvent: (event: StreamEvent) => void }) => ({ type: "run", params }),
}));

describe("websocket terminal failures", () => {
  it.each<[StreamEvent]>([
    [{ type: "error", message: "raw provider failure", kind: "rate_limit", userMessage: "safe notice" }],
    [{ type: "done", meta: { durationMs: 1, aborted: true } }],
  ])("does not send another error after $type followed by rejection", async (terminal) => {
    const { WsBroker } = await import("./ws-broker.js");
    const server = createServer();
    const broker = new WsBroker();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    runAgent.mockImplementationOnce(async (params: { onEvent: (event: StreamEvent) => void }) => {
      params.onEvent(terminal);
      settle();
      throw new Error("raw provider failure");
    });
    broker.attach(server, {
      isMultiUserEnabled: () => false,
      validateWebSocketRequest: async () => null,
      canAccessAgent: async () => true,
      getExtensionRuntime: () => ({} as ExtensionRuntime),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    const received: StreamEvent[] = [];
    ws.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    try {
      await new Promise<void>((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "send", agentId: "alpha", message: "request" }));
      await settled;
      // Pong follows the already queued terminal response and catch microtask.
      await new Promise<void>((resolve) => { ws.once("pong", resolve); ws.ping(); });
      expect(received.filter((event) => event.type === "error" || event.type === "done")).toEqual([terminal]);
    } finally {
      ws.close();
      broker.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
