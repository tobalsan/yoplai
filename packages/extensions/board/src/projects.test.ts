import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UNASSIGNED_PROJECT_ID,
  invalidateProjectCache,
  resetProjectCaches,
  scanProjectLifecycleCounts,
  scanProjectLifecycleMetadata,
  scanProjects,
  statusToGroup,
} from "./projects.js";
import { splitFrontmatter } from "./frontmatter.js";

const execFileAsync = promisify(execFile);

async function makeProject(
  root: string,
  dir: string,
  frontmatter: Record<string, string | string[]>
): Promise<void> {
  const projDir = path.join(root, dir);
  await fs.mkdir(projDir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) =>
      Array.isArray(v)
        ? `${k}:\n${v.map((item) => `  - ${item}`).join("\n")}`
        : `${k}: ${v}`
    )
    .join("\n");
  await fs.writeFile(
    path.join(projDir, "README.md"),
    `---\n${fm}\n---\n\nbody\n`,
    "utf-8"
  );
}

async function makeWorktree(
  worktreesRoot: string,
  projectDirName: string,
  name: string,
  branch: string
): Promise<string> {
  const wt = path.join(worktreesRoot, projectDirName, name);
  await fs.mkdir(wt, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", branch], { cwd: wt });
  await execFileAsync("git", ["config", "user.email", "t@t.t"], { cwd: wt });
  await execFileAsync("git", ["config", "user.name", "t"], { cwd: wt });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
    cwd: wt,
  });
  await fs.writeFile(path.join(wt, "x"), "x", "utf-8");
  await execFileAsync("git", ["add", "."], { cwd: wt });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: wt });
  return wt;
}

function makeSpace(
  worktreePath: string,
  queue: Array<{
    id: string;
    workerSlug: string;
    worktreePath: string;
    status: "pending" | "integrated" | "conflict" | "skipped" | "stale_worker";
    createdAt?: string;
    integratedAt?: string;
    startSha?: string;
    endSha?: string;
  }> = []
) {
  return {
    worktreePath,
    queue: queue.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt ?? "2026-04-30T00:00:00.000Z",
    })),
  };
}

async function withGitLog(
  tmp: string,
  statusSleepSeconds?: string
): Promise<{
  logPath: string;
  restore: () => void;
}> {
  const { stdout } = await execFileAsync("which", ["git"]);
  const realGit = stdout.trim();
  const binDir = path.join(tmp, "_bin");
  const logPath = path.join(tmp, "git.log");
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(
    path.join(binDir, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$PWD|$*" >> "$GIT_LOG"\nif [ -n "$GIT_STATUS_SLEEP" ] && [ "$1" = "status" ]; then sleep "$GIT_STATUS_SLEEP"; fi\nexec "$REAL_GIT" "$@"\n`,
    "utf8"
  );
  await fs.chmod(path.join(binDir, "git"), 0o755);
  const prevPath = process.env.PATH;
  const prevGitLog = process.env.GIT_LOG;
  const prevRealGit = process.env.REAL_GIT;
  const prevStatusSleep = process.env.GIT_STATUS_SLEEP;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ""}`;
  process.env.GIT_LOG = logPath;
  process.env.REAL_GIT = realGit;
  if (statusSleepSeconds) process.env.GIT_STATUS_SLEEP = statusSleepSeconds;
  return {
    logPath,
    restore: () => {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
      if (prevGitLog === undefined) delete process.env.GIT_LOG;
      else process.env.GIT_LOG = prevGitLog;
      if (prevRealGit === undefined) delete process.env.REAL_GIT;
      else process.env.REAL_GIT = prevRealGit;
      if (prevStatusSleep === undefined) delete process.env.GIT_STATUS_SLEEP;
      else process.env.GIT_STATUS_SLEEP = prevStatusSleep;
    },
  };
}

async function readGitLog(logPath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(logPath, "utf8");
    return raw.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(await check()).toBe(true);
}

describe("statusToGroup", () => {
  it("maps known statuses", () => {
    expect(statusToGroup("current")).toBe("active");
    expect(statusToGroup("todo")).toBe("active");
    expect(statusToGroup("shaping")).toBe("active");
    expect(statusToGroup("in_progress")).toBe("active");
    expect(statusToGroup("review")).toBe("review");
    expect(statusToGroup("ready_to_merge")).toBe("review");
    expect(statusToGroup("not_now")).toBe("stale");
    expect(statusToGroup("maybe")).toBe("stale");
    expect(statusToGroup("done")).toBe("done");
    expect(statusToGroup("cancelled")).toBe("done");
    expect(statusToGroup("archived")).toBe("done");
  });

  it("falls back to stale for unknown statuses", () => {
    expect(statusToGroup("")).toBe("stale");
    expect(statusToGroup("weird")).toBe("stale");
  });
});

describe("splitFrontmatter", () => {
  it("parses simple frontmatter", () => {
    const { frontmatter, content } = splitFrontmatter(
      "---\ntitle: Hello\nstatus: current\n---\nbody"
    );
    expect(frontmatter.title).toBe("Hello");
    expect(frontmatter.status).toBe("current");
    expect(content).toBe("body");
  });

  it("returns empty frontmatter when missing", () => {
    const { frontmatter, content } = splitFrontmatter("just body\n");
    expect(frontmatter).toEqual({});
    expect(content).toBe("just body\n");
  });
});

describe("scanProjects", () => {
  let tmp: string;
  let emptyWtRoot: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "board-projects-"));
    emptyWtRoot = path.join(tmp, "__empty_wts");
  });

  afterEach(async () => {
    resetProjectCaches();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("returns unassigned when root is missing", async () => {
    const items = await scanProjects(path.join(tmp, "nope"), false);
    expect(items).toMatchObject([{ id: UNASSIGNED_PROJECT_ID, worktrees: [] }]);
  });

  it("scans projects, skips reserved dirs and non-PRO dirs", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      area: "infra",
      created: "2026-01-01",
    });
    await makeProject(tmp, "PRO-002", {
      title: "Beta",
      status: "review",
      area: "infra",
      created: "2026-02-02",
    });
    await fs.mkdir(path.join(tmp, ".workspaces"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".archive"), { recursive: true });
    await fs.mkdir(path.join(tmp, "not-a-project"), { recursive: true });

    const items = await scanProjects(tmp, false, emptyWtRoot);
    expect(items.map((p) => p.id)).toEqual([
      "PRO-002",
      "PRO-001",
      UNASSIGNED_PROJECT_ID,
    ]);
    expect(items[0]?.group).toBe("review");
    expect(items[1]?.group).toBe("active");
  });

  it("includes .done project folder only when includeDone is true", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    await makeProject(path.join(tmp, ".done"), "PRO-002", {
      title: "Done",
      status: "done",
      created: "2026-01-02",
    });

    const withoutDone = await scanProjects(tmp, false, emptyWtRoot);
    expect(withoutDone.map((p) => p.id)).toEqual([
      "PRO-001",
      UNASSIGNED_PROJECT_ID,
    ]);

    const withDone = await scanProjects(tmp, true, emptyWtRoot);
    expect(withDone.map((p) => p.id).sort()).toEqual([
      "PRO-001",
      "PRO-002",
      UNASSIGNED_PROJECT_ID,
    ]);
  });

  it("keeps cancelled projects visible when they are stored under .done", async () => {
    await makeProject(path.join(tmp, ".done"), "PRO-002", {
      title: "Cancelled",
      status: "cancelled",
      created: "2026-01-02",
    });

    const items = await scanProjects(tmp, false, emptyWtRoot);
    expect(items.map((p) => p.id).sort()).toEqual([
      "PRO-002",
      UNASSIGNED_PROJECT_ID,
    ]);
    expect(items.find((p) => p.id === "PRO-002")?.lifecycleStatus).toBe(
      "cancelled"
    );
  });

  it("filters out done projects unless includeDone", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "A",
      status: "current",
      created: "2026-01-01",
    });
    await makeProject(tmp, "PRO-002", {
      title: "B",
      status: "done",
      created: "2026-01-02",
    });
    await makeProject(tmp, "PRO-003", {
      title: "C",
      status: "cancelled",
      created: "2026-01-03",
    });

    const without = await scanProjects(tmp, false, emptyWtRoot);
    expect(without.map((p) => p.id).sort()).toEqual([
      "PRO-001",
      "PRO-003",
      UNASSIGNED_PROJECT_ID,
    ]);

    const withDone = await scanProjects(tmp, true, emptyWtRoot);
    expect(withDone.map((p) => p.id).sort()).toEqual([
      "PRO-001",
      "PRO-002",
      "PRO-003",
      UNASSIGNED_PROJECT_ID,
    ]);
  });

  it("counts projects by lifecycle status", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "A",
      status: "active",
      created: "2026-01-01",
    });
    await makeProject(tmp, "PRO-002", {
      title: "B",
      status: "done",
      created: "2026-01-02",
    });
    await makeProject(tmp, "PRO-003", {
      title: "C",
      status: "cancelled",
      created: "2026-01-03",
    });

    await expect(scanProjectLifecycleCounts(tmp)).resolves.toEqual({
      triage: 0,
      shaping: 0,
      active: 1,
      ready_to_merge: 0,
      done: 1,
      cancelled: 1,
      archived: 0,
    });
  });

  it("caches lifecycle metadata until project cache invalidates", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "A",
      status: "active",
      created: "2026-01-01",
    });

    const first = await scanProjectLifecycleMetadata(tmp, { cacheTtlMs: 60_000 });
    await makeProject(tmp, "PRO-001", {
      title: "A",
      status: "cancelled",
      created: "2026-01-01",
    });
    const cached = await scanProjectLifecycleMetadata(tmp, { cacheTtlMs: 60_000 });
    expect(cached.counts).toEqual(first.counts);

    invalidateProjectCache(tmp);
    await expect(
      scanProjectLifecycleCounts(tmp)
    ).resolves.toMatchObject({ active: 0, cancelled: 1 });
  });

  it("counts done projects stored under .done", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "A",
      status: "active",
      created: "2026-01-01",
    });
    await makeProject(path.join(tmp, ".done"), "PRO-002", {
      title: "B",
      status: "done",
      created: "2026-01-02",
    });

    await expect(scanProjectLifecycleCounts(tmp)).resolves.toEqual({
      triage: 0,
      shaping: 0,
      active: 1,
      ready_to_merge: 0,
      done: 1,
      cancelled: 0,
      archived: 0,
    });
  });

  it("sorts by group then created desc", async () => {
    await makeProject(tmp, "PRO-A", {
      title: "A",
      status: "current",
      created: "2026-01-01",
    });
    await makeProject(tmp, "PRO-B", {
      title: "B",
      status: "current",
      created: "2026-03-01",
    });
    await makeProject(tmp, "PRO-C", {
      title: "C",
      status: "review",
      created: "2026-02-01",
    });
    await makeProject(tmp, "PRO-D", {
      title: "D",
      status: "not_now",
      created: "2026-04-01",
    });

    const items = await scanProjects(tmp, false, emptyWtRoot);
    expect(items.map((p) => p.id)).toEqual([
      "PRO-C",
      "PRO-B",
      "PRO-A",
      "PRO-D",
      UNASSIGNED_PROJECT_ID,
    ]);
  });

  it("collects worktree info from worktreesRoot when branch matches space/{id}", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(
      wtRoot,
      "yoplai",
      "feature-x",
      "space/PRO-001"
    );
    await fs.writeFile(path.join(wt, "dirty"), "dirty", "utf-8");

    const items = await scanProjects(tmp, false, wtRoot);
    expect(items).toHaveLength(2);
    const wts = items[0]?.worktrees ?? [];
    expect(wts).toHaveLength(1);
    expect(wts[0]?.name).toBe("feature-x");
    expect(wts[0]?.branch).toBe("space/PRO-001");
    expect(wts[0]?.dirty).toBe(true);
    expect(wts[0]?.ahead).toBe(0);
  });

  it("keeps active project worktree roots with hyphenated suffixes", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    await makeWorktree(wtRoot, "PRO-001-worker", "feat", "space/PRO-001");

    const items = await scanProjects(tmp, false, wtRoot);
    expect(items[0]?.worktrees.map((wt) => wt.name)).toEqual(["feat"]);
  });

  it("ignores worktrees whose branch does not match the project", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    await makeWorktree(wtRoot, "yoplai", "other", "space/PRO-999");

    const items = await scanProjects(tmp, false, wtRoot);
    expect(items[0]?.worktrees).toEqual([]);
  });

  it("places worktrees without a project token under unassigned", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(wtRoot, "yoplai", "flash-fix", "feat/flash");

    const items = await scanProjects(tmp, false, wtRoot);
    const unassigned = items.find((item) => item.id === UNASSIGNED_PROJECT_ID);
    expect(unassigned).toMatchObject({
      title: "Unassigned",
      status: "unassigned",
      area: "",
    });
    expect(unassigned?.worktrees).toMatchObject([
      {
        name: "flash-fix",
        path: wt,
        branch: "feat/flash",
      },
    ]);
  });

  it("attributes worktrees by active project id in the path", async () => {
    await makeProject(tmp, "PRO-235", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(wtRoot, "PRO-235", "foo", "feat/foo");

    const items = await scanProjects(tmp, false, wtRoot);
    expect(
      items.find((item) => item.id === "PRO-235")?.worktrees
    ).toMatchObject([
      {
        name: "foo",
        path: wt,
        branch: "feat/foo",
      },
    ]);
  });

  it("attributes worktrees by active project id in the branch token", async () => {
    await makeProject(tmp, "PRO-235", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(
      wtRoot,
      "yoplai",
      "cleanup",
      "feat/PRO-235-cleanup"
    );

    const items = await scanProjects(tmp, false, wtRoot);
    expect(
      items.find((item) => item.id === "PRO-235")?.worktrees
    ).toMatchObject([
      {
        name: "cleanup",
        path: wt,
        branch: "feat/PRO-235-cleanup",
      },
    ]);
  });

  it("prefers explicit frontmatter over path attribution", async () => {
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(wtRoot, "PRO-001", "foo", "feat/foo");
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    await makeProject(tmp, "PRO-002", {
      title: "Beta",
      status: "current",
      created: "2026-01-02",
      worktrees: [`{"path":"${wt}","branch":"feat/foo"}`],
    });

    const items = await scanProjects(tmp, false, wtRoot);
    const alpha = items.find((item) => item.id === "PRO-001");
    const beta = items.find((item) => item.id === "PRO-002");
    expect(alpha?.worktrees).toEqual([]);
    expect(beta?.worktrees.map((worktree) => worktree.path)).toEqual([wt]);
  });

  it("places inactive or nonexistent project tokens under unassigned", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const ghost = await makeWorktree(
      wtRoot,
      "yoplai",
      "ghost",
      "feat/PRO-999-thing"
    );

    const items = await scanProjects(tmp, false, wtRoot);
    const unassigned = items.find((item) => item.id === UNASSIGNED_PROJECT_ID);
    expect(items.find((item) => item.id === "PRO-001")?.worktrees).toEqual([]);
    expect(unassigned?.worktrees.map((worktree) => worktree.path)).toEqual([
      ghost,
    ]);
  });

  it("does not place attributed worktrees under unassigned", async () => {
    await makeProject(tmp, "PRO-227", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(wtRoot, "PRO-227", "foo", "feat/foo");

    const items = await scanProjects(tmp, false, wtRoot);
    expect(
      items.find((item) => item.id === "PRO-227")?.worktrees[0]?.path
    ).toBe(wt);
    expect(
      items.find((item) => item.id === UNASSIGNED_PROJECT_ID)?.worktrees
    ).toEqual([]);
  });

  it("always includes the unassigned project", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });

    const items = await scanProjects(tmp, false, emptyWtRoot);
    expect(items.at(-1)).toMatchObject({
      id: UNASSIGNED_PROJECT_ID,
      title: "Unassigned",
      worktrees: [],
    });
  });

  it("handles non-git worktree subdirs gracefully", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    await fs.mkdir(path.join(wtRoot, "yoplai", "garbage"), { recursive: true });

    const items = await scanProjects(tmp, false, wtRoot);
    expect(items).toHaveLength(2);
    expect(items[0]?.worktrees).toEqual([]);
  });

  it("returns no worktrees when a project has no space or repo", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });

    const items = await scanProjects(tmp, false, emptyWtRoot, {
      getSpace: async () => null,
    });

    expect(items[0]?.worktrees).toEqual([]);
  });

  it("adds a main worktree for repo projects with no space queue", async () => {
    const repoDir = await makeWorktree(tmp, "repos", "alpha", "main");
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
      repo: repoDir,
    });

    const items = await scanProjects(tmp, false, emptyWtRoot, {
      getSpace: async () => null,
    });

    expect(items[0]?.worktrees).toMatchObject([
      {
        id: "PRO-001:main",
        workerSlug: "main",
        worktreePath: repoDir,
        path: repoDir,
        branch: "main",
        queueStatus: null,
        agentRun: null,
      },
    ]);
  });

  it("joins space queue entries into project worktrees", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const alphaPath = path.join(tmp, "alpha");
    const spacePath = path.join(tmp, "_space");

    const items = await scanProjects(tmp, false, emptyWtRoot, {
      getSpace: async () =>
        makeSpace(spacePath, [
          {
            id: "entry-alpha",
            workerSlug: "alpha",
            worktreePath: alphaPath,
            status: "pending",
            startSha: "aaa",
            endSha: "bbb",
          },
        ]),
    });

    expect(items[0]?.worktrees).toMatchObject([
      {
        id: "entry-alpha",
        workerSlug: "alpha",
        worktreePath: alphaPath,
        branch: null,
        queueStatus: "pending",
        startedAt: "2026-04-30T00:00:00.000Z",
        startSha: "aaa",
        endSha: "bbb",
      },
      {
        id: "PRO-001:_space",
        workerSlug: "_space",
        worktreePath: spacePath,
        branch: null,
        queueStatus: null,
      },
    ]);
  });

  it("includes git-discovered worktrees that are not in the space queue", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const queuedPath = path.join(tmp, "queued");
    const gitOnlyPath = await makeWorktree(
      wtRoot,
      "PRO-001",
      "git-only",
      "space/PRO-001/git-only"
    );

    const items = await scanProjects(tmp, false, wtRoot, {
      getSpace: async () =>
        makeSpace("", [
          {
            id: "entry-queued",
            workerSlug: "queued",
            worktreePath: queuedPath,
            status: "pending",
          },
        ]),
    });

    expect(items[0]?.worktrees).toMatchObject([
      {
        id: "entry-queued",
        workerSlug: "queued",
        worktreePath: queuedPath,
        queueStatus: "pending",
      },
      {
        id: "PRO-001:git-only",
        workerSlug: "git-only",
        worktreePath: gitOnlyPath,
        branch: "space/PRO-001/git-only",
        queueStatus: null,
      },
    ]);
  });

  it("dedupes space and git-discovered worktrees by project worker slug", async () => {
    await makeProject(tmp, "PRO-227", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    await makeWorktree(
      wtRoot,
      "PRO-227",
      "worker-foundation",
      "space/PRO-227/worker-foundation"
    );
    await makeWorktree(wtRoot, "PRO-227", "_space", "space/PRO-227");
    const staleRoot = path.join(tmp, "projects", ".workspaces", "PRO-227");

    const items = await scanProjects(tmp, false, wtRoot, {
      getSpace: async () =>
        makeSpace(path.join(staleRoot, "_space"), [
          {
            id: "entry-worker-foundation",
            workerSlug: "worker-foundation",
            worktreePath: path.join(staleRoot, "worker-foundation"),
            status: "integrated",
          },
        ]),
    });

    expect(items[0]?.worktrees).toMatchObject([
      {
        id: "entry-worker-foundation",
        workerSlug: "worker-foundation",
        worktreePath: path.join(staleRoot, "worker-foundation"),
        queueStatus: "integrated",
      },
      {
        id: "PRO-227:_space",
        workerSlug: "_space",
        worktreePath: path.join(staleRoot, "_space"),
        queueStatus: null,
      },
    ]);
    expect(items[0]?.worktrees).toHaveLength(2);
  });

  it("dedupes space queue worktrees by latest queue entry", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const alphaPath = path.join(tmp, "alpha");

    const items = await scanProjects(tmp, false, emptyWtRoot, {
      getSpace: async () =>
        makeSpace("", [
          {
            id: "entry-old",
            workerSlug: "alpha",
            worktreePath: alphaPath,
            status: "pending",
            createdAt: "2026-04-30T00:00:00.000Z",
            startSha: "old-start",
            endSha: "old-end",
          },
          {
            id: "entry-new",
            workerSlug: "alpha",
            worktreePath: alphaPath,
            status: "integrated",
            createdAt: "2026-04-30T01:00:00.000Z",
            integratedAt: "2026-04-30T02:00:00.000Z",
            startSha: "new-start",
            endSha: "new-end",
          },
        ]),
    });

    expect(items[0]?.worktrees).toHaveLength(1);
    expect(items[0]?.worktrees[0]).toMatchObject({
      id: "entry-new",
      workerSlug: "alpha",
      worktreePath: alphaPath,
      queueStatus: "integrated",
      startedAt: "2026-04-30T01:00:00.000Z",
      integratedAt: "2026-04-30T02:00:00.000Z",
      startSha: "new-start",
      endSha: "new-end",
    });
  });

  it("populates running agent runs by worktree path", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const alphaPath = path.join(tmp, "alpha");
    const startedAt = "2026-04-30T01:00:00.000Z";
    const updatedAt = "2026-04-30T01:01:00.000Z";

    const items = await scanProjects(tmp, false, emptyWtRoot, {
      getSpace: async () =>
        makeSpace("", [
          {
            id: "entry-alpha",
            workerSlug: "alpha",
            worktreePath: alphaPath,
            status: "pending",
          },
        ]),
      runsByCwd: new Map([
        [
          path.resolve(alphaPath),
          {
            runId: "sar_1",
            label: "Alpha Worker",
            cli: "codex",
            status: "running",
            startedAt,
            updatedAt,
          },
        ],
      ]),
    });

    expect(items[0]?.worktrees[0]?.agentRun).toEqual({
      runId: "sar_1",
      label: "Alpha Worker",
      cli: "codex",
      status: "running",
      startedAt,
      updatedAt,
    });
  });

  it("preserves all queue statuses", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const statuses = [
      "pending",
      "integrated",
      "conflict",
      "skipped",
      "stale_worker",
    ] as const;

    const items = await scanProjects(tmp, false, emptyWtRoot, {
      getSpace: async () =>
        makeSpace(
          "",
          statuses.map((status) => ({
            id: `entry-${status}`,
            workerSlug: status,
            worktreePath: path.join(tmp, status),
            status,
          }))
        ),
    });

    expect(items[0]?.worktrees.map((wt) => wt.queueStatus)).toEqual(statuses);
  });

  it("refreshes joined project cache after space invalidation", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    let workerSlug = "alpha";
    const options = {
      cacheTtlMs: 60_000,
      getSpace: async () =>
        makeSpace("", [
          {
            id: `entry-${workerSlug}`,
            workerSlug,
            worktreePath: path.join(tmp, workerSlug),
            status: "pending" as const,
          },
        ]),
    };

    const first = await scanProjects(tmp, false, emptyWtRoot, options);
    expect(first[0]?.worktrees[0]?.workerSlug).toBe("alpha");

    workerSlug = "beta";
    const cached = await scanProjects(tmp, false, emptyWtRoot, options);
    expect(cached[0]?.worktrees[0]?.workerSlug).toBe("alpha");

    invalidateProjectCache(tmp);
    const refreshed = await scanProjects(tmp, false, emptyWtRoot, options);
    expect(refreshed[0]?.worktrees[0]?.workerSlug).toBe("beta");
  });

  it("discovers worktrees via repo frontmatter using git worktree list", async () => {
    const repoDir = path.join(tmp, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "t@t.t"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoDir });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
      cwd: repoDir,
    });
    await fs.writeFile(path.join(repoDir, "x"), "x", "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: repoDir,
    });

    const wtPath = path.join(tmp, "elsewhere", "feat");
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", "space/PRO-001", wtPath],
      { cwd: repoDir }
    );

    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
      repo: repoDir,
    });

    const items = await scanProjects(tmp, false, path.join(tmp, "missing"));
    expect(items).toHaveLength(2);
    const wts = items[0]?.worktrees ?? [];
    const found = wts.find((w) => w.branch === "space/PRO-001");
    expect(found).toBeTruthy();
    expect(await fs.realpath(found!.path)).toBe(await fs.realpath(wtPath));
  });

  it("assigns explicitly declared repo branches to only that project", async () => {
    const repoDir = path.join(tmp, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "t@t.t"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoDir });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
      cwd: repoDir,
    });
    await fs.writeFile(path.join(repoDir, "x"), "x", "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: repoDir,
    });

    const wtPath = path.join(tmp, "elsewhere", "loosen-project-phase1");
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", "feat/loosen-project-phase1", wtPath],
      { cwd: repoDir }
    );

    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
      repo: repoDir,
      worktrees: [
        `{"repo":"${repoDir}","branch":"feat/loosen-project-phase1"}`,
      ],
    });
    await makeProject(tmp, "PRO-002", {
      title: "Beta",
      status: "current",
      created: "2026-01-02",
      repo: repoDir,
    });

    const items = await scanProjects(tmp, false, path.join(tmp, "missing"));
    const alpha = items.find((item) => item.id === "PRO-001");
    const beta = items.find((item) => item.id === "PRO-002");
    expect(alpha?.worktrees.map((wt) => wt.branch)).toContain(
      "feat/loosen-project-phase1"
    );
    expect(beta?.worktrees.map((wt) => wt.branch)).not.toContain(
      "feat/loosen-project-phase1"
    );
  });

  it("discovers worktrees from bare repo metadata", async () => {
    const sourceDir = path.join(tmp, "source");
    await fs.mkdir(sourceDir, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: sourceDir,
    });
    await execFileAsync("git", ["config", "user.email", "t@t.t"], {
      cwd: sourceDir,
    });
    await execFileAsync("git", ["config", "user.name", "t"], {
      cwd: sourceDir,
    });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
      cwd: sourceDir,
    });
    await fs.writeFile(path.join(sourceDir, "x"), "x", "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: sourceDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: sourceDir,
    });

    const bareDir = path.join(tmp, "repo.git");
    await execFileAsync("git", ["clone", "--bare", sourceDir, bareDir]);
    const wtPath = path.join(tmp, "bare-wt");
    await execFileAsync("git", [
      `--git-dir=${bareDir}`,
      "worktree",
      "add",
      "-b",
      "space/PRO-001",
      wtPath,
      "main",
    ]);

    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
      repo: bareDir,
    });

    const items = await scanProjects(tmp, false, path.join(tmp, "missing"));
    const found = items[0]?.worktrees.find(
      (wt) => wt.branch === "space/PRO-001"
    );
    expect(found).toBeTruthy();
    expect(await fs.realpath(found!.path)).toBe(await fs.realpath(wtPath));
  });

  it("dedupes worktrees discovered by both root scan and repo metadata", async () => {
    const repoDir = path.join(tmp, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "t@t.t"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoDir });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
      cwd: repoDir,
    });
    await fs.writeFile(path.join(repoDir, "x"), "x", "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: repoDir,
    });

    const wtRoot = path.join(tmp, "_wts");
    const wtPath = path.join(wtRoot, "repo", "feat");
    await fs.mkdir(path.dirname(wtPath), { recursive: true });
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", "space/PRO-001", wtPath],
      { cwd: repoDir }
    );

    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
      repo: repoDir,
    });

    const items = await scanProjects(tmp, false, wtRoot);
    const wts = items[0]?.worktrees ?? [];
    expect(wts).toHaveLength(1);
    expect(wts[0]?.branch).toBe("space/PRO-001");
  });

  it("reads root worktree branches without git rev-parse", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    await makeProject(tmp, "PRO-002", {
      title: "Beta",
      status: "current",
      created: "2026-01-02",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    await makeWorktree(wtRoot, "yoplai", "alpha", "space/PRO-001");
    await makeWorktree(wtRoot, "yoplai", "beta", "space/PRO-002");

    const gitLog = await withGitLog(tmp);
    try {
      const items = await scanProjects(tmp, false, wtRoot);
      expect(items).toHaveLength(3);
    } finally {
      gitLog.restore();
    }

    const log = await readGitLog(gitLog.logPath);
    const branchReads = log.filter((line) =>
      line.endsWith("|rev-parse --abbrev-ref HEAD")
    );
    expect(branchReads).toHaveLength(0);
  });

  it("discovers repo worktrees without git worktree list", async () => {
    const repoDir = path.join(tmp, "repo");
    await fs.mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    await execFileAsync("git", ["config", "user.email", "t@t.t"], {
      cwd: repoDir,
    });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: repoDir });
    await execFileAsync("git", ["config", "commit.gpgsign", "false"], {
      cwd: repoDir,
    });
    await fs.writeFile(path.join(repoDir, "x"), "x", "utf-8");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], {
      cwd: repoDir,
    });
    await execFileAsync(
      "git",
      ["worktree", "add", "-b", "space/PRO-001", path.join(tmp, "wt-1")],
      {
        cwd: repoDir,
      }
    );

    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
      repo: repoDir,
    });
    await makeProject(tmp, "PRO-002", {
      title: "Beta",
      status: "current",
      created: "2026-01-02",
      repo: repoDir,
    });

    const gitLog = await withGitLog(tmp);
    try {
      const items = await scanProjects(tmp, false, path.join(tmp, "missing"));
      expect(items).toHaveLength(3);
    } finally {
      gitLog.restore();
    }

    const log = await readGitLog(gitLog.logPath);
    const worktreeLists = log.filter((line) =>
      line.endsWith("|worktree list --porcelain")
    );
    expect(worktreeLists).toHaveLength(0);
  });

  it("dedupes concurrent scans for the same project root", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(wtRoot, "yoplai", "alpha", "space/PRO-001");
    await fs.writeFile(path.join(wt, "dirty"), "dirty", "utf-8");

    const gitLog = await withGitLog(tmp);
    try {
      const [first, second] = await Promise.all([
        scanProjects(tmp, false, wtRoot),
        scanProjects(tmp, false, wtRoot),
      ]);
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
    } finally {
      gitLog.restore();
    }

    const log = await readGitLog(gitLog.logPath);
    const statusReads = log.filter((line) =>
      line.endsWith("|status --porcelain")
    );
    expect(statusReads).toHaveLength(1);
  });

  it("keeps endpoint cache entries separate by worktreesRoot", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    await makeWorktree(wtRoot, "yoplai", "alpha", "space/PRO-001");

    const withWorktree = await scanProjects(tmp, false, wtRoot);
    expect(withWorktree[0]?.worktrees).toHaveLength(1);

    const withoutWorktree = await scanProjects(
      tmp,
      false,
      path.join(tmp, "missing")
    );
    expect(withoutWorktree[0]?.worktrees).toEqual([]);
  });

  it("clears in-flight scans when invalidating a project root", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    await makeWorktree(wtRoot, "yoplai", "alpha", "space/PRO-001");

    const gitLog = await withGitLog(tmp, "0.3");
    let first: Promise<Awaited<ReturnType<typeof scanProjects>>>;
    try {
      first = scanProjects(tmp, false, wtRoot, { cacheTtlMs: 60_000 });
      await waitFor(async () => {
        const log = await readGitLog(gitLog.logPath);
        return log.some((line) => line.endsWith("|status --porcelain"));
      });

      await makeProject(tmp, "PRO-001", {
        title: "Beta",
        status: "current",
        created: "2026-01-01",
      });
      invalidateProjectCache(tmp);
      const second = await scanProjects(tmp, false, wtRoot, {
        cacheTtlMs: 60_000,
      });

      expect((await first)[0]?.title).toBe("Alpha");
      expect(second[0]?.title).toBe("Beta");
    } finally {
      gitLog.restore();
    }
  });

  it("clears endpoint cache when a watched git index changes", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });
    const wtRoot = path.join(tmp, "_worktrees");
    const wt = await makeWorktree(wtRoot, "yoplai", "alpha", "space/PRO-001");
    const options = { cacheTtlMs: 60_000, dirtyAheadTtlMs: 60_000 };

    const clean = await scanProjects(tmp, false, wtRoot, options);
    expect(clean[0]?.worktrees[0]?.dirty).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 25));
    await fs.writeFile(path.join(wt, "x"), "changed", "utf-8");
    await execFileAsync("git", ["add", "x"], { cwd: wt });

    await waitFor(async () => {
      const items = await scanProjects(tmp, false, wtRoot, options);
      return items[0]?.worktrees[0]?.dirty === true;
    });
  });

  it("serves cached project results until invalidated", async () => {
    await makeProject(tmp, "PRO-001", {
      title: "Alpha",
      status: "current",
      created: "2026-01-01",
    });

    const first = await scanProjects(tmp, false, emptyWtRoot);
    expect(first[0]?.title).toBe("Alpha");

    await makeProject(tmp, "PRO-001", {
      title: "Beta",
      status: "current",
      created: "2026-01-01",
    });

    const cached = await scanProjects(tmp, false, emptyWtRoot);
    expect(cached[0]?.title).toBe("Alpha");

    invalidateProjectCache(tmp);
    const refreshed = await scanProjects(tmp, false, emptyWtRoot);
    expect(refreshed[0]?.title).toBe("Beta");
  });

  it("uses dir name as id when frontmatter id missing", async () => {
    await makeProject(tmp, "PRO-X", {
      title: "X",
      status: "current",
      created: "2026-01-01",
    });
    const items = await scanProjects(tmp, false, emptyWtRoot);
    expect(items[0]?.id).toBe("PRO-X");
  });

  it("skips dirs without README.md", async () => {
    await fs.mkdir(path.join(tmp, "PRO-empty"), { recursive: true });
    const items = await scanProjects(tmp, false, emptyWtRoot);
    expect(items).toMatchObject([{ id: UNASSIGNED_PROJECT_ID, worktrees: [] }]);
  });
});
