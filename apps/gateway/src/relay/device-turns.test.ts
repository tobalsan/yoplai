import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCall } from "@yoplai/shared";
import { DeviceApprovals } from "./device-approvals.js";
import { DeviceExecutor } from "./device-exec.js";
import { AMS } from "./device-turn.fixture.js";
import { createFileDeviceSettingsStore, deviceAgentKey, deviceChatKey, type DeviceSettingsStore, type LinkIdentity } from "./device-settings.js";
import { DeviceTurns, MAX_PENDING_DEVICE_TURNS, TURN_TOKEN_TTL_MS } from "./device-turns.js";

vi.mock("../config/index.js", () => ({ getAgent: () => undefined }));

let dir: string;
let target: string;
let settings: DeviceSettingsStore;
let approvals: DeviceApprovals;
let turns: DeviceTurns;
let executor: DeviceExecutor;
let asked: string[];

const turn = (chat: string, overrides: Partial<{ gateway: string; generation: string; agentId: string }> = {}) =>
  turns.issue({ gateway: AMS.name, generation: AMS.generation, agentId: "pom", chat, page: undefined, ...overrides });

const write = (turnToken: string | undefined, extra: Record<string, unknown> = {}, link: LinkIdentity = AMS) =>
  executor.execute(
    {
      type: "call", callId: `c-${Math.random()}`, tool: "device_write", arguments: { path: target, content: "x" },
      agentId: "pom", toolCallId: "tc", turnToken, ...extra,
    } as DeviceCall,
    link,
    new AbortController().signal
  );

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-turns-")));
  target = path.join(dir, "out.txt");
  settings = createFileDeviceSettingsStore(path.join(dir, "device-settings.json"));
  approvals = new DeviceApprovals();
  turns = new DeviceTurns();
  executor = new DeviceExecutor({ settings, approvals, turns, approvalTimeoutMs: 2000 });
  asked = [];
  approvals.subscribe((event) => {
    if (event.kind !== "request") return;
    asked.push(event.message.chat);
    approvals.answer(event.message.approvalId, true);
  });
  settings.setChat(deviceChatKey(AMS, "pom@ams", "session:A"), { full: true });
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("device call permission: the chat of the turn token", () => {
  it("uses the mode of the chat that owns the token, for two chats of one agent", async () => {
    await write(turn("session:A"));
    expect(asked).toEqual([]);
    await write(turn("session:B"));
    expect(asked).toEqual(["session:B"]);
  });

  it.each([
    ["no token", () => undefined],
    ["an unknown token", () => "not-a-token"],
    ["a token of another gateway", () => turn("session:A", { gateway: "other" })],
    ["a token of another agent", () => turn("session:A", { agentId: "twin" })],
  ])("treats a call with %s as a background call", async (_name, token) => {
    await expect(write(token())).rejects.toThrow(/no user is present/);
    expect(asked).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("applies the Full switch of the agent to a call with no valid token", async () => {
    settings.setAgentFullBackground(deviceAgentKey(AMS, "pom@ams"), true);
    await write(undefined);
    expect(fs.readFileSync(target, "utf8")).toBe("x");
  });

  it("ignores a session ID and a run kind in the call", async () => {
    await expect(write(undefined, { sessionId: "A", runKind: "chat" })).rejects.toThrow(/no user is present/);
    await write(turn("session:B"), { sessionId: "A", runKind: "background" });
    expect(asked).toEqual(["session:B"]);
  });

  it("stops accepting a token after the turn ends", async () => {
    const token = turn("session:A");
    await write(token);
    turns.end(token);
    await expect(write(token)).rejects.toThrow(/no user is present/);
  });

  it("stops accepting a token 2 hours after its creation", async () => {
    vi.useFakeTimers();
    const token = turn("session:A");
    vi.advanceTimersByTime(TURN_TOKEN_TTL_MS - 1000);
    await write(token);
    vi.advanceTimersByTime(2000);
    await expect(write(token)).rejects.toThrow(/no user is present/);
  });
});

describe("device turn limits", () => {
  it("ends a turn once, and a second end changes nothing", async () => {
    const token = turn("session:A");
    const other = turn("session:A");
    turns.end(token);
    turns.end(token);
    await expect(write(token)).rejects.toThrow(/no user is present/);
    await write(other);
    expect(asked).toEqual([]);
  });

  it("frees the pending limit when turns end or expire", async () => {
    vi.useFakeTimers();
    const tokens = Array.from({ length: MAX_PENDING_DEVICE_TURNS }, () => turn("key:main"));
    expect(() => turn("key:main")).toThrow(/Too many pending device turns/);
    turns.end(tokens[0]);
    turn("key:main");
    expect(() => turn("key:main")).toThrow(/Too many pending device turns/);
    vi.advanceTimersByTime(TURN_TOKEN_TTL_MS);
    for (const token of tokens.slice(1)) await expect(write(token)).rejects.toThrow(/no user is present/);
    const fresh = turn("session:A");
    await write(fresh);
    expect(fs.readFileSync(target, "utf8")).toBe("x");
  });
});

describe("device grants: the link that made them", () => {
  const REPLACEMENT: LinkIdentity = { name: AMS.name, generation: "ams-link-2" };

  it("gives a link that replaces the name none of the chat or background grants of the old link", async () => {
    settings.setAgentFullBackground(deviceAgentKey(AMS, "pom@ams"), true);
    await write(turn("session:A"));
    await write(undefined);
    fs.rmSync(target);
    // The same name, agent and chat. The replacement has another generation, so the old Full grants do not apply.
    await expect(write(undefined, {}, REPLACEMENT)).rejects.toThrow(/no user is present/);
    await write(turn("session:A", { generation: REPLACEMENT.generation }), {}, REPLACEMENT);
    expect(asked).toEqual(["session:A"]);
  });

  it("refuses a turn of the old link on the replacement link", async () => {
    const oldTurn = turn("session:A");
    await expect(write(oldTurn, {}, REPLACEMENT)).rejects.toThrow(/no user is present/);
    expect(fs.existsSync(target)).toBe(false);
    expect(asked).toEqual([]);
  });

  it("ignores grants in a settings file from before links had a generation", async () => {
    fs.writeFileSync(
      path.join(dir, "device-settings.json"),
      JSON.stringify({
        chats: { [JSON.stringify(["ams", "pom@ams", "session:B"])]: { full: true } },
        agents: { "pom@ams": { fullBackground: true } },
      })
    );
    await expect(write(undefined)).rejects.toThrow(/no user is present/);
    await write(turn("session:B"));
    expect(asked).toEqual(["session:B"]);
  });
});
