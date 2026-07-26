import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayConfig } from "@yoplai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSubagentWorkspaceAdapter,
  validateWorkspaceRepo,
} from "./workspace-adapter.js";

describe("SubagentWorkspaceAdapter", () => {
  let tmpDir: string;
  let projectDir: string;
  let repoDir: string;
  let config: GatewayConfig;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-workspace-adapter-")
    );
    projectDir = path.join(tmpDir, "projects", "PRO-1");
    repoDir = path.join(tmpDir, "repo");
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    config = {
      agents: [],
      sessions: { idleMinutes: 360 },
      projects: {
        root: path.join(tmpDir, "projects"),
        worktreeRoot: path.join(tmpDir, "worktrees"),
      },
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prepares none mode without creating a workspace clone", async () => {
    const workspace = await getSubagentWorkspaceAdapter("none").prepare({
      config,
      projectId: "PRO-1",
      slug: "worker",
      projectDir,
      repo: repoDir,
      mode: "none",
      baseBranch: "main",
    });

    expect(workspace.mode).toBe("none");
    expect(workspace.worktreePath).toBe(repoDir);
    await expect(
      fs.stat(path.join(tmpDir, "worktrees", "PRO-1", "worker"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("falls back to project dir for none mode without repo", async () => {
    const workspace = await getSubagentWorkspaceAdapter("none").prepare({
      config,
      projectId: "PRO-1",
      slug: "worker",
      projectDir,
      repo: "",
      mode: "none",
      baseBranch: "main",
    });

    expect(workspace.worktreePath).toBe(projectDir);
  });

  it("validates repo requirements by mode", async () => {
    expect(await validateWorkspaceRepo("none", "")).toBeUndefined();
    expect(await validateWorkspaceRepo("worktree", "")).toBe(
      "Project repo not set"
    );

    const notGit = path.join(tmpDir, "not-git");
    await fs.mkdir(notGit, { recursive: true });
    expect(await validateWorkspaceRepo("clone", notGit)).toBe(
      "Project repo is not a git repo"
    );
    expect(await validateWorkspaceRepo("main-run", repoDir)).toBeUndefined();
  });
});
