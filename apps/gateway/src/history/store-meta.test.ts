import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: "" }));
vi.mock("../config/index.js", () => ({ get CONFIG_DIR() { return state.home; } }));
vi.mock("../sessions/store.js", () => ({ getSessionCreatedAt: async () => 1 }));

describe("session metadata values", () => {
  beforeEach(async () => {
    state.home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-meta-"));
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(state.home, { recursive: true, force: true });
  });

  it("reads a persisted value and keeps owners isolated", async () => {
    const { appendSessionMeta, readSessionMeta } = await import("./store.js");
    await appendSessionMeta("agent", "session", "modelRoute", { model: "locked-model" }, "alice");
    expect(await readSessionMeta("agent", "session", "modelRoute", "alice")).toEqual({ model: "locked-model" });
    expect(await readSessionMeta("agent", "session", "modelRoute", "bob")).toBeUndefined();
    expect(await readSessionMeta("agent", "session", "missing", "alice")).toBeUndefined();
  });

  it("returns the last matching value despite malformed and unrelated lines", async () => {
    const { appendSessionMeta, readSessionMeta } = await import("./store.js");
    await appendSessionMeta("agent", "session", "modelRoute", { model: "first" });
    const dir = path.join(state.home, "history");
    const [file] = await fs.readdir(dir);
    await fs.appendFile(path.join(dir, file), "null\n{broken\n");
    await appendSessionMeta("agent", "session", "other", "unrelated");
    await appendSessionMeta("agent", "session", "modelRoute", { model: "last" });
    await fs.appendFile(path.join(dir, file), "{truncated\n");
    expect(await readSessionMeta("agent", "session", "modelRoute")).toEqual({ model: "last" });
  });

  it("keeps one stored winner for simultaneous append-if-absent calls", async () => {
    const { appendSessionMetaIfAbsent, readSessionMeta } = await import("./store.js");
    expect(await Promise.all([
      appendSessionMetaIfAbsent("agent", "session", "modelRoute", { model: "first" }),
      appendSessionMetaIfAbsent("agent", "session", "modelRoute", { model: "second" }),
    ])).toEqual([true, false]);
    expect(await readSessionMeta("agent", "session", "modelRoute")).toEqual({ model: "first" });
  });
});
