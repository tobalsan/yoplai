import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentEventBus, type DeviceApprovalOutcome } from "@yoplai/shared";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { waitFor } from "./device-test-server.js";
import { getDeviceApprovals } from "./device-approvals.js";
import { issueTestTurn } from "./device-turn.fixture.js";
import { DeviceExecutor } from "./device-exec.js";
import { createFileDeviceSettingsStore, deviceChatKey, type DeviceSettingsStore } from "./device-settings.js";

const remote = vi.hoisted(() => ({ url: "", enabled: true }));
vi.mock("../config/index.js", () => ({
  getAgent: (id: string) => (id === "alpha" ? { id } : undefined),
  isAgentActive: () => true,
}));
vi.mock("../agents/index.js", () => ({
  runAgent: vi.fn(), agentEventBus: new AgentEventBus(), isStreaming: () => false, getSessionCurrentTurn: () => null,
}));
vi.mock("../sessions/index.js", () => ({ getSessionEntry: vi.fn() }));
vi.mock("../server/run-request.js", () => ({ normalizeRunRequest: vi.fn() }));
vi.mock("../relay/state.js", () => ({
  isRelayEnabled: () => remote.enabled,
  getLinkedGateways: () => [{ name: "ams", url: remote.url }],
  // A page that sends an Origin header from "evil.example" is not trusted.
  isTrustedRequest: (origin?: string | null) => !origin || !origin.includes("evil.example"),
  resolveRemoteAgent: (agentId: string) =>
    agentId.endsWith("@ams") ? { agentId: agentId.slice(0, -4), gateway: "ams" } : { agentId },
}));

type Json = Record<string, unknown>;
type Page = { socket: WebSocket; messages: Json[] };

let dir: string;
let settings: DeviceSettingsStore;
let executor: DeviceExecutor;
let localServer: Server;
let localPort: number;
let remoteServer: WebSocketServer;
let remoteMessages: Json[];
let remoteSockets: WebSocket[];
let broker: { close(): void };
const pages: Page[] = [];

async function openPage(options: { origin?: string } = {}): Promise<Page> {
  const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws`, { origin: options.origin });
  const page: Page = { socket, messages: [] };
  socket.on("message", (raw) => page.messages.push(JSON.parse(raw.toString()) as Json));
  await new Promise<void>((resolve) => socket.once("open", resolve));
  pages.push(page);
  return page;
}

function subscribe(page: Page, agentId = "pom@ams", sessionId = "s1"): void {
  page.socket.send(JSON.stringify({ type: "subscribe", agentId, sessionKey: "main", sessionId }));
}

const ofType = (page: Page, type: string) => page.messages.filter((message) => message.type === type);

function startWrite(file: string, content = "hello", options: { chat?: string; token?: string; signal?: AbortSignal; short?: boolean } = {}) {
  const runner = options.short
    ? new DeviceExecutor({ settings, approvals: getDeviceApprovals(), approvalTimeoutMs: 80 })
    : executor;
  return runner.execute(
    {
      type: "call", callId: `c-${Math.random()}`, tool: "device_write", arguments: { path: file, content },
      agentId: "pom", toolCallId: "tc-1", turnToken: options.token ?? issueTestTurn(options.chat),
    },
    "ams",
    options.signal ?? new AbortController().signal
  );
}

beforeEach(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-approval-")));
  settings = createFileDeviceSettingsStore(path.join(dir, "device-settings.json"));
  executor = new DeviceExecutor({ settings, approvals: getDeviceApprovals(), approvalTimeoutMs: 5000 });
  remoteMessages = [];
  remoteSockets = [];
  remote.enabled = true;
  remoteServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => remoteServer.once("listening", resolve));
  remote.url = `http://127.0.0.1:${(remoteServer.address() as AddressInfo).port}`;
  remoteServer.on("connection", (socket) => remoteSockets.push(socket as unknown as WebSocket) && socket.on("message", (raw) => remoteMessages.push(JSON.parse(raw.toString()) as Json)));
  const { WsBroker } = await import("../server/ws-broker.js");
  localServer = createServer();
  const wsBroker = new WsBroker();
  wsBroker.attach(localServer, {
    isMultiUserEnabled: () => false,
    validateWebSocketRequest: async () => null,
    canAccessAgent: async () => true,
    getExtensionRuntime: () => ({} as ExtensionRuntime),
  });
  broker = wsBroker;
  await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  localPort = (localServer.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const page of pages.splice(0)) page.socket.terminate();
  broker.close();
  remoteServer.close();
  await new Promise<void>((resolve) => localServer.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("device approval: protocol", () => {
  it("sends a request to a subscribed page, with long text cut to 2,000 characters", async () => {
    const page = await openPage();
    subscribe(page);
    await waitFor(() => remoteMessages.length === 1);
    const pending = startWrite(path.join(dir, "a.txt"), "x".repeat(5000));
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    const request = ofType(page, "device_approval_request")[0];
    expect(request).toMatchObject({
      gateway: "ams", agentId: "pom@ams", chat: "session:s1", toolCallId: "tc-1", tool: "device_write",
    });
    expect(typeof request.approvalId).toBe("string");
    const args = request.arguments as { path: string; content: string };
    expect(args.path).toBe(path.join(dir, "a.txt"));
    expect(args.content.length).toBeLessThan(2100);
    expect(args.content.startsWith("x".repeat(2000))).toBe(true);
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId: request.approvalId, approve: false }));
    await expect(pending).rejects.toThrow(/refused/);
  });

  function startBash(command: string) {
    return executor.execute(
      {
        type: "call", callId: `c-${Math.random()}`, tool: "device_bash", arguments: { command },
        agentId: "pom", toolCallId: "tc-1", turnToken: issueTestTurn(),
      },
      "ams",
      new AbortController().signal
    );
  }

  it("shows a command of 5,011 characters on the card in full", async () => {
    const page = await openPage();
    subscribe(page);
    await waitFor(() => remoteMessages.length === 1);
    const command = `echo ${"a".repeat(2500)}\necho ${"b".repeat(2500)}`;
    const pending = startBash(command);
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    const request = ofType(page, "device_approval_request")[0];
    expect((request.arguments as { command: string }).command).toBe(command);
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId: request.approvalId, approve: false }));
    await expect(pending).rejects.toThrow(/refused/);
  });

  it("refuses a command of 20,001 characters with no approval request, and accepts 20,000", async () => {
    const page = await openPage();
    subscribe(page);
    await waitFor(() => remoteMessages.length === 1);
    await expect(startBash(`:${"x".repeat(20_000)}`)).rejects.toThrow(
      "The command has 20001 characters. The limit for an approval is 20,000. The call did not run. Write the commands to a script file, then run the file."
    );
    expect(ofType(page, "device_approval_request")).toHaveLength(0);
    const pending = startBash(`:${"x".repeat(19_999)}`);
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    const request = ofType(page, "device_approval_request")[0];
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId: request.approvalId, approve: false }));
    await expect(pending).rejects.toThrow(/refused/);
  });

  it("runs a command of 20,001 characters in Full mode with no limit", async () => {
    settings.setChat(deviceChatKey("ams", "pom@ams", "session:s1"), { full: true });
    const result = await startBash(`:${"x".repeat(20_000)}; echo done`);
    expect(JSON.stringify(result.content)).toContain("done");
  });

  it("runs the call after the user approves, and tells the page the outcome", async () => {
    const page = await openPage();
    subscribe(page);
    const file = path.join(dir, "approved.txt");
    const pending = startWrite(file);
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    expect(fs.existsSync(file)).toBe(false);
    const approvalId = ofType(page, "device_approval_request")[0].approvalId;
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
    await pending;
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    await waitFor(() => ofType(page, "device_approval_resolved").length === 1);
    expect(ofType(page, "device_approval_resolved")[0]).toEqual({
      type: "device_approval_resolved", approvalId, agentId: "pom@ams", chat: "session:s1", outcome: "approved",
    });
  });

  it("returns an error to the agent when the user refuses, and the file does not change", async () => {
    const page = await openPage();
    subscribe(page);
    const file = path.join(dir, "refused.txt");
    const pending = startWrite(file);
    const assertion = expect(pending).rejects.toThrow(/The user refused/);
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId: ofType(page, "device_approval_request")[0].approvalId, approve: false }));
    await assertion;
    expect(fs.existsSync(file)).toBe(false);
    await waitFor(() => ofType(page, "device_approval_resolved").length === 1);
    expect(ofType(page, "device_approval_resolved")[0].outcome).toBe("refused");
  });

  it("fails the call after the timeout and tells the page", async () => {
    const page = await openPage();
    subscribe(page);
    await expect(startWrite(path.join(dir, "t.txt"), "x", { short: true })).rejects.toThrow(/did not answer/);
    await waitFor(() => ofType(page, "device_approval_resolved").length === 1);
    expect(ofType(page, "device_approval_resolved")[0].outcome).toBe("timeout");
  });

  it("gives each pending approval of the chat to a page that subscribes later", async () => {
    const pending = startWrite(path.join(dir, "late.txt"));
    const assertion = expect(pending).rejects.toThrow(/refused/);
    const late = await openPage();
    expect(ofType(late, "device_approval_request")).toHaveLength(0);
    subscribe(late);
    await waitFor(() => ofType(late, "device_approval_request").length === 1);
    const other = await openPage();
    subscribe(other, "pom@ams", "other-session");
    subscribe(await openPage(), "twin@ams", "s1");
    late.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId: ofType(late, "device_approval_request")[0].approvalId, approve: false }));
    await assertion;
    expect(ofType(other, "device_approval_request")).toHaveLength(0);
  });

  it("sends nothing to a page that is not trusted, and its answer has no effect", async () => {
    const untrusted = await openPage({ origin: "https://evil.example" });
    const trusted = await openPage();
    subscribe(untrusted);
    subscribe(trusted);
    const file = path.join(dir, "guarded.txt");
    const pending = startWrite(file);
    await waitFor(() => ofType(trusted, "device_approval_request").length === 1);
    const approvalId = ofType(trusted, "device_approval_request")[0].approvalId;
    untrusted.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ofType(untrusted, "device_approval_request")).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
    expect(getDeviceApprovals().pendingFor("pom@ams", "session:s1")).toHaveLength(1);
    trusted.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
    await pending;
    expect(fs.existsSync(file)).toBe(true);
  });

  it("ignores a second answer for the same approval", async () => {
    const page = await openPage();
    subscribe(page);
    const file = path.join(dir, "twice.txt");
    const pending = startWrite(file);
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    const approvalId = ofType(page, "device_approval_request")[0].approvalId;
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: false }));
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
    expect(ofType(page, "device_approval_resolved")).toHaveLength(1);
    expect(ofType(page, "device_approval_resolved")[0].outcome).toBe("approved" satisfies DeviceApprovalOutcome);
  });

  it("does not send the answer to the remote gateway", async () => {
    const page = await openPage();
    subscribe(page);
    await waitFor(() => remoteMessages.length === 1);
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId: "unknown", approve: true, agentId: "pom@ams" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(remoteMessages.map((message) => message.type)).toEqual(["subscribe"]);
    expect(ofType(page, "error")).toHaveLength(0);
  });

  it("tells the page when a cancel ends the wait", async () => {
    const page = await openPage();
    subscribe(page);
    const controller = new AbortController();
    const pending = startWrite(path.join(dir, "c.txt"), "x", { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow(/cancelled/);
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    controller.abort();
    await assertion;
    await waitFor(() => ofType(page, "device_approval_resolved").length === 1);
    expect(ofType(page, "device_approval_resolved")[0].outcome).toBe("cancelled");
    expect(getDeviceApprovals().pendingFor("pom@ams", "session:s1")).toEqual([]);
  });

  it("ignores an answer from a page that subscribes to another chat", async () => {
    const owner = await openPage();
    const other = await openPage();
    subscribe(owner);
    subscribe(other, "pom@ams", "other-session");
    const file = path.join(dir, "wrong-chat.txt");
    const pending = startWrite(file);
    await waitFor(() => ofType(owner, "device_approval_request").length === 1);
    const approvalId = ofType(owner, "device_approval_request")[0].approvalId;
    other.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fs.existsSync(file)).toBe(false);
    expect(getDeviceApprovals().pendingFor("pom@ams", "session:s1")).toHaveLength(1);
    owner.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: false }));
    await expect(pending).rejects.toThrow(/refused/);
  });

  it("ignores an answer while the relay is off, and sends no request", async () => {
    const page = await openPage();
    subscribe(page);
    const pending = startWrite(path.join(dir, "off.txt"));
    const assertion = expect(pending).rejects.toThrow(/refused|cancelled/);
    await waitFor(() => ofType(page, "device_approval_request").length === 1);
    const approvalId = ofType(page, "device_approval_request")[0].approvalId;
    remote.enabled = false;
    page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(getDeviceApprovals().pendingFor("pom@ams", "session:s1")).toHaveLength(1);
    const later = startWrite(path.join(dir, "off2.txt"), "x", { chat: "session:s1" });
    const laterAssertion = expect(later).rejects.toThrow(/refused|cancelled/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ofType(page, "device_approval_request")).toHaveLength(1);
    remote.enabled = true;
    for (const item of getDeviceApprovals().pendingFor("pom@ams", "session:s1")) getDeviceApprovals().answer(item.approvalId, false);
    await assertion;
    await laterAssertion;
  });

  it("does not forward a device approval message from a remote gateway to the page", async () => {
    const page = await openPage();
    subscribe(page);
    await waitFor(() => remoteSockets.length === 1);
    for (const type of ["device_approval_request", "device_approval_resolved", "device_approval_answer"]) {
      remoteSockets[0].send(JSON.stringify({ type, approvalId: "fake", agentId: "pom", chat: "session:s1" }));
    }
    remoteSockets[0].send(JSON.stringify({ type: "status", agentId: "zzz" }));
    await waitFor(() => ofType(page, "status").length === 1);
    expect(page.messages.filter((message) => String(message.type).startsWith("device_approval_"))).toEqual([]);
  });

  describe("turn token of a chat message", () => {
    const sendChat = (page: Page, extra: Json = {}) =>
      page.socket.send(JSON.stringify({ type: "send", agentId: "pom@ams", sessionKey: "main", sessionId: "s1", message: "hi", ...extra }));
    const sentTokens = () => remoteMessages.filter((message) => message.type === "send").map((message) => message.deviceTurnToken);

    it("replaces a token that the page sends, and the new token makes a chat call", async () => {
      const logged = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
      const page = await openPage();
      subscribe(page);
      sendChat(page, { deviceTurnToken: "forged" });
      await waitFor(() => sentTokens().length === 1);
      const token = sentTokens()[0] as string;
      expect(token).not.toBe("forged");
      expect(token.length).toBeGreaterThanOrEqual(43);
      const forged = startWrite(path.join(dir, "forged.txt"), "x", { token: "forged" });
      await expect(forged).rejects.toThrow(/no user is present/);
      const pending = startWrite(path.join(dir, "real.txt"), "x", { token });
      await waitFor(() => ofType(page, "device_approval_request").length === 1);
      page.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId: ofType(page, "device_approval_request")[0].approvalId, approve: true }));
      await pending;
      expect(JSON.stringify(logged.flatMap((spy) => spy.mock.calls))).not.toContain(token);
      expect(JSON.stringify(page.messages)).not.toContain(token);
      for (const spy of logged) spy.mockRestore();
    });

    it.each(["done", "error"])("ends the token when the remote gateway sends %s", async (type) => {
      const page = await openPage();
      sendChat(page);
      await waitFor(() => sentTokens().length === 1);
      const token = sentTokens()[0] as string;
      await waitFor(() => remoteSockets.length === 1);
      remoteSockets[0].send(JSON.stringify({ type, message: "x", meta: { durationMs: 1 } }));
      await waitFor(() => ofType(page, type).length === 1);
      await expect(startWrite(path.join(dir, "late.txt"), "x", { token })).rejects.toThrow(/no user is present/);
    });

    it("sends the request to the page of the turn and to a page of the same chat, not to another chat", async () => {
      const turnPage = await openPage();
      const sameChat = await openPage();
      const otherChat = await openPage();
      subscribe(sameChat);
      subscribe(otherChat, "pom@ams", "other-session");
      sendChat(turnPage);
      await waitFor(() => sentTokens().length === 1);
      const pending = startWrite(path.join(dir, "turn.txt"), "x", { token: sentTokens()[0] as string });
      await waitFor(() => ofType(turnPage, "device_approval_request").length === 1 && ofType(sameChat, "device_approval_request").length === 1);
      const approvalId = ofType(turnPage, "device_approval_request")[0].approvalId;
      expect(ofType(otherChat, "device_approval_request")).toHaveLength(0);
      otherChat.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(getDeviceApprovals().pendingFor("pom@ams", "session:s1")).toHaveLength(1);
      sameChat.socket.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve: true }));
      await pending;
    });
  });
});
