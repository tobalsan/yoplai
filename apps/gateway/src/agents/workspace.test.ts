import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import { ensureWorkspaceFiles } from "./workspace.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yoplai-workspace-"));
}

describe("agent workspace files", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("creates only core workspace files for new agents", async () => {
    tmpDir = await makeTempDir();

    const isFirstRun = await ensureWorkspaceFiles(tmpDir);
    const entries = await fs.readdir(tmpDir);

    expect(isFirstRun).toBe(true);
    expect(entries.sort()).toEqual(["AGENTS.md", "SOUL.md", "USER.md"]);
  });

  it("does not inject old workspace files even if they remain", async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents");
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), "soul");
    await fs.writeFile(path.join(tmpDir, "USER.md"), "user");
    await fs.writeFile(path.join(tmpDir, "BOOTSTRAP.md"), "bootstrap");
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), "identity");
    await fs.writeFile(path.join(tmpDir, "TOOLS.md"), "tools");
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "heartbeat");

    const contextFiles = await resolveSystemFiles({ workspaceDir: tmpDir });

    expect(contextFiles.map((file) => file.path).sort()).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "USER.md",
    ]);
  });

  it("does not mark existing core workspace as first run", async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "existing");

    await expect(ensureWorkspaceFiles(tmpDir)).resolves.toBe(false);
  });
});
