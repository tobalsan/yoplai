import type { Server } from "node:http";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventBus, DEVICE_OFFLINE_CALL_TEXT, DEVICE_PROTOCOL_VERSION, type AgentConfig, type ExtensionAgentToolContext } from "@yoplai/shared";
import { startRemoteServer, waitFor } from "./device-test-server.js";
import { getDeviceRegistry, resetDeviceRegistry } from "./device-registry.js";

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
type Json = Record<string, unknown>;

/** A fake relay that records each message of the remote gateway. */
async function connectRelay(port: number, options: { token?: string; version?: number; hello?: boolean } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/device`, {
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  const messages: Json[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString()) as Json));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  if (options.hello !== false) {
    socket.send(JSON.stringify({ type: "hello", protocolVersion: options.version ?? DEVICE_PROTOCOL_VERSION, deviceName: "laptop" }));
  }
  return { socket, messages, closed };
}

function toolContext(overrides: Partial<ExtensionAgentToolContext> = {}): ExtensionAgentToolContext {
  return {
    agent, config: {} as never, sessionId: "s1", toolCallId: "tc1", run: { source: "web" }, ...overrides,
  };
}

async function deviceTools(userId?: string, run: ExtensionAgentToolContext["run"] = { source: "web" }) {
  const { deviceToolsExtension } = await import("./device-extension.js");
  return (await deviceToolsExtension.getAgentTools?.(agent, { config: {} as never, userId, run })) ?? [];
}

describe("device link: remote side", () => {
  let remote: Awaited<ReturnType<typeof startRemoteServer>>;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    resetDeviceRegistry();
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    remote?.broker.close();
    await new Promise<void>((resolve) => (remote?.server as Server | undefined)?.close(() => resolve()) ?? resolve());
  });

  async function relay(port: number, options?: Parameters<typeof connectRelay>[1]) {
    const connection = await connectRelay(port, options);
    sockets.push(connection.socket);
    return connection;
  }

  it("answers the hello of the relay with its own hello", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    expect(connection.messages[0]).toEqual({ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION });
  });

  it("closes the link on a protocol version that it does not know", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port, { version: 99 });
    const closed = await connection.closed;
    expect(closed.code).toBe(4001);
    expect(closed.reason).toContain("Unsupported protocol version 99");
    expect(connection.messages).toEqual([]);
    expect(await deviceTools()).toEqual([]);
  });

  it("closes the link on a message that it cannot parse", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port, { hello: false });
    connection.socket.send("not json");
    expect((await connection.closed).code).toBe(4002);
  });

  it("refuses a first message that is not hello", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port, { hello: false });
    connection.socket.send(JSON.stringify({ type: "cancel", callId: "x" }));
    expect((await connection.closed).code).toBe(4002);
  });

  it("refuses an upgrade with no valid token in multi-user mode", async () => {
    remote = await startRemoteServer(true);
    await expect(connectRelay(remote.port)).rejects.toThrow(/401/);
  });

  it("keys the registry by the user of the token in multi-user mode", async () => {
    remote = await startRemoteServer(true);
    await relay(remote.port, { token: "ann" });
    await waitFor(() => getDeviceRegistry().has("user-ann"));
    expect(await deviceTools("user-ann")).toHaveLength(4);
    expect(await deviceTools("user-bob")).toEqual([]);
    expect(await deviceTools()).toEqual([]);
  });

  it("keeps the chat path working with the shared upgrade handler", async () => {
    remote = await startRemoteServer(false);
    const chat = new WebSocket(`ws://127.0.0.1:${remote.port}/ws`);
    sockets.push(chat);
    const reply = new Promise<Json>((resolve) => chat.once("message", (raw) => resolve(JSON.parse(raw.toString()) as Json)));
    await new Promise<void>((resolve) => chat.once("open", resolve));
    chat.send("not json");
    expect(await reply).toEqual({ type: "error", message: "Invalid JSON" });
  });

  it("refuses an upgrade for an unknown path", async () => {
    remote = await startRemoteServer(false);
    const other = new WebSocket(`ws://127.0.0.1:${remote.port}/other`);
    sockets.push(other);
    await expect(new Promise((_resolve, reject) => other.once("error", reject))).rejects.toThrow(/400/);
  });

  it("gives the four device tools only while a relay of the user is online", async () => {
    remote = await startRemoteServer(false);
    expect(await deviceTools()).toEqual([]);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    expect((await deviceTools()).map((tool) => tool.name)).toEqual([
      "device_read", "device_write", "device_edit", "device_bash",
    ]);
    connection.socket.close();
    await connection.closed;
    await waitFor(() => !getDeviceRegistry().has("local"));
    expect(await deviceTools()).toEqual([]);
  });

  it("sends a call and returns the text of the result", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    const tools = await deviceTools();
    const read = tools.find((tool) => tool.name === "device_read");
    const pending = read?.execute({ path: "a.txt" }, toolContext());
    await waitFor(() => connection.messages.length === 2);
    const call = connection.messages[1];
    expect(call).toMatchObject({
      type: "call", tool: "device_read", arguments: { path: "a.txt" },
      agentId: "pom", sessionId: "s1", toolCallId: "tc1", runKind: "chat",
    });
    connection.socket.send(JSON.stringify({ type: "result", callId: call.callId, ok: true, content: [{ type: "text", text: "hello" }] }));
    expect(await pending).toBe("hello");
  });

  it("fails the call with the error text of the relay", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    const tool = (await deviceTools()).find((item) => item.name === "device_bash");
    const pending = tool?.execute({ command: "x" }, toolContext());
    await waitFor(() => connection.messages.length === 2);
    connection.socket.send(JSON.stringify({ type: "result", callId: connection.messages[1].callId, ok: false, error: "The user refused" }));
    await expect(pending).rejects.toThrow("The user refused");
  });

  it("gives a background run the device tools only with requiresDevice, and a chat run as before", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    for (const source of ["scheduler", "heartbeat", "webhook", "agent", "orchestrator", "dream", "system"]) {
      expect(await deviceTools(undefined, { source })).toEqual([]);
      expect(await deviceTools(undefined, { source, requiresDevice: true })).toHaveLength(4);
    }
    expect(await deviceTools(undefined, { source: "web" })).toHaveLength(4);
    expect(await deviceTools(undefined, { source: "web", background: true })).toEqual([]);
  });

  it("keeps the device tools for a background run with requiresDevice after a drop, and the call gets the fixed offline text", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    connection.socket.terminate();
    await connection.closed;
    await vi.waitFor(async () => expect(await deviceTools(undefined, { source: "web" })).toHaveLength(0));
    const tools = await deviceTools(undefined, { source: "scheduler", requiresDevice: true });
    expect(tools.map((item) => item.name)).toHaveLength(4);
    await expect(
      tools.find((item) => item.name === "device_read")?.execute({ path: "a.txt" }, toolContext({ run: { source: "scheduler", requiresDevice: true } }))
    ).rejects.toThrow(DEVICE_OFFLINE_CALL_TEXT);
    expect(await deviceTools(undefined, { source: "scheduler" })).toEqual([]);
  });

  it("refuses a device call of a background run with no flag, even when the tool was listed", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    const tool = (await deviceTools(undefined, { source: "scheduler", requiresDevice: true })).find((item) => item.name === "device_read");
    await expect(tool?.execute({ path: "a.txt" }, toolContext({ run: { source: "scheduler" } }))).rejects.toThrow("requiresDevice: true");
    expect(connection.messages).toHaveLength(1);
  });

  it("tells the agent about the device tools only while a relay is online", async () => {
    remote = await startRemoteServer(false);
    const { deviceToolsExtension } = await import("./device-extension.js");
    expect(await deviceToolsExtension.getSystemPromptContributions?.(agent, { config: {} as never })).toBeUndefined();
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    expect(await deviceToolsExtension.getSystemPromptContributions?.(agent, { config: {} as never })).toMatch(/requiresDevice: true/);
  });

  it("marks a run with no human as a background run", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    const tool = (await deviceTools()).find((item) => item.name === "device_read");
    const runs: Array<ExtensionAgentToolContext["run"]> = [
      { source: "scheduler" }, { source: "heartbeat" }, { source: "webhook" }, { source: "agent" },
      { source: "orchestrator" }, { source: "dream" }, { source: "system" },
      { source: "web", background: true }, {}, { source: "slack" }, { source: "cli" },
    ].map((run) => (run.source === "slack" || run.source === "cli" ? run : { ...run, requiresDevice: true }));
    for (const run of runs) {
      void Promise.resolve(tool?.execute({ path: "a" }, toolContext({ run }))).catch(() => undefined);
    }
    await waitFor(() => connection.messages.length === 1 + runs.length);
    expect(connection.messages.slice(1).map((message) => message.runKind)).toEqual([
      "background", "background", "background", "background", "background", "background", "background",
      "background", "background", "chat", "chat",
    ]);
  });

  it("sends cancel and fails the call when the run aborts", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    const tool = (await deviceTools()).find((item) => item.name === "device_bash");
    const controller = new AbortController();
    const pending = tool?.execute({ command: "sleep 5" }, toolContext({ signal: controller.signal }));
    await waitFor(() => connection.messages.length === 2);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
    await waitFor(() => connection.messages.length === 3);
    expect(connection.messages[2]).toEqual({ type: "cancel", callId: connection.messages[1].callId });
  });

  it("sends cancel and fails the call after the deadline", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    const pending = getDeviceRegistry().call(
      "local",
      { tool: "device_bash", arguments: {}, agentId: "pom", sessionId: "s1", toolCallId: "tc", runKind: "chat" },
      undefined,
      50
    );
    await expect(pending).rejects.toThrow(/timed out/);
    await waitFor(() => connection.messages.length === 3);
    expect(connection.messages[2]).toMatchObject({ type: "cancel" });
  });

  it("fails each pending call when the link drops", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    const tool = (await deviceTools()).find((item) => item.name === "device_bash");
    const pending = tool?.execute({ command: "sleep 5" }, toolContext());
    await waitFor(() => connection.messages.length === 2);
    connection.socket.terminate();
    await expect(pending).rejects.toThrow(DEVICE_OFFLINE_CALL_TEXT);
  });

  it("does not send a call again after a new connection", async () => {
    remote = await startRemoteServer(false);
    const first = await relay(remote.port);
    await waitFor(() => first.messages.length === 1);
    const tool = (await deviceTools()).find((item) => item.name === "device_bash");
    const pending = tool?.execute({ command: "sleep 5" }, toolContext());
    await waitFor(() => first.messages.length === 2);
    first.socket.terminate();
    await expect(pending).rejects.toThrow();
    const second = await relay(remote.port);
    await waitFor(() => second.messages.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(second.messages).toEqual([{ type: "hello", protocolVersion: DEVICE_PROTOCOL_VERSION }]);
  });

  it("replaces the old relay of a user and fails its pending calls", async () => {
    remote = await startRemoteServer(false);
    const first = await relay(remote.port);
    await waitFor(() => first.messages.length === 1);
    const tool = (await deviceTools()).find((item) => item.name === "device_bash");
    const pending = tool?.execute({ command: "sleep 5" }, toolContext());
    await waitFor(() => first.messages.length === 2);
    const second = await relay(remote.port);
    await expect(pending).rejects.toThrow(DEVICE_OFFLINE_CALL_TEXT);
    expect((await first.closed).code).toBe(4003);
    await waitFor(() => second.messages.length === 1);
    expect((await deviceTools()).length).toBe(4);
  });

  it("ignores a result with an unknown call ID", async () => {
    remote = await startRemoteServer(false);
    const connection = await relay(remote.port);
    await waitFor(() => connection.messages.length === 1);
    connection.socket.send(JSON.stringify({ type: "result", callId: "unknown", ok: true, content: [] }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
  });

  it("fails a call at once when no relay is online", async () => {
    remote = await startRemoteServer(false);
    await expect(
      getDeviceRegistry().call("local", { tool: "device_read", arguments: {}, agentId: "pom", sessionId: "s", toolCallId: "t", runKind: "chat" })
    ).rejects.toThrow(DEVICE_OFFLINE_CALL_TEXT);
  });
});
