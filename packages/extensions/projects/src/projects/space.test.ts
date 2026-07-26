import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayConfig } from "@yoplai/shared";
import {
  ensureProjectSpace,
  getProjectSpace,
  integrateSpaceEntries,
  integrateProjectSpaceQueue,
  mergeSpaceIntoBase,
  rebaseSpaceOntoMain,
  recordWorkerDelivery,
  skipSpaceEntries,
} from "./space.js";

const execFileAsync = promisify(execFile);
const SPACE_TEST_TIMEOUT_MS = 30_000;

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

async function writeProjectReadme(projectDir: string, repo: string): Promise<void> {
  const frontmatter = [
    "---",
    'id: "PRO-1"',
    'title: "Space Test"',
    `repo: ${JSON.stringify(repo)}`,
    "---",
    "",
    "# Space Test",
    "",
  ].join("\n");
  await fs.writeFile(path.join(projectDir, "README.md"), frontmatter, "utf8");
}

async function attachOriginRemote(repoDir: string, rootDir: string): Promise<string> {
  const remoteDir = path.join(rootDir, `origin-${Date.now()}.git`);
  await runGit(rootDir, ["init", "--bare", remoteDir]);
  await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
  await runGit(repoDir, ["push", "-u", "origin", "main"]);
  return remoteDir;
}

describe("project space", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let config: GatewayConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-space-"));
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

  it("creates and persists project space", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");

    expect(space.branch).toBe("space/PRO-1");
    expect(space.baseBranch).toBe("main");
    await expect(fs.stat(path.join(projectDir, "space.json"))).resolves.toBeDefined();
    expect(await runGit(space.worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(
      "space/PRO-1"
    );
  }, SPACE_TEST_TIMEOUT_MS);

  it("queues worker worktree commits and integrates on explicit request", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    const workerPath = path.join(projectsRoot, ".workspaces", "PRO-1", "alpha");
    await fs.mkdir(path.dirname(workerPath), { recursive: true });
    await runGit(repoDir, [
      "worktree",
      "add",
      "-b",
      "PRO-1/alpha",
      workerPath,
      "main",
    ]);

    const start = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(workerPath, "app.txt"), "worker-one\n", "utf8");
    await runGit(workerPath, ["add", "app.txt"]);
    await runGit(workerPath, ["commit", "-m", "worker one"]);
    const end = await runGit(workerPath, ["rev-parse", "HEAD"]);

    const updated = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: workerPath,
      startSha: start,
      endSha: end,
    });

    expect(updated.integrationBlocked).toBe(false);
    expect(updated.queue[0]?.status).toBe("pending");
    const beforeIntegrate = await fs.readFile(
      path.join(space.worktreePath, "app.txt"),
      "utf8"
    );
    expect(beforeIntegrate).not.toContain("worker-one");

    const integrated = await integrateProjectSpaceQueue(config, "PRO-1");
    expect(integrated.queue[0]?.status).toBe("integrated");
    const content = await fs.readFile(
      path.join(space.worktreePath, "app.txt"),
      "utf8"
    );
    expect(content).toContain("worker-one");
  }, SPACE_TEST_TIMEOUT_MS);

  it(
    "blocks queue on conflict and resumes later pending entries",
    async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const workspacesRoot = path.join(projectsRoot, ".workspaces", "PRO-1");
    await fs.mkdir(workspacesRoot, { recursive: true });
    await ensureProjectSpace(config, "PRO-1", "main");

    const alphaPath = path.join(workspacesRoot, "alpha");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/alpha", alphaPath, "main"]);
    const alphaStart = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(alphaPath, "app.txt"), "worker-one\n", "utf8");
    await runGit(alphaPath, ["add", "app.txt"]);
    await runGit(alphaPath, ["commit", "-m", "alpha"]);
    const alphaEnd = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    const alphaQueued = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: alphaPath,
      startSha: alphaStart,
      endSha: alphaEnd,
    });
    expect(
      alphaQueued.queue.some(
        (item) => item.workerSlug === "alpha" && item.status === "pending"
      )
    ).toBe(true);

    const betaPath = path.join(workspacesRoot, "beta");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/beta", betaPath, "main"]);
    const betaStart = await runGit(betaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(betaPath, "app.txt"), "worker-two\n", "utf8");
    await runGit(betaPath, ["add", "app.txt"]);
    await runGit(betaPath, ["commit", "-m", "beta"]);
    const betaEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);
    const betaQueued = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "beta",
      runMode: "worktree",
      worktreePath: betaPath,
      startSha: betaStart,
      endSha: betaEnd,
    });
    expect(betaQueued.integrationBlocked).toBe(false);
    expect(
      betaQueued.queue.some(
        (item) => item.workerSlug === "beta" && item.status === "pending"
      )
    ).toBe(true);

    const blocked = await integrateProjectSpaceQueue(config, "PRO-1");
    expect(blocked.integrationBlocked).toBe(true);
    expect(blocked.queue.some((item) => item.status === "conflict")).toBe(true);

    const gammaPath = path.join(workspacesRoot, "gamma");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/gamma", gammaPath, "main"]);
    const gammaStart = await runGit(gammaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(gammaPath, "note.txt"), "ok\n", "utf8");
    await runGit(gammaPath, ["add", "note.txt"]);
    await runGit(gammaPath, ["commit", "-m", "gamma"]);
    const gammaEnd = await runGit(gammaPath, ["rev-parse", "HEAD"]);
    const pending = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "gamma",
      runMode: "worktree",
      worktreePath: gammaPath,
      startSha: gammaStart,
      endSha: gammaEnd,
    });
    expect(pending.integrationBlocked).toBe(true);
    expect(pending.queue.some((item) => item.workerSlug === "gamma" && item.status === "pending")).toBe(true);

    const resumed = await integrateProjectSpaceQueue(config, "PRO-1", {
      resume: true,
    });
    expect(resumed.integrationBlocked).toBe(false);
    expect(
      resumed.queue.some(
        (item) => item.workerSlug === "gamma" && item.status === "integrated"
      )
    ).toBe(true);
    },
    SPACE_TEST_TIMEOUT_MS
  );

  it(
    "updates conflicting entry in place when same worker re-delivers",
    async () => {
      const repoDir = path.join(tmpDir, "repo");
      await createRepo(repoDir);

      const projectDir = path.join(projectsRoot, "PRO-1_space-test");
      await fs.mkdir(projectDir, { recursive: true });
      await writeProjectReadme(projectDir, repoDir);

      const workspacesRoot = path.join(projectsRoot, ".workspaces", "PRO-1");
      await fs.mkdir(workspacesRoot, { recursive: true });
      const space = await ensureProjectSpace(config, "PRO-1", "main");

      const alphaPath = path.join(workspacesRoot, "alpha");
      await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/alpha", alphaPath, "main"]);
      const alphaStart = await runGit(alphaPath, ["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(alphaPath, "app.txt"), "worker-one\n", "utf8");
      await runGit(alphaPath, ["add", "app.txt"]);
      await runGit(alphaPath, ["commit", "-m", "alpha"]);
      const alphaEnd = await runGit(alphaPath, ["rev-parse", "HEAD"]);
      await recordWorkerDelivery(config, {
        projectId: "PRO-1",
        workerSlug: "alpha",
        runMode: "worktree",
        worktreePath: alphaPath,
        startSha: alphaStart,
        endSha: alphaEnd,
      });

      const betaPath = path.join(workspacesRoot, "beta");
      await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/beta", betaPath, "main"]);
      const betaStart = await runGit(betaPath, ["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(betaPath, "app.txt"), "worker-two\n", "utf8");
      await runGit(betaPath, ["add", "app.txt"]);
      await runGit(betaPath, ["commit", "-m", "beta"]);
      const betaEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);
      await recordWorkerDelivery(config, {
        projectId: "PRO-1",
        workerSlug: "beta",
        runMode: "worktree",
        worktreePath: betaPath,
        startSha: betaStart,
        endSha: betaEnd,
      });

      const blocked = await integrateProjectSpaceQueue(config, "PRO-1");
      expect(blocked.integrationBlocked).toBe(true);
      const conflictEntry = blocked.queue.find(
        (item) => item.workerSlug === "beta" && item.status === "conflict"
      );
      expect(conflictEntry).toBeDefined();
      const queueLengthBefore = blocked.queue.length;

      const spaceHead = await runGit(space.worktreePath, ["rev-parse", "HEAD"]);
      await runGit(betaPath, ["reset", "--hard", spaceHead]);
      await fs.writeFile(path.join(betaPath, "note.txt"), "rebased\n", "utf8");
      await runGit(betaPath, ["add", "note.txt"]);
      await runGit(betaPath, ["commit", "-m", "beta rebased"]);
      const rebasedEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);

      const updated = await recordWorkerDelivery(config, {
        projectId: "PRO-1",
        workerSlug: "beta",
        runMode: "worktree",
        worktreePath: betaPath,
        startSha: spaceHead,
        endSha: rebasedEnd,
      });

      expect(updated.integrationBlocked).toBe(false);
      expect(updated.queue).toHaveLength(queueLengthBefore);
      const updatedEntry = updated.queue.find((item) => item.id === conflictEntry?.id);
      expect(updatedEntry?.status).toBe("pending");
      expect(updatedEntry?.startSha).toBe(spaceHead);
      expect(updatedEntry?.endSha).toBe(rebasedEnd);
      expect(updatedEntry?.shas).toContain(rebasedEnd);
      expect(updatedEntry?.error).toBeUndefined();
      expect(updatedEntry?.staleAgainstSha).toBeUndefined();
    },
    SPACE_TEST_TIMEOUT_MS
  );

  it(
    "recovers conflict re-delivery when runner captures startSha == endSha",
    async () => {
      const repoDir = path.join(tmpDir, "repo");
      await createRepo(repoDir);

      const projectDir = path.join(projectsRoot, "PRO-1_space-test");
      await fs.mkdir(projectDir, { recursive: true });
      await writeProjectReadme(projectDir, repoDir);

      const workspacesRoot = path.join(projectsRoot, ".workspaces", "PRO-1");
      await fs.mkdir(workspacesRoot, { recursive: true });
      const space = await ensureProjectSpace(config, "PRO-1", "main");

      // Worktree workers — deliver both before integrating so neither is stale
      const alphaPath = path.join(workspacesRoot, "alpha");
      await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/alpha", alphaPath, "main"]);
      const alphaStart = await runGit(alphaPath, ["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(alphaPath, "app.txt"), "worker-alpha\n", "utf8");
      await runGit(alphaPath, ["add", "app.txt"]);
      await runGit(alphaPath, ["commit", "-m", "alpha"]);
      const alphaEnd = await runGit(alphaPath, ["rev-parse", "HEAD"]);
      await recordWorkerDelivery(config, {
        projectId: "PRO-1",
        workerSlug: "alpha",
        runMode: "worktree",
        worktreePath: alphaPath,
        startSha: alphaStart,
        endSha: alphaEnd,
      });

      // beta: initial delivery — will conflict with alpha (both modify app.txt from same base)
      const betaPath = path.join(workspacesRoot, "beta");
      await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/beta", betaPath, "main"]);
      const betaStart = await runGit(betaPath, ["rev-parse", "HEAD"]);
      await fs.writeFile(path.join(betaPath, "app.txt"), "worker-beta\n", "utf8");
      await runGit(betaPath, ["add", "app.txt"]);
      await runGit(betaPath, ["commit", "-m", "beta"]);
      const betaEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);
      await recordWorkerDelivery(config, {
        projectId: "PRO-1",
        workerSlug: "beta",
        runMode: "worktree",
        worktreePath: betaPath,
        startSha: betaStart,
        endSha: betaEnd,
      });

      const blocked = await integrateProjectSpaceQueue(config, "PRO-1");
      expect(blocked.integrationBlocked).toBe(true);
      const conflictEntry = blocked.queue.find(
        (item) => item.workerSlug === "beta" && item.status === "conflict"
      );
      expect(conflictEntry).toBeDefined();

      // Simulate fix-conflicts rebase: worker resets to Space HEAD and adds new commit
      const spaceHead = await runGit(space.worktreePath, ["rev-parse", "HEAD"]);
      await runGit(betaPath, ["reset", "--hard", spaceHead]);
      await fs.writeFile(path.join(betaPath, "note.txt"), "resolved\n", "utf8");
      await runGit(betaPath, ["add", "note.txt"]);
      await runGit(betaPath, ["commit", "-m", "beta fixed"]);
      const fixedEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);

      // Bug scenario: runner session starts AFTER the rebase commit exists,
      // so it captures startSha == endSha == fixedEnd (empty range → would be skipped).
      // With YOPLAI_SPACE_AUTO_REBASE disabled, the fallback in recordWorkerDelivery must recover.
      const prevAutoRebase = process.env.YOPLAI_SPACE_AUTO_REBASE;
      process.env.YOPLAI_SPACE_AUTO_REBASE = "false";
      let updated: Awaited<ReturnType<typeof recordWorkerDelivery>>;
      try {
        updated = await recordWorkerDelivery(config, {
          projectId: "PRO-1",
          workerSlug: "beta",
          runMode: "worktree",
          worktreePath: betaPath,
          startSha: fixedEnd, // runner captured wrong startSha == endSha
          endSha: fixedEnd,
        });
      } finally {
        if (prevAutoRebase === undefined) {
          delete process.env.YOPLAI_SPACE_AUTO_REBASE;
        } else {
          process.env.YOPLAI_SPACE_AUTO_REBASE = prevAutoRebase;
        }
      }

      // Should recover: non-empty shas and status=pending
      expect(updated.integrationBlocked).toBe(false);
      const updatedEntry = updated.queue.find((item) => item.id === conflictEntry?.id);
      expect(updatedEntry?.status).toBe("pending");
      expect(updatedEntry?.shas.length).toBeGreaterThan(0);
      // The recovered shas must include commits that lead to fixedEnd
      expect(updatedEntry?.endSha).toBe(fixedEnd);
    },
    SPACE_TEST_TIMEOUT_MS
  );

  it("queues clone worker commits and integrates on explicit request", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const clonePath = path.join(projectsRoot, ".workspaces", "PRO-1", "clone-a");
    await fs.mkdir(path.dirname(clonePath), { recursive: true });
    await runGit(repoDir, ["clone", repoDir, clonePath]);
    await runGit(clonePath, ["checkout", "-b", "PRO-1/clone-a", "main"]);

    const remoteName = "agent-pro-1";
    await runGit(repoDir, ["remote", "add", remoteName, clonePath]);

    await ensureProjectSpace(config, "PRO-1", "main");
    const start = await runGit(clonePath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(clonePath, "clone.txt"), "clone\n", "utf8");
    await runGit(clonePath, ["add", "clone.txt"]);
    await runGit(clonePath, ["commit", "-m", "clone commit"]);
    const end = await runGit(clonePath, ["rev-parse", "HEAD"]);

    const updated = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "clone-a",
      runMode: "clone",
      worktreePath: clonePath,
      startSha: start,
      endSha: end,
    });

    expect(updated.integrationBlocked).toBe(false);
    expect(
      updated.queue.some(
        (item) => item.workerSlug === "clone-a" && item.status === "pending"
      )
    ).toBe(true);

    const integrated = await integrateProjectSpaceQueue(config, "PRO-1");
    expect(
      integrated.queue.some(
        (item) => item.workerSlug === "clone-a" && item.status === "integrated"
      )
    ).toBe(true);

    const spaceRes = await getProjectSpace(config, "PRO-1");
    expect(spaceRes.ok).toBe(true);
    if (spaceRes.ok) {
      const content = await fs.readFile(
        path.join(spaceRes.data.worktreePath, "clone.txt"),
        "utf8"
      );
      expect(content).toContain("clone");
    }
  }, SPACE_TEST_TIMEOUT_MS);

  it("marks stale clone delivery as stale_worker when Space advanced", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");

    const alphaPath = path.join(projectsRoot, ".workspaces", "PRO-1", "alpha");
    await fs.mkdir(path.dirname(alphaPath), { recursive: true });
    await runGit(repoDir, [
      "worktree",
      "add",
      "-b",
      "PRO-1/alpha",
      alphaPath,
      "main",
    ]);
    const alphaStart = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(alphaPath, "app.txt"), "alpha\n", "utf8");
    await runGit(alphaPath, ["add", "app.txt"]);
    await runGit(alphaPath, ["commit", "-m", "alpha"]);
    const alphaEnd = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: alphaPath,
      startSha: alphaStart,
      endSha: alphaEnd,
    });
    await integrateProjectSpaceQueue(config, "PRO-1");

    const clonePath = path.join(projectsRoot, ".workspaces", "PRO-1", "clone-a");
    await runGit(repoDir, ["clone", repoDir, clonePath]);
    await runGit(clonePath, ["checkout", "-b", "PRO-1/clone-a", "main"]);
    const cloneStart = await runGit(clonePath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(clonePath, "clone.txt"), "stale\n", "utf8");
    await runGit(clonePath, ["add", "clone.txt"]);
    await runGit(clonePath, ["commit", "-m", "clone stale"]);
    const cloneEnd = await runGit(clonePath, ["rev-parse", "HEAD"]);

    const updated = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "clone-a",
      runMode: "clone",
      worktreePath: clonePath,
      startSha: cloneStart,
      endSha: cloneEnd,
    });

    const staleEntry = updated.queue.find((item) => item.workerSlug === "clone-a");
    expect(staleEntry?.status).toBe("stale_worker");
    expect(staleEntry?.staleAgainstSha).toBeTruthy();
    const spaceContent = await fs.readFile(path.join(space.worktreePath, "app.txt"), "utf8");
    expect(spaceContent).not.toContain("stale");
  }, SPACE_TEST_TIMEOUT_MS);

  it("skips only selected pending entries", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    await ensureProjectSpace(config, "PRO-1", "main");
    const workspacesRoot = path.join(projectsRoot, ".workspaces", "PRO-1");
    await fs.mkdir(workspacesRoot, { recursive: true });

    const alphaPath = path.join(workspacesRoot, "alpha");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/alpha", alphaPath, "main"]);
    const alphaStart = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(alphaPath, "alpha.txt"), "alpha\n", "utf8");
    await runGit(alphaPath, ["add", "alpha.txt"]);
    await runGit(alphaPath, ["commit", "-m", "alpha"]);
    const alphaEnd = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    const alphaQueued = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: alphaPath,
      startSha: alphaStart,
      endSha: alphaEnd,
    });
    const alphaEntry = alphaQueued.queue.find((item) => item.workerSlug === "alpha");
    expect(alphaEntry?.status).toBe("pending");

    await integrateSpaceEntries(config, "PRO-1", [alphaEntry?.id ?? ""]);
    const integratedAlpha = await getProjectSpace(config, "PRO-1");
    expect(integratedAlpha.ok).toBe(true);
    if (!integratedAlpha.ok) return;
    const integratedAlphaEntry = integratedAlpha.data.queue.find(
      (item) => item.id === alphaEntry?.id
    );
    expect(integratedAlphaEntry?.status).toBe("integrated");

    const betaPath = path.join(workspacesRoot, "beta");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/beta", betaPath, "main"]);
    const betaStart = await runGit(betaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(betaPath, "beta.txt"), "beta\n", "utf8");
    await runGit(betaPath, ["add", "beta.txt"]);
    await runGit(betaPath, ["commit", "-m", "beta"]);
    const betaEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);
    const betaQueued = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "beta",
      runMode: "worktree",
      worktreePath: betaPath,
      startSha: betaStart,
      endSha: betaEnd,
    });
    const betaEntry = betaQueued.queue.find((item) => item.workerSlug === "beta");
    expect(betaEntry?.status).toBe("pending");

    const skipped = await skipSpaceEntries(config, "PRO-1", [
      alphaEntry?.id ?? "",
      betaEntry?.id ?? "",
    ]);
    const skippedAlpha = skipped.queue.find((item) => item.id === alphaEntry?.id);
    const skippedBeta = skipped.queue.find((item) => item.id === betaEntry?.id);
    expect(skippedAlpha?.status).toBe("integrated");
    expect(skippedBeta?.status).toBe("skipped");
  }, SPACE_TEST_TIMEOUT_MS);

  it("integrates only selected entries", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    const workspacesRoot = path.join(projectsRoot, ".workspaces", "PRO-1");
    await fs.mkdir(workspacesRoot, { recursive: true });

    const alphaPath = path.join(workspacesRoot, "alpha");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/alpha", alphaPath, "main"]);
    const alphaStart = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(alphaPath, "alpha.txt"), "alpha\n", "utf8");
    await runGit(alphaPath, ["add", "alpha.txt"]);
    await runGit(alphaPath, ["commit", "-m", "alpha"]);
    const alphaEnd = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: alphaPath,
      startSha: alphaStart,
      endSha: alphaEnd,
    });

    const betaPath = path.join(workspacesRoot, "beta");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/beta", betaPath, "main"]);
    const betaStart = await runGit(betaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(betaPath, "beta.txt"), "beta\n", "utf8");
    await runGit(betaPath, ["add", "beta.txt"]);
    await runGit(betaPath, ["commit", "-m", "beta"]);
    const betaEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);
    const queued = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "beta",
      runMode: "worktree",
      worktreePath: betaPath,
      startSha: betaStart,
      endSha: betaEnd,
    });

    const alphaEntry = queued.queue.find((item) => item.workerSlug === "alpha");
    const betaEntry = queued.queue.find((item) => item.workerSlug === "beta");
    expect(alphaEntry?.status).toBe("pending");
    expect(betaEntry?.status).toBe("pending");

    const integrated = await integrateSpaceEntries(config, "PRO-1", [alphaEntry?.id ?? ""]);
    const integratedAlpha = integrated.queue.find((item) => item.id === alphaEntry?.id);
    const pendingBeta = integrated.queue.find((item) => item.id === betaEntry?.id);
    expect(integratedAlpha?.status).toBe("integrated");
    expect(pendingBeta?.status).toBe("pending");

    const alphaContent = await fs.readFile(path.join(space.worktreePath, "alpha.txt"), "utf8");
    expect(alphaContent).toContain("alpha");
    await expect(fs.readFile(path.join(space.worktreePath, "beta.txt"), "utf8")).rejects.toThrow();
  }, SPACE_TEST_TIMEOUT_MS);

  it("auto-skips replaced pending entries on delivery", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    await ensureProjectSpace(config, "PRO-1", "main");
    const workspacesRoot = path.join(projectsRoot, ".workspaces", "PRO-1");
    await fs.mkdir(workspacesRoot, { recursive: true });

    const alphaPath = path.join(workspacesRoot, "alpha");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/alpha", alphaPath, "main"]);
    const alphaStart = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(alphaPath, "alpha.txt"), "alpha\n", "utf8");
    await runGit(alphaPath, ["add", "alpha.txt"]);
    await runGit(alphaPath, ["commit", "-m", "alpha"]);
    const alphaEnd = await runGit(alphaPath, ["rev-parse", "HEAD"]);
    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: alphaPath,
      startSha: alphaStart,
      endSha: alphaEnd,
    });

    const betaPath = path.join(workspacesRoot, "beta");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/beta", betaPath, "main"]);
    const betaStart = await runGit(betaPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(betaPath, "beta.txt"), "beta\n", "utf8");
    await runGit(betaPath, ["add", "beta.txt"]);
    await runGit(betaPath, ["commit", "-m", "beta"]);
    const betaEnd = await runGit(betaPath, ["rev-parse", "HEAD"]);
    const queued = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "beta",
      runMode: "worktree",
      worktreePath: betaPath,
      startSha: betaStart,
      endSha: betaEnd,
    });

    const alphaEntry = queued.queue.find((item) => item.workerSlug === "alpha");
    const betaEntry = queued.queue.find((item) => item.workerSlug === "beta");
    expect(alphaEntry?.status).toBe("pending");
    expect(betaEntry?.status).toBe("pending");

    const fixerPath = path.join(workspacesRoot, "fixer");
    await runGit(repoDir, ["worktree", "add", "-b", "PRO-1/fixer", fixerPath, "main"]);
    const fixerStart = await runGit(fixerPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(fixerPath, "fix.txt"), "fix\n", "utf8");
    await runGit(fixerPath, ["add", "fix.txt"]);
    await runGit(fixerPath, ["commit", "-m", "fix"]);
    const fixerEnd = await runGit(fixerPath, ["rev-parse", "HEAD"]);

    const delivered = await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "fixer",
      runMode: "worktree",
      worktreePath: fixerPath,
      startSha: fixerStart,
      endSha: fixerEnd,
      replaces: [alphaEntry?.id ?? "", "beta"],
    });

    const skippedAlpha = delivered.queue.find((item) => item.id === alphaEntry?.id);
    const skippedBeta = delivered.queue.find((item) => item.id === betaEntry?.id);
    const fixerEntry = delivered.queue.find((item) => item.workerSlug === "fixer");
    expect(skippedAlpha?.status).toBe("skipped");
    expect(skippedBeta?.status).toBe("skipped");
    expect(fixerEntry?.status).toBe("pending");
  }, SPACE_TEST_TIMEOUT_MS);

  it("rebases Space onto main and rewrites pending worker SHAs", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);
    await attachOriginRemote(repoDir, tmpDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    const workerPath = path.join(projectsRoot, ".workspaces", "PRO-1", "alpha");
    await fs.mkdir(path.dirname(workerPath), { recursive: true });
    await runGit(repoDir, [
      "worktree",
      "add",
      "-b",
      "PRO-1/alpha",
      workerPath,
      "main",
    ]);
    const workerStart = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(workerPath, "worker.txt"), "hello\n", "utf8");
    await runGit(workerPath, ["add", "worker.txt"]);
    await runGit(workerPath, ["commit", "-m", "worker commit"]);
    const workerEnd = await runGit(workerPath, ["rev-parse", "HEAD"]);

    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: workerPath,
      startSha: workerStart,
      endSha: workerEnd,
    });

    await fs.writeFile(path.join(repoDir, "main.txt"), "upstream\n", "utf8");
    await runGit(repoDir, ["add", "main.txt"]);
    await runGit(repoDir, ["commit", "-m", "main advance"]);
    await runGit(repoDir, ["push", "origin", "main"]);
    await runGit(space.worktreePath, ["fetch", "origin", "main"]);
    const originMainHead = await runGit(space.worktreePath, [
      "rev-parse",
      "origin/main",
    ]);

    const rebased = await rebaseSpaceOntoMain(config, "PRO-1");
    expect(rebased.rebaseConflict).toBeUndefined();

    const spaceHead = await runGit(space.worktreePath, ["rev-parse", "HEAD"]);
    expect(spaceHead).toBe(originMainHead);

    const entry = rebased.queue.find((item) => item.workerSlug === "alpha");
    expect(entry?.status).toBe("pending");
    expect(entry?.startSha).toBe(spaceHead);
    expect(entry?.endSha).toBeTruthy();
    expect(entry?.endSha).not.toBe(workerEnd);
    expect(entry?.shas).toEqual([entry?.endSha]);
  }, SPACE_TEST_TIMEOUT_MS);

  it("stores rebaseConflict when Space rebase onto main conflicts", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);
    await attachOriginRemote(repoDir, tmpDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    await fs.writeFile(path.join(space.worktreePath, "app.txt"), "space-change\n", "utf8");
    await runGit(space.worktreePath, ["add", "app.txt"]);
    await runGit(space.worktreePath, ["commit", "-m", "space change"]);

    await fs.writeFile(path.join(repoDir, "app.txt"), "main-change\n", "utf8");
    await runGit(repoDir, ["add", "app.txt"]);
    await runGit(repoDir, ["commit", "-m", "main change"]);
    await runGit(repoDir, ["push", "origin", "main"]);

    const rebased = await rebaseSpaceOntoMain(config, "PRO-1");
    expect(rebased.rebaseConflict).toBeDefined();
    expect(rebased.rebaseConflict?.baseSha).toBeTruthy();
    expect(rebased.rebaseConflict?.error).toContain("Command failed");
    await expect(
      runGit(space.worktreePath, ["rev-parse", "--verify", "REBASE_HEAD"])
    ).resolves.toBeTruthy();
  }, SPACE_TEST_TIMEOUT_MS);

  it("marks pending worker as conflict when worker rebase onto rebased Space fails", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);
    await attachOriginRemote(repoDir, tmpDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    await ensureProjectSpace(config, "PRO-1", "main");
    const workerPath = path.join(projectsRoot, ".workspaces", "PRO-1", "alpha");
    await fs.mkdir(path.dirname(workerPath), { recursive: true });
    await runGit(repoDir, [
      "worktree",
      "add",
      "-b",
      "PRO-1/alpha",
      workerPath,
      "main",
    ]);
    const workerStart = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(workerPath, "app.txt"), "worker-change\n", "utf8");
    await runGit(workerPath, ["add", "app.txt"]);
    await runGit(workerPath, ["commit", "-m", "worker change"]);
    const workerEnd = await runGit(workerPath, ["rev-parse", "HEAD"]);

    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: workerPath,
      startSha: workerStart,
      endSha: workerEnd,
    });

    await fs.writeFile(path.join(repoDir, "app.txt"), "main-change\n", "utf8");
    await runGit(repoDir, ["add", "app.txt"]);
    await runGit(repoDir, ["commit", "-m", "main change"]);
    await runGit(repoDir, ["push", "origin", "main"]);

    const rebased = await rebaseSpaceOntoMain(config, "PRO-1");
    expect(rebased.rebaseConflict).toBeUndefined();
    expect(rebased.integrationBlocked).toBe(true);

    const entry = rebased.queue.find((item) => item.workerSlug === "alpha");
    expect(entry?.status).toBe("conflict");
    expect(entry?.error).toBeTruthy();
    await expect(
      runGit(workerPath, ["rev-parse", "--verify", "REBASE_HEAD"])
    ).rejects.toBeDefined();
  }, SPACE_TEST_TIMEOUT_MS);

  it("merges space into base and cleans up worktrees/branches", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    const workerPath = path.join(projectsRoot, ".workspaces", "PRO-1", "alpha");
    await fs.mkdir(path.dirname(workerPath), { recursive: true });
    await runGit(repoDir, [
      "worktree",
      "add",
      "-b",
      "PRO-1/alpha",
      workerPath,
      "main",
    ]);

    const start = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(workerPath, "app.txt"), "worker-one\n", "utf8");
    await runGit(workerPath, ["add", "app.txt"]);
    await runGit(workerPath, ["commit", "-m", "worker one"]);
    const end = await runGit(workerPath, ["rev-parse", "HEAD"]);

    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: workerPath,
      startSha: start,
      endSha: end,
    });
    await integrateProjectSpaceQueue(config, "PRO-1");

    const merged = await mergeSpaceIntoBase(config, "PRO-1", { cleanup: true });
    expect(merged.baseBranch).toBe("main");
    expect(merged.mergeMethod).toBe("ff");
    expect(merged.afterSha).toBeTruthy();
    expect(merged.cleanup?.workerWorktreesRemoved).toBe(1);
    expect(merged.cleanup?.spaceWorktreeRemoved).toBe(true);
    expect(merged.cleanup?.spaceBranchDeleted).toBe(true);

    const mainContent = await runGit(repoDir, ["show", "main:app.txt"]);
    expect(mainContent).toContain("worker-one");

    await expect(fs.stat(workerPath)).rejects.toBeDefined();
    await expect(fs.stat(space.worktreePath)).rejects.toBeDefined();

    expect(await runGit(repoDir, ["branch", "--list", "PRO-1/alpha"])).toBe("");
    expect(await runGit(repoDir, ["branch", "--list", "space/PRO-1"])).toBe("");

    const refreshed = await getProjectSpace(config, "PRO-1");
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(refreshed.data.queue).toHaveLength(0);
      expect(refreshed.data.integrationBlocked).toBe(false);
    }
  }, SPACE_TEST_TIMEOUT_MS);

  it("clears queue after merge when cleanup is disabled", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    const space = await ensureProjectSpace(config, "PRO-1", "main");
    const workerPath = path.join(projectsRoot, ".workspaces", "PRO-1", "alpha");
    await fs.mkdir(path.dirname(workerPath), { recursive: true });
    await runGit(repoDir, [
      "worktree",
      "add",
      "-b",
      "PRO-1/alpha",
      workerPath,
      "main",
    ]);

    const start = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(workerPath, "app.txt"), "worker-one\n", "utf8");
    await runGit(workerPath, ["add", "app.txt"]);
    await runGit(workerPath, ["commit", "-m", "worker one"]);
    const end = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: workerPath,
      startSha: start,
      endSha: end,
    });
    await integrateProjectSpaceQueue(config, "PRO-1");

    const merged = await mergeSpaceIntoBase(config, "PRO-1", { cleanup: false });
    expect(merged.mergeMethod).toBe("ff");
    expect(merged.cleanup).toBeUndefined();

    const refreshed = await getProjectSpace(config, "PRO-1");
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(refreshed.data.queue).toHaveLength(0);
      expect(refreshed.data.integrationBlocked).toBe(false);
    }

    await expect(fs.stat(workerPath)).resolves.toBeDefined();
    await expect(fs.stat(space.worktreePath)).resolves.toBeDefined();
  }, SPACE_TEST_TIMEOUT_MS);

  it("rejects merge when space queue has unresolved entries", async () => {
    const repoDir = path.join(tmpDir, "repo");
    await createRepo(repoDir);

    const projectDir = path.join(projectsRoot, "PRO-1_space-test");
    await fs.mkdir(projectDir, { recursive: true });
    await writeProjectReadme(projectDir, repoDir);

    await ensureProjectSpace(config, "PRO-1", "main");
    const workerPath = path.join(projectsRoot, ".workspaces", "PRO-1", "alpha");
    await fs.mkdir(path.dirname(workerPath), { recursive: true });
    await runGit(repoDir, [
      "worktree",
      "add",
      "-b",
      "PRO-1/alpha",
      workerPath,
      "main",
    ]);

    const start = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(workerPath, "app.txt"), "worker-one\n", "utf8");
    await runGit(workerPath, ["add", "app.txt"]);
    await runGit(workerPath, ["commit", "-m", "worker one"]);
    const end = await runGit(workerPath, ["rev-parse", "HEAD"]);
    await recordWorkerDelivery(config, {
      projectId: "PRO-1",
      workerSlug: "alpha",
      runMode: "worktree",
      worktreePath: workerPath,
      startSha: start,
      endSha: end,
    });

    await expect(
      mergeSpaceIntoBase(config, "PRO-1", { cleanup: true })
    ).rejects.toThrow("Space queue has unresolved entries");
  }, SPACE_TEST_TIMEOUT_MS);
});
