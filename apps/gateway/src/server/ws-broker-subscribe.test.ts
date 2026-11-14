import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { AgentEventBus } from "@yoplai/shared";
import type { ExtensionRuntime } from "../extensions/runtime.js";

const remote = vi.hoisted(() => ({ url: "" }));
vi.mock("../config/index.js", () => ({
  getAgent: (id: string) => (id === "alpha" ? { id } : undefined),
  isAgentActive: () => true,
}));
vi.mock("../agents/index.js", () => ({
  runAgent: vi.fn(), agentEventBus: new AgentEventBus(), isStreaming: () => false, getSessionCurrentTurn: () => null,
}));
vi.mock("../sessions/index.js", () => ({ getSessionEntry: vi.fn() }));
vi.mock("./run-request.js", () => ({ normalizeRunRequest: vi.fn() }));
vi.mock("../relay/state.js", () => ({
  getLinkedGateways: () => [{ name: "ams", url: remote.url }],
  isTrustedRequest: () => true,
  resolveRemoteAgent: (agentId: string) =>
    agentId.endsWith("@ams") ? { agentId: agentId.slice(0, -4), gateway: "ams" } : { agentId },
}));

describe("session subscription replacement", () => {
  it("does not restore a local subscribe that a remote subscribe replaced while it waited for authorization", async () => {
    const { WsBroker } = await import("./ws-broker.js");
    const remoteServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => remoteServer.once("listening", () => resolve()));
    remote.url = `http://127.0.0.1:${(remoteServer.address() as AddressInfo).port}`;
    const remoteSawSubscribe = new Promise<void>((resolve) =>
      remoteServer.on("connection", (socket) => socket.on("message", () => resolve()))
    );
    const server = createServer();
    const broker = new WsBroker();
    let grant!: () => void;
    const granted = new Promise<boolean>((resolve) => { grant = () => resolve(true); });
    broker.attach(server, {
      isMultiUserEnabled: () => false,
      validateWebSocketRequest: async () => null,
      canAccessAgent: () => granted,
      getExtensionRuntime: () => ({} as ExtensionRuntime),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    try {
      await new Promise<void>((resolve) => ws.once("open", resolve));
      ws.send(JSON.stringify({ type: "subscribe", agentId: "alpha", sessionKey: "main" }));
      ws.send(JSON.stringify({ type: "subscribe", agentId: "pom@ams", sessionKey: "main" }));
      await remoteSawSubscribe;
      grant();
      await new Promise<void>((resolve) => { ws.once("pong", resolve); ws.ping(); });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const subscriptions = (broker as unknown as { subscriptions: Map<unknown, unknown> }).subscriptions;
      expect(subscriptions.size).toBe(0);
    } finally {
      ws.close();
      broker.close();
      remoteServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
