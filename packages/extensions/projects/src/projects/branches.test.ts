import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureProjectIntegrationBranch } from "./branches.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 30_000;

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepo(repo: string): Promise<void> {
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ["init", "-b", "main"]);
  await runGit(repo, ["config", "user.name", "Yoplai Test"]);
  await runGit(repo, ["config", "user.email", "test@yoplai.local"]);
  await fs.writeFile(path.join(repo, "app.txt"), "one\n", "utf8");
  await runGit(repo, ["add", "app.txt"]);
  await runGit(repo, ["commit", "-m", "init"]);
}

async function commitFile(
  repo: string,
  fileName: string,
  content: string,
  message: string
): Promise<string> {
  await fs.writeFile(path.join(repo, fileName), content, "utf8");
  await runGit(repo, ["add", fileName]);
  await runGit(repo, ["commit", "-m", message]);
  return runGit(repo, ["rev-parse", "HEAD"]);
}

describe("project integration branches", () => {
  let tmpDir: string;
  let repo: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-branches-"));
    repo = path.join(tmpDir, "repo");
    await createRepo(repo);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it(
    "creates the project integration branch from main",
    async () => {
      const mainSha = await runGit(repo, ["rev-parse", "refs/heads/main"]);

      const branch = await ensureProjectIntegrationBranch(repo, "PRO-242");

      expect(branch).toBe("PRO-242/integration");
      expect(await runGit(repo, ["rev-parse", `refs/heads/${branch}`])).toBe(
        mainSha
      );
    },
    TEST_TIMEOUT_MS
  );

  it(
    "is idempotent when called twice",
    async () => {
      const branch = await ensureProjectIntegrationBranch(repo, "PRO-242");
      const firstSha = await runGit(repo, [
        "rev-parse",
        `refs/heads/${branch}`,
      ]);

      const secondBranch = await ensureProjectIntegrationBranch(
        repo,
        "PRO-242"
      );
      const secondSha = await runGit(repo, [
        "rev-parse",
        `refs/heads/${branch}`,
      ]);

      expect(secondBranch).toBe(branch);
      expect(secondSha).toBe(firstSha);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "does not rebase an existing integration branch when main advances",
    async () => {
      const branch = await ensureProjectIntegrationBranch(repo, "PRO-242");
      const branchSha = await runGit(repo, [
        "rev-parse",
        `refs/heads/${branch}`,
      ]);

      await commitFile(repo, "app.txt", "two\n", "main advances");
      const mainSha = await runGit(repo, ["rev-parse", "refs/heads/main"]);

      await ensureProjectIntegrationBranch(repo, "PRO-242");

      expect(await runGit(repo, ["rev-parse", `refs/heads/${branch}`])).toBe(
        branchSha
      );
      expect(branchSha).not.toBe(mainSha);
    },
    TEST_TIMEOUT_MS
  );

  it(
    "uses current main when creating for the first time",
    async () => {
      const mainSha = await commitFile(
        repo,
        "app.txt",
        "two\n",
        "main advances"
      );

      const branch = await ensureProjectIntegrationBranch(repo, "PRO-999");

      expect(await runGit(repo, ["rev-parse", `refs/heads/${branch}`])).toBe(
        mainSha
      );
    },
    TEST_TIMEOUT_MS
  );
});
