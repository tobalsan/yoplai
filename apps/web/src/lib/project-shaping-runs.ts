import type { SubagentRun } from "@yoplai/shared/types";

export type ProjectRunPillState = "running" | "stalled" | "error" | "hidden";

const DEFAULT_STALL_THRESHOLD_MS = 30 * 60 * 1000;

export function isProjectShapingRun(run: SubagentRun, projectId: string): boolean {
  return run.projectId === projectId && !run.sliceId;
}

export function sortProjectShapingRuns(a: SubagentRun, b: SubagentRun): number {
  const aLive = a.status === "running" || a.status === "starting";
  const bLive = b.status === "running" || b.status === "starting";
  if (aLive !== bLive) return aLive ? -1 : 1;
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

export function getProjectRunPillState(
  runs: SubagentRun[],
  stallThresholdMs = DEFAULT_STALL_THRESHOLD_MS,
  now = Date.now()
): ProjectRunPillState {
  const sorted = [...runs].sort(sortProjectShapingRuns);
  const mostRecent = sorted[0];
  if (mostRecent?.status === "error") return "error";

  const liveRuns = sorted.filter(
    (run) => run.status === "running" || run.status === "starting"
  );
  if (liveRuns.length === 0) return "hidden";

  const stalled = liveRuns.some((run) => {
    const started = Date.parse(run.startedAt);
    return Number.isFinite(started) && now - started > stallThresholdMs;
  });
  return stalled ? "stalled" : "running";
}

export function projectRunPillClass(state: ProjectRunPillState): string {
  return `project-run-pill project-run-pill--${state}`;
}

export function projectRunPillLabel(state: ProjectRunPillState): string {
  switch (state) {
    case "running":
      return "Running";
    case "stalled":
      return "Stalled";
    case "error":
      return "Error";
    case "hidden":
      return "";
  }
}

export function formatRunElapsed(run: SubagentRun, now = Date.now()): string {
  const start = Date.parse(run.startedAt);
  if (!Number.isFinite(start)) return "unknown";
  const end = run.finishedAt ? Date.parse(run.finishedAt) : now;
  const diff = Math.max(0, (Number.isFinite(end) ? end : now) - start);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
