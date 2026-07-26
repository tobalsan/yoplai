import { readEnv, type GatewayConfig } from "@yoplai/shared";
import { dirExists } from "../util/fs.js";
import {
  buildSpaceDefaults,
  normalizeStringList,
  type IntegrationEntry,
  type ProjectSpace,
  type SpaceContribution,
  type SpaceCommitSummary,
  type SpaceProjectContext,
  type SpaceWriteLeaseResult,
} from "./space-state.js";
import { SpaceStateStore } from "./space-state.js";
import {
  SpaceGitAdapter,
  collectCommitShas,
  collectPatchForShas,
  ensureWorktree,
  fetchCloneShas,
  getGitHead,
  isGitRepo,
  listConflictFiles,
  parseCommitSummaries,
  runGit,
  runGitInRepo,
} from "./space-git.js";

export type SpaceCleanupSummary = {
  workerWorktreesRemoved: number;
  workerWorktreesMissing: number;
  workerBranchesDeleted: number;
  workerBranchesMissing: number;
  spaceWorktreeRemoved: boolean;
  spaceWorktreeMissing: boolean;
  spaceBranchDeleted: boolean;
  spaceBranchMissing: boolean;
  errors: string[];
};

export type SpaceMergeResult = {
  baseBranch: string;
  spaceBranch: string;
  beforeSha: string | null;
  afterSha: string;
  mergeMethod: "ff" | "merge";
  pushed: boolean;
  pushedRemote?: string;
  cleanup?: SpaceCleanupSummary;
};

export type RecordWorkerDeliveryInput = {
  projectId: string;
  workerSlug: string;
  runMode: "worktree" | "clone";
  worktreePath: string;
  startSha?: string;
  endSha?: string;
  replaces?: string[];
};

function isSpaceAutoRebaseEnabled(): boolean {
  const raw = (readEnv("YOPLAI_SPACE_AUTO_REBASE") ?? "true")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function hasUnresolvedEntries(space: ProjectSpace): boolean {
  return space.queue.some(
    (item) =>
      item.status === "pending" ||
      item.status === "conflict" ||
      item.status === "stale_worker"
  );
}

export class SpaceIntegrationPolicy {
  constructor(
    private readonly config: GatewayConfig,
    private readonly state = new SpaceStateStore(config),
    private readonly git = new SpaceGitAdapter()
  ) {}

  async ensureProjectSpace(
    projectId: string,
    baseBranch?: string
  ): Promise<ProjectSpace> {
    const context = await this.state.resolveProjectContext(projectId);
    if (!(await this.git.isGitRepo(context.repo))) {
      throw new Error("Not a git repository");
    }

    const existing = await this.state.readSpaceFile(context.spaceFilePath);
    const space = buildSpaceDefaults({
      config: this.config,
      projectId,
      existing,
      baseBranch,
    });

    await this.git.ensureWorktree(
      context.repo,
      space.worktreePath,
      space.branch,
      space.baseBranch
    );

    space.updatedAt = new Date().toISOString();
    await this.state.writeSpaceFile(context.spaceFilePath, space);
    return space;
  }

  async getProjectSpace(projectId: string) {
    return this.state.getProjectSpace(projectId);
  }

  async clearProjectSpaceRebaseConflict(
    projectId: string
  ): Promise<ProjectSpace> {
    return this.state.clearRebaseConflict(projectId);
  }

  async getProjectSpaceCommitLog(
    projectId: string,
    limit = 20
  ): Promise<SpaceCommitSummary[]> {
    const context = await this.state.resolveProjectContext(projectId);
    const space = await this.state.readSpaceFile(context.spaceFilePath);
    if (!space) throw new Error("Project space not found");
    if (!(await this.git.isGitRepo(space.worktreePath))) return [];

    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.floor(limit)))
      : 20;
    const range = `${space.baseBranch || "main"}..HEAD`;
    const out = await this.git
      .runGit(space.worktreePath, [
        "log",
        "--date=iso-strict",
        "--pretty=format:%H%x09%an%x09%ad%x09%s",
        "--max-count",
        String(safeLimit),
        range,
      ])
      .catch(() => "");
    if (!out.trim()) return [];

    return out
      .split(/\r?\n/)
      .map((line) => {
        const [sha = "", author = "", date = "", ...subjectParts] =
          line.split("\t");
        if (!sha) return null;
        return {
          sha,
          author,
          date,
          subject: subjectParts.join("\t"),
        } satisfies SpaceCommitSummary;
      })
      .filter((row): row is SpaceCommitSummary => row !== null);
  }

  async getProjectSpaceContribution(
    projectId: string,
    entryId: string
  ): Promise<SpaceContribution> {
    const context = await this.state.resolveProjectContext(projectId);
    const space = await this.state.readSpaceFile(context.spaceFilePath);
    if (!space) throw new Error("Project space not found");

    const entry = space.queue.find((item) => item.id === entryId);
    if (!entry) throw new Error("Space integration entry not found");

    const preferredCwds = [entry.worktreePath, space.worktreePath, context.repo];
    let cwd = space.worktreePath;
    for (const candidate of preferredCwds) {
      if (await this.git.isGitRepo(candidate)) {
        cwd = candidate;
        break;
      }
    }

    const commits = await this.git.parseCommitSummaries(cwd, entry.shas);
    const diff = await this.git.collectPatchForShas(cwd, entry.shas);
    const conflictFiles =
      entry.status === "conflict"
        ? await this.git.listConflictFiles(space.worktreePath)
        : [];

    return { entry, commits, diff, conflictFiles };
  }

  async getProjectSpaceConflictContext(
    projectId: string,
    entryId: string
  ): Promise<{
    space: ProjectSpace;
    entry: IntegrationEntry;
    conflictFiles: string[];
  }> {
    const context = await this.state.resolveProjectContext(projectId);
    const space = await this.state.readSpaceFile(context.spaceFilePath);
    if (!space) throw new Error("Project space not found");
    const entry = space.queue.find(
      (item) => item.id === entryId && item.status === "conflict"
    );
    if (!entry) throw new Error("Space conflict entry not found");
    const conflictFiles = await this.git.listConflictFiles(space.worktreePath);
    return { space, entry, conflictFiles };
  }

  async pruneProjectRepoWorktrees(projectId: string): Promise<void> {
    const context = await this.state.resolveProjectContext(projectId);
    if (!(await this.git.isGitRepo(context.repo))) return;
    await this.git.runGitInRepo(context.repo, ["worktree", "prune"]).catch(
      () => {}
    );
  }

  getWriteLease(projectId: string): Promise<SpaceWriteLeaseResult> {
    return this.state.getWriteLease(projectId);
  }

  acquireWriteLease(
    projectId: string,
    input: { holder: string; ttlSeconds?: number; force?: boolean }
  ): Promise<SpaceWriteLeaseResult> {
    return this.state.acquireWriteLease(projectId, input);
  }

  releaseWriteLease(
    projectId: string,
    input: { holder?: string; force?: boolean }
  ): Promise<SpaceWriteLeaseResult> {
    return this.state.releaseWriteLease(projectId, input);
  }

  async cleanupSpaceWorktrees(projectId: string): Promise<SpaceCleanupSummary> {
    const context = await this.state.resolveProjectContext(projectId);
    if (!(await this.git.isGitRepo(context.repo))) {
      throw new Error("Not a git repository");
    }
    const space = await this.state.readSpaceFile(context.spaceFilePath);
    if (!space) throw new Error("Project space not found");

    const summary: SpaceCleanupSummary = {
      workerWorktreesRemoved: 0,
      workerWorktreesMissing: 0,
      workerBranchesDeleted: 0,
      workerBranchesMissing: 0,
      spaceWorktreeRemoved: false,
      spaceWorktreeMissing: false,
      spaceBranchDeleted: false,
      spaceBranchMissing: false,
      errors: [],
    };

    const seenWorktrees = new Set<string>();
    const seenBranches = new Set<string>();

    for (const item of space.queue) {
      const workerWorktree = item.worktreePath.trim();
      if (workerWorktree && !seenWorktrees.has(workerWorktree)) {
        seenWorktrees.add(workerWorktree);
        if (await dirExists(workerWorktree)) {
          try {
            await this.git.runGitInRepo(context.repo, [
              "worktree",
              "remove",
              "--force",
              workerWorktree,
            ]);
            summary.workerWorktreesRemoved += 1;
          } catch (error) {
            summary.errors.push(
              `failed to remove worktree ${workerWorktree}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } else {
          summary.workerWorktreesMissing += 1;
        }
      }

      const workerBranch = `${projectId}/${item.workerSlug}`;
      if (seenBranches.has(workerBranch)) continue;
      seenBranches.add(workerBranch);
      const deleted = await this.git.deleteBranchIfPresent(
        context.repo,
        workerBranch
      );
      if (deleted === "deleted") summary.workerBranchesDeleted += 1;
      else if (deleted === "missing") summary.workerBranchesMissing += 1;
      else summary.errors.push(`failed to delete branch ${workerBranch}`);
    }

    if (await dirExists(space.worktreePath)) {
      try {
        await this.git.runGitInRepo(context.repo, [
          "worktree",
          "remove",
          "--force",
          space.worktreePath,
        ]);
        summary.spaceWorktreeRemoved = true;
      } catch (error) {
        summary.errors.push(
          `failed to remove space worktree ${space.worktreePath}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } else {
      summary.spaceWorktreeMissing = true;
    }

    const deletedSpaceBranch = await this.git.deleteBranchIfPresent(
      context.repo,
      space.branch
    );
    if (deletedSpaceBranch === "deleted") summary.spaceBranchDeleted = true;
    else if (deletedSpaceBranch === "missing") summary.spaceBranchMissing = true;
    else summary.errors.push(`failed to delete space branch ${space.branch}`);

    await this.state.persistProjectSpace(projectId, (current) => ({
      ...current,
      queue: [],
      integrationBlocked: false,
    }));

    await this.pruneProjectRepoWorktrees(projectId).catch(() => {});
    return summary;
  }

  async mergeSpaceIntoBase(
    projectId: string,
    options?: { cleanup?: boolean }
  ): Promise<SpaceMergeResult> {
    const context = await this.state.resolveProjectContext(projectId);
    if (!(await this.git.isGitRepo(context.repo))) {
      throw new Error("Not a git repository");
    }
    const space = await this.state.readSpaceFile(context.spaceFilePath);
    if (!space) throw new Error("Project space not found");
    if (hasUnresolvedEntries(space) || space.integrationBlocked) {
      throw new Error(
        "Space queue has unresolved entries (pending/conflict/stale_worker)"
      );
    }

    const originalBranch = await this.git
      .runGitInRepo(context.repo, ["rev-parse", "--abbrev-ref", "HEAD"])
      .catch(() => "");
    let mergeMethod: "ff" | "merge" = "ff";
    let afterSha: string | null = null;
    const beforeSha = await this.git.getGitHead(context.repo);

    try {
      await this.git.runGitInRepo(context.repo, ["checkout", space.baseBranch]);
      try {
        await this.git.runGitInRepo(context.repo, [
          "merge",
          "--ff-only",
          space.branch,
        ]);
        mergeMethod = "ff";
      } catch {
        mergeMethod = "merge";
        try {
          await this.git.runGitInRepo(context.repo, [
            "merge",
            "--no-edit",
            space.branch,
          ]);
        } catch (error) {
          await this.git
            .runGitInRepo(context.repo, ["merge", "--abort"])
            .catch(() => {});
          throw new Error(
            `Space merge failed: ${
              error instanceof Error ? error.message : "git merge failed"
            }`
          );
        }
      }
      afterSha = await this.git.getGitHead(context.repo);
      if (!afterSha) throw new Error("Failed to resolve merged base HEAD");
      const pushResult = await this.git.pushBaseBranch(
        context.repo,
        space.baseBranch
      );

      let cleanupResult: SpaceCleanupSummary | undefined;
      if (options?.cleanup ?? true) {
        cleanupResult = await this.cleanupSpaceWorktrees(projectId);
      } else {
        await this.state.persistProjectSpace(projectId, (current) => ({
          ...current,
          queue: [],
          integrationBlocked: false,
        }));
      }

      return {
        baseBranch: space.baseBranch,
        spaceBranch: space.branch,
        beforeSha,
        afterSha,
        mergeMethod,
        pushed: pushResult.pushed,
        pushedRemote: pushResult.remote,
        cleanup: cleanupResult,
      };
    } finally {
      if (originalBranch && originalBranch !== space.baseBranch) {
        await this.git
          .runGitInRepo(context.repo, ["checkout", originalBranch])
          .catch(() => {});
      }
    }
  }

  async rebaseSpaceOntoMain(projectId: string): Promise<ProjectSpace> {
    const context = await this.state.resolveProjectContext(projectId);
    if (!(await this.git.isGitRepo(context.repo))) {
      throw new Error("Not a git repository");
    }

    const space = await this.ensureProjectSpace(projectId);
    let baseRef = space.baseBranch;
    await this.git
      .runGit(space.worktreePath, ["fetch", "origin", space.baseBranch])
      .then(() => {
        baseRef = `origin/${space.baseBranch}`;
      })
      .catch(() => {});
    const baseSha = await this.git
      .runGit(space.worktreePath, ["rev-parse", baseRef])
      .catch(() => "");

    try {
      await this.git.runGit(space.worktreePath, ["rebase", baseRef]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "git rebase failed";
      return this.state.persistProjectSpace(projectId, (current) => ({
        ...current,
        rebaseConflict: {
          baseSha: baseSha.trim(),
          error: message,
        },
      }));
    }

    const newSpaceHead = await this.git.getGitHead(space.worktreePath);
    if (!newSpaceHead) {
      throw new Error("Failed to resolve Space HEAD SHA after rebase");
    }

    return this.state.persistProjectSpace(projectId, async (current) => {
      const next: ProjectSpace = {
        ...current,
        rebaseConflict: undefined,
        queue: [...current.queue],
      };

      for (const item of next.queue) {
        if (item.status !== "pending") continue;
        const workerStartSha = item.startSha?.trim();
        if (!workerStartSha) {
          item.status = "conflict";
          item.error = "worker start SHA is missing; cannot rebase";
          next.integrationBlocked = true;
          continue;
        }

        try {
          await this.git.runGit(item.worktreePath, [
            "rebase",
            "--onto",
            newSpaceHead,
            workerStartSha,
            "HEAD",
          ]);
        } catch (error) {
          await this.git
            .runGit(item.worktreePath, ["rebase", "--abort"])
            .catch(() => {});
          item.status = "conflict";
          item.error =
            error instanceof Error ? error.message : "git rebase failed";
          next.integrationBlocked = true;
          continue;
        }

        const workerEndSha = await this.git.getGitHead(item.worktreePath);
        if (!workerEndSha) {
          item.status = "conflict";
          item.error = "Failed to resolve worker HEAD SHA after rebase";
          next.integrationBlocked = true;
          continue;
        }

        const rebasedShas = await this.git.collectCommitShas(
          item.worktreePath,
          newSpaceHead,
          workerEndSha
        );
        item.startSha = newSpaceHead;
        item.endSha = workerEndSha;
        item.shas = rebasedShas;
        item.error = undefined;
        item.staleAgainstSha = undefined;
        item.status = rebasedShas.length > 0 ? "pending" : "skipped";
      }

      return next;
    });
  }

  integrateProjectSpaceQueue(
    projectId: string,
    options?: { resume?: boolean }
  ): Promise<ProjectSpace> {
    return this.integrateProjectSpaceEntries(projectId, {
      resume: options?.resume,
    });
  }

  integrateSpaceEntries(
    projectId: string,
    entryIds: string[]
  ): Promise<ProjectSpace> {
    return this.integrateProjectSpaceEntries(projectId, {
      resume: true,
      entryIds,
    });
  }

  private async integrateProjectSpaceEntries(
    projectId: string,
    options?: { resume?: boolean; entryIds?: string[] }
  ): Promise<ProjectSpace> {
    const context = await this.state.resolveProjectContext(projectId);
    if (!(await this.git.isGitRepo(context.repo))) {
      throw new Error("Not a git repository");
    }
    const targetEntryIds =
      options?.entryIds && options.entryIds.length > 0
        ? new Set(normalizeStringList(options.entryIds))
        : null;

    return this.state.persistProjectSpace(projectId, async (space) => {
      const next: ProjectSpace = {
        ...space,
        queue: [...space.queue],
        integrationBlocked: options?.resume ? false : space.integrationBlocked,
      };

      if (next.integrationBlocked) {
        return next;
      }

      for (const item of next.queue) {
        if (item.status !== "pending") continue;
        if (targetEntryIds && !targetEntryIds.has(item.id)) continue;
        if (item.shas.length === 0) {
          item.status = "skipped";
          continue;
        }
        if (item.runMode === "clone") {
          try {
            await this.git.fetchCloneShas(context.repo, projectId, item.shas);
          } catch (error) {
            item.status = "conflict";
            item.error =
              error instanceof Error ? error.message : "git fetch failed";
            next.integrationBlocked = true;
            break;
          }
        }

        try {
          await this.git.runGit(next.worktreePath, [
            "cherry-pick",
            "-x",
            ...item.shas,
          ]);
          item.status = "integrated";
          item.integratedAt = new Date().toISOString();
          item.error = undefined;
        } catch (error) {
          await this.git
            .runGit(next.worktreePath, ["cherry-pick", "--abort"])
            .catch(() => {});
          item.status = "conflict";
          item.error =
            error instanceof Error ? error.message : "git cherry-pick failed";
          next.integrationBlocked = true;
          break;
        }
      }

      return next;
    });
  }

  async skipSpaceEntries(
    projectId: string,
    entryIds: string[]
  ): Promise<ProjectSpace> {
    const targetEntryIds = new Set(normalizeStringList(entryIds));
    return this.state.persistProjectSpace(projectId, (space) => {
      if (targetEntryIds.size === 0) return space;
      return {
        ...space,
        queue: space.queue.map((item) => {
          if (item.status !== "pending") return item;
          if (!targetEntryIds.has(item.id)) return item;
          return { ...item, status: "skipped" };
        }),
      };
    });
  }

  async recordWorkerDelivery(
    input: RecordWorkerDeliveryInput
  ): Promise<ProjectSpace> {
    const space = await this.ensureProjectSpace(input.projectId);
    let startSha = input.startSha;
    let endSha = input.endSha;
    let staleAgainstSha: string | undefined;
    let staleError: string | undefined;

    const spaceHead = await this.git.getGitHead(space.worktreePath);
    if (spaceHead && startSha && startSha.trim() && startSha !== spaceHead) {
      if (input.runMode === "worktree") {
        if (isSpaceAutoRebaseEnabled()) {
          const rebased = await this.git.autoRebaseWorkerOntoSpace(
            input.worktreePath,
            startSha,
            spaceHead
          );
          if (rebased.ok) {
            startSha = spaceHead;
            endSha = rebased.endSha;
          } else {
            staleError = `auto-rebase failed: ${rebased.error}`;
          }
        }
      } else {
        staleAgainstSha = spaceHead;
        staleError =
          "worker is stale vs Space HEAD; rebase required before integration";
      }
    }

    const shas = await this.git.collectCommitShas(
      input.worktreePath,
      startSha,
      endSha
    );

    const existingConflictEntry = space.queue.find(
      (item) => item.workerSlug === input.workerSlug && item.status === "conflict"
    );
    let resolvedShas = shas;
    let resolvedStartSha = startSha;
    if (existingConflictEntry && resolvedShas.length === 0 && endSha) {
      if (
        existingConflictEntry.startSha &&
        existingConflictEntry.startSha !== endSha
      ) {
        const fallback = await this.git
          .collectCommitShas(
            input.worktreePath,
            existingConflictEntry.startSha,
            endSha
          )
          .catch(() => []);
        if (fallback.length > 0) {
          resolvedShas = fallback;
          resolvedStartSha = existingConflictEntry.startSha;
        }
      }
      if (resolvedShas.length === 0 && spaceHead && spaceHead !== endSha) {
        const fallback = await this.git
          .collectCommitShas(input.worktreePath, spaceHead, endSha)
          .catch(() => []);
        if (fallback.length > 0) {
          resolvedShas = fallback;
          resolvedStartSha = spaceHead;
        }
      }
    }

    const now = new Date().toISOString();
    const replacementTargets = new Set(normalizeStringList(input.replaces));
    await this.state.persistProjectSpace(input.projectId, (current) => {
      let queue = [...current.queue];
      let integrationBlocked = current.integrationBlocked;
      let deliveredEntryId = "";
      const conflictIndex = current.queue.findIndex(
        (item) =>
          item.workerSlug === input.workerSlug && item.status === "conflict"
      );
      if (conflictIndex >= 0) {
        const existing = queue[conflictIndex]!;
        deliveredEntryId = existing.id;
        queue[conflictIndex] = {
          ...existing,
          runMode: input.runMode,
          worktreePath: input.worktreePath,
          startSha: resolvedStartSha,
          endSha,
          shas: resolvedShas,
          status: resolvedShas.length > 0 ? "pending" : "skipped",
          integratedAt: undefined,
          staleAgainstSha: undefined,
          error: undefined,
        };
        integrationBlocked = false;
      } else {
        const entry: IntegrationEntry = {
          id: `${input.workerSlug}:${Date.now()}`,
          workerSlug: input.workerSlug,
          runMode: input.runMode,
          worktreePath: input.worktreePath,
          startSha,
          endSha,
          shas,
          status: staleAgainstSha
            ? "stale_worker"
            : shas.length > 0
              ? "pending"
              : "skipped",
          createdAt: now,
          integratedAt: undefined,
          staleAgainstSha,
          error: staleError,
        };
        deliveredEntryId = entry.id;
        queue = [...queue, entry];
      }

      if (replacementTargets.size > 0) {
        queue = queue.map((item) => {
          if (item.id === deliveredEntryId) return item;
          if (item.status !== "pending") return item;
          if (
            !replacementTargets.has(item.id) &&
            !replacementTargets.has(item.workerSlug)
          ) {
            return item;
          }
          return { ...item, status: "skipped" };
        });
      }

      return {
        ...current,
        integrationBlocked,
        queue,
      };
    });

    const refreshed = await this.state.getProjectSpace(input.projectId);
    if (!refreshed.ok) throw new Error(refreshed.error);
    await this.pruneProjectRepoWorktrees(input.projectId).catch(() => {});
    return refreshed.data;
  }
}

function policy(config: GatewayConfig): SpaceIntegrationPolicy {
  return new SpaceIntegrationPolicy(config);
}

export async function ensureProjectSpace(
  config: GatewayConfig,
  projectId: string,
  baseBranch?: string
): Promise<ProjectSpace> {
  return policy(config).ensureProjectSpace(projectId, baseBranch);
}

export async function getProjectSpace(
  config: GatewayConfig,
  projectId: string
) {
  return policy(config).getProjectSpace(projectId);
}

export async function clearProjectSpaceRebaseConflict(
  config: GatewayConfig,
  projectId: string
): Promise<ProjectSpace> {
  return policy(config).clearProjectSpaceRebaseConflict(projectId);
}

export async function getProjectSpaceCommitLog(
  config: GatewayConfig,
  projectId: string,
  limit = 20
): Promise<SpaceCommitSummary[]> {
  return policy(config).getProjectSpaceCommitLog(projectId, limit);
}

export async function getProjectSpaceContribution(
  config: GatewayConfig,
  projectId: string,
  entryId: string
): Promise<SpaceContribution> {
  return policy(config).getProjectSpaceContribution(projectId, entryId);
}

export async function getProjectSpaceConflictContext(
  config: GatewayConfig,
  projectId: string,
  entryId: string
) {
  return policy(config).getProjectSpaceConflictContext(projectId, entryId);
}

export async function pruneProjectRepoWorktrees(
  config: GatewayConfig,
  projectId: string
): Promise<void> {
  return policy(config).pruneProjectRepoWorktrees(projectId);
}

export async function getProjectSpaceWriteLease(
  config: GatewayConfig,
  projectId: string
): Promise<SpaceWriteLeaseResult> {
  return policy(config).getWriteLease(projectId);
}

export async function acquireProjectSpaceWriteLease(
  config: GatewayConfig,
  projectId: string,
  input: { holder: string; ttlSeconds?: number; force?: boolean }
): Promise<SpaceWriteLeaseResult> {
  return policy(config).acquireWriteLease(projectId, input);
}

export async function releaseProjectSpaceWriteLease(
  config: GatewayConfig,
  projectId: string,
  input: { holder?: string; force?: boolean }
): Promise<SpaceWriteLeaseResult> {
  return policy(config).releaseWriteLease(projectId, input);
}

export async function cleanupSpaceWorktrees(
  config: GatewayConfig,
  projectId: string
): Promise<SpaceCleanupSummary> {
  return policy(config).cleanupSpaceWorktrees(projectId);
}

export async function mergeSpaceIntoBase(
  config: GatewayConfig,
  projectId: string,
  options?: { cleanup?: boolean }
): Promise<SpaceMergeResult> {
  return policy(config).mergeSpaceIntoBase(projectId, options);
}

export async function rebaseSpaceOntoMain(
  config: GatewayConfig,
  projectId: string
): Promise<ProjectSpace> {
  return policy(config).rebaseSpaceOntoMain(projectId);
}

export async function integrateProjectSpaceQueue(
  config: GatewayConfig,
  projectId: string,
  options?: { resume?: boolean }
): Promise<ProjectSpace> {
  return policy(config).integrateProjectSpaceQueue(projectId, options);
}

export async function integrateSpaceEntries(
  config: GatewayConfig,
  projectId: string,
  entryIds: string[]
): Promise<ProjectSpace> {
  return policy(config).integrateSpaceEntries(projectId, entryIds);
}

export async function skipSpaceEntries(
  config: GatewayConfig,
  projectId: string,
  entryIds: string[]
): Promise<ProjectSpace> {
  return policy(config).skipSpaceEntries(projectId, entryIds);
}

export async function recordWorkerDelivery(
  config: GatewayConfig,
  input: RecordWorkerDeliveryInput
): Promise<ProjectSpace> {
  return policy(config).recordWorkerDelivery(input);
}

export const spaceGitInternals = {
  collectCommitShas,
  collectPatchForShas,
  ensureWorktree,
  fetchCloneShas,
  getGitHead,
  isGitRepo,
  listConflictFiles,
  parseCommitSummaries,
  runGit,
  runGitInRepo,
};

export type { SpaceProjectContext };

