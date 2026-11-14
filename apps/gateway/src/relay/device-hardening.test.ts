import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventBus, DEVICE_PROTOCOL_VERSION } from "@yoplai/shared";
import { DeviceApprovals } from "./device-approvals.js";
import { DeviceExecutor } from "./device-exec.js";
import { DeviceLinkManager, MAX_ACTIVE_CALLS } from "./device-link-client.js";
import { DEVICE_MAX_MESSAGE_BYTES, getDeviceRegistry, resetDeviceRegistry } from "./device-registry.js";
import { startRemoteServer, waitFor } from "./device-test-server.js";
import { createFileDeviceSettingsStore, deviceChatKey, type DeviceSettingsStore } from "./device-settings.js";

vi.mock("../config/index.js", () => ({
  getAgent: (id: string) => (id === "alpha" ? { id } : undefined),
  isAgentActive: () => true,
}));
vi.mock("../agents/index.js", () => ({
  runAgent: vi.fn(), agentEventBus: new AgentEventBus(), isStreaming: () => false, getSessionCurrentTurn: () => null,
}));
vi.mock("../sessions/index.js", () => ({ getSessionEntry: vi.fn() }));
vi.mock("../server/run-request.js", () => ({ normalizeRunRequest: vi.fn() }));

type Json = Record<string, unknown>;

let dir: string;
let settings: DeviceSettingsStore;
let remote: Awaited<ReturnType<typeof startRemoteServer>>;
let manager: DeviceLinkManager | undefined;
const sockets: WebSocket[] = [];
const fakes: WebSocketServer[] = [];

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-hardening-")));
  settings = createFileDeviceSettingsStore(path.join(dir, "device-settings.json"));
  resetDeviceRegistry();
  remote = await startRemoteServer(false);
});
afterEach(async () => {
  manager?.stop();
  manager = undefined;
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const fake of fakes.splice(0)) fake.close();
  remote.broker.close();
  await new Promise<void>((resolve) => remote.server.close(() => resolve()));
  remote.server.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const deviceUrl = () => `ws://127.0.0.1:${remote.port}/ws/device`;

async function openDevice(): Promise<WebSocket> {
  const socket = new WebSocket(deviceUrl(), { headers: { authorization: "Bearer tok" } });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

/** A device that says hello and waits for calls. */
async function helloDevice(): Promise<{ socket: WebSocket; messages: Json[] }> {
  const socket = await openDevice();
  const messages: Json[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Json));
  socket.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION, deviceName: "t" }));
  await waitFor(() => messages.some((message) => message.type === "hello"));
  return { socket, messages };
}

const closed = (socket: WebSocket) => new Promise<number>((resolve) => socket.once("close", resolve));

function rawRequest(requestLine: string): Promise<string> {
  return new Promise((resolve) => {
    const client = net.connect(remote.port, "127.0.0.1", () => client.write(`${requestLine}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let data = "";
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\r\n")) client.destroy();
    });
    client.on("close", () => resolve(data));
    client.on("error", () => resolve(data));
  });
}

describe("gateway upgrade handler", () => {
  it("refuses a malformed URL with no exception, and keeps working", async () => {
    const uncaught: Error[] = [];
    const listener = (error: Error) => uncaught.push(error);
    process.on("uncaughtException", listener);
    try {
      const response = await rawRequest("GET http://[ HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==");
      expect(response).toMatch(/400|^$/);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("uncaughtException", listener);
    }
    expect(uncaught).toEqual([]);
    await openDevice();
  });

  it("keeps the exact path rule: a dot segment does not reach /ws", async () => {
    const upgrade = "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==";
    expect(await rawRequest(`GET /x/../ws HTTP/1.1${upgrade}`)).toMatch(/^HTTP\/1.1 400/);
    expect(await rawRequest(`GET /ws HTTP/1.1${upgrade}`)).toMatch(/^HTTP\/1.1 101/);
  });
});

describe("device registry: socket errors", () => {
  it("closes the link and fails each pending call when a frame is invalid", async () => {
    const { socket } = await helloDevice();
    const uncaught: Error[] = [];
    const listener = (error: Error) => uncaught.push(error);
    process.on("uncaughtException", listener);
    try {
      const pending = getDeviceRegistry().call("local", {
        tool: "device_bash", arguments: { command: "x" }, agentId: "a", sessionId: "s", toolCallId: "t", runKind: "chat",
      });
      const assertion = expect(pending).rejects.toThrow(/dropped/);
      // A text frame with a byte that is not valid UTF-8.
      (socket as unknown as { _socket: net.Socket })._socket.write(Buffer.from([0x81, 0x01, 0xff]));
      await assertion;
      await waitFor(() => !getDeviceRegistry().has("local"));
    } finally {
      process.off("uncaughtException", listener);
    }
    expect(uncaught).toEqual([]);
  });

  it("closes a link that sends a message over the size limit", async () => {
    const { socket } = await helloDevice();
    const code = closed(socket);
    socket.send("x".repeat(DEVICE_MAX_MESSAGE_BYTES + 1));
    await code;
    await waitFor(() => !getDeviceRegistry().has("local"));
  });
});

describe("gateway broker close", () => {
  it("closes each device socket, fails its calls, and clears the registry", async () => {
    const { socket } = await helloDevice();
    const pending = getDeviceRegistry().call("local", {
      tool: "device_bash", arguments: { command: "x" }, agentId: "a", sessionId: "s", toolCallId: "t", runKind: "chat",
    });
    const assertion = expect(pending).rejects.toThrow();
    const code = closed(socket);
    remote.broker.close();
    await assertion;
    await code;
    expect(getDeviceRegistry().has("local")).toBe(false);
  });
});

describe("device link client", () => {
  async function fakeGateway(onMessage: (socket: WebSocket, message: Json) => void) {
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    fakes.push(fake);
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    const connections: WebSocket[] = [];
    fake.on("connection", (socket) => {
      connections.push(socket as unknown as WebSocket);
      socket.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION }));
      socket.on("message", (raw) => onMessage(socket as unknown as WebSocket, JSON.parse(raw.toString()) as Json));
    });
    return { url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, connections };
  }

  function startLink(url: string, executor: Pick<DeviceExecutor, "execute">) {
    manager = new DeviceLinkManager({
      executor: executor as DeviceExecutor,
      getGateways: () => [{ name: "ams", url }],
      reconnectMinMs: 20, reconnectMaxMs: 80, checkIntervalMs: 30,
    });
    manager.start();
  }

  const callMessage = (callId: string): Json => ({
    type: "call", callId, tool: "device_bash", arguments: { command: "x" },
    agentId: "pom", sessionId: "s1", toolCallId: "t", runKind: "chat",
  });

  it("refuses a call whose ID is active, and keeps the first call cancellable", async () => {
    const signals: AbortSignal[] = [];
    const results: Json[] = [];
    const gateway = await fakeGateway((_socket, message) => {
      if (message.type === "result") results.push(message);
    });
    startLink(gateway.url, {
      execute: (_call, _name, signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    await waitFor(() => gateway.connections.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    gateway.connections[0].send(JSON.stringify(callMessage("same")));
    gateway.connections[0].send(JSON.stringify(callMessage("same")));
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ callId: "same", ok: false });
    expect(String(results[0].error)).toMatch(/already active/);
    expect(signals).toHaveLength(1);
    gateway.connections[0].send(JSON.stringify({ type: "cancel", callId: "same" }));
    await waitFor(() => signals[0].aborted);
  });

  it("refuses a call over the limit of active calls", async () => {
    const results: Json[] = [];
    let started = 0;
    const gateway = await fakeGateway((_socket, message) => {
      if (message.type === "result") results.push(message);
    });
    startLink(gateway.url, {
      execute: () => {
        started += 1;
        return new Promise(() => undefined);
      },
    });
    await waitFor(() => gateway.connections.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (let index = 0; index <= MAX_ACTIVE_CALLS; index += 1) gateway.connections[0].send(JSON.stringify(callMessage(`c${index}`)));
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ callId: `c${MAX_ACTIVE_CALLS}`, ok: false });
    expect(started).toBe(MAX_ACTIVE_CALLS);
  });

  it("closes the link and aborts its calls when the remote sends an invalid frame", async () => {
    const signals: AbortSignal[] = [];
    const gateway = await fakeGateway(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startLink(gateway.url, {
      execute: (_call, _name, signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    await waitFor(() => gateway.connections.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const uncaught: Error[] = [];
    const listener = (error: Error) => uncaught.push(error);
    process.on("uncaughtException", listener);
    try {
      gateway.connections[0].send(JSON.stringify(callMessage("one")));
      await waitFor(() => signals.length === 1);
      (gateway.connections[0] as unknown as { _socket: net.Socket })._socket.write(Buffer.from([0x81, 0x01, 0xff]));
      await waitFor(() => signals[0].aborted);
    } finally {
      process.off("uncaughtException", listener);
    }
    expect(uncaught).toEqual([]);
  });

  it("stops each link, its calls, and its timers when the manager stops", async () => {
    const signals: AbortSignal[] = [];
    const gateway = await fakeGateway(() => undefined);
    startLink(gateway.url, {
      execute: (_call, _name, signal) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
    });
    await waitFor(() => gateway.connections.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    gateway.connections[0].send(JSON.stringify(callMessage("one")));
    await waitFor(() => signals.length === 1);
    const code = closed(gateway.connections[0]);
    manager?.stop();
    await code;
    await waitFor(() => signals[0].aborted);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(gateway.connections).toHaveLength(1);
  });

  it("fails the pending approval when the link drops", async () => {
    const approvals = new DeviceApprovals();
    const gateway = await fakeGateway(() => undefined);
    settings.setChat(deviceChatKey("ams", "s1"), { workspaceFolder: dir, full: false });
    const pending: string[] = [];
    approvals.subscribe((event) => {
      if (event.kind === "request") pending.push(event.message.approvalId);
    });
    startLink(gateway.url, new DeviceExecutor({ settings, approvals, approvalTimeoutMs: 5000 }));
    await waitFor(() => gateway.connections.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    gateway.connections[0].send(JSON.stringify({ ...callMessage("ask"), tool: "device_bash" }));
    await waitFor(() => pending.length === 1);
    gateway.connections[0].terminate();
    await waitFor(() => approvals.pendingFor("pom@ams", "s1").length === 0);
  });
});
