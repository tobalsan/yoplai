import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import type { ProjectListItem } from "../projects/store.js";
import type { SliceRecord } from "../projects/slices.js";
import type { SubagentListItem } from "../subagents/index.js";
import type { SpawnSubagentInput } from "../subagents/runner.js";
import {
  createOrchestratorAttemptTracker,
  createStallTracker,
  dispatchOrchestratorTick,
  isActiveOrchestratorRun,
  reconcileLiveRuns,
  resolveNotifyCommand,
  runNotify,
} from "./dispatcher.js";
import { resolveHitlNotifyChannel } from "./index.js";
import type { HitlEvent } from "./hitl.js";
import type { OrchestratorConfig } from "./config.js";

vi.mock("../projects/branches.js", () => ({
  ensureProjectIntegrationBranch: vi.fn(
    async (_repo: string, projectId: string) => `${projectId}/integration`
  ),
  projectIntegrationBranchName: (projectId: string) =>
    `${projectId}/integration`,
}));

const config = {
  agents: [],
  extensions: {
    subagents: {
      profiles: [
        { name: "Worker", cli: "codex", runMode: "clone", type: "worker" },
        { name: "Reviewer", cli: "codex", runMode: "none", type: "reviewer" },
        { name: "Merger", cli: "codex", runMode: "worktree", type: "merger" },
        { name: "RepoSetter", cli: "codex", runMode: "none", type: "shaper" },
      ],
    },
    projects: {},
  },
} as GatewayConfig;

const orchestratorConfig: OrchestratorConfig = {
  enabled: true,
  poll_interval_ms: 30_000,
  failure_cooldown_ms: 60_000,
  stall_threshold_ms: 30 * 60_000,
  statuses: {
    todo: { profile: "Worker", max_concurrent: 2 },
  },
};

const donePingConfig: OrchestratorConfig = {
  ...orchestratorConfig,
  notify_channel: "ops",
  statuses: {},
};

const originalHomeDir = process.env.YOPLAI_HOME;

afterEach(() => {
  if (originalHomeDir === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = originalHomeDir;
});

/** Create a project in `active` status (the project gate for slice dispatch). */
function project(id: string, status = "active"): ProjectListItem {
  return {
    id,
    title: `${id} title`,
    path: id,
    absolutePath: `/tmp/projects/${id}`,
    repoValid: true,
    frontmatter: { status, repo: "/tmp/repo" },
  };
}

/** Create a minimal SliceRecord with given id and status. */
function slice(
  sliceId: string,
  projectId: string,
  status: SliceRecord["frontmatter"]["status"] = "todo",
  extraFrontmatter: Partial<SliceRecord["frontmatter"]> = {}
): SliceRecord {
  return {
    id: sliceId,
    projectId,
    dirPath: `/tmp/projects/${projectId}/slices/${sliceId}`,
    frontmatter: {
      id: sliceId,
      project_id: projectId,
      title: `${sliceId} title`,
      status,
      ...extraFrontmatter,
      hill_position: "figuring",
      created_at: "2026-05-03T00:00:00Z",
      updated_at: "2026-05-03T00:00:00Z",
    },
    docs: {
      readme: "## Must\n\n## Nice\n",
      specs: "",
      tasks: "",
      validation: "",
      thread: "",
    },
  };
}

function run(
  status: SubagentListItem["status"],
  source: SubagentListItem["source"],
  extra: Partial<SubagentListItem> = {}
): SubagentListItem {
  return {
    slug: `${source}-${status}`,
    status,
    source,
    ...extra,
  };
}

async function tempWorkspace(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `yoplai-${name}-`));
}

/** Default updateSlice mock — records calls + returns a slice record. */
function makeUpdateSliceMock(): {
  fn: (typeof import("../projects/slices.js"))["updateSlice"];
  calls: Array<{ sliceId: string; status?: string; thread?: string }>;
} {
  const calls: Array<{ sliceId: string; status?: string; thread?: string }> = [];
  const fn = (async (_projectDir, sliceId, input) => {
    calls.push({ sliceId, status: input.status, thread: input.thread });
    return slice(sliceId, sliceId.split("-S")[0] ?? sliceId);
  }) as (typeof import("../projects/slices.js"))["updateSlice"];
  return { fn, calls };
}

describe("orchestrator dispatcher", () => {
  it("reconciles a Worker run whose slice moved out of in_progress", async () => {
    const interrupted: Array<{ projectId: string; slug: string }> = [];
    const logs: string[] = [];

    const result = await reconcileLiveRuns(config, orchestratorConfig, {
      listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1", "done")],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [
            run("running", "orchestrator", {
              slug: "worker-run",
              name: "Worker",
              sliceId: "PRO-1-S01",
            }),
          ],
        },
      }),
      interruptSubagent: async (_config, projectId, slug) => {
        interrupted.push({ projectId, slug });
        return { ok: true, data: { slug } };
      },
      log: (message) => logs.push(message),
    });

    expect(result.interrupted).toBe(1);
    expect(interrupted).toEqual([{ projectId: "PRO-1", slug: "worker-run" }]);
    expect(result.decisions[0]).toMatchObject({
      action: "interrupted",
      reason: "status_mismatch",
      sliceId: "PRO-1-S01",
    });
    expect(
      logs.some(
        (line) =>
          line.includes("action=reconcile_interrupt") &&
          line.includes("expected_status=in_progress") &&
          line.includes("actual_status=done")
      )
    ).toBe(true);
  });

  it("leaves a Worker run alone while its slice is in_progress", async () => {
    const interrupted: Array<{ projectId: string; slug: string }> = [];

    const result = await reconcileLiveRuns(config, orchestratorConfig, {
      listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1", "in_progress")],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [
            run("running", "orchestrator", {
              slug: "worker-run",
              name: "Worker",
              sliceId: "PRO-1-S01",
            }),
          ],
        },
      }),
      interruptSubagent: async (_config, projectId, slug) => {
        interrupted.push({ projectId, slug });
        return { ok: true, data: { slug } };
      },
      log: () => {},
    });

    expect(result.interrupted).toBe(0);
    expect(result.decisions).toEqual([
      {
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
        slug: "worker-run",
        action: "skipped",
        reason: "status_matches",
      },
    ]);
    expect(interrupted).toEqual([]);
  });

  it("ignores legacy running orchestrator runs without sliceId", async () => {
    const interrupted: Array<{ projectId: string; slug: string }> = [];

    const result = await reconcileLiveRuns(config, orchestratorConfig, {
      listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1", "done")],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [
            run("running", "orchestrator", {
              slug: "legacy-worker-run",
              name: "Worker",
            }),
          ],
        },
      }),
      interruptSubagent: async (_config, projectId, slug) => {
        interrupted.push({ projectId, slug });
        return { ok: true, data: { slug } };
      },
      log: () => {},
    });

    expect(result).toEqual({ inspected: 0, interrupted: 0, decisions: [] });
    expect(interrupted).toEqual([]);
  });

  it("matches active orchestrator run by sliceId", () => {
    expect(
      isActiveOrchestratorRun(
        run("running", "orchestrator", { sliceId: "PRO-1-S01" }),
        "PRO-1-S01"
      )
    ).toBe(true);
    expect(
      isActiveOrchestratorRun(
        run("running", "orchestrator", { sliceId: "PRO-1-S02" }),
        "PRO-1-S01"
      )
    ).toBe(false);
  });

  it("falls back to cwd for legacy run without sliceId", () => {
    expect(
      isActiveOrchestratorRun(
        run("running", "orchestrator", { worktreePath: "/tmp/wt/s01" }),
        "PRO-1-S01",
        ["/tmp/wt/s01"]
      )
    ).toBe(true);
    expect(
      isActiveOrchestratorRun(
        run("running", "orchestrator", { worktreePath: "/tmp/wt/s01/agent" }),
        "PRO-1-S01",
        ["/tmp/wt/s01"]
      )
    ).toBe(true);
    expect(
      isActiveOrchestratorRun(
        run("running", "orchestrator", { worktreePath: "/tmp/wt/s02" }),
        "PRO-1-S01",
        ["/tmp/wt/s01"]
      )
    ).toBe(false);
  });

  it("dispatches Shaper profiles for matching shaping project statuses", async () => {
    process.env.YOPLAI_HOME = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-home-")
    );
    const spawned: SpawnSubagentInput[] = [];
    const shapingConfig: OrchestratorConfig = {
      ...orchestratorConfig,
      statuses: {},
      shaping_statuses: {
        "shaping:repo": { profile: "RepoSetter", max_concurrent: 1 },
        "shaping:drill": { profile: "RepoSetter", max_concurrent: 1 },
      },
    };

    const result = await dispatchOrchestratorTick(config, shapingConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1", "shaping:repo"), project("PRO-2", "shaping:drill")],
      }),
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      now: () => new Date("2026-05-03T00:00:00.000Z"),
      log: () => {},
    });

    expect(result.eligible).toBe(2);
    expect(spawned).toHaveLength(2);
    expect(spawned[0]).toMatchObject({ projectId: "PRO-1", name: "RepoSetter", source: "orchestrator" });
    expect(spawned[0].sliceId).toBeUndefined();
    expect(spawned[0].prompt).toContain("Current shaping status: shaping:repo");
    expect(spawned[0].prompt).toContain("Next status: shaping:drill");
  });

  it("loads Shaper prompt templates from YOPLAI_HOME, not process cwd", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-home-"));
    const cwdDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-cwd-"));
    process.env.YOPLAI_HOME = homeDir;
    await fs.mkdir(path.join(homeDir, "prompts"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, "prompts", "RepoSetter.md"),
      "CUSTOM ${profileName} ${projectId} ${nextStatus}"
    );
    const previousCwd = process.cwd();
    process.chdir(cwdDir);
    try {
      const spawned: SpawnSubagentInput[] = [];
      const shapingConfig: OrchestratorConfig = {
        ...orchestratorConfig,
        statuses: {},
        shaping_statuses: {
          "shaping:repo": { profile: "RepoSetter", max_concurrent: 1 },
        },
      };

      await dispatchOrchestratorTick(config, shapingConfig, {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1", "shaping:repo")],
        }),
        listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        now: () => new Date("2026-05-03T00:00:00.000Z"),
        log: () => {},
      });

      expect(spawned[0]?.prompt).toBe("CUSTOM RepoSetter PRO-1 active");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("skips a Shaper prompt build failure and continues slice dispatch", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-home-"));
    process.env.YOPLAI_HOME = homeDir;
    await fs.mkdir(path.join(homeDir, "prompts"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, "prompts", "RepoSetter.md"),
      "CUSTOM ${missingVariable}"
    );
    const spawned: SpawnSubagentInput[] = [];
    const updates = makeUpdateSliceMock();
    const logs: string[] = [];
    const shapingConfig: OrchestratorConfig = {
      ...orchestratorConfig,
      shaping_statuses: {
        "shaping:repo": { profile: "RepoSetter", max_concurrent: 1 },
      },
    };

    const result = await dispatchOrchestratorTick(config, shapingConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1", "shaping:repo"), project("PRO-2", "active")],
      }),
      listSlices: async (projectDir) =>
        projectDir.includes("PRO-2") ? [slice("PRO-2-S01", "PRO-2")] : [],
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:00:00.000Z"),
      log: (message) => logs.push(message),
    });

    expect(result.decisions).toContainEqual({
      projectId: "PRO-1",
      action: "skipped",
      reason: "build_failed",
    });
    expect(spawned.map((input) => input.projectId)).toEqual(["PRO-2"]);
    expect(spawned[0]?.sliceId).toBe("PRO-2-S01");
    expect(updates.calls).toEqual([
      { sliceId: "PRO-2-S01", status: "in_progress" },
    ]);
    expect(
      logs.some(
        (line) =>
          line.includes("action=build_failed") &&
          line.includes("project=PRO-1") &&
          line.includes("missingVariable")
      )
    ).toBe(true);
  });

  it("moves stale shaping projects to shaping:blocked", async () => {
    const updates: Array<{ id: string; status?: string }> = [];
    const comments: Array<{ projectId: string; body: string }> = [];
    const shapingConfig: OrchestratorConfig = {
      ...orchestratorConfig,
      statuses: {},
      shaping_statuses: {
        "shaping:repo": { profile: "RepoSetter", max_concurrent: 1, stall_threshold_ms: 1000 },
      },
    };

    const result = await dispatchOrchestratorTick(config, shapingConfig, {
      listProjects: async () => ({
        ok: true,
        data: [{ ...project("PRO-1", "shaping:repo"), frontmatter: { status: "shaping:repo", repo: "/tmp/repo", last_status_change_at: "2026-05-03T00:00:00.000Z" } }],
      }),
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      updateProject: async (_config, id, input) => {
        updates.push({ id, status: input.status });
        return { ok: true as const, data: project(id, input.status) };
      },
      appendProjectComment: async (_config, projectId, entry) => {
        comments.push({ projectId, body: entry.body });
        return { ok: true as const, data: entry };
      },
      spawnSubagent: async () => {
        throw new Error("should not spawn");
      },
      now: () => new Date("2026-05-03T00:00:02.000Z"),
      log: () => {},
    });

    expect(result.decisions).toContainEqual({ projectId: "PRO-1", action: "skipped", reason: "shaping_stalled" });
    expect(updates).toEqual([{ id: "PRO-1", status: "shaping:blocked" }]);
    expect(comments[0]?.body).toContain("Shaping stage shaping:repo exceeded");
  });

  it("dispatches Workers for todo slices under active projects", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const updates = makeUpdateSliceMock();

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1"), project("PRO-2"), project("PRO-3")],
      }),
      // PRO-1 has 2 slices in todo, PRO-2 has 1, PRO-3 has 1
      listSlices: async (projectDir) => {
        if (projectDir.includes("PRO-1")) {
          return [slice("PRO-1-S01", "PRO-1"), slice("PRO-1-S02", "PRO-1")];
        }
        if (projectDir.includes("PRO-2")) {
          return [slice("PRO-2-S01", "PRO-2")];
        }
        return [slice("PRO-3-S01", "PRO-3")];
      },
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:00:00.000Z"),
      log: () => {},
    });

    // max_concurrent = 2 so only 2 of the 4 eligible slices are dispatched
    expect(result.availableSlots).toBe(2);
    expect(result.eligible).toBe(4);
    expect(spawned).toHaveLength(2);
    // First two slices across projects (PRO-1-S01, PRO-1-S02)
    expect(spawned.every((input) => input.source === "orchestrator")).toBe(
      true
    );
    expect(spawned.every((input) => input.cli === "codex")).toBe(true);
    expect(spawned.every((input) => input.mode === "clone")).toBe(true);
    // sliceId is set on each spawn
    expect(spawned.map((s) => s.sliceId)).toEqual(["PRO-1-S01", "PRO-1-S02"]);
    // Prompt uses `yoplai slices move` (not `projects move`)
    expect(spawned[0]?.prompt).toContain(
      "`yoplai slices move PRO-1-S01 review`"
    );
    expect(spawned[0]?.prompt).toContain("always pass `--author Worker`");
    expect(spawned[0]?.prompt).toContain("yoplai projects comment");
    expect(spawned[0]?.prompt).toContain("yoplai slices comment");
    expect(spawned[0]?.prompt).not.toContain("projects move");
    // Worker lock: slices moved to in_progress
    expect(updates.calls.map((c) => c.sliceId)).toEqual([
      "PRO-1-S01",
      "PRO-1-S02",
    ]);
    expect(updates.calls.every((c) => c.status === "in_progress")).toBe(true);
  });

  it("does NOT dispatch slices under shaping projects", async () => {
    const spawned: SpawnSubagentInput[] = [];

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [
          project("PRO-1", "shaping"), // shaping → not dispatched
          project("PRO-2", "active"), // active → dispatched
        ],
      }),
      listSlices: async (projectDir) => {
        if (projectDir.includes("PRO-1")) return [slice("PRO-1-S01", "PRO-1")];
        return [slice("PRO-2-S01", "PRO-2")];
      },
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    expect(result.eligible).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sliceId).toBe("PRO-2-S01");
    expect(spawned[0]?.projectId).toBe("PRO-2");
  });

  it.each([["done"], ["ready_to_merge"], ["cancelled"]] as const)(
    "dispatches slices when blocker is %s",
    async (blockerStatus) => {
      const spawned: SpawnSubagentInput[] = [];

      const result = await dispatchOrchestratorTick(
        config,
        orchestratorConfig,
        {
          listProjects: async () => ({
            ok: true,
            data: [project("PRO-1"), project("PRO-2", "done")],
          }),
          listSlices: async (projectDir) => {
            if (projectDir.includes("PRO-1")) {
              return [
                slice("PRO-1-S01", "PRO-1", "todo", {
                  blocked_by: ["PRO-2-S01"],
                }),
              ];
            }
            return [slice("PRO-2-S01", "PRO-2", blockerStatus)];
          },
          listSubagents: async () => ({
            ok: true as const,
            data: { items: [] },
          }),
          spawnSubagent: async (_config, input) => {
            spawned.push(input);
            return { ok: true, data: { slug: input.slug } };
          },
          updateSlice: makeUpdateSliceMock().fn,
          log: () => {},
        }
      );

      expect(result.eligible).toBe(1);
      expect(spawned.map((input) => input.sliceId)).toEqual(["PRO-1-S01"]);
    }
  );

  it.each([["todo"], ["in_progress"], ["review"]] as const)(
    "skips slices when blocker is %s",
    async (blockerStatus) => {
      const spawned: SpawnSubagentInput[] = [];

      const result = await dispatchOrchestratorTick(
        config,
        orchestratorConfig,
        {
          listProjects: async () => ({
            ok: true,
            data: [project("PRO-1"), project("PRO-2", "done")],
          }),
          listSlices: async (projectDir) => {
            if (projectDir.includes("PRO-1")) {
              return [
                slice("PRO-1-S01", "PRO-1", "todo", {
                  blocked_by: ["PRO-2-S01"],
                }),
              ];
            }
            return [slice("PRO-2-S01", "PRO-2", blockerStatus)];
          },
          listSubagents: async () => ({
            ok: true as const,
            data: { items: [] },
          }),
          spawnSubagent: async (_config, input) => {
            spawned.push(input);
            return { ok: true, data: { slug: input.slug } };
          },
          updateSlice: makeUpdateSliceMock().fn,
          log: () => {},
        }
      );

      expect(result.eligible).toBe(0);
      expect(spawned).toHaveLength(0);
    }
  );

  it("logs blocked slices and still dispatches unblocked siblings", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const logs: string[] = [];

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1"), project("PRO-2", "done")],
      }),
      listSlices: async (projectDir) => {
        if (projectDir.includes("PRO-1")) {
          return [
            slice("PRO-1-S01", "PRO-1", "todo", {
              blocked_by: ["PRO-2-S01", "PRO-2-S99"],
            }),
            slice("PRO-1-S02", "PRO-1"),
          ];
        }
        return [slice("PRO-2-S01", "PRO-2", "todo")];
      },
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: (message) => logs.push(message),
    });

    expect(result.eligible).toBe(1);
    expect(spawned.map((input) => input.sliceId)).toEqual(["PRO-1-S02"]);
    expect(
      logs.some(
        (line) =>
          line.includes("action=skip") &&
          line.includes("reason=blocked_by_pending") &&
          line.includes("project=PRO-1") &&
          line.includes("slice=PRO-1-S01") &&
          line.includes("pending=PRO-2-S01,PRO-2-S99")
      )
    ).toBe(true);
  });

  it("applies blockers to reviewer dispatch", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const reviewConfig: OrchestratorConfig = {
      ...orchestratorConfig,
      statuses: {
        review: { profile: "Reviewer", max_concurrent: 1 },
      },
    };

    const result = await dispatchOrchestratorTick(config, reviewConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1"), project("PRO-2", "done")],
      }),
      listSlices: async (projectDir) => {
        if (projectDir.includes("PRO-1")) {
          return [
            slice("PRO-1-S01", "PRO-1", "review", {
              blocked_by: ["PRO-2-S01"],
            }),
          ];
        }
        return [slice("PRO-2-S01", "PRO-2", "todo")];
      },
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    expect(result.eligible).toBe(0);
    expect(spawned).toHaveLength(0);
  });

  it("counts only running orchestrator runs against status slots", async () => {
    const spawned: SpawnSubagentInput[] = [];

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1"), project("PRO-2"), project("PRO-3")],
      }),
      listSlices: async (projectDir) => {
        if (projectDir.includes("PRO-1")) return [slice("PRO-1-S01", "PRO-1")];
        if (projectDir.includes("PRO-2")) return [slice("PRO-2-S01", "PRO-2")];
        return [slice("PRO-3-S01", "PRO-3")];
      },
      listSubagents: async (_config, projectId) => {
        const items =
          projectId === "PRO-1"
            ? [run("running", "orchestrator", { sliceId: "PRO-1-S01" })]
            : projectId === "PRO-2"
              ? [run("running", "manual", { sliceId: "PRO-2-S01" })]
              : [];
        return { ok: true, data: { items } };
      },
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    // PRO-1-S01 has active orchestrator run (1 running)
    // PRO-2-S01 has manual run (not counted against orchestrator slots)
    expect(result.running).toBe(1);
    expect(result.availableSlots).toBe(1);
    // PRO-1-S01 skipped (active run), PRO-2-S01 + PRO-3-S01 eligible (2), 1 slot
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sliceId).toBe("PRO-2-S01");
  });

  it("ignores non-todo slices and skips todo slices with active orchestrator runs", async () => {
    const spawned: SpawnSubagentInput[] = [];

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { todo: { profile: "Worker", max_concurrent: 5 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1"), project("PRO-2"), project("PRO-3")],
        }),
        listSlices: async (projectDir) => {
          if (projectDir.includes("PRO-1")) {
            return [slice("PRO-1-S01", "PRO-1", "todo")];
          }
          if (projectDir.includes("PRO-2")) {
            // PRO-2 has a review slice (not todo, ignored for Worker dispatch)
            return [slice("PRO-2-S01", "PRO-2", "review")];
          }
          return [slice("PRO-3-S01", "PRO-3", "todo")];
        },
        listSubagents: async (_config, projectId) => {
          const items =
            projectId === "PRO-1"
              ? [run("running", "orchestrator", { sliceId: "PRO-1-S01" })]
              : [];
          return { ok: true, data: { items } };
        },
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: makeUpdateSliceMock().fn,
        log: () => {},
      }
    );

    expect(result.running).toBe(1);
    expect(result.eligible).toBe(1); // PRO-3-S01 is the only eligible todo slice
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sliceId).toBe("PRO-3-S01");
  });

  it("records an attempt + cleans the orphan dir when spawnSubagent throws", async () => {
    const removed: string[] = [];
    const logs: string[] = [];
    const recorded: Array<{ sliceId: string; kind: string; atMs: number }> = [];
    const updates = makeUpdateSliceMock();
    const tracker = {
      recordFailure: (sliceId: string, kind: string, atMs: number) => {
        recorded.push({ sliceId, kind, atMs });
      },
      recordSuccess: () => {},
      isCoolingDown: () => false,
      clear: () => {},
    };

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async () => {
        throw new Error("git worktree add failed");
      },
      updateSlice: updates.fn,
      attempts: tracker,
      removeOrphanDir: async (dirPath: string) => {
        removed.push(dirPath);
      },
      now: () => new Date("2026-05-03T17:00:00.000Z"),
      log: (msg) => logs.push(msg),
    });

    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]?.action).toBe("skipped");
    expect(result.decisions[0]?.reason).toBe("spawn_failed");
    expect(result.decisions[0]?.sliceId).toBe("PRO-1-S01");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sliceId).toBe("PRO-1-S01");
    expect(recorded[0]?.kind).toBe("worker");
    expect(updates.calls).toEqual([{ sliceId: "PRO-1-S01", status: "todo" }]);
    expect(
      logs.some(
        (m) =>
          m.includes("action=spawn_failed_revert") &&
          m.includes("reason=git worktree add failed") &&
          m.includes("status_reverted=true")
      )
    ).toBe(true);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/\/tmp\/projects\/PRO-1\/sessions\/pro-1-s01-/);
  });

  it("reverts Worker slice when spawnSubagent returns ok false", async () => {
    const logs: string[] = [];
    const recorded: Array<{ sliceId: string; kind: string; atMs: number }> = [];
    const updates = makeUpdateSliceMock();

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async () => ({ ok: false, error: "missing repo" }),
      updateSlice: updates.fn,
      attempts: {
        recordFailure: (sliceId, kind, atMs) =>
          recorded.push({ sliceId, kind, atMs }),
        recordSuccess: () => {},
        isCoolingDown: () => false,
        clear: () => {},
      },
      now: () => new Date("2026-05-03T17:00:00.000Z"),
      log: (msg) => logs.push(msg),
    });

    expect(result.decisions).toEqual([
      {
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
        action: "skipped",
        reason: "spawn_failed",
      },
    ]);
    expect(recorded).toEqual([
      { sliceId: "PRO-1-S01", kind: "worker", atMs: 1_777_827_600_000 },
    ]);
    expect(updates.calls).toEqual([{ sliceId: "PRO-1-S01", status: "todo" }]);
    expect(
      logs.some(
        (m) =>
          m.includes("action=spawn_failed_revert") &&
          m.includes("reason=missing repo") &&
          m.includes("status_reverted=true")
      )
    ).toBe(true);
  });

  it("reverts only failed Worker spawns in a mixed tick", async () => {
    const updates = makeUpdateSliceMock();

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1"),
        slice("PRO-1-S02", "PRO-1"),
      ],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        if (input.sliceId === "PRO-1-S01") {
          return { ok: false, error: "missing repo" };
        }
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: updates.fn,
      log: () => {},
    });

    expect(updates.calls).toEqual([
      { sliceId: "PRO-1-S01", status: "todo" },
      { sliceId: "PRO-1-S02", status: "in_progress" },
    ]);
  });

  it("logs revert_failed when Worker spawn failure cannot be reverted", async () => {
    const logs: string[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async () => ({ ok: false, error: "missing repo" }),
      updateSlice: async () => {
        throw new Error("disk full");
      },
      log: (msg) => logs.push(msg),
    });

    expect(
      logs.some(
        (m) =>
          m.includes("action=revert_failed") &&
          m.includes("reason=disk full") &&
          m.includes("spawn_reason=missing repo") &&
          m.includes("status_reverted=false")
      )
    ).toBe(true);
  });

  it("sibling slices are independent — active run on S01 does not block S02", async () => {
    const spawned: SpawnSubagentInput[] = [];

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1"),
        slice("PRO-1-S02", "PRO-1"),
      ],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [run("running", "orchestrator", { sliceId: "PRO-1-S01" })],
        },
      }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    expect(result.running).toBe(1);
    expect(result.eligible).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sliceId).toBe("PRO-1-S02");
  });

  it("keys cooldown by sliceId", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const tracker = {
      recordFailure: () => {},
      recordSuccess: () => {},
      // PRO-1-S01 is cooling down; PRO-1-S02 is not
      isCoolingDown: (sliceId: string) => sliceId === "PRO-1-S01",
      clear: () => {},
    };

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1"),
        slice("PRO-1-S02", "PRO-1"),
      ],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      attempts: tracker,
      log: () => {},
    });

    expect(result.eligible).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sliceId).toBe("PRO-1-S02");
    expect(spawned[0]?.projectId).toBe("PRO-1");
  });

  it("matches legacy active run by repo cwd fallback", async () => {
    const spawned: SpawnSubagentInput[] = [];

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [
          {
            ...project("PRO-1"),
            frontmatter: { status: "active", repo: "/tmp/repo" },
          },
        ],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [
            // Legacy run: has worktreePath but no sliceId
            run("running", "orchestrator", {
              worktreePath: "/tmp/repo",
            }),
          ],
        },
      }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    expect(result.running).toBe(1);
    expect(result.eligible).toBe(0);
    expect(spawned).toHaveLength(0);
  });

  it("skips slices in the failure cooldown window", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const tracker = {
      recordFailure: () => {},
      recordSuccess: () => {},
      isCoolingDown: (sliceId: string) => sliceId === "PRO-1-S01",
      clear: () => {},
    };

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1"), project("PRO-2")],
      }),
      listSlices: async (projectDir) => {
        if (projectDir.includes("PRO-1")) return [slice("PRO-1-S01", "PRO-1")];
        return [slice("PRO-2-S01", "PRO-2")];
      },
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      attempts: tracker,
      log: () => {},
    });

    expect(result.eligible).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sliceId).toBe("PRO-2-S01");
  });

  it("backs off spawn failures exponentially up to 30 minutes", async () => {
    const tracker = createOrchestratorAttemptTracker();
    const attemptAt = new Date("2026-05-03T00:00:00.000Z").getTime();

    tracker.recordFailure("PRO-1-S01", "worker", attemptAt);
    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 29_999)
    ).toBe(true);
    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 30_000)
    ).toBe(false);

    tracker.recordFailure("PRO-1-S01", "worker", attemptAt + 30_000);
    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 89_999)
    ).toBe(true);
    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 90_000)
    ).toBe(false);

    tracker.recordFailure("PRO-1-S01", "worker", attemptAt + 90_000);
    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 209_999)
    ).toBe(true);
    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 210_000)
    ).toBe(false);

    for (let i = 0; i < 10; i += 1) {
      tracker.recordFailure("PRO-1-S02", "worker", attemptAt);
    }
    expect(
      tracker.isCoolingDown("PRO-1-S02", "worker", attemptAt + 1_799_999)
    ).toBe(true);
    expect(
      tracker.isCoolingDown("PRO-1-S02", "worker", attemptAt + 1_800_000)
    ).toBe(false);
  });

  it("resets backoff after successful dispatch", () => {
    const tracker = createOrchestratorAttemptTracker();
    const attemptAt = new Date("2026-05-03T00:00:00.000Z").getTime();

    tracker.recordFailure("PRO-1-S01", "worker", attemptAt);
    tracker.recordFailure("PRO-1-S01", "worker", attemptAt + 30_000);
    tracker.recordSuccess("PRO-1-S01", "worker");
    tracker.recordFailure("PRO-1-S01", "worker", attemptAt + 90_000);

    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 119_999)
    ).toBe(true);
    expect(
      tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 120_000)
    ).toBe(false);
  });

  it("keeps backoff separate by sliceId and dispatch kind", () => {
    const tracker = createOrchestratorAttemptTracker();
    const attemptAt = new Date("2026-05-03T00:00:00.000Z").getTime();

    tracker.recordFailure("PRO-1-S01", "worker", attemptAt);

    expect(tracker.isCoolingDown("PRO-1-S01", "worker", attemptAt + 1)).toBe(
      true
    );
    expect(tracker.isCoolingDown("PRO-1-S01", "reviewer", attemptAt + 1)).toBe(
      false
    );
    expect(tracker.isCoolingDown("PRO-1-S02", "worker", attemptAt + 1)).toBe(
      false
    );
  });

  it("locks spawned Worker slices by moving them to in_progress (project status unchanged)", async () => {
    const updates = makeUpdateSliceMock();

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1"), project("PRO-2")],
      }),
      listSlices: async (projectDir) => {
        if (projectDir.includes("PRO-1")) return [slice("PRO-1-S01", "PRO-1")];
        return [slice("PRO-2-S01", "PRO-2")];
      },
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => ({
        ok: true,
        data: { slug: input.slug },
      }),
      updateSlice: updates.fn,
      log: () => {},
    });

    expect(updates.calls).toEqual([
      { sliceId: "PRO-1-S01", status: "in_progress" },
      { sliceId: "PRO-2-S01", status: "in_progress" },
    ]);
  });

  it("dispatches Reviewers for slices in review status under active projects", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const updates = makeUpdateSliceMock();
    const workerDir = await tempWorkspace("reviewer-dispatch");

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { review: { profile: "Reviewer", max_concurrent: 2 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1")],
        }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "review")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("idle", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: workerDir,
                sliceId: "PRO-1-S01",
              }),
            ],
          },
        }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: updates.fn,
        now: () => new Date("2026-05-03T00:00:00.000Z"),
        log: () => {},
      }
    );

    expect(result.availableSlots).toBe(2);
    expect(result.eligible).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.sliceId).toBe("PRO-1-S01");
    expect(spawned[0]?.projectId).toBe("PRO-1");
    expect(spawned[0]?.name).toBe("Reviewer");
    expect(spawned[0]?.mode).toBe("none");
    expect(spawned[0]?.baseBranch).toBeUndefined();
    expect(spawned[0]?.source).toBe("orchestrator");
    // Reviewer uses `slices move` for both pass and fail paths
    expect(spawned[0]?.prompt).toContain(
      "`yoplai slices move PRO-1-S01 ready_to_merge`"
    );
    expect(spawned[0]?.prompt).toContain("always pass `--author Reviewer`");
    expect(spawned[0]?.prompt).toContain(
      '`yoplai slices comment PRO-1-S01 --author Reviewer "<one-line PASS summary>"`'
    );
    expect(spawned[0]?.prompt).toContain("yoplai projects comment");
    expect(spawned[0]?.prompt).toContain("yoplai slices comment");
    // BLOCK path must instruct Reviewer to record durable feedback in SPECS.md
    // (PRO-249 — prevents identical reject loops across fresh Worker iterations)
    expect(spawned[0]?.prompt).toContain("## Known traps");
    expect(spawned[0]?.prompt).toContain(
      "/tmp/projects/PRO-1/slices/PRO-1-S01/SPECS.md"
    );
    expect(spawned[0]?.prompt).toContain("Wrong fix to avoid");
    expect(spawned[0]?.prompt).toContain("Correct fix");
    // Reviewer does NOT lock the slice status
    expect(updates.calls).toEqual([]);
  });

  it("dispatches Merger for ready_to_merge slices from the integration branch", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const updates = makeUpdateSliceMock();

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger", max_concurrent: 2 } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "ready_to_merge")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("replied", "orchestrator", {
                name: "Worker",
                slug: "pro-1-s01-worker",
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T00:00:00.000Z",
              }),
            ],
          },
        }),
        ensureProjectIntegrationBranch: async () => "PRO-1/integration",
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: updates.fn,
        now: () => new Date("2026-05-03T00:00:00.000Z"),
        log: () => {},
      }
    );

    expect(result.availableSlots).toBe(2);
    expect(result.eligible).toBe(1);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      name: "Merger",
      mode: "worktree",
      baseBranch: "PRO-1/integration",
      source: "orchestrator",
    });
    expect(spawned[0]?.slug).toContain("pro-1-s01-merger-");
    expect(spawned[0]?.prompt).toContain("git merge PRO-1/pro-1-s01-worker");
    expect(spawned[0]?.prompt).toContain("yoplai slices move PRO-1-S01 done");
    expect(spawned[0]?.prompt).toContain(
      "yoplai slices merger-conflict PRO-1-S01"
    );
    expect(updates.calls).toEqual([]);
  });

  it("defaults ready_to_merge Merger concurrency to two", async () => {
    const spawned: SpawnSubagentInput[] = [];

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger" } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [
          slice("PRO-1-S01", "PRO-1", "ready_to_merge"),
          slice("PRO-1-S02", "PRO-1", "ready_to_merge"),
          slice("PRO-1-S03", "PRO-1", "ready_to_merge"),
        ],
        listSubagents: async () => ({ ok: true, data: { items: [] } }),
        ensureProjectIntegrationBranch: async () => "PRO-1/integration",
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: makeUpdateSliceMock().fn,
        now: () => new Date("2026-05-03T00:00:00.000Z"),
        log: () => {},
      }
    );

    expect(result.availableSlots).toBe(2);
    expect(result.eligible).toBe(3);
    expect(spawned.map((input) => input.sliceId)).toEqual([
      "PRO-1-S01",
      "PRO-1-S02",
    ]);
  });

  it("does not dispatch a second Merger when one is already running", async () => {
    const spawned: SpawnSubagentInput[] = [];

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger", max_concurrent: 2 } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "ready_to_merge")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("running", "orchestrator", {
                name: "Merger",
                sliceId: "PRO-1-S01",
              }),
            ],
          },
        }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: makeUpdateSliceMock().fn,
        log: () => {},
      }
    );

    expect(result.running).toBe(1);
    expect(result.availableSlots).toBe(1);
    expect(result.eligible).toBe(0);
    expect(spawned).toEqual([]);
  });

  it("leaves ready_to_merge slices unchanged when Merger spawn fails", async () => {
    const updates = makeUpdateSliceMock();

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "ready_to_merge")],
        listSubagents: async () => ({ ok: true, data: { items: [] } }),
        ensureProjectIntegrationBranch: async () => "PRO-1/integration",
        spawnSubagent: async () => ({ ok: false, error: "boom" }),
        updateSlice: updates.fn,
        log: () => {},
      }
    );

    expect(result.decisions).toEqual([
      {
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
        action: "skipped",
        reason: "spawn_failed",
      },
    ]);
    expect(updates.calls).toEqual([]);
  });

  it("emits HITL and parks a ready_to_merge slice with Merger conflict metadata", async () => {
    const events: HitlEvent[] = [];
    const spawned: SpawnSubagentInput[] = [];
    const conflictSlice = slice("PRO-1-S01", "PRO-1", "ready_to_merge", {
      merger_conflict: {
        summary: "src/app.ts, package.json",
        at: "2026-05-03T00:04:00.000Z",
        source: "merger_outcome",
      },
    });

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [conflictSlice],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("replied", "orchestrator", {
                name: "Merger",
                slug: "pro-1-s01-merger",
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T00:03:00.000Z",
                finishedAt: "2026-05-03T00:04:30.000Z",
              }),
            ],
          },
        }),
        ensureProjectIntegrationBranch: async () => "PRO-1/integration",
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        hitl: { add: (event) => events.push(event) },
        log: () => {},
      }
    );

    expect(events).toEqual([
      expect.objectContaining({
        kind: "merger_conflict",
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
        summary: "src/app.ts, package.json",
      }),
    ]);
    expect(result.eligible).toBe(0);
    expect(spawned).toEqual([]);
  });

  it("parks Merger conflicts even when HITL is not injected", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const conflictSlice = slice("PRO-1-S01", "PRO-1", "ready_to_merge", {
      merger_conflict: {
        summary: "src/app.ts",
        at: "2026-05-03T00:04:00.000Z",
        source: "merger_outcome",
      },
    });

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [conflictSlice],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("replied", "orchestrator", {
                name: "Merger",
                slug: "pro-1-s01-merger",
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T00:03:00.000Z",
                finishedAt: "2026-05-03T00:04:30.000Z",
              }),
            ],
          },
        }),
        ensureProjectIntegrationBranch: async () => "PRO-1/integration",
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        log: () => {},
      }
    );

    expect(result.eligible).toBe(0);
    expect(spawned).toEqual([]);
  });

  it("uses Merger conflict comments as a fallback parking signal", async () => {
    const events: HitlEvent[] = [];
    const conflictSlice = {
      ...slice("PRO-1-S01", "PRO-1", "ready_to_merge"),
      docs: {
        ...slice("PRO-1-S01", "PRO-1").docs,
        thread: [
          "## 2026-05-03T00:04:00.000Z",
          "[author:Merger]",
          "[date:2026-05-03T00:04:00.000Z]",
          "",
          "Merge conflict - needs human: src/app.ts",
          "",
        ].join("\n"),
      },
    };

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [conflictSlice],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("replied", "orchestrator", {
                name: "Merger",
                slug: "pro-1-s01-merger",
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T00:03:00.000Z",
                finishedAt: "2026-05-03T00:04:30.000Z",
              }),
            ],
          },
        }),
        hitl: { add: (event) => events.push(event) },
        log: () => {},
      }
    );

    expect(events[0]).toEqual(
      expect.objectContaining({
        kind: "merger_conflict",
        summary: "src/app.ts",
      })
    );
    expect(result.eligible).toBe(0);
  });

  it("does not park stale Merger conflict metadata", async () => {
    const events: HitlEvent[] = [];
    const spawned: SpawnSubagentInput[] = [];
    const conflictSlice = slice("PRO-1-S01", "PRO-1", "ready_to_merge", {
      merger_conflict: {
        summary: "src/app.ts",
        at: "2026-05-03T00:04:00.000Z",
        source: "merger_outcome",
      },
    });

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { ready_to_merge: { profile: "Merger", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({ ok: true, data: [project("PRO-1")] }),
        listSlices: async () => [conflictSlice],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("replied", "orchestrator", {
                name: "Merger",
                slug: "pro-1-s01-merger-later",
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T00:10:00.000Z",
                finishedAt: "2026-05-03T00:11:00.000Z",
              }),
            ],
          },
        }),
        ensureProjectIntegrationBranch: async () => "PRO-1/integration",
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        hitl: { add: (event) => events.push(event) },
        log: () => {},
      }
    );

    expect(events).toEqual([]);
    expect(result.eligible).toBe(1);
    expect(spawned).toHaveLength(1);
  });

  it("emits a HITL event when a reviewer-failed slice is back in todo", async () => {
    const events: HitlEvent[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1", "todo")],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [
            run("idle", "orchestrator", {
              name: "Reviewer",
              sliceId: "PRO-1-S01",
              finishedAt: "2026-05-03T00:00:00.000Z",
            }),
          ],
        },
      }),
      spawnSubagent: async (_config, input) => ({
        ok: true,
        data: { slug: input.slug },
      }),
      updateSlice: makeUpdateSliceMock().fn,
      hitl: { add: (event) => events.push(event) },
      log: () => {},
    });

    expect(events).toEqual([
      expect.objectContaining({
        kind: "reviewer_fail",
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
      }),
    ]);
  });

  it("does not emit reviewer-fail HITL for manual reviewer runs", async () => {
    const events: HitlEvent[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1", "todo")],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [
            run("idle", "manual", {
              name: "Reviewer",
              sliceId: "PRO-1-S01",
              finishedAt: "2026-05-03T00:00:00.000Z",
            }),
          ],
        },
      }),
      spawnSubagent: async (_config, input) => ({
        ok: true,
        data: { slug: input.slug },
      }),
      updateSlice: makeUpdateSliceMock().fn,
      hitl: { add: (event) => events.push(event) },
      log: () => {},
    });

    expect(events).toEqual([]);
  });

  it("accounts todo and review slots independently", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const updates = makeUpdateSliceMock();
    const workerDir = await tempWorkspace("reviewer-slots");

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: {
          todo: { profile: "Worker", max_concurrent: 1 },
          review: { profile: "Reviewer", max_concurrent: 1 },
        },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1"), project("PRO-2")],
        }),
        listSlices: async (projectDir) => {
          if (projectDir.includes("PRO-1")) {
            return [
              slice("PRO-1-S01", "PRO-1", "todo"),
              slice("PRO-1-S02", "PRO-1", "review"),
            ];
          }
          return [slice("PRO-2-S01", "PRO-2", "todo")];
        },
        listSubagents: async (_config, projectId) => ({
          ok: true,
          data: {
            items:
              projectId === "PRO-1"
                ? [
                    run("idle", "orchestrator", {
                      name: "Worker",
                      cli: "codex",
                      worktreePath: workerDir,
                      sliceId: "PRO-1-S02",
                    }),
                  ]
                : [],
          },
        }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: updates.fn,
        log: () => {},
      }
    );

    // 1 slot for todo (2 eligible: PRO-1-S01, PRO-2-S01) → 1 spawned
    // 1 slot for review (1 eligible: PRO-1-S02) → 1 spawned
    expect(result.availableSlots).toBe(2);
    expect(result.eligible).toBe(3);
    expect(spawned).toHaveLength(2);
    const workerSpawns = spawned.filter((s) => s.name === "Worker");
    const reviewerSpawns = spawned.filter((s) => s.name === "Reviewer");
    expect(workerSpawns).toHaveLength(1);
    expect(reviewerSpawns).toHaveLength(1);
    // Worker lock applied only for todo slice
    expect(updates.calls).toHaveLength(1);
    expect(updates.calls[0]?.status).toBe("in_progress");
  });

  it("does not dispatch when configured status has no eligible slices", async () => {
    const spawned: SpawnSubagentInput[] = [];

    // Only `review` configured but all slices are in `todo`
    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { review: { profile: "Reviewer", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1")],
        }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "todo")],
        listSubagents: async () => ({ ok: true, data: { items: [] } }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: makeUpdateSliceMock().fn,
        log: () => {},
      }
    );

    expect(result.eligible).toBe(0);
    expect(spawned).toEqual([]);
  });

  it("includes the most recent worker workspace in reviewer prompts (filtered by sliceId)", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const oldDir = await tempWorkspace("reviewer-old");
    const newDir = await tempWorkspace("reviewer-new");
    const otherSliceDir = await tempWorkspace("reviewer-other-slice");
    const manualDir = await tempWorkspace("reviewer-manual");

    await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { review: { profile: "Reviewer", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1")],
        }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "review")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("idle", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: oldDir,
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T00:00:00.000Z",
              }),
              run("idle", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: newDir,
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T01:00:00.000Z",
              }),
              // Different slice — should NOT appear in PRO-1-S01 reviewer prompt
              run("idle", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: otherSliceDir,
                sliceId: "PRO-1-S02",
                startedAt: "2026-05-03T02:00:00.000Z",
              }),
              // Manual run — not an orchestrator worker run
              run("idle", "manual", {
                name: "Worker",
                cli: "codex",
                worktreePath: manualDir,
                startedAt: "2026-05-03T02:00:00.000Z",
              }),
            ],
          },
        }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: makeUpdateSliceMock().fn,
        log: () => {},
      }
    );

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.prompt).toContain(`Worker (codex): ${newDir}`);
    expect(spawned[0]?.prompt).not.toContain(oldDir);
    expect(spawned[0]?.prompt).not.toContain(otherSliceDir);
    expect(spawned[0]?.prompt).not.toContain(manualDir);
  });

  it("prunes stale worker workspace refs before reviewer prompt assembly", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const logs: string[] = [];
    const existingDir = await tempWorkspace("reviewer-existing");
    const missingDir = path.join(
      await tempWorkspace("reviewer-missing-parent"),
      "missing"
    );

    await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { review: { profile: "Reviewer", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1")],
        }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "review")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("idle", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: existingDir,
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T00:00:00.000Z",
              }),
              run("idle", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: missingDir,
                sliceId: "PRO-1-S01",
                startedAt: "2026-05-03T01:00:00.000Z",
              }),
            ],
          },
        }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: makeUpdateSliceMock().fn,
        log: (msg) => logs.push(msg),
      }
    );

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.prompt).toContain(`Worker (codex): ${existingDir}`);
    expect(spawned[0]?.prompt).not.toContain(missingDir);
    expect(
      logs.some(
        (line) =>
          line.includes("action=prune_stale_worker_workspace") &&
          line.includes(`path=${missingDir}`)
      )
    ).toBe(true);
  });

  it("reverts review slice to todo when no worker workspace exists and no worker is live", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const logs: string[] = [];
    const updates = makeUpdateSliceMock();
    const missingDir = path.join(
      await tempWorkspace("reviewer-all-missing-parent"),
      "missing"
    );

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { review: { profile: "Reviewer", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1")],
        }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "review")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("idle", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: missingDir,
                sliceId: "PRO-1-S01",
              }),
            ],
          },
        }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: updates.fn,
        log: (msg) => logs.push(msg),
      }
    );

    expect(result.decisions).toContainEqual({
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      action: "skipped",
      reason: "reviewer_skipped_no_worker_workspace",
    });
    expect(spawned).toEqual([]);
    expect(updates.calls).toEqual([{ sliceId: "PRO-1-S01", status: "todo" }]);
    expect(
      logs.some(
        (line) =>
          line.includes("action=reviewer_skipped_no_worker_workspace") &&
          line.includes("live_worker=false")
      )
    ).toBe(true);
  });

  it("leaves review slice alone when no worker workspace exists but a worker is live", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const logs: string[] = [];
    const updates = makeUpdateSliceMock();
    const missingDir = path.join(
      await tempWorkspace("reviewer-live-missing-parent"),
      "missing"
    );

    const result = await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { review: { profile: "Reviewer", max_concurrent: 1 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1")],
        }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "review")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("running", "orchestrator", {
                name: "Worker",
                cli: "codex",
                worktreePath: missingDir,
                sliceId: "PRO-1-S01",
              }),
            ],
          },
        }),
        spawnSubagent: async (_config, input) => {
          spawned.push(input);
          return { ok: true, data: { slug: input.slug } };
        },
        updateSlice: updates.fn,
        log: (msg) => logs.push(msg),
      }
    );

    expect(result.decisions).toContainEqual({
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      action: "skipped",
      reason: "reviewer_skipped_no_worker_workspace",
    });
    expect(spawned).toEqual([]);
    expect(updates.calls).toEqual([]);
    expect(
      logs.some(
        (line) =>
          line.includes("action=reviewer_skipped_no_worker_workspace") &&
          line.includes("live_worker=true")
      )
    ).toBe(true);
  });

  it("logs lock_failed but does not unwind a successful spawn", async () => {
    const spawned: SpawnSubagentInput[] = [];
    const logs: string[] = [];

    const result = await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: async () => {
        throw new Error("disk full");
      },
      log: (msg) => logs.push(msg),
    });

    expect(spawned).toHaveLength(1);
    expect(result.decisions[0]?.action).toBe("spawned");
    expect(
      logs.some(
        (m) =>
          m.includes("action=lock_failed") && m.includes("reason=disk full")
      )
    ).toBe(true);
  });

  it("Worker prompt includes stay-in-slice clause and slice-specific file links", async () => {
    const spawned: SpawnSubagentInput[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    expect(spawned).toHaveLength(1);
    const prompt = spawned[0]?.prompt ?? "";
    // Stay-in-slice clause
    expect(prompt).toContain("Stay in Your Slice");
    // Slice doc links
    expect(prompt).toContain(`/tmp/projects/PRO-1/slices/PRO-1-S01/SPECS.md`);
    expect(prompt).toContain(`/tmp/projects/PRO-1/slices/PRO-1-S01/TASKS.md`);
    expect(prompt).toContain(
      `/tmp/projects/PRO-1/slices/PRO-1-S01/VALIDATION.md`
    );
    // Project context (pitch + scope map + thread)
    expect(prompt).toContain(`/tmp/projects/PRO-1/README.md`);
    expect(prompt).toContain(`/tmp/projects/PRO-1/SCOPE_MAP.md`);
    expect(prompt).toContain(`/tmp/projects/PRO-1/THREAD.md`);
    // Prior iteration feedback framing (PRO-249)
    expect(prompt).toContain("Prior Iteration Feedback");
    expect(prompt).toContain("Known traps");
    expect(prompt).toContain("Do NOT repeat the rejected approach");
    expect(prompt).toContain("investigate root cause before band-aiding");
  });

  it("Worker run gets projectId + sliceId in spawn input", async () => {
    const spawned: SpawnSubagentInput[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    expect(spawned[0]?.projectId).toBe("PRO-1");
    expect(spawned[0]?.sliceId).toBe("PRO-1-S01");
  });

  it("Worker dispatch forks from the project integration branch", async () => {
    const spawned: SpawnSubagentInput[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      log: () => {},
    });

    expect(spawned[0]?.baseBranch).toBe("PRO-1/integration");
  });

  it("worktree slug encodes sliceId for §5.8 path layout", async () => {
    const spawned: SpawnSubagentInput[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1")],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      spawnSubagent: async (_config, input) => {
        spawned.push(input);
        return { ok: true, data: { slug: input.slug } };
      },
      updateSlice: makeUpdateSliceMock().fn,
      now: () => new Date("2026-05-03T17:00:00.000Z"),
      log: () => {},
    });

    // Slug starts with lowercase sliceId prefix
    expect(spawned[0]?.slug).toMatch(/^pro-1-s01-/);
  });

  it("comments once for long-idle in_progress slices with no live run", async () => {
    const updates = makeUpdateSliceMock();
    const logs: string[] = [];
    const hitlEvents: unknown[] = [];

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1", "in_progress", {
          updated_at: "2026-05-03T00:00:00.000Z",
        }),
      ],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:31:00.000Z"),
      stalls: createStallTracker(),
      hitl: { add: (event) => hitlEvents.push(event) },
      log: (msg) => logs.push(msg),
    });

    expect(updates.calls).toHaveLength(1);
    expect(updates.calls[0]?.sliceId).toBe("PRO-1-S01");
    expect(updates.calls[0]?.thread).toContain(
      "Stall detected: slice PRO-1-S01 has been in in_progress for 31m with no live subagent run. Last run: none."
    );
    expect(updates.calls[0]?.thread).toContain("[author:Orchestrator]");
    expect(hitlEvents).toEqual([
      expect.objectContaining({
        kind: "stall",
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
      }),
    ]);
    expect(logs.some((msg) => msg.includes("action=stall_detected"))).toBe(true);
  });

  it("suppresses duplicate stall comments for the same stall", async () => {
    const updates = makeUpdateSliceMock();
    const stalls = createStallTracker();
    const hitlEvents: unknown[] = [];
    const deps = {
      listProjects: async () => ({
        ok: true as const,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1", "in_progress", {
          updated_at: "2026-05-03T00:00:00.000Z",
        }),
      ],
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:31:00.000Z"),
      stalls,
      hitl: { add: (event: unknown) => hitlEvents.push(event) },
      log: () => {},
    };

    await dispatchOrchestratorTick(config, orchestratorConfig, deps);
    await dispatchOrchestratorTick(config, orchestratorConfig, deps);

    expect(updates.calls).toHaveLength(1);
    expect(hitlEvents).toHaveLength(1);
  });

  it("does not comment for slices below the stall threshold", async () => {
    const updates = makeUpdateSliceMock();

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1", "in_progress", {
          updated_at: "2026-05-03T00:00:00.000Z",
        }),
      ],
      listSubagents: async () => ({ ok: true, data: { items: [] } }),
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:29:00.000Z"),
      stalls: createStallTracker(),
      log: () => {},
    });

    expect(updates.calls).toEqual([]);
  });

  it("does not comment for long-idle slices with a live orchestrator run", async () => {
    const updates = makeUpdateSliceMock();

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1", "in_progress", {
          updated_at: "2026-05-03T00:00:00.000Z",
        }),
      ],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [
            run("running", "orchestrator", { sliceId: "PRO-1-S01" }),
          ],
        },
      }),
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:31:00.000Z"),
      stalls: createStallTracker(),
      log: () => {},
    });

    expect(updates.calls).toEqual([]);
  });

  it("does not comment for long-idle slices with a live manual run", async () => {
    const updates = makeUpdateSliceMock();

    await dispatchOrchestratorTick(config, orchestratorConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1", "in_progress", {
          updated_at: "2026-05-03T00:00:00.000Z",
        }),
      ],
      listSubagents: async () => ({
        ok: true,
        data: {
          items: [run("running", "manual", { sliceId: "PRO-1-S01" })],
        },
      }),
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:31:00.000Z"),
      stalls: createStallTracker(),
      log: () => {},
    });

    expect(updates.calls).toEqual([]);
  });

  it("comments again after a stalled slice changes status away and back", async () => {
    const updates = makeUpdateSliceMock();
    const stalls = createStallTracker();
    const hitlEvents: unknown[] = [];
    let status: SliceRecord["frontmatter"]["status"] = "in_progress";
    const deps = {
      listProjects: async () => ({
        ok: true as const,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1", status, {
          updated_at: "2026-05-03T00:00:00.000Z",
        }),
      ],
      listSubagents: async () => ({ ok: true as const, data: { items: [] } }),
      updateSlice: updates.fn,
      now: () => new Date("2026-05-03T00:31:00.000Z"),
      stalls,
      hitl: { add: (event: unknown) => hitlEvents.push(event) },
      log: () => {},
    };

    await dispatchOrchestratorTick(config, orchestratorConfig, deps);
    status = "ready_to_merge";
    await dispatchOrchestratorTick(config, orchestratorConfig, deps);
    status = "in_progress";
    await dispatchOrchestratorTick(config, orchestratorConfig, deps);

    expect(updates.calls).toHaveLength(2);
    expect(hitlEvents).toHaveLength(2);
  });

  it("emits HITL when a reviewer returns a slice to todo", async () => {
    const hitlEvents: unknown[] = [];

    await dispatchOrchestratorTick(
      config,
      {
        ...orchestratorConfig,
        statuses: { todo: { profile: "Worker", max_concurrent: 0 } },
      },
      {
        listProjects: async () => ({
          ok: true,
          data: [project("PRO-1")],
        }),
        listSlices: async () => [slice("PRO-1-S01", "PRO-1", "todo")],
        listSubagents: async () => ({
          ok: true,
          data: {
            items: [
              run("idle", "orchestrator", {
                name: "Reviewer",
                sliceId: "PRO-1-S01",
                finishedAt: "2026-05-03T00:30:00.000Z",
              }),
            ],
          },
        }),
        hitl: { add: (event) => hitlEvents.push(event) },
        stalls: createStallTracker(),
        log: () => {},
      }
    );

    expect(hitlEvents).toEqual([
      expect.objectContaining({
        kind: "reviewer_fail",
        projectId: "PRO-1",
        sliceId: "PRO-1-S01",
        summary: "Reviewer returned the slice to todo.",
      }),
    ]);
  });

  it("pings once per day when integration is ahead of main", async () => {
    const notifications: Array<{ channel: string; message: string }> = [];
    const lastDonePingDates = new Map<string, string>();

    const deps = {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [
        slice("PRO-1-S01", "PRO-1", "done"),
        slice("PRO-1-S02", "PRO-1", "done"),
      ],
      countIntegrationAhead: async () => 2,
      notify: async (input: { channel: string; message: string }) => {
        notifications.push(input);
      },
      lastDonePingDates,
      now: () => new Date("2026-05-05T10:00:00.000Z"),
      log: () => {},
    };

    await dispatchOrchestratorTick(config, donePingConfig, deps);
    await dispatchOrchestratorTick(config, donePingConfig, deps);

    expect(notifications).toEqual([
      {
        channel: "ops",
        message:
          "PRO-1 has 2 slices `done` on integration, ready for main merge: PRO-1-S01, PRO-1-S02",
      },
    ]);
  });

  it("does not ping when integration has no unmerged commits", async () => {
    const notifications: Array<{ channel: string; message: string }> = [];

    await dispatchOrchestratorTick(config, donePingConfig, {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1", "done")],
      countIntegrationAhead: async () => 0,
      notify: async (input) => {
        notifications.push(input);
      },
      lastDonePingDates: new Map(),
      now: () => new Date("2026-05-05T10:00:00.000Z"),
      log: () => {},
    });

    expect(notifications).toEqual([]);
  });

  it("pings again on a different day while integration remains ahead", async () => {
    const notifications: Array<{ channel: string; message: string }> = [];
    const lastDonePingDates = new Map<string, string>();
    let now = new Date("2026-05-05T10:00:00.000Z");

    const deps = {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => [slice("PRO-1-S01", "PRO-1", "done")],
      countIntegrationAhead: async () => 1,
      notify: async (input: { channel: string; message: string }) => {
        notifications.push(input);
      },
      lastDonePingDates,
      now: () => now,
      log: () => {},
    };

    await dispatchOrchestratorTick(config, donePingConfig, deps);
    now = new Date("2026-05-06T10:00:00.000Z");
    await dispatchOrchestratorTick(config, donePingConfig, deps);

    expect(notifications).toHaveLength(2);
  });

  it("clears the daily ping gate after integration is merged to main", async () => {
    const notifications: Array<{ channel: string; message: string }> = [];
    const lastDonePingDates = new Map<string, string>();
    let aheadCount = 1;
    let now = new Date("2026-05-05T10:00:00.000Z");
    let slices = [slice("PRO-1-S01", "PRO-1", "done")];

    const deps = {
      listProjects: async () => ({
        ok: true,
        data: [project("PRO-1")],
      }),
      listSlices: async () => slices,
      countIntegrationAhead: async () => aheadCount,
      notify: async (input: { channel: string; message: string }) => {
        notifications.push(input);
      },
      lastDonePingDates,
      now: () => now,
      log: () => {},
    };

    await dispatchOrchestratorTick(config, donePingConfig, deps);
    expect(notifications).toHaveLength(1);

    aheadCount = 0;
    now = new Date("2026-05-06T10:00:00.000Z");
    await dispatchOrchestratorTick(config, donePingConfig, deps);
    expect(notifications).toHaveLength(1);

    aheadCount = 1;
    now = new Date("2026-05-07T10:00:00.000Z");
    slices = [
      slice("PRO-1-S01", "PRO-1", "done"),
      slice("PRO-1-S02", "PRO-1", "done"),
    ];
    await dispatchOrchestratorTick(config, donePingConfig, deps);

    expect(notifications).toEqual([
      {
        channel: "ops",
        message:
          "PRO-1 has 1 slices `done` on integration, ready for main merge: PRO-1-S01",
      },
      {
        channel: "ops",
        message:
          "PRO-1 has 2 slices `done` on integration, ready for main merge: PRO-1-S01, PRO-1-S02",
      },
    ]);
  });

  it("resolves prod notify CLI args", () => {
    const oldDev = process.env.YOPLAI_DEV;
    const oldRoot = process.env.YOPLAI_WORKSPACE_ROOT;
    delete process.env.YOPLAI_DEV;
    delete process.env.YOPLAI_WORKSPACE_ROOT;

    try {
      expect(
        resolveNotifyCommand({ channel: "ops", message: "ready" })
      ).toEqual({
        file: "yoplai",
        args: ["notify", "--channel", "ops", "--message", "ready"],
      });
    } finally {
      if (oldDev === undefined) delete process.env.YOPLAI_DEV;
      else process.env.YOPLAI_DEV = oldDev;
      if (oldRoot === undefined) delete process.env.YOPLAI_WORKSPACE_ROOT;
      else process.env.YOPLAI_WORKSPACE_ROOT = oldRoot;
    }
  });

  it("resolves dev notify CLI args", () => {
    const oldDev = process.env.YOPLAI_DEV;
    const oldRoot = process.env.YOPLAI_WORKSPACE_ROOT;
    process.env.YOPLAI_DEV = "1";
    process.env.YOPLAI_WORKSPACE_ROOT = "/repo";

    try {
      expect(
        resolveNotifyCommand({ channel: "ops", message: "ready" })
      ).toEqual({
        file: "pnpm",
        args: [
          "--dir",
          "/repo",
          "yoplai:dev",
          "notify",
          "--channel",
          "ops",
          "--message",
          "ready",
        ],
      });
    } finally {
      if (oldDev === undefined) delete process.env.YOPLAI_DEV;
      else process.env.YOPLAI_DEV = oldDev;
      if (oldRoot === undefined) delete process.env.YOPLAI_WORKSPACE_ROOT;
      else process.env.YOPLAI_WORKSPACE_ROOT = oldRoot;
    }
  });

  it("runs prod notify CLI args through the default notifier path", async () => {
    const oldDev = process.env.YOPLAI_DEV;
    const oldRoot = process.env.YOPLAI_WORKSPACE_ROOT;
    delete process.env.YOPLAI_DEV;
    delete process.env.YOPLAI_WORKSPACE_ROOT;
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile = ((
      file: string,
      args: string[],
      callback: (error: Error | null) => void
    ) => {
      calls.push({ file, args });
      callback(null);
    }) as typeof import("node:child_process").execFile;

    try {
      await runNotify({ channel: "ops", message: "ready" }, execFile);
      expect(calls).toEqual([
        {
          file: "yoplai",
          args: ["notify", "--channel", "ops", "--message", "ready"],
        },
      ]);
    } finally {
      if (oldDev === undefined) delete process.env.YOPLAI_DEV;
      else process.env.YOPLAI_DEV = oldDev;
      if (oldRoot === undefined) delete process.env.YOPLAI_WORKSPACE_ROOT;
      else process.env.YOPLAI_WORKSPACE_ROOT = oldRoot;
    }
  });

  it("runs dev notify CLI args through the default notifier path", async () => {
    const oldDev = process.env.YOPLAI_DEV;
    const oldRoot = process.env.YOPLAI_WORKSPACE_ROOT;
    process.env.YOPLAI_DEV = "1";
    process.env.YOPLAI_WORKSPACE_ROOT = "/repo";
    const calls: Array<{ file: string; args: string[] }> = [];
    const execFile = ((
      file: string,
      args: string[],
      callback: (error: Error | null) => void
    ) => {
      calls.push({ file, args });
      callback(null);
    }) as typeof import("node:child_process").execFile;

    try {
      await runNotify({ channel: "ops", message: "ready" }, execFile);
      expect(calls).toEqual([
        {
          file: "pnpm",
          args: [
            "--dir",
            "/repo",
            "yoplai:dev",
            "notify",
            "--channel",
            "ops",
            "--message",
            "ready",
          ],
        },
      ]);
    } finally {
      if (oldDev === undefined) delete process.env.YOPLAI_DEV;
      else process.env.YOPLAI_DEV = oldDev;
      if (oldRoot === undefined) delete process.env.YOPLAI_WORKSPACE_ROOT;
      else process.env.YOPLAI_WORKSPACE_ROOT = oldRoot;
    }
  });
});

describe("orchestrator HITL channel config", () => {
  it("disables HITL notifications when no channel is configured", () => {
    expect(resolveHitlNotifyChannel(config, undefined)).toBeUndefined();
  });

  it("requires an explicitly configured HITL channel to exist", () => {
    expect(() => resolveHitlNotifyChannel(config, "ops")).toThrow(
      "not configured"
    );
    expect(
      resolveHitlNotifyChannel(
        { ...config, notifications: { channels: { ops: { discord: "123" } } } },
        "ops"
      )
    ).toBe("ops");
  });
});
