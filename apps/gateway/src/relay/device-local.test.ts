import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCall } from "@yoplai/shared";
import { DeviceApprovals } from "./device-approvals.js";
import { DeviceExecutor } from "./device-exec.js";
import { relayDeviceApi } from "./device-routes.js";
import { createFileDeviceSettingsStore, deviceChatKey, type DeviceSettingsStore } from "./device-settings.js";

vi.mock("../config/index.js", () => ({ getAgent: () => undefined }));

let dir: string;
let folder: string;
let outside: string;
let settings: DeviceSettingsStore;
let approvals: DeviceApprovals;
let executor: DeviceExecutor;
let asked: string[];
const chatKey = deviceChatKey("ams", "s1");

function call(tool: string, args: unknown, overrides: Partial<DeviceCall> = {}): DeviceCall {
  return {
    type: "call", callId: `call-${Math.random()}`, tool, arguments: args,
    agentId: "pom", sessionId: "s1", toolCallId: "tc1", runKind: "chat", ...overrides,
  };
}

function textOf(result: { content: unknown[] }): string {
  return result.content.map((block) => (block as { text?: string }).text ?? "").join("");
}

/** Answers each approval request with the given answer and records the tool name. */
function answerApprovals(approve: boolean): void {
  approvals.subscribe((event) => {
    if (event.kind !== "request") return;
    asked.push(event.message.tool);
    approvals.answer(event.message.approvalId, approve);
  });
}

const run = (tool: string, args: unknown, overrides: Partial<DeviceCall> = {}, signal = new AbortController().signal) =>
  executor.execute(call(tool, args, overrides), "ams", signal);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-device-")));
  folder = path.join(dir, "workspace");
  outside = path.join(dir, "outside");
  fs.mkdirSync(folder);
  fs.mkdirSync(outside);
  settings = createFileDeviceSettingsStore(path.join(dir, "device-settings.json"));
  approvals = new DeviceApprovals();
  executor = new DeviceExecutor({ settings, approvals, approvalTimeoutMs: 2000 });
  asked = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("device gate: Ask mode", () => {
  beforeEach(() => answerApprovals(true));

  it("passes device_read with no prompt", async () => {
    fs.writeFileSync(path.join(outside, "a.txt"), "secret text");
    const result = await run("device_read", { path: path.join(outside, "a.txt") });
    expect(textOf(result)).toContain("secret text");
    expect(asked).toEqual([]);
  });

  it.each([
    ["device_write", () => ({ path: path.join(outside, "w.txt"), content: "x" })],
    ["device_edit", () => ({ path: path.join(outside, "e.txt"), edits: [{ oldText: "a", newText: "b" }] })],
    ["device_bash", () => ({ command: "echo hi" })],
  ])("asks before %s", async (tool, args) => {
    fs.writeFileSync(path.join(outside, "e.txt"), "a");
    await run(tool, args());
    expect(asked).toEqual([tool]);
  });
});

describe("device gate: Workspace mode", () => {
  beforeEach(() => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    answerApprovals(true);
  });

  it("passes device_read with no prompt", async () => {
    fs.writeFileSync(path.join(outside, "a.txt"), "outside text");
    await run("device_read", { path: path.join(outside, "a.txt") });
    expect(asked).toEqual([]);
  });

  it("passes device_write and device_edit in the folder", async () => {
    await run("device_write", { path: path.join(folder, "new.txt"), content: "hello" });
    await run("device_edit", { path: path.join(folder, "new.txt"), edits: [{ oldText: "hello", newText: "bye" }] });
    expect(fs.readFileSync(path.join(folder, "new.txt"), "utf8")).toBe("bye");
    expect(asked).toEqual([]);
  });

  it("asks for device_write and device_edit outside the folder", async () => {
    fs.writeFileSync(path.join(outside, "e.txt"), "a");
    await run("device_write", { path: path.join(outside, "w.txt"), content: "x" });
    await run("device_edit", { path: path.join(outside, "e.txt"), edits: [{ oldText: "a", newText: "b" }] });
    expect(asked).toEqual(["device_write", "device_edit"]);
  });

  it("asks before device_bash, which starts in the folder", async () => {
    const result = await run("device_bash", { command: "pwd" });
    expect(asked).toEqual(["device_bash"]);
    expect(textOf(result)).toContain(folder);
  });

  it("resolves a relative path against the folder for the gate and for the tool", async () => {
    await run("device_write", { path: "rel.txt", content: "relative" });
    expect(fs.readFileSync(path.join(folder, "rel.txt"), "utf8")).toBe("relative");
    expect(asked).toEqual([]);
    await run("device_write", { path: "../outside/rel.txt", content: "escape" });
    expect(asked).toEqual(["device_write"]);
  });

  it("asks when a symbolic link in the folder points outside the folder", async () => {
    fs.symlinkSync(outside, path.join(folder, "link"));
    await run("device_write", { path: path.join(folder, "link", "w.txt"), content: "x" });
    expect(asked).toEqual(["device_write"]);
    expect(fs.readFileSync(path.join(outside, "w.txt"), "utf8")).toBe("x");
  });

  it("asks when a dangling symbolic link in the folder points outside the folder", async () => {
    fs.symlinkSync(path.join(outside, "missing.txt"), path.join(folder, "dangling.txt"));
    await run("device_write", { path: path.join(folder, "dangling.txt"), content: "x" });
    expect(asked).toEqual(["device_write"]);
  });

  it("passes a new file in a new directory in the folder", async () => {
    await run("device_write", { path: path.join(folder, "deep", "er", "new.txt"), content: "x" });
    expect(asked).toEqual([]);
  });
});

describe("device gate: Full mode", () => {
  it("passes each call with no prompt, and wins over a workspace folder", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: true });
    answerApprovals(true);
    fs.writeFileSync(path.join(outside, "e.txt"), "a");
    await run("device_write", { path: path.join(outside, "w.txt"), content: "x" });
    await run("device_edit", { path: path.join(outside, "e.txt"), edits: [{ oldText: "a", newText: "b" }] });
    const bash = await run("device_bash", { command: "echo full" });
    expect(textOf(bash)).toContain("full");
    expect(fs.readFileSync(path.join(outside, "e.txt"), "utf8")).toBe("b");
    expect(asked).toEqual([]);
  });

  it("starts in the home directory when the chat has no folder", async () => {
    settings.setChat(chatKey, { full: true });
    const result = await run("device_bash", { command: "pwd" });
    expect(textOf(result)).toContain(fs.realpathSync(os.homedir()));
  });

  it("does not apply the Full switch of another chat", async () => {
    settings.setChat(deviceChatKey("ams", "other"), { full: true });
    answerApprovals(true);
    await run("device_bash", { command: "echo hi" });
    expect(asked).toEqual(["device_bash"]);
  });
});

describe("device calls: arguments and refusal", () => {
  it("refuses arguments that do not match the schema and runs no tool", async () => {
    settings.setChat(chatKey, { full: true });
    const target = path.join(outside, "never.txt");
    await expect(run("device_write", { path: target })).rejects.toThrow(/Invalid arguments for device_write/);
    await expect(run("device_bash", { command: 5 })).rejects.toThrow(/Invalid arguments for device_bash/);
    await expect(run("device_read", {})).rejects.toThrow(/Invalid arguments/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("gives an error result for an unknown tool", async () => {
    await expect(run("device_grep", {})).rejects.toThrow("Unknown device tool: device_grep");
  });

  it("returns an error to the agent when the user refuses, and the file does not change", async () => {
    answerApprovals(false);
    const target = path.join(outside, "w.txt");
    await expect(run("device_write", { path: target, content: "x" })).rejects.toThrow(/The user refused/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("fails the call when the user does not answer in time", async () => {
    const short = new DeviceExecutor({ settings, approvals, approvalTimeoutMs: 30 });
    const target = path.join(outside, "w.txt");
    await expect(short.execute(call("device_write", { path: target, content: "x" }), "ams", new AbortController().signal))
      .rejects.toThrow(/did not answer within/);
    expect(fs.existsSync(target)).toBe(false);
    expect(approvals.pendingFor("pom@ams", "s1")).toEqual([]);
  });
});

describe("device calls: background runs", () => {
  it("refuses at once a call that needs an answer, with no prompt", async () => {
    answerApprovals(true);
    const target = path.join(outside, "w.txt");
    await expect(run("device_write", { path: target, content: "x" }, { runKind: "background" })).rejects.toThrow(/no user is present/);
    expect(asked).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("runs a call that passes in the mode of the chat", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    await run("device_write", { path: path.join(folder, "bg.txt"), content: "ok" }, { runKind: "background" });
    expect(fs.readFileSync(path.join(folder, "bg.txt"), "utf8")).toBe("ok");
  });

  it("passes each call when the agent setting is on, and only for that agent", async () => {
    settings.setAgentFullBackground("pom@ams", true);
    const target = path.join(outside, "w.txt");
    await run("device_write", { path: target, content: "x" }, { runKind: "background" });
    expect(fs.readFileSync(target, "utf8")).toBe("x");
    await expect(run("device_write", { path: target, content: "y" }, { runKind: "background", agentId: "other" })).rejects.toThrow(/no user is present/);
    answerApprovals(true);
    await run("device_write", { path: target, content: "z" }, { runKind: "chat" });
    expect(asked).toEqual(["device_write"]);
  });
});

describe("device settings store", () => {
  it("writes the file with mode 0600", () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: true });
    settings.setAgentFullBackground("pom@ams", true);
    const file = path.join(dir, "device-settings.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(createFileDeviceSettingsStore(file).getChat(chatKey)).toEqual({ workspaceFolder: folder, full: true });
  });

  it("keeps the settings of two different gateway and session pairs apart", () => {
    settings.setChat(deviceChatKey("a", "b:c"), { full: true });
    expect(settings.getChat(deviceChatKey("a:b", "c")).full).toBe(false);
  });
});

describe("device settings routes", () => {
  let app: Hono;
  let enabled: boolean;
  const request = (url: string, init?: RequestInit) => app.request(url, init);
  const put = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    request(url, { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  const chatUrl = "/api/relay/device-settings?agentId=pom%40ams&sessionId=s1";

  beforeEach(() => {
    enabled = true;
    app = new Hono();
    app.use("/api/*", relayDeviceApi({
      isEnabled: () => enabled,
      getGateways: () => [{ name: "ams", url: "http://127.0.0.1:1" }],
      getLinkStates: () => [{ name: "ams", connected: true }],
      settings: () => settings,
    }));
    app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  });

  it("changes the mode when the user sets and removes a folder, and when the user selects Full", async () => {
    expect(await (await request(chatUrl)).json()).toMatchObject({ mode: "ask", workspaceFolder: null, full: false });
    expect(await (await put(chatUrl, { workspaceFolder: folder })).json()).toMatchObject({ mode: "workspace", workspaceFolder: folder });
    expect(await (await put(chatUrl, { full: true })).json()).toMatchObject({ mode: "full", workspaceFolder: folder });
    expect(await (await put(chatUrl, { full: false, workspaceFolder: null })).json()).toMatchObject({ mode: "ask", workspaceFolder: null });
  });

  it("refuses a folder that is not an absolute path to a directory", async () => {
    fs.writeFileSync(path.join(dir, "file.txt"), "x");
    for (const bad of ["relative/dir", path.join(dir, "missing"), path.join(dir, "file.txt"), 5]) {
      expect((await put(chatUrl, { workspaceFolder: bad })).status).toBe(400);
    }
    expect(settings.getChat(chatKey).workspaceFolder).toBeUndefined();
  });

  it("reads and writes the background setting of a remote agent", async () => {
    const url = "/api/relay/agent-settings?agentId=pom%40ams";
    expect(await (await request(url)).json()).toEqual({ agentId: "pom@ams", fullBackground: false });
    expect(await (await put(url, { fullBackground: true })).json()).toEqual({ agentId: "pom@ams", fullBackground: true });
    expect((await put(url, { fullBackground: "yes" })).status).toBe(400);
  });

  it("answers an agent that is not remote with not found", async () => {
    expect((await request("/api/relay/agent-settings?agentId=local-agent")).status).toBe(404);
  });

  it("lists the device links for diagnosis", async () => {
    expect(await (await request("/api/relay/device-links")).json()).toEqual([{ name: "ams", connected: true }]);
  });

  it("answers an untrusted request like an unknown route", async () => {
    const unknown = await request("/api/relay/nothing");
    const headersList: Array<Record<string, string>> = [{ origin: "https://evil.example" }, { "x-forwarded-for": "203.0.113.9" }];
    for (const headers of headersList) {
      const response = await put(chatUrl, { full: true }, headers);
      expect(response.status).toBe(unknown.status);
      expect(await response.json()).toEqual(await unknown.clone().json());
      expect((await request("/api/relay/device-links", { headers })).status).toBe(404);
    }
    expect(settings.getChat(chatKey).full).toBe(false);
  });

  it("answers like an unknown route while the relay is off", async () => {
    enabled = false;
    expect((await request("/api/relay/device-links")).status).toBe(404);
    expect((await request(chatUrl)).status).toBe(404);
    expect((await put(chatUrl, { full: true })).status).toBe(404);
    expect((await request("/api/relay/agent-settings?agentId=pom%40ams")).status).toBe(404);
    expect((await put("/api/relay/agent-settings?agentId=pom%40ams", { fullBackground: true })).status).toBe(404);
    expect(settings.getChat(chatKey).full).toBe(false);
    expect(settings.getAgentFullBackground("pom@ams")).toBe(false);
  });

  it("refuses to write the agent setting from an untrusted request", async () => {
    const url = "/api/relay/agent-settings?agentId=pom%40ams";
    const response = await put(url, { fullBackground: true }, { origin: "https://evil.example" });
    expect(response.status).toBe(404);
    expect(settings.getAgentFullBackground("pom@ams")).toBe(false);
  });

  it("reports the mode that the executor uses when the workspace folder is gone", async () => {
    await put(chatUrl, { workspaceFolder: folder });
    fs.rmSync(folder, { recursive: true });
    expect(await (await request(chatUrl)).json()).toMatchObject({ mode: "ask" });
    await put(chatUrl, { full: true });
    expect(await (await request(chatUrl)).json()).toMatchObject({ mode: "full" });
  });
});
