import {
  type GatewayConfig,
  type ProjectsOrchestratorShapingStatusConfig,
  type ProjectsOrchestratorStatusConfig,
  type SubagentRuntimeProfile,
} from "@yoplai/shared";
import { resolveProfile } from "../profiles/resolver.js";
import type { ProjectListItem } from "../projects/store.js";
import type { SliceRecord, SliceStatus } from "../projects/slices.js";
import type { SubagentListItem } from "../subagents/index.js";
import type { OrchestratorConfig } from "./config.js";
import type {
  OrchestratorAttemptTracker,
  OrchestratorDispatchKind,
  SliceDispatchItem,
} from "./dispatcher.js";

export const WORKER_SLICE_STATUS = "todo";
export const REVIEWER_SLICE_STATUS = "review";
export const MERGER_SLICE_STATUS = "ready_to_merge";
export const STALL_SLICE_STATUSES = new Set<SliceStatus>([
  "in_progress",
  "review",
]);

const TERMINAL_BLOCKER_STATUSES = new Set<SliceStatus>([
  "done",
  "ready_to_merge",
  "cancelled",
]);

export function sourceOf(run: SubagentListItem): string {
  return run.source ?? "manual";
}

export function projectStatus(project: ProjectListItem): string {
  return typeof project.frontmatter.status === "string"
    ? project.frontmatter.status
    : "";
}

export function blockedBy(slice: SliceRecord): string[] {
  const value = slice.frontmatter.blocked_by;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function pendingBlockers(
  slice: SliceRecord,
  sliceStatusIndex: Map<string, SliceStatus>
): string[] {
  return blockedBy(slice).filter((blockerId) => {
    const status = sliceStatusIndex.get(blockerId);
    return !status || !TERMINAL_BLOCKER_STATUSES.has(status);
  });
}

export function isActiveOrchestratorRun(
  run: SubagentListItem,
  sliceId?: string,
  fallbackCwds: string[] = []
): boolean {
  if (sourceOf(run) !== "orchestrator" || run.status !== "running") {
    return false;
  }
  if (!sliceId) return true;
  if (run.sliceId) return run.sliceId === sliceId;
  if (!run.worktreePath) return false;
  const worktreePath = run.worktreePath;
  return fallbackCwds.some(
    (fallback) =>
      worktreePath === fallback || worktreePath.startsWith(`${fallback}/`)
  );
}

export function isLiveSliceRun(
  run: SubagentListItem,
  sliceId: string,
  fallbackCwds: string[] = []
): boolean {
  if (run.status !== "running") return false;
  if (run.sliceId) return run.sliceId === sliceId;
  const worktreePath = run.worktreePath;
  if (!worktreePath) return false;
  return fallbackCwds.some(
    (fallback) =>
      worktreePath === fallback || worktreePath.startsWith(`${fallback}/`)
  );
}

export function statusConfigFor(
  orchestratorConfig: OrchestratorConfig,
  statusKey: string
): ProjectsOrchestratorStatusConfig | undefined {
  const value = (orchestratorConfig.statuses as Record<string, unknown>)[
    statusKey
  ];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ProjectsOrchestratorStatusConfig>;
  if (typeof candidate.profile !== "string") return undefined;
  return {
    profile: candidate.profile,
    max_concurrent:
      typeof candidate.max_concurrent === "number"
        ? candidate.max_concurrent
        : defaultMaxConcurrentForStatus(statusKey),
  };
}

export function defaultMaxConcurrentForStatus(statusKey: string): number {
  return statusKey === MERGER_SLICE_STATUS ? 2 : 1;
}

export function configuredStatusKeys(
  orchestratorConfig: OrchestratorConfig
): string[] {
  return Object.keys(orchestratorConfig.statuses).filter((key) =>
    Boolean(statusConfigFor(orchestratorConfig, key))
  );
}

export function shapingStatusConfigFor(
  orchestratorConfig: OrchestratorConfig,
  statusKey: string
): ProjectsOrchestratorShapingStatusConfig | undefined {
  const value = ((orchestratorConfig.shaping_statuses ?? {}) as Record<string, unknown>)[
    statusKey
  ];
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ProjectsOrchestratorShapingStatusConfig>;
  if (typeof candidate.profile !== "string") return undefined;
  return {
    profile: candidate.profile,
    max_concurrent:
      typeof candidate.max_concurrent === "number" ? candidate.max_concurrent : 1,
    stall_threshold_ms:
      typeof candidate.stall_threshold_ms === "number"
        ? candidate.stall_threshold_ms
        : undefined,
  };
}

export function configuredShapingStatusKeys(
  orchestratorConfig: OrchestratorConfig
): string[] {
  return Object.keys(orchestratorConfig.shaping_statuses ?? {}).filter((key) =>
    Boolean(shapingStatusConfigFor(orchestratorConfig, key))
  );
}

export function dispatchKindForStatus(
  statusKey: string
): OrchestratorDispatchKind | undefined {
  if (statusKey === WORKER_SLICE_STATUS) return "worker";
  if (statusKey === REVIEWER_SLICE_STATUS) return "reviewer";
  return undefined;
}

function profileForRun(
  config: GatewayConfig,
  run: SubagentListItem
): SubagentRuntimeProfile | undefined {
  if (!run.name) return undefined;
  return resolveProfile(config, run.name);
}

export function isWorkerRun(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  run: SubagentListItem
): boolean {
  const profile = profileForRun(config, run);
  if (profile?.type?.toLowerCase() === "worker") return true;
  return Boolean(
    run.name &&
      run.name ===
        statusConfigFor(orchestratorConfig, WORKER_SLICE_STATUS)?.profile
  );
}

export function isReviewerRun(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  run: SubagentListItem
): boolean {
  const profile = profileForRun(config, run);
  if (profile?.type?.toLowerCase() === "reviewer") return true;
  return Boolean(
    run.name &&
      run.name ===
        statusConfigFor(orchestratorConfig, REVIEWER_SLICE_STATUS)?.profile
  );
}

export function isMergerRun(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  run: SubagentListItem
): boolean {
  const profile = profileForRun(config, run);
  if (profile?.type?.toLowerCase() === "merger") return true;
  return Boolean(
    run.name &&
      run.name ===
        statusConfigFor(orchestratorConfig, MERGER_SLICE_STATUS)?.profile
  );
}

export function isShaperRun(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  run: SubagentListItem
): boolean {
  const profile = profileForRun(config, run);
  if (profile?.type?.toLowerCase() === "shaper") return true;
  return configuredShapingStatusKeys(orchestratorConfig).some(
    (statusKey) => run.name === shapingStatusConfigFor(orchestratorConfig, statusKey)?.profile
  );
}

export function isActiveRunForStatus(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  statusKey: string,
  run: SubagentListItem,
  sliceId: string,
  fallbackCwds: string[]
): boolean {
  if (!isActiveOrchestratorRun(run, sliceId, fallbackCwds)) return false;
  if (statusKey === WORKER_SLICE_STATUS) {
    return !run.name || isWorkerRun(config, orchestratorConfig, run);
  }
  if (statusKey === REVIEWER_SLICE_STATUS) {
    return !run.name || isReviewerRun(config, orchestratorConfig, run);
  }
  return true;
}

export function expectedStatusForRun(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  run: SubagentListItem
): SliceStatus | undefined {
  const profile = profileForRun(config, run);
  const profileType = profile?.type?.toLowerCase();
  if (profileType === "worker") return "in_progress";
  if (profileType === "reviewer") return "review";
  if (profileType === "merger") return "ready_to_merge";

  for (const statusKey of configuredStatusKeys(orchestratorConfig)) {
    const statusConfig = statusConfigFor(orchestratorConfig, statusKey);
    if (run.name !== statusConfig?.profile) continue;
    if (statusKey === WORKER_SLICE_STATUS) return "in_progress";
    if (
      statusKey === "review" ||
      statusKey === "ready_to_merge" ||
      statusKey === "done" ||
      statusKey === "cancelled"
    ) {
      return statusKey;
    }
  }

  return undefined;
}

export type DispatchPolicyInput = {
  config: GatewayConfig;
  orchestratorConfig: OrchestratorConfig;
};

export type SliceEligibilityInput = {
  item: SliceDispatchItem & { runs: SubagentListItem[] };
  statusKey: string;
  globalSliceStatusIndex: Map<string, SliceStatus>;
  activeRuns: SubagentListItem[];
  nowMs: number;
  attempts?: OrchestratorAttemptTracker;
  hasMergerConflict?: boolean;
};

export type SliceEligibility =
  | { eligible: true }
  | { eligible: false; reason: string; pending?: string[] };

export class SliceDispatchPolicy {
  constructor(private readonly input: DispatchPolicyInput) {}

  statusConfig(
    statusKey: string
  ): ProjectsOrchestratorStatusConfig | undefined {
    return statusConfigFor(this.input.orchestratorConfig, statusKey);
  }

  configuredStatusKeys(): string[] {
    return configuredStatusKeys(this.input.orchestratorConfig);
  }

  isSupportedStatus(statusKey: string): boolean {
    return (
      statusKey === WORKER_SLICE_STATUS ||
      statusKey === REVIEWER_SLICE_STATUS ||
      statusKey === MERGER_SLICE_STATUS
    );
  }

  activeRunsForStatus(
    statusKey: string,
    item: SliceDispatchItem & { runs: SubagentListItem[] },
    fallbackCwds: string[]
  ): SubagentListItem[] {
    return item.runs.filter((run) => {
      if (
        !isActiveRunForStatus(
          this.input.config,
          this.input.orchestratorConfig,
          statusKey,
          run,
          item.slice.id,
          fallbackCwds
        )
      ) {
        return false;
      }
      if (statusKey === MERGER_SLICE_STATUS) {
        return isMergerRun(
          this.input.config,
          this.input.orchestratorConfig,
          run
        );
      }
      return true;
    });
  }

  availableSlots(statusKey: string, running: number): number {
    const statusConfig = this.statusConfig(statusKey);
    if (!statusConfig) return 0;
    return Math.max(0, statusConfig.max_concurrent - running);
  }

  shouldDispatchSlice(input: SliceEligibilityInput): SliceEligibility {
    if (input.activeRuns.length > 0) {
      return { eligible: false, reason: "active_run" };
    }
    if (input.statusKey === MERGER_SLICE_STATUS && input.hasMergerConflict) {
      return { eligible: false, reason: "merger_conflict_parked" };
    }
    const pending = pendingBlockers(
      input.item.slice,
      input.globalSliceStatusIndex
    );
    if (pending.length > 0) {
      return { eligible: false, reason: "blocked_by_pending", pending };
    }
    const dispatchKind = dispatchKindForStatus(input.statusKey);
    if (
      dispatchKind &&
      input.attempts?.isCoolingDown(
        input.item.slice.id,
        dispatchKind,
        input.nowMs
      )
    ) {
      return { eligible: false, reason: "failure_cooldown" };
    }
    return { eligible: true };
  }
}
