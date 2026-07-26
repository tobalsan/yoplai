import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expandPath, readEnv } from "@yoplai/shared";
import { splitFrontmatter } from "./frontmatter.js";

const execFileAsync = promisify(execFile);

export type BoardProjectGroup = "active" | "review" | "stale" | "done";

/** Lifecycle status per §5.4 of the kanban-slice-refactor spec. */
export type ProjectLifecycleStatus =
  | "triage"
  | "shaping"
  | "active"
  | "ready_to_merge"
  | "done"
  | "cancelled"
  | "archived";

export type ProjectLifecycleCounts = Record<ProjectLifecycleStatus, number>;

export type ProjectLifecycleScan = {
  counts: ProjectLifecycleCounts;
  statuses: Map<string, ProjectLifecycleStatus>;
};

export type SliceProgress = {
  done: number;
  total: number;
};

export type BoardWorktree = {
  name: string;
  path: string;
  branch: string;
  dirty: boolean;
  ahead: number;
};

export type BoardAgentRunView = {
  runId: string;
  label: string;
  cli: string;
  status: "running" | "done" | "failed" | "interrupted" | string;
  startedAt: string;
  updatedAt: string;
};

export type BoardWorktreeView = Omit<BoardWorktree, "branch"> & {
  id: string;
  workerSlug: string;
  worktreePath: string;
  branch: string | null;
  queueStatus:
    | "pending"
    | "integrated"
    | "conflict"
    | "skipped"
    | "stale_worker"
    | null;
  agentRun: BoardAgentRunView | null;
  startedAt?: string;
  integratedAt?: string;
  startSha?: string;
  endSha?: string;
};

export type BoardProject = {
  id: string;
  title: string;
  area: string;
  status: string;
  /** Mapped lifecycle status for the board home grouped view. */
  lifecycleStatus: ProjectLifecycleStatus;
  group: BoardProjectGroup;
  created: string;
  /** Progress of slices: { done, total }. Null when no slices directory. */
  sliceProgress: SliceProgress;
  /** ISO timestamp of most recent activity (updated_at frontmatter or README mtime). */
  lastActivity: string | null;
  /** Count of worktrees with an actively running agent. */
  activeRunCount: number;
  worktrees: BoardWorktreeView[];
};

export const UNASSIGNED_PROJECT_ID = "__unassigned";

/** Valid target lifecycle statuses for POST /board/projects/:id/move */
export const MOVEABLE_LIFECYCLE_STATUSES = new Set<ProjectLifecycleStatus>([
  "triage",
  "shaping",
  "active",
  "ready_to_merge",
  "done",
  "cancelled",
  "archived",
]);

/** Map a raw project status string to a board lifecycle status. */
export function mapToLifecycleStatus(status: string): ProjectLifecycleStatus {
  if (status.startsWith("shaping:")) return "shaping";
  switch (status) {
    case "triage":
      return "triage";
    case "active":
      return "active";
    case "shaping":
      return "shaping";
    case "maybe":
    case "not_now":
      return "triage";
    // Legacy kanban statuses (todo, in_progress, review, ready_to_merge) map to
    // "active" per §10.1 of kanban-slice-refactor spec.
    case "todo":
    case "in_progress":
    case "review":
      return "active";
    case "ready_to_merge":
      return "ready_to_merge";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "archived":
      return "archived";
    default:
      return "triage";
  }
}

/**
 * Validate a lifecycle status transition per §5.4.
 * Returns null when valid; returns an error message when invalid.
 */
export type TransitionValidation =
  | { ok: true }
  | { ok: false; reason: string; code: string };

export function validateLifecycleTransition(
  from: ProjectLifecycleStatus,
  to: ProjectLifecycleStatus,
  slices?: { done: number; total: number }
): TransitionValidation {
  if (from === to) {
    return { ok: false, reason: `Project is already ${to}`, code: "no_change" };
  }
  if (from === "active" && to === "done") {
    if (slices && slices.total > 0 && slices.done < slices.total) {
      return {
        ok: false,
        reason: `Cannot mark done: ${slices.total - slices.done} slice(s) not yet finished`,
        code: "slices_not_terminal",
      };
    }
    return { ok: true };
  }
  return { ok: true };
}

const SLICE_ID_PATTERN = /^PRO-\d+-S\d+$/;

/** Read slice progress (done/total) from a project directory. */
export async function readSliceProgress(
  projectDir: string
): Promise<SliceProgress> {
  const slicesDir = path.join(projectDir, "slices");
  try {
    const entries = await fs.readdir(slicesDir, { withFileTypes: true });
    const sliceDirs = entries
      .filter((e) => e.isDirectory() && SLICE_ID_PATTERN.test(e.name))
      .map((e) => e.name);
    if (sliceDirs.length === 0) return { done: 0, total: 0 };
    let done = 0;
    const total = sliceDirs.length;
    await Promise.all(
      sliceDirs.map(async (sliceName) => {
        const readmePath = path.join(slicesDir, sliceName, "README.md");
        try {
          const raw = await fs.readFile(readmePath, "utf-8");
          const { frontmatter } = splitFrontmatter(raw);
          const status =
            typeof frontmatter.status === "string" ? frontmatter.status : "";
          if (status === "done" || status === "cancelled") done++;
        } catch {
          // ignore unreadable slices
        }
      })
    );
    return { done, total };
  } catch {
    return { done: 0, total: 0 };
  }
}

const PROJECT_DIR_PATTERN = /^PRO-/;
const SKIP_DIRS = new Set([".workspaces", ".archive", ".done", ".trash"]);
const DONE_DIR = ".done";

const GROUP_ORDER: Record<BoardProjectGroup, number> = {
  review: 0,
  active: 1,
  stale: 2,
  done: 3,
};

const DEFAULT_PROJECT_CACHE_TTL_MS = 10_000;
const DEFAULT_REPO_WORKTREE_TTL_MS = 30_000;
const DEFAULT_BRANCH_CACHE_TTL_MS = 30_000;
const DEFAULT_DIRTY_AHEAD_TTL_MS = 15_000;

export type ScanProjectsOptions = {
  cacheTtlMs?: number;
  repoWorktreeTtlMs?: number;
  branchTtlMs?: number;
  dirtyAheadTtlMs?: number;
  getSpace?: (projectId: string) => Promise<SpaceView | null>;
  runsByCwd?: Map<string, AgentRunSummaryView>;
  lifecycleStatuses?: Map<string, ProjectLifecycleStatus>;
};

type SpaceQueueEntryView = {
  id: string;
  workerSlug: string;
  worktreePath: string;
  status: BoardWorktreeView["queueStatus"];
  createdAt: string;
  integratedAt?: string;
  startSha?: string;
  endSha?: string;
};

type SpaceView = {
  worktreePath: string;
  queue: SpaceQueueEntryView[];
};

type ProjectEntryLocation = {
  root: string;
  dirName: string;
};

type ProjectWorktreeRef = {
  path?: string;
  repo?: string;
  branch?: string;
  name?: string;
};

type AgentRunSummaryView = {
  runId: string;
  label: string;
  cli: string;
  cwd?: string;
  status: string;
  startedAt: string;
  updatedAt: string;
};

type ProjectCacheEntry = {
  value: BoardProject[];
  expiresAt: number;
};

type RepoWorktreeCacheEntry = {
  value: Array<{ path: string; name: string }>;
  expiresAt: number;
};

type BranchCacheEntry = {
  branch: string | null;
  headPath: string;
  mtimeMs: number;
  expiresAt: number;
};

type DirtyAheadCacheEntry = {
  dirty: boolean;
  ahead: number;
  expiresAt: number;
};

type GitMetadata = {
  gitDir: string;
  commonGitDir: string;
  headPath: string;
  indexPath: string;
};

const projectResultCache = new Map<string, ProjectCacheEntry>();
const inFlightScans = new Map<string, Promise<BoardProject[]>>();

// These process-local caches keep the hot board endpoint free of filesystem
// and git work on repeat requests while still allowing event-driven invalidation.
const repoWorktreeCache = new Map<string, RepoWorktreeCacheEntry>();
const branchCache = new Map<string, BranchCacheEntry>();
const dirtyAheadCache = new Map<string, DirtyAheadCacheEntry>();
const indexWatchers = new Map<
  string,
  { watcher?: FSWatcher; worktreeKey: string; mtimeMs: number }
>();
const lifecycleMetadataCache = new Map<
  string,
  { version: number; expiresAt: number; value: ProjectLifecycleScan }
>();
const inFlightLifecycleScans = new Map<string, Promise<ProjectLifecycleScan>>();
let projectCacheVersion = 0;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function projectCacheTtlMs(options?: ScanProjectsOptions): number {
  return (
    options?.cacheTtlMs ??
    readPositiveIntEnv(
      "YOPLAI_BOARD_PROJECTS_CACHE_TTL_MS",
      DEFAULT_PROJECT_CACHE_TTL_MS
    )
  );
}

function repoWorktreeTtlMs(options?: ScanProjectsOptions): number {
  return (
    options?.repoWorktreeTtlMs ??
    readPositiveIntEnv(
      "YOPLAI_BOARD_REPO_WORKTREE_TTL_MS",
      DEFAULT_REPO_WORKTREE_TTL_MS
    )
  );
}

function branchTtlMs(options?: ScanProjectsOptions): number {
  return (
    options?.branchTtlMs ??
    readPositiveIntEnv(
      "YOPLAI_BOARD_BRANCH_CACHE_TTL_MS",
      DEFAULT_BRANCH_CACHE_TTL_MS
    )
  );
}

function dirtyAheadTtlMs(options?: ScanProjectsOptions): number {
  return (
    options?.dirtyAheadTtlMs ??
    readPositiveIntEnv(
      "YOPLAI_BOARD_DIRTY_AHEAD_TTL_MS",
      DEFAULT_DIRTY_AHEAD_TTL_MS
    )
  );
}

function boardWorktreeDiagnosticsEnabled(): boolean {
  return readEnv("YOPLAI_BOARD_WORKTREE_DIAGNOSTICS") === "1";
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function scanCacheKey(
  projectsRoot: string,
  worktreesRoot: string,
  includeDone: boolean,
  options?: ScanProjectsOptions
): string {
  const variant = options?.getSpace || options?.runsByCwd ? "joined" : "base";
  return `${projectsRoot}\0${worktreesRoot}\0${includeDone ? "1" : "0"}\0${variant}`;
}

export function invalidateProjectCache(projectsRoot?: string): void {
  projectCacheVersion++;
  if (!projectsRoot) {
    projectResultCache.clear();
    lifecycleMetadataCache.clear();
    inFlightScans.clear();
    inFlightLifecycleScans.clear();
    return;
  }
  const prefix = `${projectsRoot}\0`;
  for (const key of projectResultCache.keys()) {
    if (key.startsWith(prefix)) projectResultCache.delete(key);
  }
  lifecycleMetadataCache.delete(projectsRoot);
  inFlightLifecycleScans.delete(projectsRoot);
  for (const key of inFlightScans.keys()) {
    if (key.startsWith(prefix)) inFlightScans.delete(key);
  }
}

export function resetProjectCaches(): void {
  projectCacheVersion++;
  projectResultCache.clear();
  lifecycleMetadataCache.clear();
  inFlightScans.clear();
  inFlightLifecycleScans.clear();
  repoWorktreeCache.clear();
  branchCache.clear();
  dirtyAheadCache.clear();
  for (const { watcher } of indexWatchers.values()) watcher?.close();
  indexWatchers.clear();
}

export function statusToGroup(status: string): BoardProjectGroup {
  switch (status) {
    case "current":
    case "triage":
    case "todo":
    case "shaping":
    case "active":
    case "in_progress":
      return "active";
    case "review":
    case "ready_to_merge":
      return "review";
    case "not_now":
    case "maybe":
      return "stale";
    case "done":
    case "cancelled":
    case "archived":
      return "done";
    default:
      return "stale";
  }
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

function readProjectWorktreeRefs(value: unknown): ProjectWorktreeRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ProjectWorktreeRef[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      refs.push({ path: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const rawPath = asString(raw.path ?? raw.worktreePath);
    const repo = asString(raw.repo);
    const branch = asString(raw.branch);
    const name = asString(raw.name);
    const ref: ProjectWorktreeRef = {};
    if (rawPath) ref.path = rawPath;
    if (repo) ref.repo = repo;
    if (branch) ref.branch = branch;
    if (name) ref.name = name;
    if (ref.path || ref.branch) refs.push(ref);
  }
  return refs;
}

async function readProjectMeta(
  projectsRoot: string,
  dirName: string
): Promise<{
  id: string;
  title: string;
  area: string;
  status: string;
  created: string;
  updatedAt: string | null;
  repo?: string;
  worktrees: ProjectWorktreeRef[];
  projectDir: string;
} | null> {
  const projectDir = path.join(projectsRoot, dirName);
  const readmePath = path.join(projectDir, "README.md");
  let raw: string;
  let mtime: Date | null = null;
  try {
    const stat = await fs.stat(readmePath);
    mtime = stat.mtime;
    raw = await fs.readFile(readmePath, "utf-8");
  } catch {
    return null;
  }
  const { frontmatter } = splitFrontmatter(raw);
  const id = asString(frontmatter.id) ?? dirName;
  const title = asString(frontmatter.title) ?? dirName;
  const area = asString(frontmatter.area) ?? "";
  const status = asString(frontmatter.status) ?? "";
  const created = asString(frontmatter.created) ?? "";
  const updatedAt =
    asString(frontmatter.updated_at) ?? (mtime ? mtime.toISOString() : null);
  const repo = asString(frontmatter.repo);
  const worktrees = readProjectWorktreeRefs(frontmatter.worktrees);
  return {
    id,
    title,
    area,
    status,
    created,
    updatedAt,
    repo,
    worktrees,
    projectDir,
  };
}

async function readProjectLifecycleStatus(
  projectsRoot: string,
  dirName: string
): Promise<ProjectLifecycleStatus | null> {
  try {
    const raw = await fs.readFile(
      path.join(projectsRoot, dirName, "README.md"),
      "utf-8"
    );
    const { frontmatter } = splitFrontmatter(raw);
    return mapToLifecycleStatus(asString(frontmatter.status) ?? "");
  } catch {
    return null;
  }
}

async function readProjectEntryLocations(
  projectsRoot: string,
  options?: { includeDone?: boolean }
): Promise<ProjectEntryLocation[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const locations = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !SKIP_DIRS.has(entry.name) &&
        PROJECT_DIR_PATTERN.test(entry.name)
    )
    .map((entry) => ({ root: projectsRoot, dirName: entry.name }));

  if (!options?.includeDone) return locations;

  let doneEntries: import("node:fs").Dirent[];
  const doneRoot = path.join(projectsRoot, DONE_DIR);
  try {
    doneEntries = await fs.readdir(doneRoot, { withFileTypes: true });
  } catch {
    return locations;
  }
  for (const entry of doneEntries) {
    if (entry.isDirectory() && PROJECT_DIR_PATTERN.test(entry.name)) {
      locations.push({ root: doneRoot, dirName: entry.name });
    }
  }
  return locations;
}

async function readProjectLifecycleMetadata(
  projectsRoot: string
): Promise<ProjectLifecycleScan> {
  const counts: ProjectLifecycleCounts = {
    triage: 0,
    shaping: 0,
    active: 0,
    ready_to_merge: 0,
    done: 0,
    cancelled: 0,
    archived: 0,
  };
  const statuses = new Map<string, ProjectLifecycleStatus>();
  const projectEntries = await readProjectEntryLocations(projectsRoot, {
    includeDone: true,
  });
  const readStatuses = await Promise.all(
    projectEntries.map((entry) =>
      readProjectLifecycleStatus(entry.root, entry.dirName)
    )
  );
  for (let i = 0; i < readStatuses.length; i += 1) {
    const status = readStatuses[i];
    if (status) counts[status] += 1;
    if (status && projectEntries[i]!.root === projectsRoot) {
      statuses.set(projectEntries[i]!.dirName, status);
    }
  }
  return { counts, statuses };
}

export async function scanProjectLifecycleMetadata(
  projectsRoot: string,
  options?: { cacheTtlMs?: number }
): Promise<ProjectLifecycleScan> {
  const now = Date.now();
  const cached = lifecycleMetadataCache.get(projectsRoot);
  if (
    cached &&
    cached.version === projectCacheVersion &&
    cached.expiresAt > now
  ) {
    return cached.value;
  }

  const inFlight = inFlightLifecycleScans.get(projectsRoot);
  if (inFlight) return inFlight;

  const promise = readProjectLifecycleMetadata(projectsRoot).then((value) => {
    lifecycleMetadataCache.set(projectsRoot, {
      version: projectCacheVersion,
      expiresAt: Date.now() + projectCacheTtlMs(options),
      value,
    });
    return value;
  });
  inFlightLifecycleScans.set(projectsRoot, promise);
  try {
    return await promise;
  } finally {
    inFlightLifecycleScans.delete(projectsRoot);
  }
}

export async function scanProjectLifecycleCounts(
  projectsRoot: string
): Promise<ProjectLifecycleCounts> {
  return (await scanProjectLifecycleMetadata(projectsRoot)).counts;
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolveGitPath(baseDir: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(baseDir, trimmed);
}

async function resolveGitMetadata(worktreePath: string): Promise<GitMetadata> {
  const dotGitPath = path.join(worktreePath, ".git");
  const stat = await fs.stat(dotGitPath);
  let gitDir: string;
  if (stat.isDirectory()) {
    gitDir = dotGitPath;
  } else {
    const raw = await fs.readFile(dotGitPath, "utf-8");
    const prefix = "gitdir:";
    if (!raw.startsWith(prefix)) throw new Error("Invalid .git file");
    gitDir = resolveGitPath(worktreePath, raw.slice(prefix.length));
  }

  let commonGitDir = gitDir;
  try {
    const commonRaw = await fs.readFile(
      path.join(gitDir, "commondir"),
      "utf-8"
    );
    commonGitDir = resolveGitPath(gitDir, commonRaw);
  } catch {
    // Main worktrees do not have commondir; their git dir is the common dir.
  }

  return {
    gitDir,
    commonGitDir,
    headPath: path.join(gitDir, "HEAD"),
    indexPath: path.join(gitDir, "index"),
  };
}

function parseBranchFromHead(raw: string): string | null {
  const head = raw.trim();
  const headsPrefix = "ref: refs/heads/";
  if (head.startsWith(headsPrefix)) return head.slice(headsPrefix.length);
  return null;
}

async function readWorktreeBranch(
  worktreePath: string,
  options?: ScanProjectsOptions
): Promise<string | null> {
  const key = path.resolve(worktreePath);
  const now = Date.now();
  const cached = branchCache.get(key);
  if (cached && cached.expiresAt > now) return cached.branch;

  try {
    const metadata = await resolveGitMetadata(worktreePath);
    const stat = await fs.stat(metadata.headPath);
    if (
      cached &&
      cached.headPath === metadata.headPath &&
      cached.mtimeMs === stat.mtimeMs
    ) {
      cached.expiresAt = now + branchTtlMs(options);
      return cached.branch;
    }
    const branch = parseBranchFromHead(
      await fs.readFile(metadata.headPath, "utf-8")
    );
    branchCache.set(key, {
      branch,
      headPath: metadata.headPath,
      mtimeMs: stat.mtimeMs,
      expiresAt: now + branchTtlMs(options),
    });
    return branch;
  } catch {
    return null;
  }
}

function watchIndexForDirtyInvalidation(
  indexPath: string,
  worktreeKey: string,
  mtimeMs: number
): void {
  if (indexWatchers.has(indexPath)) return;
  indexWatchers.set(indexPath, { worktreeKey, mtimeMs });
  try {
    const indexName = path.basename(indexPath);
    const watcher = watch(path.dirname(indexPath), (_event, filename) => {
      const changedName = typeof filename === "string" ? filename : undefined;
      if (
        changedName &&
        changedName !== indexName &&
        changedName !== `${indexName}.lock`
      ) {
        return;
      }
      dirtyAheadCache.delete(worktreeKey);
      invalidateProjectCache();
      void fs
        .stat(indexPath)
        .then((stat) => {
          const entry = indexWatchers.get(indexPath);
          if (entry) entry.mtimeMs = stat.mtimeMs;
        })
        .catch(() => undefined);
    });
    watcher.on("error", () => {
      watcher.close();
      const entry = indexWatchers.get(indexPath);
      if (entry) entry.watcher = undefined;
    });
    const entry = indexWatchers.get(indexPath);
    if (entry) entry.watcher = watcher;
  } catch {
    // Some repos have no index yet or disallow watching; TTL remains fallback.
  }
}

async function invalidateChangedIndexCaches(): Promise<void> {
  for (const [indexPath, entry] of indexWatchers) {
    try {
      const stat = await fs.stat(indexPath);
      if (stat.mtimeMs === entry.mtimeMs) continue;
      entry.mtimeMs = stat.mtimeMs;
      dirtyAheadCache.delete(entry.worktreeKey);
      invalidateProjectCache();
    } catch {
      dirtyAheadCache.delete(entry.worktreeKey);
      invalidateProjectCache();
    }
  }
}

async function readDirtyAheadCached(
  worktreePath: string,
  worktreeKey: string,
  options?: ScanProjectsOptions
): Promise<{ dirty: boolean; ahead: number }> {
  const now = Date.now();
  const cached = dirtyAheadCache.get(worktreeKey);
  if (cached && cached.expiresAt > now) {
    return { dirty: cached.dirty, ahead: cached.ahead };
  }

  try {
    const metadata = await resolveGitMetadata(worktreePath);
    const stat = await fs.stat(metadata.indexPath);
    watchIndexForDirtyInvalidation(
      metadata.indexPath,
      worktreeKey,
      stat.mtimeMs
    );
  } catch {
    // Dirty/ahead are best-effort status decorations.
  }

  let dirty = false;
  try {
    const status = await gitText(["status", "--porcelain"], worktreePath);
    dirty = status.trim().length > 0;
  } catch {
    dirty = false;
  }
  let ahead = 0;
  try {
    const out = await gitText(
      ["rev-list", "--count", "HEAD", "--not", "origin/main"],
      worktreePath
    );
    const n = Number.parseInt(out.trim(), 10);
    ahead = Number.isFinite(n) ? n : 0;
  } catch {
    ahead = 0;
  }

  dirtyAheadCache.set(worktreeKey, {
    dirty,
    ahead,
    expiresAt: now + dirtyAheadTtlMs(options),
  });
  return { dirty, ahead };
}

async function readWorktreeDetails(
  worktreePath: string,
  name: string,
  branch: string,
  options?: ScanProjectsOptions
): Promise<BoardWorktree> {
  const worktreeKey = await canonicalPath(worktreePath);
  const { dirty, ahead } = await readDirtyAheadCached(
    worktreePath,
    worktreeKey,
    options
  );
  return { name, path: worktreePath, branch, dirty, ahead };
}

function agentRunForPath(
  worktreePath: string,
  runsByCwd?: Map<string, AgentRunSummaryView>
): BoardAgentRunView | null {
  const run = runsByCwd?.get(path.resolve(worktreePath));
  if (!run) return null;
  return {
    runId: run.runId,
    label: run.label,
    cli: run.cli,
    status: run.status === "error" ? "failed" : run.status,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
}

async function readWorktreeView(params: {
  id: string;
  workerSlug: string;
  worktreePath: string;
  queueStatus: BoardWorktreeView["queueStatus"];
  name?: string;
  startedAt?: string;
  integratedAt?: string;
  startSha?: string;
  endSha?: string;
  runsByCwd?: Map<string, AgentRunSummaryView>;
  options?: ScanProjectsOptions;
}): Promise<BoardWorktreeView> {
  const branch = await readWorktreeBranch(params.worktreePath, params.options);
  const worktreeKey = await canonicalPath(params.worktreePath);
  const dirtyAhead = branch
    ? await readDirtyAheadCached(
        params.worktreePath,
        worktreeKey,
        params.options
      )
    : { dirty: false, ahead: 0 };
  const name =
    params.name ?? (params.workerSlug || path.basename(params.worktreePath));
  return {
    name,
    path: params.worktreePath,
    branch,
    dirty: dirtyAhead.dirty,
    ahead: dirtyAhead.ahead,
    id: params.id,
    workerSlug: params.workerSlug,
    worktreePath: params.worktreePath,
    queueStatus: params.queueStatus,
    agentRun: agentRunForPath(params.worktreePath, params.runsByCwd),
    startedAt: params.startedAt,
    integratedAt: params.integratedAt,
    startSha: params.startSha,
    endSha: params.endSha,
  };
}

async function buildProjectWorktreeViews(
  meta: ProjectMeta,
  legacyWorktrees: BoardWorktree[],
  options?: ScanProjectsOptions
): Promise<BoardWorktreeView[]> {
  const getSpace = options?.getSpace;
  const space = getSpace ? await getSpace(meta.id) : null;
  const views: BoardWorktreeView[] = [];
  const covered = new Set<string>();
  const diagnostics = boardWorktreeDiagnosticsEnabled();
  const logWorktreePath = async (
    source: string,
    worktreePath: string
  ): Promise<string> => {
    const canonical = await canonicalPath(worktreePath);
    if (diagnostics) {
      console.warn(
        `[board] worktree ${meta.id} ${source}: raw=${worktreePath} canonical=${canonical}`
      );
    }
    return canonical;
  };
  const worktreeKeys = (
    worktreePath: string,
    workerSlug?: string,
    branch?: string | null
  ): string[] => {
    const keys = [`path:${worktreePath}`];
    const slug = workerSlug || workerSlugFromBranch(branch, meta.id);
    if (slug) keys.push(`worker:${meta.id}:${normalizeSlug(slug)}`);
    return keys;
  };
  const coveredHas = async (
    source: string,
    worktreePath: string,
    workerSlug?: string,
    branch?: string | null
  ): Promise<boolean> => {
    const canonical = await logWorktreePath(source, worktreePath);
    return worktreeKeys(canonical, workerSlug, branch).some((key) =>
      covered.has(key)
    );
  };
  const addCovered = async (
    source: string,
    worktreePath: string,
    workerSlug?: string,
    branch?: string | null
  ): Promise<void> => {
    const canonical = await logWorktreePath(source, worktreePath);
    for (const key of worktreeKeys(canonical, workerSlug, branch)) {
      covered.add(key);
    }
  };

  if (space) {
    const latestByPath = new Map<string, SpaceQueueEntryView>();
    for (const entry of space.queue) {
      await logWorktreePath(
        `space-queue:${entry.workerSlug}`,
        entry.worktreePath
      );
      const key = `worker:${meta.id}:${normalizeSlug(entry.workerSlug)}`;
      const current = latestByPath.get(key);
      if (!current) {
        latestByPath.set(key, entry);
        continue;
      }
      const currentTime = Date.parse(current.createdAt);
      const entryTime = Date.parse(entry.createdAt);
      if (
        !Number.isFinite(currentTime) ||
        !Number.isFinite(entryTime) ||
        entryTime >= currentTime
      ) {
        latestByPath.set(key, entry);
      }
    }

    for (const entry of latestByPath.values()) {
      views.push(
        await readWorktreeView({
          id: entry.id,
          workerSlug: entry.workerSlug,
          worktreePath: entry.worktreePath,
          queueStatus: entry.status,
          startedAt: entry.createdAt,
          integratedAt: entry.integratedAt,
          startSha: entry.startSha,
          endSha: entry.endSha,
          runsByCwd: options?.runsByCwd,
          options,
        })
      );
      await addCovered(
        `space-queue:${entry.workerSlug}`,
        entry.worktreePath,
        entry.workerSlug
      );
    }
    if (
      space.worktreePath &&
      !(await coveredHas("space-root", space.worktreePath, "_space"))
    ) {
      views.push(
        await readWorktreeView({
          id: `${meta.id}:_space`,
          workerSlug: "_space",
          worktreePath: space.worktreePath,
          queueStatus: null,
          runsByCwd: options?.runsByCwd,
          options,
        })
      );
      await addCovered("space-root", space.worktreePath, "_space");
    }
  }

  for (const ref of meta.worktrees) {
    if (!ref.path) continue;
    const worktreePath = expandPath(ref.path);
    const name = ref.name ?? path.basename(worktreePath);
    if (
      await coveredHas(`frontmatter:${name}`, worktreePath, name, ref.branch)
    ) {
      continue;
    }
    views.push(
      await readWorktreeView({
        id: `${meta.id}:${name}`,
        workerSlug: name,
        worktreePath,
        queueStatus: null,
        name,
        runsByCwd: options?.runsByCwd,
        options,
      })
    );
    await addCovered(`frontmatter:${name}`, worktreePath, name, ref.branch);
  }

  for (const wt of legacyWorktrees) {
    const legacySlug = workerSlugFromBranch(wt.branch, meta.id) ?? wt.name;
    if (await coveredHas(`git:${legacySlug}`, wt.path, legacySlug, wt.branch)) {
      continue;
    }
    const isMainRepo =
      meta.repo &&
      (await canonicalPath(wt.path)) ===
        (await canonicalPath(expandPath(meta.repo)));
    const workerSlug = isMainRepo ? "main" : wt.name || path.basename(wt.path);
    views.push({
      ...wt,
      id: `${meta.id}:${workerSlug}`,
      workerSlug,
      worktreePath: wt.path,
      queueStatus: null,
      agentRun: agentRunForPath(wt.path, options?.runsByCwd),
    });
    await addCovered(`git:${workerSlug}`, wt.path, workerSlug, wt.branch);
  }
  if (views.length > 0) return views;

  if (!meta.repo) return [];
  const worktreePath = expandPath(meta.repo);
  return [
    await readWorktreeView({
      id: `${meta.id}:main`,
      workerSlug: "main",
      worktreePath,
      queueStatus: null,
      name: "main",
      runsByCwd: options?.runsByCwd,
      options,
    }),
  ];
}

function branchMatchesProject(branch: string, id: string): boolean {
  return (
    branch === `space/${id}` ||
    branch.startsWith(`space/${id}/`) ||
    branch.startsWith(`${id}/`)
  );
}

function extractProjectIdFromPath(
  p: string,
  activeProjectIds: Set<string>
): string | null {
  for (const segment of path.resolve(expandPath(p)).split(path.sep)) {
    const match = segment.match(/\bPRO-\d+\b/);
    if (!match) continue;
    return activeProjectIds.has(match[0]) ? match[0] : null;
  }
  return null;
}

function extractProjectIdFromBranchToken(
  branch: string,
  activeProjectIds: Set<string>
): string | null {
  const match = branch.match(/\bPRO-\d+\b/);
  if (!match) return null;
  return activeProjectIds.has(match[0]) ? match[0] : null;
}

function projectIdFromBranchPrefix(
  branch: string,
  activeProjectIds: Set<string>
): string | null {
  for (const id of activeProjectIds) {
    if (branchMatchesProject(branch, id)) return id;
  }
  return null;
}

function workerSlugFromBranch(
  branch: string | null | undefined,
  id: string
): string | null {
  if (!branch) return null;
  if (branch === `space/${id}`) return "_space";
  const spacePrefix = `space/${id}/`;
  if (branch.startsWith(spacePrefix)) return branch.slice(spacePrefix.length);
  const projectPrefix = `${id}/`;
  if (branch.startsWith(projectPrefix))
    return branch.slice(projectPrefix.length);
  return null;
}

async function isGitWorktree(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, ".git"));
}

type ProjectMeta = {
  id: string;
  title: string;
  area: string;
  status: string;
  created: string;
  updatedAt: string | null;
  repo?: string;
  worktrees: ProjectWorktreeRef[];
  projectDir: string;
};

type WorktreeIndex = Map<string, BoardWorktree[]>;

type WorktreeIndexResult = {
  attributed: WorktreeIndex;
  unassigned: BoardWorktree[];
};

async function worktreeMatchesExplicitRef(
  worktreePath: string,
  branch: string,
  meta: ProjectMeta
): Promise<boolean> {
  for (const ref of meta.worktrees) {
    if (ref.branch !== branch) continue;
    if (!ref.repo) return true;
    try {
      const worktreeGit = await resolveGitMetadata(worktreePath);
      const repoPath = expandPath(ref.repo);
      const repoGit =
        (await pathExists(path.join(repoPath, "HEAD"))) &&
        (await pathExists(path.join(repoPath, "objects")))
          ? { commonGitDir: repoPath }
          : await resolveGitMetadata(repoPath);
      if (
        (await canonicalPath(worktreeGit.commonGitDir)) ===
        (await canonicalPath(repoGit.commonGitDir))
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

function explicitWorktreeRepos(metas: ProjectMeta[]): string[] {
  const repos = new Set<string>();
  for (const meta of metas) {
    for (const ref of meta.worktrees) {
      if (ref.repo) repos.add(ref.repo);
      else if (ref.branch && meta.repo) repos.add(meta.repo);
    }
  }
  return [...repos];
}

function addWorktreeToIndex(
  index: WorktreeIndex,
  projectId: string,
  wt: BoardWorktree
): void {
  const existing = index.get(projectId) ?? [];
  existing.push(wt);
  index.set(projectId, existing);
}

function startsWithInactiveProjectId(
  name: string,
  activeProjectIds: Set<string>
): boolean {
  if (!name.startsWith("PRO-")) return false;
  for (const projectId of activeProjectIds) {
    if (name === projectId || name.startsWith(`${projectId}-`)) return false;
  }
  return true;
}

async function scanWorktreePathsFromRoot(
  worktreesRoot: string,
  activeProjectIds: Set<string>,
  activeRepoNames?: Set<string>
): Promise<Array<{ path: string; name: string }>> {
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(worktreesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ path: string; name: string }> = [];
  for (const proj of projectDirs) {
    if (!proj.isDirectory()) continue;
    if (SKIP_DIRS.has(proj.name)) continue;
    if (startsWithInactiveProjectId(proj.name, activeProjectIds)) continue;
    if (
      activeRepoNames &&
      !proj.name.startsWith("PRO-") &&
      !activeRepoNames.has(proj.name)
    ) {
      continue;
    }
    const projPath = path.join(worktreesRoot, proj.name);
    let inner: import("node:fs").Dirent[];
    try {
      inner = await fs.readdir(projPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of inner) {
      if (!entry.isDirectory()) continue;
      if (startsWithInactiveProjectId(entry.name, activeProjectIds)) continue;
      const wtPath = path.join(projPath, entry.name);
      if (!(await isGitWorktree(wtPath))) continue;
      out.push({ path: wtPath, name: entry.name });
    }
  }
  return out;
}

async function scanWorktreeRefsFromRepo(
  repo: string,
  options?: ScanProjectsOptions
): Promise<Array<{ path: string; name: string }>> {
  const repoPath = expandPath(repo);
  const now = Date.now();
  const cached = repoWorktreeCache.get(repoPath);
  if (cached && cached.expiresAt > now) return cached.value;

  const out: Array<{ path: string; name: string }> = [];
  try {
    let commonGitDir: string;
    if (
      (await pathExists(path.join(repoPath, "HEAD"))) &&
      (await pathExists(path.join(repoPath, "objects")))
    ) {
      commonGitDir = repoPath;
    } else {
      const metadata = await resolveGitMetadata(repoPath);
      commonGitDir = metadata.commonGitDir;
      out.push({ path: repoPath, name: path.basename(repoPath) });
    }

    const worktreesDir = path.join(commonGitDir, "worktrees");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(worktreesDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadataDir = path.join(worktreesDir, entry.name);
      let gitdirRaw: string;
      try {
        gitdirRaw = await fs.readFile(
          path.join(metadataDir, "gitdir"),
          "utf-8"
        );
      } catch {
        continue;
      }
      const gitdirPath = resolveGitPath(metadataDir, gitdirRaw);
      const worktreePath = path.dirname(gitdirPath);
      out.push({ path: worktreePath, name: path.basename(worktreePath) });
    }
  } catch {
    return [];
  }
  repoWorktreeCache.set(repoPath, {
    value: out,
    expiresAt: now + repoWorktreeTtlMs(options),
  });
  return out;
}

async function canonicalPath(p: string): Promise<string> {
  const expanded = expandPath(p);
  try {
    return await fs.realpath(expanded);
  } catch {
    return path.resolve(expanded);
  }
}

async function buildWorktreeIndex(
  metas: ProjectMeta[],
  worktreesRoot: string,
  options?: ScanProjectsOptions
): Promise<WorktreeIndexResult> {
  const activeMetas = metas.filter(
    (meta) => statusToGroup(meta.status) !== "done"
  );
  const activeProjectIds = new Set(activeMetas.map((meta) => meta.id));

  const repos = [
    ...new Set(
      [
        ...activeMetas.map((meta) => meta.repo),
        ...explicitWorktreeRepos(activeMetas),
      ].filter(
        (repo): repo is string => typeof repo === "string" && repo !== ""
      )
    ),
  ];
  const activeRepoNames =
    repos.length > 0 &&
    activeMetas.every(
      (meta) => typeof meta.repo === "string" && meta.repo !== ""
    )
      ? new Set(repos.map((repo) => path.basename(expandPath(repo))))
      : undefined;

  const index: WorktreeIndex = new Map();
  const unassigned: BoardWorktree[] = [];
  const detailsByPath = new Map<string, BoardWorktree>();

  const explicitProjectIdForWorktree = async (
    worktreePath: string,
    branch: string
  ): Promise<string | null> => {
    for (const meta of activeMetas) {
      if (await worktreeMatchesExplicitRef(worktreePath, branch, meta)) {
        return meta.id;
      }
    }
    return null;
  };

  const projectIdForWorktree = async (
    worktreePath: string,
    branch: string
  ): Promise<string | null> => {
    // Association precedence: frontmatter worktrees, branch prefix convention,
    // branch PRO-id token, then path PRO-id token.
    return (
      (await explicitProjectIdForWorktree(worktreePath, branch)) ??
      projectIdFromBranchPrefix(branch, activeProjectIds) ??
      extractProjectIdFromBranchToken(branch, activeProjectIds) ??
      extractProjectIdFromPath(worktreePath, activeProjectIds)
    );
  };

  const readMatchedWorktree = async (
    worktreePath: string,
    name: string,
    branch: string
  ): Promise<{ projectId: string | null; wt: BoardWorktree } | null> => {
    const projectId = await projectIdForWorktree(worktreePath, branch);
    const key = await canonicalPath(worktreePath);
    const cached = detailsByPath.get(key);
    if (cached) return { projectId, wt: cached };
    const wt = await readWorktreeDetails(worktreePath, name, branch, options);
    detailsByPath.set(key, wt);
    return { projectId, wt };
  };

  const rootPaths = await scanWorktreePathsFromRoot(
    worktreesRoot,
    activeProjectIds,
    activeRepoNames
  );
  const rootWorktrees = await Promise.all(
    rootPaths.map(async (candidate) => {
      const branch = await readWorktreeBranch(candidate.path, options);
      if (!branch) return null;
      return readMatchedWorktree(candidate.path, candidate.name, branch);
    })
  );
  for (const match of rootWorktrees) {
    if (!match) continue;
    if (match.projectId) addWorktreeToIndex(index, match.projectId, match.wt);
    else unassigned.push(match.wt);
  }

  const repoRefs = await Promise.all(
    repos.map((repo) => scanWorktreeRefsFromRepo(repo, options))
  );
  const repoWorktrees = await Promise.all(
    repoRefs.flat().map(async (ref) => {
      const branch = await readWorktreeBranch(ref.path, options);
      if (!branch) return null;
      return readMatchedWorktree(ref.path, ref.name, branch);
    })
  );
  for (const match of repoWorktrees) {
    if (!match) continue;
    if (match.projectId) addWorktreeToIndex(index, match.projectId, match.wt);
    else unassigned.push(match.wt);
  }

  return { attributed: index, unassigned };
}

async function lookupWorktrees(
  index: WorktreeIndex,
  meta: ProjectMeta
): Promise<BoardWorktree[]> {
  const dedup = new Map<string, BoardWorktree>();
  for (const wt of index.get(meta.id) ?? []) {
    const key = await canonicalPath(wt.path);
    if (!dedup.has(key)) dedup.set(key, wt);
  }
  const result = [...dedup.values()];
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

async function buildUnassignedProject(
  worktrees: BoardWorktree[],
  options?: ScanProjectsOptions
): Promise<BoardProject> {
  const meta: ProjectMeta = {
    id: UNASSIGNED_PROJECT_ID,
    title: "Unassigned",
    area: "",
    status: "unassigned",
    created: "",
    updatedAt: null,
    worktrees: [],
    projectDir: "",
  };
  return {
    id: UNASSIGNED_PROJECT_ID,
    title: "Unassigned",
    area: "",
    status: "unassigned",
    lifecycleStatus: "shaping",
    group: "active",
    created: "",
    sliceProgress: { done: 0, total: 0 },
    lastActivity: null,
    activeRunCount: 0,
    worktrees: await buildProjectWorktreeViews(meta, worktrees, options),
  };
}

export async function scanProjects(
  projectsRoot: string,
  includeDone: boolean,
  worktreesRoot?: string,
  options?: ScanProjectsOptions
): Promise<BoardProject[]> {
  const wtRoot = worktreesRoot ?? expandPath("~/.worktrees");
  const key = scanCacheKey(projectsRoot, wtRoot, includeDone, options);
  const cached = projectResultCache.get(key);
  if (cached) {
    await invalidateChangedIndexCaches();
    const current = projectResultCache.get(key);
    if (!current) {
      return refreshProjectCache(
        key,
        projectsRoot,
        includeDone,
        wtRoot,
        options
      );
    }
    if (current.expiresAt <= Date.now()) {
      void refreshProjectCache(
        key,
        projectsRoot,
        includeDone,
        wtRoot,
        options
      ).catch(() => undefined);
    }
    return current.value;
  }
  return refreshProjectCache(key, projectsRoot, includeDone, wtRoot, options);
}

function refreshProjectCache(
  key: string,
  projectsRoot: string,
  includeDone: boolean,
  worktreesRoot?: string,
  options?: ScanProjectsOptions
): Promise<BoardProject[]> {
  const inFlight = inFlightScans.get(key);
  if (inFlight) return inFlight;

  const version = projectCacheVersion;
  const promise = scanProjectsUncached(
    projectsRoot,
    includeDone,
    worktreesRoot,
    options
  )
    .then((items) => {
      if (version === projectCacheVersion) {
        projectResultCache.set(key, {
          value: items,
          expiresAt: Date.now() + projectCacheTtlMs(options),
        });
      }
      return items;
    })
    .finally(() => {
      if (inFlightScans.get(key) === promise) inFlightScans.delete(key);
    });

  inFlightScans.set(key, promise);
  return promise;
}

async function scanProjectsUncached(
  projectsRoot: string,
  includeDone: boolean,
  worktreesRoot?: string,
  options?: ScanProjectsOptions
): Promise<BoardProject[]> {
  const projectEntries = await readProjectEntryLocations(projectsRoot, {
    includeDone: true,
  });
  if (projectEntries.length === 0) {
    return [await buildUnassignedProject([], options)];
  }

  const wtRoot = worktreesRoot ?? expandPath("~/.worktrees");

  const entriesToRead = includeDone
    ? projectEntries
    : (
        await Promise.all(
          projectEntries.map(async (entry) => ({
            entry,
            lifecycleStatus:
              options?.lifecycleStatuses?.get(entry.dirName) ??
              (await readProjectLifecycleStatus(entry.root, entry.dirName)),
          }))
        )
      )
        .filter((item) => item.lifecycleStatus !== "done")
        .map((item) => item.entry);
  const metas = (
    await Promise.all(
      entriesToRead.map((entry) => readProjectMeta(entry.root, entry.dirName))
    )
  ).filter((meta): meta is ProjectMeta => meta !== null);
  const worktreeIndex = await buildWorktreeIndex(metas, wtRoot, options);

  const projects: BoardProject[] = [];
  for (const meta of metas) {
    const group = statusToGroup(meta.status);
    const worktrees = await buildProjectWorktreeViews(
      meta,
      await lookupWorktrees(worktreeIndex.attributed, meta),
      options
    );
    const sliceProgress = await readSliceProgress(meta.projectDir);
    const activeRunCount = worktrees.filter(
      (wt) => wt.agentRun?.status === "running"
    ).length;
    projects.push({
      id: meta.id,
      title: meta.title,
      area: meta.area,
      status: meta.status,
      lifecycleStatus: mapToLifecycleStatus(meta.status),
      group,
      created: meta.created,
      sliceProgress,
      lastActivity: meta.updatedAt,
      activeRunCount,
      worktrees,
    });
  }

  projects.sort((a, b) => {
    const g = GROUP_ORDER[a.group] - GROUP_ORDER[b.group];
    if (g !== 0) return g;
    return b.created.localeCompare(a.created);
  });

  projects.push(
    await buildUnassignedProject(worktreeIndex.unassigned, options)
  );

  return projects;
}
