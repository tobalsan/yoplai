import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expandPath, type GatewayConfig } from "@yoplai/shared";
import { getProject } from "./store.js";
import { getProjectSpace } from "./space.js";

const execFileAsync = promisify(execFile);

export type FileChange = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed";
  staged: boolean;
};

export type MainBranchCommit = {
  sha: string;
  subject: string;
};

export type DirtyState = {
  files: FileChange[];
  diff: string;
  stats: { filesChanged: number; insertions: number; deletions: number };
};

export type ProjectChanges = {
  branch: string;
  baseBranch: string;
  source: { type: "space" | "repo"; path: string };
  files: FileChange[];
  diff: string;
  stats: { filesChanged: number; insertions: number; deletions: number };
  branchDiffStats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  branchDiffFiles: { path: string; insertions: number; deletions: number }[];
  mainAheadCommits: MainBranchCommit[];
  mainRepoDirty?: DirtyState;
};

export type CommitResult =
  | { ok: true; sha: string; message: string }
  | { ok: false; error: string };

export type ProjectPullRequestTarget = {
  branch: string;
  baseBranch: string;
  compareUrl?: string;
};

function mapStatus(code: string): FileChange["status"] {
  if (code === "A") return "added";
  if (code === "D") return "deleted";
  if (code === "R") return "renamed";
  return "modified";
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trimEnd();
}

function normalizeGithubRepoUrl(remote: string): string | null {
  const value = remote.trim();
  if (!value) return null;
  const cleaned = value.replace(/\.git$/i, "");
  const sshMatch = cleaned.match(/^git@github\.com:(.+\/.+)$/i);
  if (sshMatch?.[1]) return `https://github.com/${sshMatch[1]}`;
  const httpsMatch = cleaned.match(/^https?:\/\/github\.com\/(.+\/.+)$/i);
  if (httpsMatch?.[1]) return `https://github.com/${httpsMatch[1]}`;
  return null;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

async function resolveRepoPath(
  config: GatewayConfig,
  projectId: string
): Promise<{
  repoPath: string;
  baseBranch: string;
  source: ProjectChanges["source"];
  mainRepoPath?: string;
}> {
  const project = await getProject(config, projectId);
  if (!project.ok) throw new Error(project.error);

  const rawRepo =
    typeof project.data.frontmatter.repo === "string"
      ? project.data.frontmatter.repo
      : "";
  if (!rawRepo.trim()) throw new Error("Project repo not set");

  const repo = expandPath(rawRepo.trim());
  const space = await getProjectSpace(config, projectId);
  if (space.ok && (await isGitRepo(space.data.worktreePath))) {
    return {
      repoPath: space.data.worktreePath,
      baseBranch: space.data.baseBranch || "main",
      source: {
        type: "space",
        path: space.data.worktreePath,
      },
      mainRepoPath: repo,
    };
  }

  return {
    repoPath: repo,
    baseBranch: "main",
    source: {
      type: "repo",
      path: repo,
    },
  };
}

function parseStatusPorcelain(statusText: string): FileChange[] {
  const files: FileChange[] = [];
  for (const rawLine of statusText.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.length < 4) continue;
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const filePath = line.slice(3).trim();
    const staged = x !== " " && x !== "?";
    const statusCode = x !== " " && x !== "?" ? x : y;
    files.push({
      path: filePath,
      status: mapStatus(statusCode),
      staged,
    });
  }
  return files;
}

function parseNumStat(text: string): {
  files: Set<string>;
  insertions: number;
  deletions: number;
  byFile: Map<string, { insertions: number; deletions: number }>;
} {
  const files = new Set<string>();
  let insertions = 0;
  let deletions = 0;
  const byFile = new Map<string, { insertions: number; deletions: number }>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [insRaw, delRaw, ...fileParts] = trimmed.split("\t");
    if (!insRaw || !delRaw || fileParts.length === 0) continue;
    const filePath = fileParts.join("\t");
    files.add(filePath);
    const ins = Number(insRaw);
    const del = Number(delRaw);
    if (Number.isFinite(ins)) insertions += ins;
    if (Number.isFinite(del)) deletions += del;
    byFile.set(filePath, {
      insertions: Number.isFinite(ins) ? ins : 0,
      deletions: Number.isFinite(del) ? del : 0,
    });
  }

  return { files, insertions, deletions, byFile };
}

export async function getProjectChanges(
  config: GatewayConfig,
  projectId: string
): Promise<ProjectChanges> {
  const resolved = await resolveRepoPath(config, projectId);
  const repo = resolved.repoPath;
  if (!(await isGitRepo(repo))) {
    throw new Error("Not a git repository");
  }

  const [
    branch,
    statusText,
    unstagedDiff,
    stagedDiff,
    unstagedStat,
    stagedStat,
  ] = await Promise.all([
    runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(repo, ["status", "--porcelain"]),
    runGit(repo, ["diff"]),
    runGit(repo, ["diff", "--cached"]),
    runGit(repo, ["diff", "--numstat"]),
    runGit(repo, ["diff", "--cached", "--numstat"]),
  ]);

  const files = parseStatusPorcelain(statusText);
  const diff = [unstagedDiff, stagedDiff].filter(Boolean).join("\n").trim();

  const unstaged = parseNumStat(unstagedStat);
  const staged = parseNumStat(stagedStat);
  const fileSet = new Set<string>([...unstaged.files, ...staged.files]);

  // Branch diff stats: only count commits whose content isn't already on main.
  // git cherry marks already-picked commits with "-", unmerged with "+".
  let branchDiffStats = { filesChanged: 0, insertions: 0, deletions: 0 };
  let branchDiffFiles: {
    path: string;
    insertions: number;
    deletions: number;
  }[] = [];
  try {
    const cherryOutput = await runGit(repo, [
      "cherry",
      resolved.baseBranch,
      "HEAD",
    ]);
    const unmergedShas = cherryOutput
      .split("\n")
      .filter((l) => l.startsWith("+ "))
      .map((l) => l.slice(2).trim());
    if (unmergedShas.length > 0) {
      // Sum stats across each unmerged commit
      let totalIns = 0;
      let totalDel = 0;
      const allFiles = new Set<string>();
      const perFile = new Map<
        string,
        { insertions: number; deletions: number }
      >();
      for (const sha of unmergedShas) {
        const stat = await runGit(repo, ["diff", `${sha}~1`, sha, "--numstat"]);
        const parsed = parseNumStat(stat);
        for (const f of parsed.files) allFiles.add(f);
        for (const [filePath, fileStat] of parsed.byFile.entries()) {
          const current = perFile.get(filePath) ?? {
            insertions: 0,
            deletions: 0,
          };
          current.insertions += fileStat.insertions;
          current.deletions += fileStat.deletions;
          perFile.set(filePath, current);
        }
        totalIns += parsed.insertions;
        totalDel += parsed.deletions;
      }
      branchDiffStats = {
        filesChanged: allFiles.size,
        insertions: totalIns,
        deletions: totalDel,
      };
      branchDiffFiles = Array.from(perFile.entries()).map(([path, stat]) => ({
        path,
        insertions: stat.insertions,
        deletions: stat.deletions,
      }));
    }
  } catch {
    // baseBranch may not exist locally
  }

  // Commits on main that are ahead of current branch
  let mainAheadCommits: MainBranchCommit[] = [];
  try {
    const logOutput = await runGit(repo, [
      "log",
      `HEAD..${resolved.baseBranch}`,
      "--oneline",
      "--no-decorate",
      "-20",
    ]);
    if (logOutput.trim()) {
      mainAheadCommits = logOutput
        .trim()
        .split("\n")
        .map((line) => {
          const spaceIdx = line.indexOf(" ");
          return {
            sha: spaceIdx > 0 ? line.slice(0, spaceIdx) : line,
            subject: spaceIdx > 0 ? line.slice(spaceIdx + 1) : "",
          };
        });
    }
  } catch {
    // baseBranch may not exist
  }

  // Dirty state of main repo (only when source is space worktree)
  let mainRepoDirty: DirtyState | undefined;
  if (resolved.mainRepoPath && (await isGitRepo(resolved.mainRepoPath))) {
    try {
      const [
        mrStatus,
        mrUnstagedDiff,
        mrStagedDiff,
        mrUnstagedStat,
        mrStagedStat,
      ] = await Promise.all([
        runGit(resolved.mainRepoPath, ["status", "--porcelain"]),
        runGit(resolved.mainRepoPath, ["diff"]),
        runGit(resolved.mainRepoPath, ["diff", "--cached"]),
        runGit(resolved.mainRepoPath, ["diff", "--numstat"]),
        runGit(resolved.mainRepoPath, ["diff", "--cached", "--numstat"]),
      ]);
      const mrFiles = parseStatusPorcelain(mrStatus);
      if (mrFiles.length > 0) {
        const mrDiff = [mrUnstagedDiff, mrStagedDiff]
          .filter(Boolean)
          .join("\n")
          .trim();
        const mrU = parseNumStat(mrUnstagedStat);
        const mrS = parseNumStat(mrStagedStat);
        const mrFileSet = new Set([...mrU.files, ...mrS.files]);
        mainRepoDirty = {
          files: mrFiles,
          diff: mrDiff,
          stats: {
            filesChanged: mrFileSet.size,
            insertions: mrU.insertions + mrS.insertions,
            deletions: mrU.deletions + mrS.deletions,
          },
        };
      }
    } catch {
      // main repo may not be accessible
    }
  }

  return {
    branch: branch.trim() || "HEAD",
    baseBranch: resolved.baseBranch,
    source: resolved.source,
    files,
    diff,
    stats: {
      filesChanged: fileSet.size,
      insertions: unstaged.insertions + staged.insertions,
      deletions: unstaged.deletions + staged.deletions,
    },
    branchDiffStats,
    branchDiffFiles,
    mainAheadCommits,
    mainRepoDirty,
  };
}

export async function commitProjectChanges(
  config: GatewayConfig,
  projectId: string,
  message: string
): Promise<CommitResult> {
  const resolved = await resolveRepoPath(config, projectId);
  const repo = resolved.repoPath;
  if (!(await isGitRepo(repo))) {
    return { ok: false, error: "Not a git repository" };
  }

  const commitMessage = message.trim();
  if (!commitMessage) {
    return { ok: false, error: "Commit message is required" };
  }

  const status = await runGit(repo, ["status", "--porcelain"]);
  if (!status.trim()) {
    return { ok: false, error: "Nothing to commit" };
  }

  await runGit(repo, ["add", "-A"]);
  try {
    await runGit(repo, ["commit", "-m", commitMessage]);
  } catch (error) {
    const msg =
      error instanceof Error && error.message ? error.message : "Commit failed";
    if (msg.includes("nothing to commit")) {
      return { ok: false, error: "Nothing to commit" };
    }
    return { ok: false, error: "Commit failed" };
  }

  const sha = await runGit(repo, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, sha: sha.trim(), message: commitMessage };
}

export async function getProjectPullRequestTarget(
  config: GatewayConfig,
  projectId: string
): Promise<ProjectPullRequestTarget> {
  const resolved = await resolveRepoPath(config, projectId);
  const repo = resolved.repoPath;
  if (!(await isGitRepo(repo))) {
    throw new Error("Not a git repository");
  }

  const branchRaw = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRaw.trim() || "HEAD";
  const baseBranch = resolved.baseBranch || "main";

  let compareUrl: string | undefined;
  try {
    const remoteRaw = await runGit(repo, ["remote", "get-url", "origin"]);
    const githubRepo = normalizeGithubRepoUrl(remoteRaw);
    if (githubRepo) {
      compareUrl = `${githubRepo}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(branch)}?expand=1`;
    }
  } catch {
    // no origin remote configured
  }

  return { branch, baseBranch, compareUrl };
}
