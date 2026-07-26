import { describe, expect, it, vi } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import {
  interruptCancelledOrchestratorRuns,
  normalizeShapingMoveTarget,
  updateProjectLifecycle,
} from "./update-project-lifecycle.js";

describe("updateProjectLifecycle", () => {
  it("rejects legacy run fields", async () => {
    const result = await updateProjectLifecycle(
      { agents: [] } as unknown as GatewayConfig,
      "PRO-1",
      { runAgent: "cli:codex" }
    );

    expect(result).toEqual({
      ok: false,
      error: "runAgent/runMode/baseBranch not supported on projects",
      status: 400,
    });
  });
});

describe("normalizeShapingMoveTarget", () => {
  it("rewrites bare shaping to the first manifest key", () => {
    expect(normalizeShapingMoveTarget("shaping", ["shaping:repo"])).toBe(
      "shaping:repo"
    );
  });

  it("preserves manifest insertion order when picking the first key", () => {
    expect(
      normalizeShapingMoveTarget("shaping", ["shaping:drill", "shaping:slice"])
    ).toBe("shaping:drill");
  });

  it("leaves bare shaping unchanged when no manifest keys are configured", () => {
    expect(normalizeShapingMoveTarget("shaping", [])).toBe("shaping");
  });

  it("does not rewrite an explicit manifest key", () => {
    expect(
      normalizeShapingMoveTarget("shaping:slice", [
        "shaping:repo",
        "shaping:slice",
      ])
    ).toBe("shaping:slice");
  });

  it("does not rewrite non-shaping statuses", () => {
    expect(normalizeShapingMoveTarget("active", ["shaping:repo"])).toBe(
      "active"
    );
  });
});

describe("interruptCancelledOrchestratorRuns", () => {
  it("interrupts only running orchestrator runs matching cascaded slice ids", async () => {
    const config = { agents: [] } as unknown as GatewayConfig;
    const listSubagentsFn = vi.fn(async () => ({
      ok: true as const,
      data: {
        items: [
          { slug: "match", source: "orchestrator", status: "running", sliceId: "S-1" },
          { slug: "manual", source: "manual", status: "running", sliceId: "S-1" },
          { slug: "idle", source: "orchestrator", status: "idle", sliceId: "S-1" },
          { slug: "other-slice", source: "orchestrator", status: "running", sliceId: "S-2" },
        ],
      },
    }));
    const interruptSubagentFn = vi.fn(async () => ({ ok: true as const }));

    await interruptCancelledOrchestratorRuns(config, "PRO-1", ["S-1"], {
      listSubagentsFn,
      interruptSubagentFn,
    });

    expect(interruptSubagentFn).toHaveBeenCalledTimes(1);
    expect(interruptSubagentFn).toHaveBeenCalledWith(config, "PRO-1", "match");
  });
});
