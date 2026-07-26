import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpaceGitAdapter } from "./space-git.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

describe("SpaceGitAdapter", () => {
  let tmpDir: string;
  let git: SpaceGitAdapter;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-space-git-"));
    git = new SpaceGitAdapter();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("collects commits between two SHAs", async () => {
    await runGit(tmpDir, ["init", "-b", "main"]);
    await runGit(tmpDir, ["config", "user.name", "Yoplai Test"]);
    await runGit(tmpDir, ["config", "user.email", "test@yoplai.local"]);
    await fs.writeFile(path.join(tmpDir, "app.txt"), "base\n", "utf8");
    await runGit(tmpDir, ["add", "."]);
    await runGit(tmpDir, ["commit", "-m", "base"]);
    const start = await runGit(tmpDir, ["rev-parse", "HEAD"]);

    await fs.writeFile(path.join(tmpDir, "app.txt"), "next\n", "utf8");
    await runGit(tmpDir, ["add", "."]);
    await runGit(tmpDir, ["commit", "-m", "next"]);
    const end = await runGit(tmpDir, ["rev-parse", "HEAD"]);

    await expect(git.collectCommitShas(tmpDir, start, end)).resolves.toEqual([
      end,
    ]);
  });
});

