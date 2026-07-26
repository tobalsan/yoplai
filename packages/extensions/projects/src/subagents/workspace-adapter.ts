import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayConfig } from "@yoplai/shared";
import { expandPath } from "@yoplai/shared";
import { getProject } from "../projects/store.js";
import { getSlice } from "../projects/slices.js";
import {
  acquireProjectSpaceWriteLease,
  ensureProjectSpace,
  isSpaceWriteLeaseEnabled,
  pruneProjectRepoWorktrees,
  recordWorkerDelivery,
  releaseProjectSpaceWriteLease,
} from "../projects/space.js";
import { dirExists } from "../util/fs.js";
import { getProjectsWorktreeRoot } from "../util/paths.js";
import type { SubagentMode } from "./runner.js";

const execFileAsync = promisify(execFile);

export type SubagentWorkspacePrepareInput = {
  config: GatewayConfig;
  projectId: string;
  sliceId?: string;
  slug: string;
  projectDir: string;
  repo: string;
  mode: SubagentMode;
  baseBranch: string;
};

export type SubagentWorkspaceDeliveryInput = {
  config: GatewayConfig;
  projectId: string;
  slug: string;
  startHeadSha: string;
  replaces?: string[];
};

export type SubagentWorkspaceDelivery = {
  endHeadSha: string;
  commitRange: string;
};

export type PreparedSubagentWorkspace = {
  mode: SubagentMode;
  worktreePath: string;
  baseBranch: string;
  startHeadSha?: string;
  releaseLease(): Promise<void>;
  prune(): Promise<void>;
  recordDelivery(
    input: SubagentWorkspaceDeliveryInput
  ): Promise<SubagentWorkspaceDelivery | undefined>;
};

export interface SubagentWorkspaceAdapter {
  readonly mode: SubagentMode;
  prepare(
    input: SubagentWorkspacePrepareInput
  ): Promise<PreparedSubagentWorkspace>;
  cleanup(
    input: SubagentWorkspacePrepareInput & { worktreePath?: string }
  ): Promise<void>;
}

export async function resolveProjectRepo(
  config: GatewayConfig,
  projectId: string,
  projectDir?: string,
  sliceId?: string,
  projectFrontmatter?: Record<string, unknown>
): Promise<string> {
  const expandRepo = (candidate: string): string =>
    expandPath(candidate.trim());
  const readExistingRepo = async (candidate: string): Promise<string> => {
    const expanded = expandRepo(candidate);
    if (!expanded) return "";
    return (await dirExists(expanded)) ? expanded : "";
  };

  if (projectDir && sliceId) {
    try {
      const slice = await getSlice(projectDir, sliceId);
      const sliceRepo =
        typeof slice.frontmatter.repo === "string"
          ? slice.frontmatter.repo
          : "";
      if (sliceRepo.trim()) return expandRepo(sliceRepo);
    } catch {
      // Missing/invalid slices fall back to project repo for legacy callers.
    }
  }

  const directRepo =
    typeof projectFrontmatter?.repo === "string" ? projectFrontmatter.repo : "";
  if (directRepo.trim()) {
    const resolved = await readExistingRepo(directRepo);
    if (resolved) return resolved;
  }

  const project = await getProject(config, projectId);
  if (!project.ok) return "";
  const inheritedRepo =
    typeof project.data.frontmatter.repo === "string"
      ? project.data.frontmatter.repo
      : "";
  if (!inheritedRepo) return "";
  return readExistingRepo(inheritedRepo);
}

function isProjectSpaceBranch(projectId: string, branch: string): boolean {
  return branch === `space/${projectId}`;
}

async function ensureRunnerBaseBranch(
  config: GatewayConfig,
  projectId: string,
  baseBranch: string
): Promise<void> {
  if (!isProjectSpaceBranch(projectId, baseBranch)) return;
  await ensureProjectSpace(config, projectId);
}

async function createWorktree(
  repo: string,
  worktreePath: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  await fs.mkdir(worktreePath, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "git",
      ["-C", repo, "worktree", "add", "-b", branch, worktreePath, baseBranch],
      { stdio: "ignore" }
    );
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("git worktree add failed"));
    });
    child.on("error", reject);
  });
}

async function runGit(args: string[], errorMessage: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { stdio: "ignore" });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorMessage));
    });
    child.on("error", reject);
  });
}

async function runGitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function getGitHead(cwd: string): Promise<string | undefined> {
  try {
    const out = await runGitStdout(cwd, ["rev-parse", "HEAD"]);
    return out || undefined;
  } catch {
    return undefined;
  }
}

async function createClone(
  repo: string,
  clonePath: string,
  branch: string,
  baseBranch: string
): Promise<void> {
  await fs.mkdir(path.dirname(clonePath), { recursive: true });
  await runGit(["clone", repo, clonePath], "git clone failed");
  try {
    await runGit(
      ["-C", clonePath, "checkout", "-b", branch, `origin/${baseBranch}`],
      "git checkout -b failed"
    );
  } catch {
    await runGit(
      ["-C", clonePath, "checkout", "-b", branch, baseBranch],
      "git checkout -b failed"
    );
  }
}

function cloneRemoteName(projectId: string): string {
  return `agent-${projectId}`.toLowerCase();
}

async function ensureCloneRemote(
  repo: string,
  projectId: string,
  clonePath: string
): Promise<void> {
  const remote = cloneRemoteName(projectId);
  const realClonePath = await fs.realpath(clonePath).catch(() => clonePath);
  try {
    await runGit(
      ["-C", repo, "remote", "set-url", remote, realClonePath],
      "git remote set-url failed"
    );
  } catch {
    await runGit(
      ["-C", repo, "remote", "add", remote, realClonePath],
      "git remote add failed"
    );
  }
}

async function removeCloneRemote(
  repo: string,
  projectId: string
): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(
      "git",
      ["-C", repo, "remote", "remove", cloneRemoteName(projectId)],
      { stdio: "ignore" }
    );
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

function workspaceDirs(config: GatewayConfig, projectId: string, slug: string) {
  const workspacesRoot = path.join(getProjectsWorktreeRoot(config), projectId);
  return { workspacesRoot, worktreeDir: path.join(workspacesRoot, slug) };
}

function basePrepared(input: {
  mode: SubagentMode;
  worktreePath: string;
  baseBranch: string;
  startHeadSha?: string;
  releaseLease?: () => Promise<void>;
}): PreparedSubagentWorkspace {
  return {
    mode: input.mode,
    worktreePath: input.worktreePath,
    baseBranch: input.baseBranch,
    startHeadSha: input.startHeadSha,
    releaseLease: input.releaseLease ?? (async () => {}),
    prune: async () => {},
    recordDelivery: async () => undefined,
  };
}

class NoneWorkspaceAdapter implements SubagentWorkspaceAdapter {
  readonly mode = "none" as const;

  async prepare(
    input: SubagentWorkspacePrepareInput
  ): Promise<PreparedSubagentWorkspace> {
    return basePrepared({
      mode: this.mode,
      worktreePath: input.repo || input.projectDir,
      baseBranch: input.baseBranch,
    });
  }

  async cleanup(input: SubagentWorkspacePrepareInput): Promise<void> {
    await pruneProjectRepoWorktrees(input.config, input.projectId).catch(
      () => {}
    );
  }
}

class MainRunWorkspaceAdapter implements SubagentWorkspaceAdapter {
  readonly mode = "main-run" as const;

  async prepare(
    input: SubagentWorkspacePrepareInput
  ): Promise<PreparedSubagentWorkspace> {
    const space = await ensureProjectSpace(
      input.config,
      input.projectId,
      input.baseBranch
    );
    let acquired = false;
    if (isSpaceWriteLeaseEnabled()) {
      const lease = await acquireProjectSpaceWriteLease(
        input.config,
        input.projectId,
        {
          holder: input.slug,
        }
      );
      if (!lease.ok) throw new Error(lease.error);
      acquired = true;
    }
    return basePrepared({
      mode: this.mode,
      worktreePath: space.worktreePath,
      baseBranch: input.baseBranch,
      releaseLease: async () => {
        if (!acquired) return;
        await releaseProjectSpaceWriteLease(input.config, input.projectId, {
          holder: input.slug,
        }).catch(() => {});
      },
    });
  }

  async cleanup(input: SubagentWorkspacePrepareInput): Promise<void> {
    if (isSpaceWriteLeaseEnabled()) {
      await releaseProjectSpaceWriteLease(input.config, input.projectId, {
        holder: input.slug,
      }).catch(() => {});
    }
    await pruneProjectRepoWorktrees(input.config, input.projectId).catch(
      () => {}
    );
  }
}

class GitWorkspaceAdapter implements SubagentWorkspaceAdapter {
  constructor(readonly mode: "worktree" | "clone") {}

  async prepare(
    input: SubagentWorkspacePrepareInput
  ): Promise<PreparedSubagentWorkspace> {
    const { workspacesRoot, worktreeDir } = workspaceDirs(
      input.config,
      input.projectId,
      input.slug
    );
    const branch = `${input.projectId}/${input.slug}`;
    await fs.mkdir(workspacesRoot, { recursive: true });
    const worktreeGitExists = await fs
      .stat(path.join(worktreeDir, ".git"))
      .then(() => true)
      .catch(() => false);
    if (!worktreeGitExists) {
      await ensureRunnerBaseBranch(
        input.config,
        input.projectId,
        input.baseBranch
      );
      if (this.mode === "worktree") {
        await createWorktree(input.repo, worktreeDir, branch, input.baseBranch);
      } else {
        await createClone(input.repo, worktreeDir, branch, input.baseBranch);
      }
    }
    if (this.mode === "clone") {
      await ensureCloneRemote(input.repo, input.projectId, worktreeDir);
    }
    const startHeadSha = await getGitHead(worktreeDir);
    return {
      mode: this.mode,
      worktreePath: worktreeDir,
      baseBranch: input.baseBranch,
      startHeadSha,
      releaseLease: async () => {},
      prune: async () => {
        await pruneProjectRepoWorktrees(input.config, input.projectId).catch(
          () => {}
        );
      },
      recordDelivery: async (deliveryInput) => {
        const endHeadSha = await getGitHead(worktreeDir);
        const commitRange =
          endHeadSha && endHeadSha !== deliveryInput.startHeadSha
            ? `${deliveryInput.startHeadSha}..${endHeadSha}`
            : "";
        if (endHeadSha) {
          await recordWorkerDelivery(input.config, {
            projectId: input.projectId,
            workerSlug: input.slug,
            runMode: this.mode,
            worktreePath: worktreeDir,
            startSha: deliveryInput.startHeadSha,
            endSha: endHeadSha,
            replaces: deliveryInput.replaces,
          }).catch(() => {});
        }
        return { endHeadSha: endHeadSha ?? "", commitRange };
      },
    };
  }

  async cleanup(
    input: SubagentWorkspacePrepareInput & { worktreePath?: string }
  ): Promise<void> {
    const { workspacesRoot, worktreeDir } = workspaceDirs(
      input.config,
      input.projectId,
      input.slug
    );
    const resolvedPath = input.worktreePath || worktreeDir;
    if (this.mode === "worktree") {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          "git",
          ["-C", input.repo, "worktree", "remove", resolvedPath, "--force"],
          { stdio: "ignore" }
        );
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error("git worktree remove failed"));
        });
        child.on("error", reject);
      });
      await new Promise<void>((resolve) => {
        const child = spawn(
          "git",
          [
            "-C",
            input.repo,
            "branch",
            "-D",
            `${input.projectId}/${input.slug}`,
          ],
          { stdio: "ignore" }
        );
        child.on("exit", () => resolve());
        child.on("error", () => resolve());
      });
    } else {
      if (input.repo) await removeCloneRemote(input.repo, input.projectId);
      await fs.rm(resolvedPath, { recursive: true, force: true });
    }
    await pruneProjectRepoWorktrees(input.config, input.projectId).catch(
      () => {}
    );
    try {
      const remaining = await fs.readdir(workspacesRoot);
      if (remaining.length === 0) await fs.rmdir(workspacesRoot);
    } catch {
      // ignore
    }
  }
}

export function getSubagentWorkspaceAdapter(
  mode: SubagentMode
): SubagentWorkspaceAdapter {
  switch (mode) {
    case "none":
      return new NoneWorkspaceAdapter();
    case "main-run":
      return new MainRunWorkspaceAdapter();
    case "worktree":
      return new GitWorkspaceAdapter("worktree");
    case "clone":
      return new GitWorkspaceAdapter("clone");
  }
}

export async function validateWorkspaceRepo(
  mode: SubagentMode,
  repo: string
): Promise<string | undefined> {
  if (mode !== "none" && !repo) return "Project repo not set";
  const needsGit =
    mode === "clone" || mode === "worktree" || mode === "main-run";
  if (!needsGit) return undefined;
  const repoHasGit = repo
    ? await fs
        .stat(path.join(repo, ".git"))
        .then(() => true)
        .catch(() => false)
    : false;
  return repoHasGit ? undefined : "Project repo is not a git repo";
}
