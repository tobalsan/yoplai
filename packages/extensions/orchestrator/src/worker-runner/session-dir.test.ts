import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionDir } from "./session-dir.js";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-session-dir-test-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("resolveSessionDir", () => {
  it("returns the new location when neither directory exists yet", () => {
    const resolved = resolveSessionDir(workspace, "claude-sessions");
    expect(resolved).toBe(path.join(workspace, ".yoplai", "claude-sessions"));
  });

  it("returns the new location unchanged when it already has state", async () => {
    const newDir = path.join(workspace, ".yoplai", "claude-sessions");
    await fs.mkdir(newDir, { recursive: true });
    await fs.writeFile(path.join(newDir, "new-session.jsonl"), "{}\n");
    const legacyDir = path.join(workspace, ".aihub", "claude-sessions");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "legacy-session.jsonl"), "{}\n");

    const resolved = resolveSessionDir(workspace, "claude-sessions");

    expect(resolved).toBe(newDir);
    await expect(fs.readdir(newDir)).resolves.toEqual(["new-session.jsonl"]);
    await expect(fs.access(legacyDir)).resolves.toBeUndefined();
  });

  it("migrates a legacy directory into the new location, and future resolutions stay on the new one", async () => {
    const legacyDir = path.join(workspace, ".aihub", "claude-sessions");
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(path.join(legacyDir, "pre-rename.jsonl"), '{"event":"resumed"}\n');

    const newDir = path.join(workspace, ".yoplai", "claude-sessions");
    const first = resolveSessionDir(workspace, "claude-sessions");
    expect(first).toBe(newDir);
    await expect(fs.readdir(newDir)).resolves.toEqual(["pre-rename.jsonl"]);
    await expect(fs.access(legacyDir)).rejects.toThrow();

    await fs.writeFile(path.join(newDir, "post-rename.jsonl"), '{"event":"new"}\n');

    const second = resolveSessionDir(workspace, "claude-sessions");
    expect(second).toBe(newDir);
    await expect(fs.readdir(newDir)).resolves.toEqual(expect.arrayContaining(["pre-rename.jsonl", "post-rename.jsonl"]));
  });
});
