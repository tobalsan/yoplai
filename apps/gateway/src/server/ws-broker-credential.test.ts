import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventBus, DEVICE_OFFLINE_CALL_TEXT, DEVICE_PROTOCOL_VERSION } from "@yoplai/shared";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { getDeviceRegistry, resetDeviceRegistry } from "../relay/device-registry.js";
import { waitFor } from "../relay/device-test-server.js";

const { runAgent } = vi.hoisted(() => ({ runAgent: vi.fn() }));
vi.mock("../config/index.js", () => ({ getAgent: () => ({ id: "alpha" }), isAgentActive: () => true }));
vi.mock("../agents/index.js", () => ({
  runAgent, agentEventBus: new AgentEventBus(), isStreaming: () => false, getSessionCurrentTurn: () => null,
}));
vi.mock("../sessions/index.js", () => ({ getSessionEntry: vi.fn() }));
vi.mock("./run-request.js", () => ({ normalizeRunRequest: async (params: unknown) => ({ type: "run", params }) }));

/** A key that the remote can revoke at any time. The tests flip `keyActive` the way a revoke would. */
let keyActive: boolean;
let server: Server;
let broker: InstanceType<typeof import("./ws-broker.js").WsBroker>;
let port: number;
const sockets: WebSocket[] = [];

const bearerContext = { user: { id: "user-1" }, session: { id: "apikey:key-1", userId: "user-1" } };
const cookieContext = { user: { id: "user-1" }, session: { id: "session-1", userId: "user-1" } };

async function start(context: object, recheckMs = 30) {
  const { WsBroker } = await import("./ws-broker.js");
  server = createServer();
  broker = new WsBroker({ recheckMs });
  broker.attach(server, {
    isMultiUserEnabled: () => true,
    validateWebSocketRequest: async () => context as never,
    canAccessAgent: async () => true,
    getExtensionRuntime: () => ({} as ExtensionRuntime),
    isAuthContextActive: (authContext) => !authContext.session.id.startsWith("apikey:") || keyActive,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
}

function open(pathname: "/ws" | "/ws/device"): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

const closeCode = (ws: WebSocket) => new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));

beforeEach(() => {
  keyActive = true;
  resetDeviceRegistry();
  runAgent.mockReset();
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  broker.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("chat socket of a key", () => {
  it("closes an idle socket after the key stops", async () => {
    await start(bearerContext);
    const ws = await open("/ws");
    const closed = closeCode(ws);
    keyActive = false;
    expect(await closed).toBe(1008);
  });

  it("closes at the next client action and runs nothing", async () => {
    // A slow timer shows that the action itself checks the key.
    await start(bearerContext, 60_000);
    const ws = await open("/ws");
    keyActive = false;
    const closed = closeCode(ws);
    ws.send(JSON.stringify({ type: "send", agentId: "alpha", message: "hello" }));
    expect(await closed).toBe(1008);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("keeps a cookie session open whatever the key state is", async () => {
    await start(cookieContext);
    const ws = await open("/ws");
    keyActive = false;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("device socket of a key", () => {
  async function hello(ws: WebSocket) {
    ws.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION, deviceName: "laptop" }));
    await waitFor(() => getDeviceRegistry().has("user-1"));
  }

  it("fails a call and closes the socket after the key stops", async () => {
    await start(bearerContext);
    const ws = await open("/ws/device");
    await hello(ws);
    const closed = closeCode(ws);
    // A call that waits for a result fails when the socket closes.
    const pending = getDeviceRegistry().call("user-1", { tool: "device_read", args: {} } as never);
    const settled = pending.then(() => "result", (error: Error) => error.message);
    keyActive = false;
    expect(await closed).toBe(1008);
    expect(await settled).toContain(DEVICE_OFFLINE_CALL_TEXT);
    await waitFor(() => !getDeviceRegistry().has("user-1"));
    await expect(getDeviceRegistry().call("user-1", { tool: "device_read", args: {} } as never)).rejects.toThrow(DEVICE_OFFLINE_CALL_TEXT);
  });

  it("closes an idle device socket after the key stops", async () => {
    await start(bearerContext);
    const ws = await open("/ws/device");
    await hello(ws);
    keyActive = false;
    expect(await closeCode(ws)).toBe(1008);
  });

  it("keeps a device socket of an active key online", async () => {
    await start(bearerContext);
    const ws = await open("/ws/device");
    await hello(ws);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(getDeviceRegistry().has("user-1")).toBe(true);
  });
});
