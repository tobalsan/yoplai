import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceCall } from "@yoplai/shared";
import { DeviceApprovals } from "./device-approvals.js";
import { issueTestTurn } from "./device-turn.fixture.js";
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
const chatKey = deviceChatKey("ams", "pom@ams", "session:s1");

function call(tool: string, args: unknown, overrides: Partial<DeviceCall> = {}): DeviceCall {
  return {
    type: "call", callId: `call-${Math.random()}`, tool, arguments: args,
    agentId: "pom", toolCallId: "tc1", turnToken: issueTestTurn(), ...overrides,
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

describe("device gate: the file operations compare the path that Pi opens", () => {
  const tools = ["device_write", "device_edit"] as const;
  const forms: [string, (target: string) => string][] = [
    ["file URL", (target) => `file://${target}`],
    ["file URL with localhost", (target) => `file://localhost${target}`],
    ["file URL with a leading @", (target) => `@file://${target}`],
  ];

  it.each(tools.flatMap((tool) => forms.map((form) => [tool, ...form] as const)))(
    "%s keeps the outside file unchanged for a %s with an escaped Unicode space",
    async (tool, _name, form) => {
      fs.symlinkSync(outside, path.join(folder, "a b"));
      fs.writeFileSync(path.join(outside, "x"), "old");
      const raw = form(`${folder}/a%C2%A0b/x`);
      const args =
        tool === "device_write"
          ? { path: raw, content: "escaped" }
          : { path: raw, edits: [{ oldText: "old", newText: "new" }] };
      await run(tool, args).catch(() => undefined);
      expect(fs.readFileSync(path.join(outside, "x"), "utf8")).toBe("old");
    }
  );

  it.each(["device_write", "device_edit"])(
    "%s throws and writes nothing when the checked path differs from the path of Pi",
    async (tool) => {
      fs.symlinkSync(outside, path.join(folder, "a b"));
      fs.writeFileSync(path.join(outside, "x"), "old");
      const wrongPath = new DeviceExecutor({
        settings, approvals, approvalTimeoutMs: 2000,
        resolvePath: (cwd) => `${cwd}/a\u00a0b/x`,
      });
      const args =
        tool === "device_write"
          ? { path: "ignored", content: "escaped" }
          : { path: "ignored", edits: [{ oldText: "old", newText: "new" }] };
      await expect(wrongPath.execute(call(tool, args), "ams", new AbortController().signal)).rejects.toThrow(
        /path changed after the permission check/
      );
      expect(fs.readFileSync(path.join(outside, "x"), "utf8")).toBe("old");
      expect(asked).toEqual([]);
    }
  );

  it("treats an escaped percent sign as a literal name", async () => {
    await run("device_write", { path: path.join(folder, "p%2520q.txt"), content: "in" });
    expect(fs.readFileSync(path.join(folder, "p%2520q.txt"), "utf8")).toBe("in");
  });

  it("handles a mix of @, ~, and a Unicode space with no write outside the folder", async () => {
    await expect(run("device_write", { path: "@~/yoplai\u00a0never.txt", content: "x" })).rejects.toThrow();
    expect(fs.existsSync(path.join(os.homedir(), "yoplai never.txt"))).toBe(false);
  });

  it("writes in a workspace folder whose name has a percent sign", async () => {
    const odd = path.join(dir, "w%20x");
    fs.mkdirSync(odd);
    settings.setChat(chatKey, { workspaceFolder: odd, full: false });
    await run("device_write", { path: "n.txt", content: "ok" });
    expect(fs.readFileSync(path.join(odd, "n.txt"), "utf8")).toBe("ok");
    expect(asked).toEqual([]);
  });

  it("asks, and writes nothing, in a workspace folder whose name has a Unicode space, which Pi cannot open", async () => {
    const odd = path.join(dir, "w\u00a0s");
    fs.mkdirSync(odd);
    settings.setChat(chatKey, { workspaceFolder: odd, full: false });
    await expect(run("device_write", { path: "n.txt", content: "no" })).rejects.toThrow(/refused/);
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(path.join(odd, "n.txt"))).toBe(false);
  });

  it("still writes a relative path, an absolute path, and a new sub-directory, and edits a file", async () => {
    await run("device_write", { path: "rel.txt", content: "r" });
    await run("device_write", { path: path.join(folder, "abs.txt"), content: "a" });
    await run("device_write", { path: "sub/deeper/new.txt", content: "n" });
    await run("device_edit", { path: "rel.txt", edits: [{ oldText: "r", newText: "e" }] });
    expect(fs.readFileSync(path.join(folder, "rel.txt"), "utf8")).toBe("e");
    expect(fs.readFileSync(path.join(folder, "abs.txt"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(folder, "sub/deeper/new.txt"), "utf8")).toBe("n");
    expect(asked).toEqual([]);
  });

  it("writes outside the folder after the user approves", async () => {
    const target = path.join(outside, "ok.txt");
    // The subscriber from beforeEach refuses, so use a fresh approvals object.
    approvals = new DeviceApprovals();
    executor = new DeviceExecutor({ settings, approvals, approvalTimeoutMs: 2000 });
    approvals.subscribe((event) => {
      if (event.kind === "request") approvals.answer(event.message.approvalId, true);
    });
    await run("device_write", { path: target, content: "approved" });
    expect(fs.readFileSync(target, "utf8")).toBe("approved");
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
    const result = run(tool, args(), { turnToken: undefined });
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
