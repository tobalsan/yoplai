import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCall } from "@yoplai/shared";
import { DeviceApprovals } from "./device-approvals.js";
import { DeviceExecutor } from "./device-exec.js";
import { deviceRunKind } from "./device-extension.js";
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

const run = (tool: string, args: unknown, overrides: Partial<DeviceCall> = {}, signal = new AbortController().signal) =>
  executor.execute(call(tool, args, overrides), "ams", signal);

/** Refuses each approval request and records the path that the gate asked about. */
function refuseApprovals(): void {
  approvals.subscribe((event) => {
    if (event.kind !== "request") return;
    asked.push(String((event.message.arguments as { path?: string }).path));
    approvals.answer(event.message.approvalId, false);
  });
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-paths-")));
  folder = path.join(dir, "workspace");
  outside = path.join(dir, "outside");
  fs.mkdirSync(folder);
  fs.mkdirSync(outside);
  settings = createFileDeviceSettingsStore(path.join(dir, "device-settings.json"));
  settings.setChat(chatKey, { workspaceFolder: folder, full: false });
  approvals = new DeviceApprovals();
  executor = new DeviceExecutor({ settings, approvals, approvalTimeoutMs: 2000 });
  asked = [];
  refuseApprovals();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("device gate: the path that the gate checks is the path that the tool opens", () => {
  it("asks for a write through a link whose name has a Unicode space", async () => {
    fs.symlinkSync(outside, path.join(folder, "a b"));
    await expect(run("device_write", { path: "a\u00a0b/x", content: "escaped" })).rejects.toThrow(/refused/);
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
  });

  it("asks for a write when Pi drops a leading @ and the rest is a link to the outside", async () => {
    fs.symlinkSync(outside, path.join(folder, "esc"));
    await expect(run("device_write", { path: "@esc/x", content: "escaped" })).rejects.toThrow(/refused/);
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
  });

  it("asks for a write to a file URL that points outside the folder", async () => {
    const target = pathToFileURL(path.join(outside, "x")).href;
    await expect(run("device_write", { path: target, content: "escaped" })).rejects.toThrow(/refused/);
    expect(asked).toEqual([path.join(outside, "x")]);
    expect(fs.existsSync(path.join(outside, "x"))).toBe(false);
  });

  it("asks for a write to a path with ~, which is the home folder", async () => {
    await expect(run("device_write", { path: "~/yoplai-never-written.txt", content: "x" })).rejects.toThrow(/refused/);
    expect(asked).toEqual([path.join(os.homedir(), "yoplai-never-written.txt")]);
  });

  it("gives the tool an absolute path that Pi leaves unchanged, and writes the file in the folder", async () => {
    await run("device_write", { path: "plain\u00a0name.txt", content: "inside" });
    expect(fs.readFileSync(path.join(folder, "plain name.txt"), "utf8")).toBe("inside");
    expect(asked).toEqual([]);
  });

  it("asks for an edit through a link whose name has a Unicode space", async () => {
    fs.symlinkSync(outside, path.join(folder, "a b"));
    fs.writeFileSync(path.join(outside, "e.txt"), "old");
    await expect(
      run("device_edit", { path: "a\u00a0b/e.txt", edits: [{ oldText: "old", newText: "new" }] })
    ).rejects.toThrow(/refused/);
    expect(fs.readFileSync(path.join(outside, "e.txt"), "utf8")).toBe("old");
  });
});

describe("device gate: other rules", () => {
  it("asks when the workspace folder no longer exists", async () => {
    fs.rmSync(folder, { recursive: true });
    await expect(run("device_write", { path: path.join(folder, "x.txt"), content: "x" })).rejects.toThrow(/refused/);
    expect(asked).toHaveLength(1);
  });

  it("refuses invalid device_edit arguments before the gate", async () => {
    await expect(run("device_edit", { path: path.join(folder, "e.txt") })).rejects.toThrow(/Invalid arguments/);
    await expect(run("device_edit", { path: path.join(folder, "e.txt"), edits: [{ oldText: 1 }] })).rejects.toThrow(/Invalid arguments/);
    expect(asked).toEqual([]);
  });

  it.each([
    ["device_read", () => ({ path: path.join(folder, "e.txt") })],
    ["device_write", () => ({ path: path.join(outside, "w.txt"), content: "x" })],
    ["device_edit", () => ({ path: path.join(outside, "e.txt"), edits: [{ oldText: "a", newText: "b" }] })],
    ["device_bash", () => ({ command: "echo hi" })],
  ])("treats %s in a background run by the gate rule", async (tool, args) => {
    fs.writeFileSync(path.join(folder, "e.txt"), "a");
    fs.writeFileSync(path.join(outside, "e.txt"), "a");
    const result = run(tool, args(), { runKind: "background" });
    if (tool === "device_read") {
      await expect(result).resolves.toBeDefined();
    } else {
      await expect(result).rejects.toThrow(/no user is present/);
    }
    expect(asked).toEqual([]);
  });

  it("stops a command and its child process when the call is cancelled", async () => {
    settings.setChat(chatKey, { full: true });
    const pidFile = path.join(dir, "child.pid");
    const controller = new AbortController();
    const pending = run("device_bash", { command: `sleep 30 & echo $! > ${pidFile}; wait` }, {}, controller.signal);
    const assertion = expect(pending).rejects.toThrow();
    const end = Date.now() + 3000;
    while (!(fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "")) {
      if (Date.now() > end) throw new Error("the child did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort();
    await assertion;
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const stopBy = Date.now() + 3000;
    while (alive() && Date.now() < stopBy) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alive()).toBe(false);
  });
});

describe("device run kind", () => {
  it("counts a run with no origin as background", () => {
    expect(deviceRunKind(undefined)).toBe("background");
    expect(deviceRunKind({})).toBe("background");
    expect(deviceRunKind({ sender: { kind: "user" } })).toBe("background");
  });

  it("counts a run from the page, the CLI, or a channel as chat", () => {
    for (const source of ["web", "cli", "discord", "slack", "telegram"]) {
      expect(deviceRunKind({ source })).toBe("chat");
    }
  });

  it("counts a scheduled run and a flagged run as background", () => {
    expect(deviceRunKind({ source: "scheduler" })).toBe("background");
    expect(deviceRunKind({ source: "web", background: true })).toBe("background");
  });
});
