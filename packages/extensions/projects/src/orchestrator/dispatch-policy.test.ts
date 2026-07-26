import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import type { ProjectListItem } from "../projects/store.js";
import type { SliceRecord } from "../projects/slices.js";
import type { SubagentListItem } from "../subagents/index.js";
import type { OrchestratorConfig } from "./config.js";
import {
  MERGER_SLICE_STATUS,
  SliceDispatchPolicy,
  isActiveOrchestratorRun,
} from "./dispatch-policy.js";

const config = {
  agents: [],
  extensions: {
    subagents: {
      profiles: [
        { name: "Worker", cli: "codex", type: "worker" },
        { name: "Merger", cli: "codex", type: "merger" },
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
    todo: { profile: "Worker", max_concurrent: 2 },
    ready_to_merge: { profile: "Merger" },
  },
};

function project(id: string): ProjectListItem {
  return {
    id,
    title: id,
    path: id,
    absolutePath: `/tmp/projects/${id}`,
    repoValid: true,
    frontmatter: { status: "active", repo: "/tmp/repo" },
  };
}

function slice(extra: Partial<SliceRecord["frontmatter"]> = {}): SliceRecord {
  return {
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
      ...extra,
    },
    docs: { readme: "", specs: "", tasks: "", validation: "", thread: "" },
  };
}

function run(extra: Partial<SubagentListItem> = {}): SubagentListItem {
  return {
    slug: "worker-run",
    status: "running",
    source: "orchestrator",
    name: "Worker",
    sliceId: "PRO-1-S01",
    ...extra,
  };
}

describe("SliceDispatchPolicy", () => {
  it("defaults merger concurrency to two when omitted", () => {
    const policy = new SliceDispatchPolicy({ config, orchestratorConfig });

    expect(policy.statusConfig(MERGER_SLICE_STATUS)?.max_concurrent).toBe(2);
    expect(policy.availableSlots(MERGER_SLICE_STATUS, 1)).toBe(1);
  });

  it("counts active orchestrator runs for the matching slice/status", () => {
    const policy = new SliceDispatchPolicy({ config, orchestratorConfig });
    const active = policy.activeRunsForStatus(
      "todo",
      {
        project: project("PRO-1"),
        slice: slice(),
        runs: [
          run(),
          run({ slug: "manual", source: "manual" }),
          run({ slug: "other", sliceId: "PRO-1-S02" }),
        ],
      },
      []
    );

    expect(active.map((item) => item.slug)).toEqual(["worker-run"]);
  });

  it("blocks slices until every blocker is terminal", () => {
    const policy = new SliceDispatchPolicy({ config, orchestratorConfig });
    const decision = policy.shouldDispatchSlice({
      item: {
        project: project("PRO-1"),
        slice: slice({ blocked_by: ["PRO-1-S00", "PRO-1-S99"] }),
        runs: [],
      },
      statusKey: "todo",
      globalSliceStatusIndex: new Map([
        ["PRO-1-S00", "done"],
        ["PRO-1-S99", "review"],
      ]),
      activeRuns: [],
      nowMs: 0,
    });

    expect(decision).toEqual({
      eligible: false,
      reason: "blocked_by_pending",
      pending: ["PRO-1-S99"],
    });
  });

  it("parks merger slices with current conflict metadata", () => {
    const policy = new SliceDispatchPolicy({ config, orchestratorConfig });

    expect(
      policy.shouldDispatchSlice({
        item: {
          project: project("PRO-1"),
          slice: slice({ status: "ready_to_merge" }),
          runs: [],
        },
        statusKey: MERGER_SLICE_STATUS,
        globalSliceStatusIndex: new Map(),
        activeRuns: [],
        nowMs: 0,
        hasMergerConflict: true,
      })
    ).toEqual({ eligible: false, reason: "merger_conflict_parked" });
  });

  it("still exports active run matching for dispatcher callers", () => {
    expect(isActiveOrchestratorRun(run(), "PRO-1-S01")).toBe(true);
    expect(isActiveOrchestratorRun(run({ source: "manual" }), "PRO-1-S01")).toBe(
      false
    );
  });
});
