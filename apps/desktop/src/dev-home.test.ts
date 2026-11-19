import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDevHome, seedDevHome } from "./dev-home.js";

let root: string;
let userHome: string;
let appData: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-dev-home-"));
  userHome = path.join(root, "user");
  appData = path.join(root, "app-data");
  fs.mkdirSync(userHome);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("uses the default home even when the legacy home exists", () => {
  const legacy = path.join(userHome, ".aihub");
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "aihub.json"), "{}");
  const selected = createDevHome({ HOME: userHome, AIHUB_HOME: legacy }, [], appData);
  expect(selected).toMatchObject({ mode: "persistent", home: path.join(userHome, ".yoplai"), userHome });
  seedDevHome(selected, {});
  expect(JSON.parse(fs.readFileSync(path.join(selected.home, "yoplai.json"), "utf8"))).toMatchObject({
    agents: "$YOPLAI_HOME/agents/*", gateway: { bind: "loopback" }, ui: { bind: "loopback" },
    oauth: { encryptionKey: "$env:OAUTH_ENCRYPTION_KEY" },
  });
  expect(parseEnv(fs.readFileSync(path.join(selected.home, ".env"), "utf8")).OAUTH_ENCRYPTION_KEY).toMatch(/^[\w-]{43}$/);
});

it("expands a quoted tilde and isolates user data by home and mode", () => {
  const env = { HOME: userHome, YOPLAI_HOME: "~/state", YOPLAI_DESKTOP_DEV_PARENT: root };
  const persistent = createDevHome(env, [], appData);
  expect(persistent.home).toBe(path.join(userHome, "state"));
  expect(createDevHome({ ...env, YOPLAI_HOME: persistent.home }, [], appData).userData).toBe(persistent.userData);
  expect(createDevHome({ ...env, YOPLAI_HOME: "~/other" }, [], appData).userData).not.toBe(persistent.userData);
  const fresh = createDevHome(env, ["--fresh"], appData);
  const next = createDevHome({ ...env, YOPLAI_DESKTOP_FRESH: "1" }, [], appData);
  expect(fresh.mode).toBe("fresh");
  expect(path.dirname(fresh.userHome!)).toBe(root);
  expect(fresh.home).toBe(path.join(fresh.userHome!, "home"));
  seedDevHome(fresh, env);
  expect(fs.existsSync(path.join(fresh.home, "yoplai.json"))).toBe(true);
  expect(next.mode).toBe("fresh");
  expect(next.home).not.toBe(fresh.home);
  expect(new Set([persistent.userData, fresh.userData, next.userData]).size).toBe(3);
});

it.each(["aihub.json", "yoplai.json"])("preserves an older home with %s", (name) => {
  const env = { HOME: userHome, YOPLAI_HOME: "~/older" };
  const selected = createDevHome(env, [], appData);
  const oldFiles = {
    [name]: '{\r\n  "version":3, "agents":[], "gateway":{"bind":"loopback"}, "ui":{"bind":"loopback"}\r\n}',
    "agents/sample/agent.yaml": "id: sample\nname: Sample\nmodel:\n  provider: openai\n  model: gpt-4o-mini\n",
    "sessions/sample/old.jsonl": '{"type":"session","version":3,"id":"old"}\n',
    ".env": 'export OAUTH_ENCRYPTION_KEY="old-fake-key"\r\nOTHER=value',
  };
  for (const [relative, contents] of Object.entries(oldFiles)) {
    const file = path.join(selected.home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  const warn = vi.fn();
  seedDevHome(selected, env, warn);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("No agent discovery rules"));
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("No usable oauth.encryptionKey"));
  for (const [relative, contents] of Object.entries(oldFiles)) {
    expect(fs.readFileSync(path.join(selected.home, relative))).toEqual(Buffer.from(contents));
  }
  if (name === "aihub.json") expect(fs.existsSync(path.join(selected.home, "yoplai.json"))).toBe(false);
});

it("appends a key after the original bytes and does not append it twice", () => {
  const env = { HOME: userHome };
  const selected = createDevHome(env, [], appData);
  const envFile = path.join(selected.home, ".env");
  const original = Buffer.from('# OAUTH_ENCRYPTION_KEY=comment\r\nOTHER="OAUTH_ENCRYPTION_KEY=not-a-key"');
  fs.writeFileSync(envFile, original);
  const warn = vi.fn();
  seedDevHome(selected, env, warn);
  const seeded = fs.readFileSync(envFile);
  expect(seeded.subarray(0, original.length)).toEqual(original);
  expect(seeded.subarray(original.length).toString()).toMatch(/^\nOAUTH_ENCRYPTION_KEY=[\w-]{43}\n$/);
  seedDevHome(selected, env, warn);
  expect(fs.readFileSync(envFile)).toEqual(seeded);
  expect(warn).not.toHaveBeenCalled();
});

it("warns if the configured OAuth key has no value", () => {
  const env = { HOME: userHome };
  const selected = createDevHome(env, [], appData);
  fs.writeFileSync(path.join(selected.home, "yoplai.json"), '{"version":3,"oauth":{"encryptionKey":"$env:CUSTOM_KEY"}}');
  const warn = vi.fn();
  expect(seedDevHome(selected, env, warn)).toBe("CUSTOM_KEY");
  expect(warn).toHaveBeenCalledOnce();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("No usable oauth.encryptionKey"));
  warn.mockClear();
  seedDevHome(selected, { ...env, CUSTOM_KEY: "fake-key" }, warn);
  expect(warn).not.toHaveBeenCalled();
});
