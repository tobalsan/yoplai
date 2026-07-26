import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { GatewayConfig } from "@yoplai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpaceIntegrationPolicy } from "./space-policy.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function createRepo(repoDir: string): Promise<void> {
  await fs.mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "-b", "main"]);
  await runGit(repoDir, ["config", "user.name", "Yoplai Test"]);
  await runGit(repoDir, ["config", "user.email", "test@yoplai.local"]);
  await fs.writeFile(path.join(repoDir, "app.txt"), "base\n", "utf8");
  await runGit(repoDir, ["add", "."]);
  await runGit(repoDir, ["commit", "-m", "init"]);
}

async function writeProject(projectDir: string, repo: string): Promise<void> {
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "README.md"),
    [
      "---",
      'id: "PRO-1"',
      'title: "Space Policy Test"',
      `repo: ${JSON.stringify(repo)}`,
      "---",
      "",
      "# Space Policy Test",
      "",
    ].join("\n"),
    "utf8"
  );
}

describe("SpaceIntegrationPolicy", () => {
  let tmpDir: string;
  let config: GatewayConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-space-policy-"));
    config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root: path.join(tmpDir, "projects") },
    } as unknown as GatewayConfig;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("composes state and git to ensure project space", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);
    await writeProject(
      path.join(tmpDir, "projects", "PRO-1_space-policy-test"),
      repoDir
    );

    const policy = new SpaceIntegrationPolicy(config);
    const space = await policy.ensureProjectSpace("PRO-1", "main");

    expect(space.branch).toBe("space/PRO-1");
    await expect(
      fs.stat(path.join(tmpDir, "projects", "PRO-1_space-policy-test", "space.json"))
    ).resolves.toBeDefined();
    await expect(
      runGit(space.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])
    ).resolves.toBe("space/PRO-1");
  });
});

