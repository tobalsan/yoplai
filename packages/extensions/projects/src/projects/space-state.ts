import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expandPath, readEnv, type GatewayConfig } from "@yoplai/shared";
import { getProject } from "./store.js";
import { getProjectsRoot } from "../util/paths.js";

const DEFAULT_LEASE_TTL_SECONDS = 60 * 60;
const spaceMutationQueues = new Map<string, Promise<void>>();

async function serializeSpaceMutation<T>(
  filePath: string,
  mutation: () => Promise<T>
): Promise<T> {
  const previous = spaceMutationQueues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => {}).then(() => current);
  spaceMutationQueues.set(filePath, queued);
  await previous.catch(() => {});
  try {
    return await mutation();
  } finally {
    release();
    if (spaceMutationQueues.get(filePath) === queued) {
      spaceMutationQueues.delete(filePath);
    }
  }
}

export type IntegrationStatus =
  | "pending"
  | "integrated"
  | "conflict"
  | "skipped"
  | "stale_worker";

export type IntegrationEntry = {
  id: string;
  workerSlug: string;
  runMode: "worktree" | "clone";
  worktreePath: string;
  startSha?: string;
  endSha?: string;
  shas: string[];
  status: IntegrationStatus;
  createdAt: string;
  integratedAt?: string;
  error?: string;
  staleAgainstSha?: string;
};

export type SpaceRebaseConflict = {
  baseSha: string;
  error: string;
};

export type ProjectSpace = {
  version: 1;
  projectId: string;
  branch: string;
  worktreePath: string;
  baseBranch: string;
  rebaseConflict?: SpaceRebaseConflict;
  integrationBlocked: boolean;
  queue: IntegrationEntry[];
  updatedAt: string;
};

export type SpaceFile = ProjectSpace;
export type SpaceQueueEntry = IntegrationEntry;

export type SpaceCommitSummary = {
  sha: string;
  subject: string;
  author: string;
  date: string;
};

export type SpaceContribution = {
  entry: IntegrationEntry;
  commits: SpaceCommitSummary[];
  diff: string;
  conflictFiles: string[];
};

export type SpaceWriteLease = {
  holder: string;
  acquiredAt: string;
  expiresAt: string;
};

export type SpaceWriteLeaseResult =
  | { ok: true; data: SpaceWriteLease | null }
  | { ok: false; error: string };

export type ProjectSpaceResult =
  | { ok: true; data: ProjectSpace }
  | { ok: false; error: string };

export type SpaceProjectContext = {
  projectId: string;
  projectDir: string;
  repo: string;
  spaceFilePath: string;
  leaseFilePath: string;
};

export function normalizeStringList(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export function isSpaceWriteLeaseEnabled(): boolean {
  const raw = (readEnv("YOPLAI_SPACE_WRITE_LEASE") ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function normalizeQueue(input: unknown): IntegrationEntry[] {
  if (!Array.isArray(input)) return [];
  const entries: IntegrationEntry[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    const workerSlug =
      typeof row.workerSlug === "string" ? row.workerSlug.trim() : "";
    const runMode = row.runMode === "clone" ? "clone" : "worktree";
    const worktreePath =
      typeof row.worktreePath === "string" ? row.worktreePath.trim() : "";
    const createdAt =
      typeof row.createdAt === "string"
        ? row.createdAt
        : new Date().toISOString();
    const status: IntegrationStatus =
      row.status === "integrated" ||
      row.status === "conflict" ||
      row.status === "skipped" ||
      row.status === "stale_worker"
        ? row.status
        : "pending";
    const shas = Array.isArray(row.shas)
      ? row.shas
          .filter((value): value is string => typeof value === "string")
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : [];
    if (!id || !workerSlug || !worktreePath) continue;
    entries.push({
      id,
      workerSlug,
      runMode,
      worktreePath,
      startSha: typeof row.startSha === "string" ? row.startSha : undefined,
      endSha: typeof row.endSha === "string" ? row.endSha : undefined,
      shas,
      status,
      createdAt,
      integratedAt:
        typeof row.integratedAt === "string" ? row.integratedAt : undefined,
      error: typeof row.error === "string" ? row.error : undefined,
      staleAgainstSha:
        typeof row.staleAgainstSha === "string"
          ? row.staleAgainstSha
          : undefined,
    });
  }
  return entries;
}

export function parseSpaceFile(raw: string): ProjectSpace | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const projectId =
    typeof parsed.projectId === "string" ? parsed.projectId.trim() : "";
  const branch = typeof parsed.branch === "string" ? parsed.branch.trim() : "";
  const worktreePath =
    typeof parsed.worktreePath === "string" ? parsed.worktreePath.trim() : "";
  const baseBranch =
    typeof parsed.baseBranch === "string" ? parsed.baseBranch.trim() : "main";
  const rawRebaseConflict = parsed.rebaseConflict;
  const rebaseConflict =
    rawRebaseConflict &&
    typeof rawRebaseConflict === "object" &&
    typeof (rawRebaseConflict as Record<string, unknown>).baseSha ===
      "string" &&
    typeof (rawRebaseConflict as Record<string, unknown>).error === "string"
      ? {
          baseSha: (rawRebaseConflict as Record<string, string>).baseSha,
          error: (rawRebaseConflict as Record<string, string>).error,
        }
      : undefined;
  if (!projectId || !branch || !worktreePath) return null;
  return {
    version: 1,
    projectId,
    branch,
    worktreePath,
    baseBranch: baseBranch || "main",
    rebaseConflict,
    integrationBlocked: parsed.integrationBlocked === true,
    queue: normalizeQueue(parsed.queue),
    updatedAt:
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date().toISOString(),
  };
}

export function buildSpaceDefaults(input: {
  config: GatewayConfig;
  projectId: string;
  existing?: ProjectSpace | null;
  baseBranch?: string;
}): ProjectSpace {
  const branch = input.existing?.branch || `space/${input.projectId}`;
  const baseBranch =
    input.existing?.baseBranch || input.baseBranch?.trim() || "main";
  const worktreePath =
    input.existing?.worktreePath ||
    path.join(
      getProjectsRoot(input.config),
      ".workspaces",
      input.projectId,
      "_space"
    );
  return {
    version: 1,
    projectId: input.projectId,
    branch,
    baseBranch,
    worktreePath,
    rebaseConflict: input.existing?.rebaseConflict,
    integrationBlocked: input.existing?.integrationBlocked ?? false,
    queue: input.existing?.queue ?? [],
    updatedAt: new Date().toISOString(),
  };
}

function isLeaseExpired(lease: SpaceWriteLease, now = Date.now()): boolean {
  const leaseTs = Date.parse(lease.expiresAt);
  return Number.isFinite(leaseTs) ? leaseTs <= now : true;
}

export class SpaceStateStore {
  constructor(private readonly config: GatewayConfig) {}

  async resolveProjectContext(projectId: string): Promise<SpaceProjectContext> {
    const project = await getProject(this.config, projectId);
    if (!project.ok) throw new Error(project.error);

    const repoRaw =
      typeof project.data.frontmatter.repo === "string"
        ? project.data.frontmatter.repo
        : "";
    if (!repoRaw.trim()) throw new Error("Project repo not set");

    const repo = expandPath(repoRaw.trim());
    const projectDir = project.data.absolutePath;
    return {
      projectId,
      projectDir,
      repo,
      spaceFilePath: path.join(projectDir, "space.json"),
      leaseFilePath: path.join(projectDir, "space-lease.json"),
    };
  }

  async readSpaceFile(filePath: string): Promise<ProjectSpace | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return parseSpaceFile(raw);
    } catch {
      return null;
    }
  }

  async writeSpaceFile(filePath: string, space: ProjectSpace): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tempPath, JSON.stringify(space, null, 2), "utf8");
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async readProjectSpace(projectId: string): Promise<ProjectSpace | null> {
    const context = await this.resolveProjectContext(projectId);
    return this.readSpaceFile(context.spaceFilePath);
  }

  async getProjectSpace(projectId: string): Promise<ProjectSpaceResult> {
    let context;
    try {
      context = await this.resolveProjectContext(projectId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Project lookup failed",
      };
    }

    const space = await this.readSpaceFile(context.spaceFilePath);
    if (!space) {
      return { ok: false, error: "Project space not found" };
    }
    return { ok: true, data: space };
  }

  async persistProjectSpace(
    projectId: string,
    updater: (space: ProjectSpace) => Promise<ProjectSpace> | ProjectSpace,
    initial?: ProjectSpace
  ): Promise<ProjectSpace> {
    const context = await this.resolveProjectContext(projectId);
    return serializeSpaceMutation(context.spaceFilePath, async () => {
      const existing = await this.readSpaceFile(context.spaceFilePath);
      if (!existing && !initial) throw new Error("Project space not found");
      const updated = await updater(existing ?? initial!);
      updated.updatedAt = new Date().toISOString();
      await this.writeSpaceFile(context.spaceFilePath, updated);
      return updated;
    });
  }

  async clearRebaseConflict(projectId: string): Promise<ProjectSpace> {
    return this.persistProjectSpace(projectId, (space) => ({
      ...space,
      rebaseConflict: undefined,
    }));
  }

  async readLeaseFile(filePath: string): Promise<SpaceWriteLease | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const holder =
        typeof parsed.holder === "string" ? parsed.holder.trim() : "";
      const acquiredAt =
        typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "";
      const expiresAt =
        typeof parsed.expiresAt === "string" ? parsed.expiresAt : "";
      if (!holder || !acquiredAt || !expiresAt) return null;
      return { holder, acquiredAt, expiresAt };
    } catch {
      return null;
    }
  }

  async writeLeaseFile(
    filePath: string,
    lease: SpaceWriteLease
  ): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(lease, null, 2), "utf8");
  }

  async getWriteLease(projectId: string): Promise<SpaceWriteLeaseResult> {
    if (!isSpaceWriteLeaseEnabled()) {
      return { ok: true, data: null };
    }
    let context;
    try {
      context = await this.resolveProjectContext(projectId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Project lookup failed",
      };
    }

    const lease = await this.readLeaseFile(context.leaseFilePath);
    if (!lease) return { ok: true, data: null };
    if (isLeaseExpired(lease)) {
      await fs.rm(context.leaseFilePath, { force: true }).catch(() => {});
      return { ok: true, data: null };
    }
    return { ok: true, data: lease };
  }

  async acquireWriteLease(
    projectId: string,
    input: { holder: string; ttlSeconds?: number; force?: boolean }
  ): Promise<SpaceWriteLeaseResult> {
    if (!isSpaceWriteLeaseEnabled()) {
      return { ok: false, error: "Space write lease is disabled" };
    }
    const holder = input.holder.trim();
    if (!holder) {
      return { ok: false, error: "holder is required" };
    }

    let context;
    try {
      context = await this.resolveProjectContext(projectId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Project lookup failed",
      };
    }

    const existing = await this.readLeaseFile(context.leaseFilePath);
    if (
      existing &&
      !isLeaseExpired(existing) &&
      existing.holder !== holder &&
      !input.force
    ) {
      return {
        ok: false,
        error: `Space lease already held by ${existing.holder}`,
      };
    }

    const ttlSeconds = Number.isFinite(input.ttlSeconds)
      ? Math.max(30, Math.min(24 * 60 * 60, Math.floor(input.ttlSeconds ?? 0)))
      : DEFAULT_LEASE_TTL_SECONDS;
    const now = Date.now();
    const lease: SpaceWriteLease = {
      holder,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    };
    await this.writeLeaseFile(context.leaseFilePath, lease);
    return { ok: true, data: lease };
  }

  async releaseWriteLease(
    projectId: string,
    input: { holder?: string; force?: boolean }
  ): Promise<SpaceWriteLeaseResult> {
    if (!isSpaceWriteLeaseEnabled()) {
      return { ok: true, data: null };
    }
    let context;
    try {
      context = await this.resolveProjectContext(projectId);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Project lookup failed",
      };
    }

    const existing = await this.readLeaseFile(context.leaseFilePath);
    if (!existing || isLeaseExpired(existing)) {
      await fs.rm(context.leaseFilePath, { force: true }).catch(() => {});
      return { ok: true, data: null };
    }
    if (
      !input.force &&
      input.holder &&
      input.holder.trim() &&
      existing.holder !== input.holder.trim()
    ) {
      return {
        ok: false,
        error: `Space lease held by ${existing.holder}`,
      };
    }
    await fs.rm(context.leaseFilePath, { force: true });
    return { ok: true, data: null };
  }
}
