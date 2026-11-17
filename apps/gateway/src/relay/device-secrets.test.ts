import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHomeDir, type DeviceCall } from "@yoplai/shared";
import { DeviceApprovals } from "./device-approvals.js";
import { AMS, issueTestTurn } from "./device-turn.fixture.js";
import { DeviceExecutor } from "./device-exec.js";
import { createFileDeviceSettingsStore, deviceAgentKey, deviceChatKey, type DeviceSettingsStore } from "./device-settings.js";
import { DEVICE_TOOL_DEFINITIONS } from "./device-tools.js";
import { isSecretPath, secretReadRefusal } from "./device-secrets.js";

vi.mock("../config/index.js", () => ({ getAgent: () => undefined }));

describe("secret paths of a device", () => {
  it.each([
    "/Users/ann/.ssh/id_rsa",
    "/Users/ann/.SSH/config",
    "/Users/ann/.gnupg/pubring.kbx",
    "/Users/ann/.aws/credentials",
    "/Users/ann/.azure/accessTokens.json",
    "/Users/ann/.kube/config",
    "/Users/ann/.password-store/mail.gpg",
    "/Users/ann/.config/gcloud/credentials.db",
    "/Users/ann/Library/Keychains/login.keychain-db",
    "/Users/ann/.docker/config.json",
    "/work/app/.env",
    "/work/app/.ENV",
    "/work/app/.env.local",
    "/work/app/.env.production",
    "/home/ann/.netrc",
    "/home/ann/.npmrc",
    "/home/ann/.pypirc",
    "/home/ann/.git-credentials",
    "/srv/.htpasswd",
    "/work/auth.json",
    "/work/credentials",
    "/work/credentials.json",
    "/work/id_rsa.pub",
    "/work/id_dsa",
    "/work/id_ecdsa",
    "/work/id_ed25519",
    "/work/server.pem",
    "/work/server.KEY",
    "/work/cert.p12",
    "/work/cert.pfx",
    "/work/x.keychain-db",
    "/work/vault.kdbx",
  ])("treats %s as secret", (target) => {
    expect(isSecretPath(target)).toBe(true);
  });

  it.each([
    "/work/app/.env.example",
    "/work/app/.env.sample",
    "/work/app/.env.template",
    "/work/app/.env.dist",
    "/work/src/environment.ts",
    "/work/docs/keyboard.md",
    "/work/notes/monkey.txt",
    "/work/.config/other/settings.json",
    "/work/library/books.txt",
    "/work/docker/config.json",
    "/work/ssh/readme.md",
    "/work/README.md",
  ])("does not treat %s as secret", (target) => {
    expect(isSecretPath(target)).toBe(false);
  });

  it("treats the files of the Yoplai home as secret", () => {
    const home = process.env.YOPLAI_HOME ?? path.join(os.homedir(), ".yoplai");
    for (const file of ["remote-gateways.json", "device-settings.json", "user-token.json", "auth.db"]) {
      expect(isSecretPath(path.join(home, file))).toBe(true);
    }
    expect(isSecretPath(path.join(home, "yoplai.json"))).toBe(false);
  });
});

describe("device calls and secret files", () => {
  let dir: string;
  let folder: string;
  let secret: string;
  let settings: DeviceSettingsStore;
  let approvals: DeviceApprovals;
  let executor: DeviceExecutor;
  let asked: Array<{ tool: string; path: string }>;
  let previousHome: string | undefined;
  const chatKey = deviceChatKey(AMS, "pom@ams", "session:s1");

  const call = (tool: string, args: unknown, overrides: Partial<DeviceCall> = {}): DeviceCall => ({
    type: "call", callId: `call-${Math.random()}`, tool, arguments: args,
    agentId: "pom", toolCallId: "tc1", turnToken: issueTestTurn(), ...overrides,
  });
  const run = (tool: string, args: unknown, overrides: Partial<DeviceCall> = {}) =>
    executor.execute(call(tool, args, overrides), AMS, new AbortController().signal);
  const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-secrets-")));
    folder = path.join(dir, "workspace");
    fs.mkdirSync(path.join(folder, ".ssh"), { recursive: true });
    secret = path.join(folder, ".ssh", "id_rsa");
    fs.writeFileSync(secret, "PRIVATE-KEY");
    fs.writeFileSync(path.join(folder, "notes.txt"), "plain notes");
    fs.writeFileSync(path.join(folder, ".env.example"), "EXAMPLE=1");
    previousHome = process.env.HOME;
    process.env.HOME = dir;
    settings = createFileDeviceSettingsStore(path.join(dir, "device-settings.json"));
    approvals = new DeviceApprovals();
    executor = new DeviceExecutor({ settings, approvals, approvalTimeoutMs: 2000 });
    asked = [];
    approvals.subscribe((event) => {
      if (event.kind !== "request") return;
      asked.push({ tool: event.message.tool, path: String((event.message.arguments as { path?: string }).path) });
      approvals.answer(event.message.approvalId, false);
    });
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const modes: Array<[string, () => void, Partial<DeviceCall>]> = [
    ["Ask mode", () => settings.setChat(chatKey, { full: false }), {}],
    ["Workspace mode", () => settings.setChat(chatKey, { workspaceFolder: folder, full: false }), {}],
    ["a background run", () => settings.setChat(chatKey, { workspaceFolder: folder, full: false }), { turnToken: undefined }],
  ];

  it.each(modes)("refuses a read of a secret file in %s with no prompt", async (_name, setup, overrides) => {
    setup();
    await expect(run("device_read", { path: secret }, overrides)).rejects.toThrow(secretReadRefusal(secret));
    expect(asked).toEqual([]);
  });

  it("still reads a file that is not secret in Ask mode", async () => {
    settings.setChat(chatKey, { full: false });
    expect(textOf(await run("device_read", { path: path.join(folder, "notes.txt") }))).toBe("plain notes");
    expect(textOf(await run("device_read", { path: path.join(folder, ".env.example") }))).toBe("EXAMPLE=1");
  });

  it("refuses a call outside Full mode when the real path of the home directory cannot be read", async () => {
    const realpath = fs.realpathSync;
    const home = path.resolve(resolveHomeDir());
    const spy = vi.spyOn(fs, "realpathSync").mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(target)) === home) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return (realpath as (...args: unknown[]) => string)(target, ...rest);
    }) as typeof fs.realpathSync);
    try {
      settings.setChat(chatKey, { full: false });
      await expect(run("device_read", { path: path.join(folder, "notes.txt") })).rejects.toThrow(/secret files/);
      settings.setChat(chatKey, { workspaceFolder: folder, full: true });
      expect(textOf(await run("device_read", { path: path.join(folder, "notes.txt") }))).toBe("plain notes");
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a secret file in Full mode", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: true });
    expect(textOf(await run("device_read", { path: secret }))).toBe("PRIVATE-KEY");
  });

  it("reads a secret file in a background run with the Full switch of the agent", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    settings.setAgentFullBackground(deviceAgentKey(AMS, "pom@ams"), true);
    expect(textOf(await run("device_read", { path: secret }, { turnToken: undefined }))).toBe("PRIVATE-KEY");
  });

  it("refuses a read through a symbolic link that points to a secret file", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    const link = path.join(folder, "innocent.txt");
    fs.symlinkSync(secret, link);
    await expect(run("device_read", { path: link })).rejects.toThrow(/secret files/);
    await expect(run("device_read", { path: "innocent.txt" })).rejects.toThrow(/secret files/);
    expect(asked).toEqual([]);
  });

  it("refuses a read when the real path lookup fails with an error other than a missing file", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    const link = path.join(folder, "innocent.txt");
    fs.symlinkSync(secret, link);
    const realpath = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (target, ...rest) => {
      if (String(target) === link) throw Object.assign(new Error("disk error"), { code: "EIO" });
      return realpath(target, ...(rest as []));
    });
    try {
      await expect(run("device_read", { path: link })).rejects.toThrow(
        `The device cannot check ${link} against the list of secret files. The call did not run.`
      );
      expect(asked).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not let a write or an edit that passed with no prompt change a secret file when the path becomes a link", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    const target = path.join(folder, "later.txt");
    fs.writeFileSync(target, "plain notes");
    const realpath = fsPromises.realpath.bind(fsPromises);
    let gateDone = false;
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (value, ...rest) => {
      const result = await realpath(value, ...(rest as []));
      if (!gateDone && String(value) === target) {
        gateDone = true;
        fs.rmSync(target);
        fs.symlinkSync(secret, target);
      }
      return result;
    });
    try {
      await expect(run("device_write", { path: target, content: "WRITE-CHANGE" })).rejects.toThrow(/secret files/);
      gateDone = false;
      fs.rmSync(target);
      fs.writeFileSync(target, "PRIVATE-KEY");
      await expect(
        run("device_edit", { path: target, edits: [{ oldText: "PRIVATE", newText: "EDIT-CHANGE" }] })
      ).rejects.toThrow(/secret files/);
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.readFileSync(secret, "utf8")).toBe("PRIVATE-KEY");
    expect(asked).toEqual([]);
  });

  it("refuses a read through a symbolic link to a folder with secret files", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    fs.symlinkSync(path.join(folder, ".ssh"), path.join(folder, "keys"));
    await expect(run("device_read", { path: "keys/id_rsa" })).rejects.toThrow(/secret files/);
  });

  it("refuses a secret path in the forms that Pi rewrites", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    fs.mkdirSync(path.join(dir, "sub dir", ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sub dir", ".ssh", "id_rsa"), "PRIVATE-KEY");
    fs.mkdirSync(path.join(dir, ".ssh"));
    fs.writeFileSync(path.join(dir, ".ssh", "config"), "Host x");
    const forms = [
      path.join(dir, "sub\u00a0dir", ".ssh", "id_rsa"),
      "@.ssh/id_rsa",
      pathToFileURL(secret).href,
      "~/.ssh/config",
    ];
    for (const form of forms) {
      await expect(run("device_read", { path: form })).rejects.toThrow(/secret files/);
    }
    expect(asked).toEqual([]);
  });

  it("refuses at the point of use, also when the gate was not asked", async () => {
    const link = path.join(folder, "innocent.txt");
    fs.symlinkSync(secret, link);
    const tool = DEVICE_TOOL_DEFINITIONS.device_read.create(folder, undefined, true);
    await expect(tool.execute("c1", { path: ".ssh/id_rsa" } as never)).rejects.toThrow(/secret files/);
    await expect(tool.execute("c2", { path: "innocent.txt" } as never)).rejects.toThrow(/secret files/);
    await expect(tool.execute("c3", { path: "@.ssh/id_rsa" } as never)).rejects.toThrow(/secret files/);
    const open = DEVICE_TOOL_DEFINITIONS.device_read.create(folder, undefined, false);
    expect(textOf(await open.execute("c4", { path: "innocent.txt" } as never))).toBe("PRIVATE-KEY");
  });

  it("asks before a write to a secret file in the workspace folder, and not for a plain file", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    await expect(run("device_write", { path: ".env", content: "TOKEN=1" })).rejects.toThrow(/refused/);
    await expect(run("device_edit", { path: ".ssh/id_rsa", edits: [{ oldText: "PRIVATE", newText: "X" }] })).rejects.toThrow(/refused/);
    expect(asked.map((item) => item.path)).toEqual([path.join(folder, ".env"), secret]);
    await run("device_write", { path: "plain.txt", content: "ok" });
    expect(asked).toHaveLength(2);
    expect(fs.readFileSync(path.join(folder, "plain.txt"), "utf8")).toBe("ok");
    expect(fs.existsSync(path.join(folder, ".env"))).toBe(false);
  });

  it("refuses a write to a secret file in a background run, as a call that asks", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: false });
    await expect(run("device_write", { path: ".env", content: "x" }, { turnToken: undefined })).rejects.toThrow(/needs the approval/);
    expect(asked).toEqual([]);
  });

  it("writes a secret file in Full mode", async () => {
    settings.setChat(chatKey, { workspaceFolder: folder, full: true });
    await run("device_write", { path: ".env", content: "TOKEN=1" });
    expect(fs.readFileSync(path.join(folder, ".env"), "utf8")).toBe("TOKEN=1");
  });
});
