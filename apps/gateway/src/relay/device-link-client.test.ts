import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventBus, DEVICE_OFFLINE_CALL_TEXT, DEVICE_PROTOCOL_VERSION, type AgentConfig, type ExtensionAgentToolContext } from "@yoplai/shared";
import { deviceToolsExtension } from "./device-extension.js";
import { DeviceApprovals } from "./device-approvals.js";
import { AMS, issueTestTurn } from "./device-turn.fixture.js";
import { DeviceExecutor } from "./device-exec.js";
import { DeviceLinkManager } from "./device-link-client.js";
import { getDeviceRegistry, resetDeviceRegistry } from "./device-registry.js";
import { startRemoteServer, waitFor } from "./device-test-server.js";
import { createFileDeviceSettingsStore, deviceAgentKey, deviceChatKey, type DeviceSettingsStore } from "./device-settings.js";
import type { RemoteGateway } from "./store.js";

vi.mock("../config/index.js", () => ({
  getAgent: (id: string) => (id === "alpha" ? { id } : undefined),
  isAgentActive: () => true,
}));
vi.mock("../agents/index.js", () => ({
  runAgent: vi.fn(), agentEventBus: new AgentEventBus(), isStreaming: () => false, getSessionCurrentTurn: () => null,
}));
vi.mock("../sessions/index.js", () => ({ getSessionEntry: vi.fn() }));
vi.mock("../server/run-request.js", () => ({ normalizeRunRequest: vi.fn() }));

const agent = { id: "pom" } as AgentConfig;
const FAST = { reconnectMinMs: 20, reconnectMaxMs: 80, checkIntervalMs: 30 };

let dir: string;
let settings: DeviceSettingsStore;
let approvals: DeviceApprovals;
let remote: Awaited<ReturnType<typeof startRemoteServer>> | undefined;
let manager: DeviceLinkManager | undefined;
let gateways: RemoteGateway[];
const closers: Array<() => void> = [];

function startManager(options: Partial<ConstructorParameters<typeof DeviceLinkManager>[0]> = {}) {
  manager = new DeviceLinkManager({
    executor: new DeviceExecutor({ settings, approvals, approvalTimeoutMs: 2000 }),
    getGateways: () => gateways,
    deviceName: "test-laptop",
    ...FAST,
    ...options,
  });
  manager.start();
  return manager;
}

async function deviceTool(name: string) {
  const tools = (await deviceToolsExtension.getAgentTools?.(agent, { config: {} as never, run: { source: "web" } })) ?? [];
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`No ${name} tool`);
  return (args: unknown, overrides: Partial<ExtensionAgentToolContext> = {}) =>
    tool.execute(args, { agent, config: {} as never, sessionId: "s1", toolCallId: "tc1", run: { source: "web", deviceTurnToken: issueTestTurn() }, ...overrides });
}

const online = () => getDeviceRegistry().has("local");

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-link-")));
  settings = createFileDeviceSettingsStore(path.join(dir, "device-settings.json"));
  approvals = new DeviceApprovals();
  resetDeviceRegistry();
  remote = await startRemoteServer(false);
  gateways = [{ ...AMS, url: `http://127.0.0.1:${remote.port}` }];
});
afterEach(async () => {
  manager?.stop();
  manager = undefined;
  for (const close of closers.splice(0)) close();
  remote?.broker.close();
  await new Promise<void>((resolve) => remote?.server.close(() => resolve()) ?? resolve());
  remote?.server.closeAllConnections();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("device link: local client", () => {
  it("connects with a hello that carries the protocol version and the device name", async () => {
    const hellos: unknown[] = [];
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    closers.push(() => fake.close());
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    fake.on("connection", (socket) => socket.once("message", (raw) => hellos.push(JSON.parse(raw.toString()))));
    gateways = [{ ...AMS, url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, token: "tok" }];
    startManager();
    await waitFor(() => hellos.length === 1);
    expect(hellos[0]).toEqual({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION, deviceName: "test-laptop" });
  });

  it("sends the bearer token of the store on the upgrade request", async () => {
    const auth: Array<string | undefined> = [];
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    closers.push(() => fake.close());
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    fake.on("connection", (_socket, request) => auth.push(request.headers.authorization));
    gateways = [{ ...AMS, url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`, token: "secret-token" }];
    startManager();
    await waitFor(() => auth.length === 1);
    expect(auth[0]).toBe("Bearer secret-token");
  });

  it("closes the link when the remote gateway answers with an unknown protocol version", async () => {
    const closes: number[] = [];
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    closers.push(() => fake.close());
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    fake.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 99 }));
      socket.on("close", (code) => closes.push(code));
    });
    gateways = [{ ...AMS, url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = startManager();
    await waitFor(() => closes.includes(4001));
    expect(started.states()).toEqual([{ name: "ams", connected: false, status: "connecting" }]);
  });

  it("shows an unauthorized state when the remote refuses the key at the upgrade", async () => {
    const server = (await import("node:http")).createServer();
    closers.push(() => server.close());
    server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    gateways = [{ ...AMS, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: "dead-key" }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = startManager();
    await waitFor(() => started.states()[0]?.status === "unauthorized");
    expect(started.states()).toEqual([{ name: "ams", connected: false, status: "unauthorized" }]);
  });

  it("shows a replaced state when another relay of the same user took the link", async () => {
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    closers.push(() => fake.close());
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    fake.on("connection", (socket) => socket.once("message", () => socket.close(4003, "Replaced")));
    gateways = [{ ...AMS, url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const started = startManager();
    await waitFor(() => started.states()[0]?.status === "replaced");
    expect(started.states()).toEqual([{ name: "ams", connected: false, status: "replaced" }]);
  });

  it("links to nothing while the list of gateways is empty, and links after a store change with no restart", async () => {
    gateways = [];
    const started = startManager();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started.states()).toEqual([]);
    expect(online()).toBe(false);
    gateways = [{ ...AMS, url: `http://127.0.0.1:${remote?.port}` }];
    await waitFor(() => online() && started.states()[0]?.connected === true);
    expect(started.states()).toEqual([{ name: "ams", connected: true, status: "connected" }]);
    gateways = [];
    await waitFor(() => !online());
    expect(started.states()).toEqual([]);
  });

  it("connects again after a drop", async () => {
    startManager();
    await waitFor(() => online());
    const wss = (remote?.broker as unknown as { deviceWss: WebSocketServer }).deviceWss;
    for (const client of wss.clients) client.terminate();
    await waitFor(() => !online());
    await waitFor(() => online());
  });

  it("writes one log line for a remote gateway with no device path, then stays quiet", async () => {
    const older = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/ws" });
    closers.push(() => older.close());
    await new Promise<void>((resolve) => older.once("listening", resolve));
    gateways = [{ name: "old", url: `http://127.0.0.1:${(older.address() as AddressInfo).port}` }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    startManager();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("device link: calls from the remote gateway", () => {
  beforeEach(async () => {
    settings.setChat(deviceChatKey(AMS, "pom@ams", "session:s1"), { full: true });
    startManager();
    await waitFor(() => online());
  });

  it("reads a file on the local side", async () => {
    fs.writeFileSync(path.join(dir, "note.txt"), "local content");
    expect(await (await deviceTool("device_read"))({ path: path.join(dir, "note.txt") })).toContain("local content");
  });

  it("writes a file on the local side", async () => {
    await (await deviceTool("device_write"))({ path: path.join(dir, "out.txt"), content: "written" });
    expect(fs.readFileSync(path.join(dir, "out.txt"), "utf8")).toBe("written");
  });

  it("edits a file on the local side", async () => {
    fs.writeFileSync(path.join(dir, "edit.txt"), "typo here");
    await (await deviceTool("device_edit"))({ path: path.join(dir, "edit.txt"), edits: [{ oldText: "typo", newText: "fix" }] });
    expect(fs.readFileSync(path.join(dir, "edit.txt"), "utf8")).toBe("fix here");
  });

  it("runs a command on the local side", async () => {
    expect(await (await deviceTool("device_bash"))({ command: "echo from-local" })).toContain("from-local");
  });

  it("returns the error of a call that fails on the local side", async () => {
    await expect((await deviceTool("device_read"))({ path: path.join(dir, "missing.txt") })).rejects.toThrow(/ENOENT|not found|no such file/i);
    await expect((await deviceTool("device_write"))({ path: "x" })).rejects.toThrow(/Invalid arguments/);
  });

  it("uses the settings of the link name, and never a gateway name from a message", async () => {
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    closers.push(() => fake.close());
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    const results: Array<Record<string, unknown>> = [];
    fake.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "result") results.push(message);
      });
      socket.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION }));
      socket.send(JSON.stringify({
        type: "call", callId: "c1", tool: "device_write", arguments: { path: path.join(dir, "link.txt"), content: "x" },
        agentId: "pom", toolCallId: "t1", turnToken: issueTestTurn(), gateway: "evil", gatewayName: "evil",
      }));
    });
    manager?.stop();
    gateways = [{ ...AMS, url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` }];
    startManager();
    // Full mode is set for the chat of the link name "ams" only, so the write runs with no prompt.
    await waitFor(() => results.length === 1);
    expect(results[0]).toMatchObject({ callId: "c1", ok: true });
    expect(fs.readFileSync(path.join(dir, "link.txt"), "utf8")).toBe("x");

    // The same call on the link "other" carries a token of the link "ams". It is a background call, so it asks nothing.
    gateways = [{ name: "other", url: gateways[0].url }];
    const asked: string[] = [];
    approvals.subscribe((event) => {
      if (event.kind === "request") asked.push(event.message.gateway);
    });
    await waitFor(() => results.length === 2);
    expect(results[1]).toMatchObject({ ok: false, error: expect.stringMatching(/no user is present/) });
    expect(asked).toEqual([]);
  });

  it.each([
    ["different", "fake-bearer-new"],
    ["equal", "fake-bearer-old"],
  ])("gives a link that is removed and created again with %s values none of the old grants", async (_name, newToken) => {
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    closers.push(() => fake.close());
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const results: Array<Record<string, unknown>> = [];
    const sockets: WebSocket[] = [];
    fake.on("connection", (socket) => {
      sockets.push(socket as unknown as WebSocket);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (message.type === "result") results.push(message);
      });
      socket.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION }));
    });
    const call = (socket: WebSocket, callId: string, turnToken: string | undefined) =>
      socket.send(JSON.stringify({
        type: "call", callId, tool: "device_write", arguments: { path: path.join(dir, `${callId}.txt`), content: "x" },
        agentId: "pom", toolCallId: callId, turnToken,
      }));
    settings.setAgentFullBackground(deviceAgentKey(AMS, "pom@ams"), true);
    manager?.stop();
    gateways = [{ ...AMS, url, token: "fake-bearer-old" }];
    startManager();
    await waitFor(() => sockets.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    call(sockets[0], "chat-old", issueTestTurn());
    call(sockets[0], "background-old", undefined);
    await waitFor(() => results.length === 2);
    expect(results.map((result) => result.ok)).toEqual([true, true]);

    // The same name comes back as a new link. Only its generation tells it from the old one.
    const replacement = { ...AMS, generation: "ams-link-2" };
    gateways = [{ ...replacement, url, token: newToken }];
    await waitFor(() => sockets.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const asked: string[] = [];
    approvals.subscribe((event) => {
      if (event.kind !== "request") return;
      asked.push(event.message.chat);
      approvals.answer(event.message.approvalId, false);
    });
    call(sockets[1], "chat-new", issueTestTurn("session:s1", { generation: replacement.generation }));
    call(sockets[1], "background-new", undefined);
    await waitFor(() => results.length === 4);
    // The chat call asks the user again, and the background call has no user to ask.
    expect(asked).toEqual(["session:s1"]);
    expect(results.find((result) => result.callId === "chat-new")).toMatchObject({ ok: false, error: expect.stringMatching(/refused/) });
    expect(results.find((result) => result.callId === "background-new")).toMatchObject({ ok: false, error: expect.stringMatching(/no user is present/) });
    expect(fs.existsSync(path.join(dir, "chat-new.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "background-new.txt"))).toBe(false);
  });

  it("stops a running command when the run aborts", async () => {
    const pidFile = path.join(dir, "abort.pid");
    const controller = new AbortController();
    const pending = (await deviceTool("device_bash"))({ command: `echo $$ > ${pidFile}; exec sleep 30` }, { signal: controller.signal });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    await waitFor(() => !isAlive(pid));
  });

  it("fails the pending call and stops the command when the link drops", async () => {
    const pidFile = path.join(dir, "drop.pid");
    const pending = (await deviceTool("device_bash"))({ command: `echo $$ > ${pidFile}; exec sleep 30` });
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    const wss = (remote?.broker as unknown as { deviceWss: WebSocketServer }).deviceWss;
    for (const client of wss.clients) client.terminate();
    await expect(pending).rejects.toThrow(DEVICE_OFFLINE_CALL_TEXT);
    await waitFor(() => !isAlive(pid));
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("device link: a drop with a call that waits", () => {
  it("sends no result after a new connection for a call of the old connection", async () => {
    const connections: Array<{ socket: WebSocket; messages: Array<Record<string, unknown>> }> = [];
    const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    closers.push(() => fake.close());
    await new Promise<void>((resolve) => fake.once("listening", resolve));
    fake.on("connection", (socket) => {
      const connection = { socket: socket as unknown as WebSocket, messages: [] as Array<Record<string, unknown>> };
      connections.push(connection);
      socket.on("message", (raw) => connection.messages.push(JSON.parse(raw.toString()) as Record<string, unknown>));
      socket.send(JSON.stringify({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION }));
    });
    gateways = [{ ...AMS, url: `http://127.0.0.1:${(fake.address() as AddressInfo).port}` }];
    settings.setChat(deviceChatKey(AMS, "pom@ams", "session:s1"), { full: true });
    const pidFile = path.join(dir, "old.pid");
    startManager();
    await waitFor(() => connections.length === 1 && connections[0].messages.length === 1);
    connections[0].socket.send(JSON.stringify({
      type: "call", callId: "old", tool: "device_bash", arguments: { command: `echo $$ > ${pidFile}; exec sleep 1` },
      agentId: "pom", toolCallId: "t", turnToken: issueTestTurn(),
    }));
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    connections[0].socket.terminate();
    await waitFor(() => connections.length === 2 && connections[1].messages.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(connections[1].messages).toEqual([
      { type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION, deviceName: "test-laptop" },
    ]);
    expect(connections[0].messages.filter((message) => message.type === "result")).toEqual([]);
  });
});
