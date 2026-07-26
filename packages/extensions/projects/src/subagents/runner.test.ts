import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { GatewayConfig } from "@yoplai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSubagent } from "./runner.js";

describe("subagent runner repo resolution", () => {
  let tmpDir: string;
  let projectsRoot: string;
  let worktreeRoot: string;
  let binDir: string;
  let previousPath: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-runner-"));
    projectsRoot = path.join(tmpDir, "projects");
    worktreeRoot = path.join(tmpDir, "worktrees");
    binDir = path.join(tmpDir, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(
      path.join(binDir, "codex"),
      [
        "#!/bin/sh",
        'echo \'{"type":"thread.started","thread_id":"test-thread"}\'',
      ].join("\n"),
      { mode: 0o755 }
    );
    previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  });

  afterEach(async () => {
    process.env.PATH = previousPath;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function createRepo(name: string): Promise<string> {
    const repoDir = path.join(tmpDir, name);
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    return repoDir;
  }

  async function createProject(input: {
    projectRepo?: string;
    sliceRepo?: string;
  }): Promise<{ config: GatewayConfig; projectDir: string }> {
    const projectDir = path.join(projectsRoot, "PRO-1_repo-resolution");
    const sliceDir = path.join(projectDir, "slices", "PRO-1-S01");
    await fs.mkdir(sliceDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, "README.md"),
      [
        "---",
        'id: "PRO-1"',
        'title: "Repo Resolution"',
        'status: "active"',
        input.projectRepo ? `repo: ${JSON.stringify(input.projectRepo)}` : "",
        "---",
        "# Repo Resolution",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(sliceDir, "README.md"),
      [
        "---",
        'id: "PRO-1-S01"',
        'project_id: "PRO-1"',
        'title: "Slice"',
        'status: "todo"',
        'hill_position: "figuring"',
        'created_at: "2026-05-04T00:00:00.000Z"',
        'updated_at: "2026-05-04T00:00:00.000Z"',
        input.sliceRepo ? `repo: ${JSON.stringify(input.sliceRepo)}` : "",
        "---",
        "# Slice",
        "",
      ]
        .filter(Boolean)
        .join("\n"),
      "utf8"
    );
    return {
      projectDir,
      config: {
        agents: [],
        sessions: { idleMinutes: 360 },
        projects: { root: projectsRoot, worktreeRoot },
      },
    };
  }

  it("uses slice repo when project and slice repos are both set", async () => {
    const projectRepo = await createRepo("project-repo");
    const sliceRepo = await createRepo("slice-repo");
    const { config, projectDir } = await createProject({
      projectRepo,
      sliceRepo,
    });

    const result = await spawnSubagent(config, {
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      slug: "worker",
      cli: "codex",
      prompt: "test",
      mode: "none",
    });

    expect(result.ok).toBe(true);
    const state = JSON.parse(
      await fs.readFile(
        path.join(projectDir, "sessions", "worker", "state.json"),
        "utf8"
      )
    ) as { worktree_path?: string };
    expect(state.worktree_path).toBe(sliceRepo);
  });

  it("falls back to project repo when slice repo is absent", async () => {
    const projectRepo = await createRepo("project-repo");
    const { config, projectDir } = await createProject({ projectRepo });

    const result = await spawnSubagent(config, {
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      slug: "worker",
      cli: "codex",
      prompt: "test",
      mode: "none",
    });

    expect(result.ok).toBe(true);
    const state = JSON.parse(
      await fs.readFile(
        path.join(projectDir, "sessions", "worker", "state.json"),
        "utf8"
      )
    ) as { worktree_path?: string };
    expect(state.worktree_path).toBe(projectRepo);
  });

  it("errors when worktree mode has no slice or project repo", async () => {
    const { config } = await createProject({});

    const result = await spawnSubagent(config, {
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      slug: "worker",
      cli: "codex",
      prompt: "test",
      mode: "worktree",
    });

    expect(result).toEqual({ ok: false, error: "Project repo not set" });
  });
});
