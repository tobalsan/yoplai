import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayConfig } from "@yoplai/shared";
import {
  getProjectChanges,
  commitProjectChanges,
  getProjectPullRequestTarget,
} from "./git.js";
import { ensureProjectSpace } from "./space.js";

const execFileAsync = promisify(execFile);
const GIT_TEST_TIMEOUT_MS = 30_000;

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(repoDir: string): Promise<void> {
  await fs.mkdir(repoDir, { recursive: true });
  await runGit(repoDir, ["init", "-b", "main"]);
  await runGit(repoDir, ["config", "user.name", "Yoplai Test"]);
  await runGit(repoDir, ["config", "user.email", "test@yoplai.local"]);
  await fs.writeFile(path.join(repoDir, "README.md"), "hello\n", "utf8");
  await runGit(repoDir, ["add", "."]);
  await runGit(repoDir, ["commit", "-m", "init"]);
}

async function writeProjectReadme(
  projectDir: string,
  repo?: string
): Promise<void> {
  const frontmatter = [
    "---",
    'id: "PRO-1"',
    'title: "Changes Test"',
    ...(repo ? [`repo: "${repo}"`] : []),
    "---",
    "",
    "# Changes Test",
    "",
  ].join("\n");
  await fs.writeFile(path.join(projectDir, "README.md"), frontmatter, "utf8");
}

describe("projects git", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let config: GatewayConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-git-"));
    projectsRoot = path.join(tmpDir, "projects");
    await fs.mkdir(projectsRoot, { recursive: true });
    config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: { root: projectsRoot },
    } as unknown as GatewayConfig;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns project changes with diff and stats", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_changes-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    await fs.writeFile(
      path.join(repoDir, "README.md"),
      "hello\nworld\n",
      "utf8"
    );

    const result = await getProjectChanges(config, "PRO-1");

    expect(result.branch).toBe("main");
    expect(result.source.type).toBe("repo");
    expect(result.files.length).toBe(1);
    expect(result.files[0]?.path).toBe("README.md");
    expect(result.files[0]?.status).toBe("modified");
    expect(result.diff).toContain("diff --git a/README.md b/README.md");
    expect(result.stats.filesChanged).toBe(1);
    expect(result.stats.insertions).toBeGreaterThan(0);
  }, GIT_TEST_TIMEOUT_MS);

  it("commits project changes", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_changes-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    await fs.writeFile(
      path.join(repoDir, "README.md"),
      "hello\nworld\n",
      "utf8"
    );

    const commit = await commitProjectChanges(config, "PRO-1", "apply changes");

    expect(commit.ok).toBe(true);
    if (commit.ok) {
      expect(commit.sha.length).toBeGreaterThan(0);
      expect(commit.message).toBe("apply changes");
    }

    const changes = await getProjectChanges(config, "PRO-1");
    expect(changes.files.length).toBe(0);
    expect(changes.stats.filesChanged).toBe(0);
    expect(changes.source.type).toBe("repo");
  }, GIT_TEST_TIMEOUT_MS);

  it("errors when project repo is missing", async () => {
    const projectDir = path.join(projectsRoot, "PRO-1_changes-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir);

    await expect(getProjectChanges(config, "PRO-1")).rejects.toThrow(
      "Project repo not set"
    );
  });

  it("errors when repo is not git", async () => {
    const repoDir = path.join(tmpDir, "repo-not-git");
    await fs.mkdir(repoDir, { recursive: true });

    const projectDir = path.join(projectsRoot, "PRO-1_changes-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    await expect(getProjectChanges(config, "PRO-1")).rejects.toThrow(
      "Not a git repository"
    );
  });

  it("returns nothing to commit", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_changes-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const result = await commitProjectChanges(config, "PRO-1", "noop");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Nothing to commit");
    }
  }, GIT_TEST_TIMEOUT_MS);

  it("prefers Space worktree when project space exists", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_changes-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    await fs.writeFile(path.join(space.worktreePath, "README.md"), "space\n", "utf8");

    const result = await getProjectChanges(config, "PRO-1");

    expect(result.source.type).toBe("space");
    expect(result.source.path).toBe(space.worktreePath);
    expect(result.baseBranch).toBe("main");
    expect(result.branch).toBe("space/PRO-1");
    expect(result.files.length).toBe(1);
  }, GIT_TEST_TIMEOUT_MS);

  it("builds PR compare target from origin remote", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);
    await runGit(repoDir, ["remote", "add", "origin", "git@github.com:acme/yoplai.git"]);

    const projectDir = path.join(projectsRoot, "PRO-1_changes-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    await fs.writeFile(path.join(space.worktreePath, "README.md"), "space\n", "utf8");
    await runGit(space.worktreePath, ["add", "README.md"]);
    await runGit(space.worktreePath, ["commit", "-m", "space change"]);

    const target = await getProjectPullRequestTarget(config, "PRO-1");

    expect(target.branch).toBe("space/PRO-1");
    expect(target.baseBranch).toBe("main");
    expect(target.compareUrl).toContain(
      "https://github.com/acme/yoplai/compare/main...space%2FPRO-1"
    );
  }, GIT_TEST_TIMEOUT_MS);
});
