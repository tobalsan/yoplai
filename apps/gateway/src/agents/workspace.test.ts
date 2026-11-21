import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import { ensureWorkspaceFiles } from "./workspace.js";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "yoplai-workspace-"));
}

describe("agent workspace files", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
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
    expect(entries.sort()).toEqual(["AGENTS.md", "USER.md"]);
  });

  it("reads templates from YOPLAI_TEMPLATES_DIR when it is set", async () => {
    tmpDir = await makeTempDir();
    const templatesDir = await makeTempDir();
    await fs.writeFile(path.join(templatesDir, "AGENTS.md"), "---\nsummary: x\n---\ncustom agents text");
    await fs.writeFile(path.join(templatesDir, "USER.md"), "custom user text");
    vi.stubEnv("YOPLAI_TEMPLATES_DIR", templatesDir);
    try {
      await ensureWorkspaceFiles(tmpDir);

      expect(await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf-8")).toBe("custom agents text");
      expect(await fs.readFile(path.join(tmpDir, "USER.md"), "utf-8")).toBe("custom user text");
    } finally {
      await fs.rm(templatesDir, { recursive: true, force: true });
    }
  });

  it("uses the repo templates when YOPLAI_TEMPLATES_DIR is not set", async () => {
    tmpDir = await makeTempDir();
    vi.stubEnv("YOPLAI_TEMPLATES_DIR", "");

    await ensureWorkspaceFiles(tmpDir);
    const repoAgents = await fs.readFile(path.resolve(import.meta.dirname, "../../../../docs/templates/AGENTS.md"), "utf-8");

    expect((await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf-8")).trim()).toBe(
      repoAgents.replace(/^---[\s\S]*?\n---\s*/, "").trim()
    );
  });

  it("does not inject old workspace files even if they remain", async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "agents");
    await fs.writeFile(path.join(tmpDir, "PERSONA.md"), "persona");
    await fs.writeFile(path.join(tmpDir, "USER.md"), "user");
    await fs.writeFile(path.join(tmpDir, "BOOTSTRAP.md"), "bootstrap");
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), "identity");
    await fs.writeFile(path.join(tmpDir, "TOOLS.md"), "tools");
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "heartbeat");

    const contextFiles = await resolveSystemFiles({ workspaceDir: tmpDir });

    expect(contextFiles.map((file) => file.path).sort()).toEqual([
      "AGENTS.md",
      "USER.md",
    ]);
  });

  it("does not mark existing core workspace as first run", async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "existing");

    await expect(ensureWorkspaceFiles(tmpDir)).resolves.toBe(false);
  });

  it("does not recreate removed core files in an existing workspace", async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "existing");

    await ensureWorkspaceFiles(tmpDir);

    expect(await fs.readdir(tmpDir)).toEqual(["AGENTS.md"]);
  });

  it("restores a missing AGENTS.md in an existing workspace", async () => {
    tmpDir = await makeTempDir();
    await fs.writeFile(path.join(tmpDir, "USER.md"), "existing");

    await expect(ensureWorkspaceFiles(tmpDir)).resolves.toBe(false);
    expect((await fs.readdir(tmpDir)).sort()).toEqual(["AGENTS.md", "USER.md"]);
  });
});
