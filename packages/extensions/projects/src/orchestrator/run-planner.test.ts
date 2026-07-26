import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import type { ProjectListItem } from "../projects/store.js";
import type { SliceRecord } from "../projects/slices.js";
import type { SubagentListItem } from "../subagents/index.js";
import type { OrchestratorConfig } from "./config.js";
import {
  OrchestratorRunPlanner,
  recentWorkerBranch,
  recentWorkerWorkspaces,
  slugForStatus,
} from "./run-planner.js";

const config = {
  agents: [],
  extensions: {
    subagents: {
      profiles: [
        { name: "Worker", cli: "codex", runMode: "clone", type: "worker" },
        { name: "Reviewer", cli: "codex", runMode: "none", type: "reviewer" },
        { name: "Merger", cli: "codex", runMode: "worktree", type: "merger" },
      ],
    },
  },
} as GatewayConfig;

const orchestratorConfig: OrchestratorConfig = {
  enabled: true,
  poll_interval_ms: 30_000,
  failure_cooldown_ms: 60_000,
  stall_threshold_ms: 30 * 60_000,
  statuses: {
    todo: { profile: "Worker" },
    review: { profile: "Reviewer" },
    ready_to_merge: { profile: "Merger" },
  },
};

const project: ProjectListItem = {
  id: "PRO-1",
  title: "Project",
  path: "PRO-1",
  absolutePath: "/tmp/projects/PRO-1",
  repoValid: true,
  frontmatter: { status: "active", repo: "/tmp/repo" },
};

const slice: SliceRecord = {
  id: "PRO-1-S01",
  projectId: "PRO-1",
  dirPath: "/tmp/projects/PRO-1/slices/PRO-1-S01",
  frontmatter: {
    id: "PRO-1-S01",
    project_id: "PRO-1",
    title: "Slice",
    status: "todo",
    hill_position: "figuring",
    created_at: "2026-05-03T00:00:00Z",
    updated_at: "2026-05-03T00:00:00Z",
  },
  docs: { readme: "", specs: "", tasks: "", validation: "", thread: "" },
};

function run(extra: Partial<SubagentListItem> = {}): SubagentListItem {
  return {
    slug: "pro-1-s01-worker",
    status: "idle",
    source: "orchestrator",
    name: "Worker",
    cli: "codex",
    sliceId: "PRO-1-S01",
    startedAt: "2026-05-03T00:00:00Z",
    ...extra,
  };
}

describe("OrchestratorRunPlanner", () => {
  it("generates merger-specific slugs", () => {
    expect(
      slugForStatus(
        "ready_to_merge",
        "PRO-1-S01",
        new Date("2026-05-03T00:00:00Z"),
        1
      )
    ).toMatch(/^pro-1-s01-merger-[a-z0-9]+-2$/);
  });

  it("builds Worker spawn input with integration base branch", async () => {
    const planner = new OrchestratorRunPlanner(config, orchestratorConfig, {
      ensureProjectIntegrationBranch: async (repo, projectId) =>
        `${repo}:${projectId}/integration`,
    });
    const profile = planner.resolveProfile("Worker");

    const input = await planner.buildWorkerSpawnInput(
      { project, slice },
      profile!,
      "pro-1-s01-worker"
    );

    expect(input).toMatchObject({
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
      slug: "pro-1-s01-worker",
      cli: "codex",
      mode: "clone",
      baseBranch: "/tmp/repo:PRO-1/integration",
      source: "orchestrator",
    });
    expect(input.prompt).toContain("PRO-1-S01");
  });

  it("selects the latest existing Worker workspace for review", async () => {
    const workspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-worker-")
    );
    const missing = path.join(os.tmpdir(), "yoplai-missing-worker");

    const workspaces = await recentWorkerWorkspaces(
      config,
      orchestratorConfig,
      [
        run({
          slug: "missing",
          worktreePath: missing,
          startedAt: "2026-05-04T00:00:00Z",
        }),
        run({
          slug: "existing",
          worktreePath: workspace,
          startedAt: "2026-05-03T00:00:00Z",
        }),
      ],
      "PRO-1-S01"
    );

    expect(workspaces).toEqual([
      { name: "Worker", cli: "codex", path: workspace },
    ]);
  });

  it("uses the latest Worker slug as merger branch", () => {
    expect(
      recentWorkerBranch(
        config,
        orchestratorConfig,
        [
          run({ slug: "older", startedAt: "2026-05-03T00:00:00Z" }),
          run({ slug: "newer", startedAt: "2026-05-04T00:00:00Z" }),
        ],
        "PRO-1",
        "PRO-1-S01"
      )
    ).toBe("PRO-1/newer");
  });
});
