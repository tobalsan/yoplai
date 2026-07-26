import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { expandPath, readEnv, type GatewayConfig } from "@yoplai/shared";
import {
  appendProjectComment,
  listProjects,
  updateProject,
  type ProjectListItem,
} from "../projects/store.js";
import { ensureProjectIntegrationBranch } from "../projects/branches.js";
import {
  listSlices,
  updateSlice,
  type SliceRecord,
  type SliceStatus,
} from "../projects/slices.js";
import { listSubagents, type SubagentListItem } from "../subagents/index.js";
import {
  interruptSubagent,
  spawnSubagent,
  type SpawnSubagentResult,
} from "../subagents/runner.js";
import type { OrchestratorConfig } from "./config.js";
import type { HitlEvent } from "./hitl.js";
import {
  MERGER_SLICE_STATUS,
  REVIEWER_SLICE_STATUS,
  STALL_SLICE_STATUSES,
  SliceDispatchPolicy,
  WORKER_SLICE_STATUS,
  configuredShapingStatusKeys,
  configuredStatusKeys,
  dispatchKindForStatus,
  expectedStatusForRun,
  isLiveSliceRun,
  isMergerRun,
  isReviewerRun,
  isShaperRun,
  projectStatus,
  shapingStatusConfigFor,
  sourceOf,
} from "./dispatch-policy.js";
import {
  OrchestratorRunPlanner,
  fallbackCwdsForProject,
  hasLiveWorkerRun,
  pathExists,
  workerWorkspaceRuns,
} from "./run-planner.js";

export { isActiveOrchestratorRun } from "./dispatch-policy.js";
export { resolveCli } from "./prompt-factory.js";

const execFileAsync = promisify(execFile);
type ExecFileFn = typeof execFile;

type Logger = (message: string) => void;

export type OrchestratorDispatchKind = "worker" | "reviewer" | "merger";

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export type OrchestratorAttemptTracker = {
  recordFailure(
    sliceId: string,
    kind: OrchestratorDispatchKind,
    atMs: number
  ): void;
  recordSuccess(sliceId: string, kind: OrchestratorDispatchKind): void;
  isCoolingDown(
    sliceId: string,
    kind: OrchestratorDispatchKind,
    nowMs: number
  ): boolean;
  clear(): void;
};

export function createOrchestratorAttemptTracker(): OrchestratorAttemptTracker {
  const backoffs = new Map<
    string,
    { nextAttempt: number; failureCount: number }
  >();

  const key = (sliceId: string, kind: OrchestratorDispatchKind): string =>
    `${sliceId}:${kind}`;

  return {
    recordFailure(sliceId, kind, atMs): void {
      const attemptKey = key(sliceId, kind);
      const previous = backoffs.get(attemptKey);
      const failureCount = (previous?.failureCount ?? 0) + 1;
      const delay = Math.min(
        BACKOFF_BASE_MS * 2 ** (failureCount - 1),
        BACKOFF_MAX_MS
      );
      backoffs.set(attemptKey, {
        failureCount,
        nextAttempt: atMs + delay,
      });
    },
    recordSuccess(sliceId, kind): void {
      backoffs.delete(key(sliceId, kind));
    },
    isCoolingDown(sliceId, kind, nowMs): boolean {
      const entry = backoffs.get(key(sliceId, kind));
      return entry !== undefined && nowMs < entry.nextAttempt;
    },
    clear(): void {
      backoffs.clear();
    },
  };
}

export type OrchestratorStallTracker = {
  recordStatus(sliceId: string, status: SliceStatus): boolean;
  isReported(sliceId: string, status: SliceStatus, runKey: string): boolean;
  markReported(sliceId: string, status: SliceStatus, runKey: string): void;
  clear(): void;
};

export type OrchestratorDispatcherDeps = {
  listProjects?: typeof listProjects;
  listSlices?: typeof listSlices;
  listSubagents?: typeof listSubagents;
  spawnSubagent?: typeof spawnSubagent;
  ensureProjectIntegrationBranch?: typeof ensureProjectIntegrationBranch;
  interruptSubagent?: typeof interruptSubagent;
  updateSlice?: typeof updateSlice;
  updateProject?: typeof updateProject;
  appendProjectComment?: typeof appendProjectComment;
  now?: () => Date;
  log?: Logger;
  hitl?: { add(event: HitlEvent): void };
  attempts?: OrchestratorAttemptTracker;
  stalls?: OrchestratorStallTracker;
  removeOrphanDir?: (dirPath: string) => Promise<void>;
  countIntegrationAhead?: (
    repoPath: string,
    projectId: string
  ) => Promise<number>;
  notify?: (input: { channel: string; message: string }) => Promise<void>;
  lastDonePingDates?: Map<string, string>;
};

async function defaultRemoveOrphanDir(dirPath: string): Promise<void> {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; do not let it crash the tick
  }
}

export type DispatchDecision = {
  projectId: string;
  sliceId?: string;
  action: "spawned" | "skipped";
  reason?: string;
  slug?: string;
};

export type DispatchResult = {
  running: number;
  availableSlots: number;
  eligible: number;
  decisions: DispatchDecision[];
};

export type ReconcileDecision = {
  projectId: string;
  sliceId: string;
  slug: string;
  action: "interrupted" | "skipped";
  reason?: string;
};

export type ReconcileResult = {
  inspected: number;
  interrupted: number;
  decisions: ReconcileDecision[];
};

const ORCHESTRATOR_STALL_AUTHOR = "Orchestrator";

const defaultLastDonePingDates = new Map<string, string>();

type MergerConflictState = {
  summary: string;
  dedupeKey: string;
};

/** A slice paired with its resolved parent project info. */
export type SliceDispatchItem = {
  slice: SliceRecord;
  project: ProjectListItem;
};

function keyValueLog(
  log: Logger,
  data: Record<string, string | number | string[]>
): void {
  log(
    Object.entries(data)
      .map(
        ([key, value]) =>
          `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`
      )
      .join(" ")
  );
}

async function runGitInRepo(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args]);
  return stdout.trim();
}

async function defaultCountIntegrationAhead(
  repoPath: string,
  projectId: string
): Promise<number> {
  const branch = `${projectId}/integration`;
  try {
    await runGitInRepo(repoPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${branch}`,
    ]);
  } catch {
    return 0;
  }

  const rawCount = await runGitInRepo(repoPath, [
    "rev-list",
    "--count",
    `main..${branch}`,
  ]);
  const count = Number(rawCount);
  return Number.isFinite(count) ? count : 0;
}

export function resolveNotifyCommand(input: {
  channel: string;
  message: string;
}): { file: string; args: string[] } {
  if (readEnv("YOPLAI_DEV")) {
    const root = readEnv("YOPLAI_WORKSPACE_ROOT") ?? process.cwd();
    return {
      file: "pnpm",
      args: [
        "--dir",
        root,
        "yoplai:dev",
        "notify",
        "--channel",
        input.channel,
        "--message",
        input.message,
      ],
    };
  }

  return {
    file: "yoplai",
    args: ["notify", "--channel", input.channel, "--message", input.message],
  };
}

export async function runNotify(
  input: {
    channel: string;
    message: string;
  },
  execFileImpl: ExecFileFn = execFile
): Promise<void> {
  const command = resolveNotifyCommand(input);
  const execFileWithImpl = promisify(execFileImpl);
  await execFileWithImpl(command.file, command.args);
}

async function defaultNotify(input: {
  channel: string;
  message: string;
}): Promise<void> {
  await runNotify(input);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildDonePingMessage(
  project: ProjectListItem,
  doneSlices: SliceRecord[]
): string {
  const sliceList =
    doneSlices.length > 0
      ? doneSlices.map((slice) => slice.id).join(", ")
      : "(no done slices found)";
  return `${project.id} has ${doneSlices.length} slices \`done\` on integration, ready for main merge: ${sliceList}`;
}

async function pingDoneOnIntegration(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  deps: OrchestratorDispatcherDeps
): Promise<void> {
  const channel = orchestratorConfig.notify_channel?.trim();
  if (!channel) return;

  const projectResult = await (deps.listProjects ?? listProjects)(config);
  if (!projectResult.ok) return;

  const now = (deps.now ?? (() => new Date()))();
  const today = dayKey(now);
  const lastPingDates = deps.lastDonePingDates ?? defaultLastDonePingDates;
  const countAhead = deps.countIntegrationAhead ?? defaultCountIntegrationAhead;
  const notify = deps.notify ?? defaultNotify;
  const log = deps.log ?? console.log;

  for (const project of projectResult.data) {
    const repo =
      typeof project.frontmatter.repo === "string"
        ? project.frontmatter.repo.trim()
        : "";
    if (!repo) continue;

    let aheadCount = 0;
    try {
      aheadCount = await countAhead(expandPath(repo), project.id);
    } catch (error) {
      keyValueLog(log, {
        component: "orchestrator",
        action: "done_ping_failed",
        project: project.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (aheadCount <= 0) {
      lastPingDates.delete(project.id);
      continue;
    }
    if (lastPingDates.get(project.id) === today) continue;

    const slices = await (deps.listSlices ?? listSlices)(project.absolutePath);
    const doneSlices = slices.filter(
      (slice) => slice.frontmatter.status === "done"
    );
    if (doneSlices.length === 0) continue;

    const message = buildDonePingMessage(project, doneSlices);
    try {
      await notify({ channel, message });
      lastPingDates.set(project.id, today);
      keyValueLog(log, {
        component: "orchestrator",
        action: "done_ping_sent",
        project: project.id,
        done_slices: doneSlices.map((slice) => slice.id),
        ahead_commits: aheadCount,
      });
    } catch (error) {
      keyValueLog(log, {
        component: "orchestrator",
        action: "done_ping_failed",
        project: project.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createStallTracker(): OrchestratorStallTracker {
  const lastStatus = new Map<string, SliceStatus>();
  const reported = new Set<string>();
  return {
    recordStatus(sliceId: string, status: SliceStatus): boolean {
      const previous = lastStatus.get(sliceId);
      if (previous !== undefined && previous !== status) {
        for (const key of reported) {
          if (key.startsWith(`${sliceId}:`)) reported.delete(key);
        }
      }
      lastStatus.set(sliceId, status);
      return previous !== status;
    },
    isReported(sliceId: string, status: SliceStatus, runKey: string): boolean {
      return reported.has(`${sliceId}:${status}:${runKey}`);
    },
    markReported(sliceId: string, status: SliceStatus, runKey: string): void {
      reported.add(`${sliceId}:${status}:${runKey}`);
    },
    clear(): void {
      lastStatus.clear();
      reported.clear();
    },
  };
}

async function buildGlobalSliceStatusIndex(
  config: GatewayConfig,
  deps: OrchestratorDispatcherDeps
): Promise<Map<string, SliceStatus>> {
  const index = new Map<string, SliceStatus>();
  const projectResult = await (deps.listProjects ?? listProjects)(config);
  if (!projectResult.ok) return index;

  await Promise.all(
    projectResult.data.map(async (project) => {
      const slices = await (deps.listSlices ?? listSlices)(
        project.absolutePath
      );
      for (const slice of slices) {
        index.set(slice.id, slice.frontmatter.status);
      }
    })
  );

  return index;
}

export async function reconcileLiveRuns(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  deps: OrchestratorDispatcherDeps = {}
): Promise<ReconcileResult> {
  const log = deps.log ?? console.log;
  const decisions: ReconcileDecision[] = [];
  const projectResult = await (deps.listProjects ?? listProjects)(config);
  if (!projectResult.ok) {
    keyValueLog(log, {
      component: "orchestrator",
      action: "reconcile_failed",
      reason: "list_projects_failed",
    });
    return { inspected: 0, interrupted: 0, decisions };
  }

  for (const project of projectResult.data) {
    const slices = await (deps.listSlices ?? listSlices)(project.absolutePath);
    const sliceStatuses = new Map(
      slices.map((slice) => [slice.id, slice.frontmatter.status])
    );
    const runsResult = await (deps.listSubagents ?? listSubagents)(
      config,
      project.id
    );
    if (!runsResult.ok) {
      keyValueLog(log, {
        component: "orchestrator",
        action: "reconcile_failed",
        project: project.id,
        reason: "list_subagents_failed",
      });
      continue;
    }

    for (const run of runsResult.data.items) {
      if (
        sourceOf(run) !== "orchestrator" ||
        run.status !== "running" ||
        !run.sliceId
      ) {
        continue;
      }

      const expectedStatus = expectedStatusForRun(
        config,
        orchestratorConfig,
        run
      );
      if (!expectedStatus) {
        decisions.push({
          projectId: project.id,
          sliceId: run.sliceId,
          slug: run.slug,
          action: "skipped",
          reason: "unknown_expected_status",
        });
        continue;
      }

      const actualStatus = sliceStatuses.get(run.sliceId);
      if (actualStatus === expectedStatus) {
        decisions.push({
          projectId: project.id,
          sliceId: run.sliceId,
          slug: run.slug,
          action: "skipped",
          reason: "status_matches",
        });
        continue;
      }

      const result = await (deps.interruptSubagent ?? interruptSubagent)(
        config,
        project.id,
        run.slug
      );
      if (result.ok) {
        decisions.push({
          projectId: project.id,
          sliceId: run.sliceId,
          slug: run.slug,
          action: "interrupted",
          reason: actualStatus ? "status_mismatch" : "slice_missing",
        });
        keyValueLog(log, {
          component: "orchestrator",
          action: "reconcile_interrupt",
          project: project.id,
          slice: run.sliceId,
          slug: run.slug,
          expected_status: expectedStatus,
          actual_status: actualStatus ?? "missing",
        });
      } else {
        decisions.push({
          projectId: project.id,
          sliceId: run.sliceId,
          slug: run.slug,
          action: "skipped",
          reason: "interrupt_failed",
        });
        keyValueLog(log, {
          component: "orchestrator",
          action: "reconcile_interrupt_failed",
          project: project.id,
          slice: run.sliceId,
          slug: run.slug,
          reason: result.error,
        });
      }
    }
  }

  return {
    inspected: decisions.length,
    interrupted: decisions.filter(
      (decision) => decision.action === "interrupted"
    ).length,
    decisions,
  };
}

function runEventTime(run: SubagentListItem): number {
  const parsed = Date.parse(
    run.finishedAt ?? run.lastActive ?? run.startedAt ?? ""
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function runLastActivityAt(run: SubagentListItem): number {
  const parsed = Date.parse(run.lastActive ?? run.startedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function lastRunForSlice(
  runs: SubagentListItem[],
  sliceId: string,
  fallbackCwds: string[]
): SubagentListItem | undefined {
  return runs
    .filter((run) => {
      if (run.sliceId) return run.sliceId === sliceId;
      const worktreePath = run.worktreePath;
      if (!worktreePath) return false;
      return fallbackCwds.some(
        (fallback) =>
          worktreePath === fallback || worktreePath.startsWith(`${fallback}/`)
      );
    })
    .sort((a, b) => runLastActivityAt(b) - runLastActivityAt(a))[0];
}

function lastRunKey(run: SubagentListItem | undefined): string {
  if (!run) return "none";
  return [
    run.slug,
    run.status,
    run.finishedAt ?? run.lastActive ?? run.startedAt ?? "",
    run.lastError ?? "",
  ].join("|");
}

function describeRun(run: SubagentListItem | undefined): string {
  if (!run) return "none";
  const details = [
    run.slug,
    run.status,
    run.lastError ? `error=${run.lastError}` : "",
    run.finishedAt ? `finished=${run.finishedAt}` : "",
  ].filter(Boolean);
  return details.join(" / ");
}

function parseTimeMs(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function sliceUpdatedAt(slice: SliceRecord): number {
  const parsed = Date.parse(slice.frontmatter.updated_at ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function appendThreadComment(
  existing: string,
  body: string,
  now: Date
): string {
  const separator = existing.trim().length > 0 ? "\n\n" : "";
  const entry = [
    `## ${now.toISOString()}`,
    `[author:${ORCHESTRATOR_STALL_AUTHOR}]`,
    `[date:${now.toISOString()}]`,
    "",
    body,
  ].join("\n");
  return `${existing.trimEnd()}${separator}${entry}\n`;
}

async function detectStalls(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  deps: OrchestratorDispatcherDeps
): Promise<void> {
  const thresholdMs = orchestratorConfig.stall_threshold_ms;
  if (thresholdMs <= 0) return;

  const log = deps.log ?? console.log;
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const tracker = deps.stalls;
  if (!tracker) return;

  const projectResult = await (deps.listProjects ?? listProjects)(config);
  if (!projectResult.ok) {
    keyValueLog(log, {
      component: "orchestrator",
      action: "stall_check_failed",
      reason: "list_projects_failed",
    });
    return;
  }

  const activeProjects = projectResult.data.filter(
    (project) => projectStatus(project) === "active"
  );

  await Promise.all(
    activeProjects.map(async (project) => {
      const [slices, runsResult] = await Promise.all([
        (deps.listSlices ?? listSlices)(project.absolutePath),
        (deps.listSubagents ?? listSubagents)(config, project.id),
      ]);
      const runs = runsResult.ok ? runsResult.data.items : [];
      const fallbackCwds = fallbackCwdsForProject(config, project);

      for (const slice of slices) {
        tracker.recordStatus(slice.id, slice.frontmatter.status);
        if (!STALL_SLICE_STATUSES.has(slice.frontmatter.status)) continue;

        const updatedAt = sliceUpdatedAt(slice);
        if (updatedAt === 0 || nowMs - updatedAt < thresholdMs) continue;

        const liveRun = runs.find((run) =>
          isLiveSliceRun(run, slice.id, fallbackCwds)
        );
        if (liveRun) continue;

        const lastRun = lastRunForSlice(runs, slice.id, fallbackCwds);
        const runKey = lastRunKey(lastRun);
        if (tracker.isReported(slice.id, slice.frontmatter.status, runKey)) {
          continue;
        }

        const idleMinutes = Math.floor((nowMs - updatedAt) / 60_000);
        const body = `Stall detected: slice ${slice.id} has been in ${slice.frontmatter.status} for ${idleMinutes}m with no live subagent run. Last run: ${describeRun(lastRun)}.`;
        keyValueLog(log, {
          component: "orchestrator",
          action: "stall_detected",
          project: project.id,
          slice: slice.id,
          status: slice.frontmatter.status,
          idle_minutes: idleMinutes,
          last_run: describeRun(lastRun),
        });

        await (deps.updateSlice ?? updateSlice)(
          project.absolutePath,
          slice.id,
          {
            thread: appendThreadComment(slice.docs.thread, body, now),
          }
        );
        tracker.markReported(slice.id, slice.frontmatter.status, runKey);
        deps.hitl?.add({
          kind: "stall",
          projectId: project.id,
          sliceId: slice.id,
          summary: body,
          link: slice.dirPath,
          dedupeKey: `stall:${slice.id}:${slice.frontmatter.status}:${runKey}`,
        });
      }
    })
  );
}

function emitReviewerFailureHitl(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  items: Array<SliceDispatchItem & { runs: SubagentListItem[] }>,
  deps: OrchestratorDispatcherDeps
): void {
  if (!deps.hitl) return;

  for (const item of items) {
    if (item.slice.frontmatter.status !== WORKER_SLICE_STATUS) continue;
    const latestReviewer = item.runs
      .filter(
        (run) =>
          sourceOf(run) === "orchestrator" &&
          isReviewerRun(config, orchestratorConfig, run) &&
          run.sliceId === item.slice.id &&
          run.status !== "running"
      )
      .sort((a, b) => runEventTime(b) - runEventTime(a))[0];
    if (!latestReviewer) continue;

    deps.hitl.add({
      kind: "reviewer_fail",
      projectId: item.project.id,
      sliceId: item.slice.id,
      summary: "Reviewer returned the slice to todo.",
      link: item.slice.dirPath,
      dedupeKey: `reviewer_fail:${item.slice.id}:${
        latestReviewer.finishedAt ??
        latestReviewer.lastActive ??
        latestReviewer.startedAt ??
        latestReviewer.slug
      }`,
    });
  }
}

function latestMergerRun(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  item: SliceDispatchItem & { runs: SubagentListItem[] }
): SubagentListItem | undefined {
  return item.runs
    .filter(
      (run) =>
        sourceOf(run) === "orchestrator" &&
        run.status !== "running" &&
        isMergerRun(config, orchestratorConfig, run) &&
        run.sliceId === item.slice.id
    )
    .sort((a, b) => runEventTime(b) - runEventTime(a))[0];
}

function frontmatterMergerConflict(
  item: SliceDispatchItem & { runs: SubagentListItem[] },
  latestMerger: SubagentListItem
): MergerConflictState | undefined {
  const metadata = item.slice.frontmatter.merger_conflict;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const data = metadata as Record<string, unknown>;
  const summary = data.summary;
  const at = data.at;
  if (typeof summary !== "string" || !summary.trim()) return undefined;
  if (typeof at !== "string") return undefined;
  const atMs = parseTimeMs(at);
  if (atMs === 0) return undefined;
  const startedAt = parseTimeMs(latestMerger.startedAt);
  const finishedAt = runEventTime(latestMerger);
  if (startedAt > 0 && atMs < startedAt) return undefined;
  if (finishedAt > 0 && atMs > finishedAt) return undefined;

  return {
    summary: summary.trim(),
    dedupeKey: `merger_conflict:${item.slice.id}:${
      latestMerger.finishedAt ??
      latestMerger.lastActive ??
      latestMerger.startedAt ??
      latestMerger.slug
    }:${at}`,
  };
}

function threadMergerConflict(
  item: SliceDispatchItem & { runs: SubagentListItem[] },
  latestMerger: SubagentListItem
): MergerConflictState | undefined {
  const entries = item.slice.docs.thread.split(/^##\s+/m).slice(1);
  const startedAt = parseTimeMs(latestMerger.startedAt);
  const finishedAt = runEventTime(latestMerger);
  for (const rawEntry of entries.reverse()) {
    const [heading = "", ...bodyParts] = rawEntry.split(/\r?\n/);
    const at = heading.trim();
    const atMs = parseTimeMs(at);
    if (atMs === 0) continue;
    if (startedAt > 0 && atMs < startedAt) continue;
    if (finishedAt > 0 && atMs > finishedAt) continue;
    const body = bodyParts.join("\n");
    if (!body.includes("[author:Merger]")) continue;
    const summaryMatch = body.match(
      /Merge conflict\s+(?:—|-)\s+needs human:\s*([^\n]+)?/i
    );
    if (!summaryMatch) continue;
    const summary = (summaryMatch[1] ?? "").trim();
    return {
      summary: summary || "Merge conflict needs human.",
      dedupeKey: `merger_conflict:${item.slice.id}:${
        latestMerger.finishedAt ??
        latestMerger.lastActive ??
        latestMerger.startedAt ??
        latestMerger.slug
      }:${at}`,
    };
  }
  return undefined;
}

function latestMergerConflictState(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  item: SliceDispatchItem & { runs: SubagentListItem[] }
): MergerConflictState | undefined {
  if (item.slice.frontmatter.status !== MERGER_SLICE_STATUS) return undefined;
  const latest = latestMergerRun(config, orchestratorConfig, item);
  if (!latest) return undefined;
  return (
    frontmatterMergerConflict(item, latest) ??
    threadMergerConflict(item, latest)
  );
}

function addMergerConflictHitlEvents(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  items: Array<SliceDispatchItem & { runs: SubagentListItem[] }>,
  deps: OrchestratorDispatcherDeps
): void {
  if (!deps.hitl) return;
  for (const item of items) {
    const conflict = latestMergerConflictState(
      config,
      orchestratorConfig,
      item
    );
    if (!conflict) continue;
    deps.hitl.add({
      kind: "merger_conflict",
      projectId: item.project.id,
      sliceId: item.slice.id,
      summary: conflict.summary,
      link: item.slice.dirPath,
      dedupeKey: conflict.dedupeKey,
    });
  }
}

async function logStaleWorkerWorkspaces(
  log: Logger,
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  projectId: string,
  runs: SubagentListItem[]
): Promise<void> {
  for (const run of workerWorkspaceRuns(config, orchestratorConfig, runs)) {
    if (!run.worktreePath || (await pathExists(run.worktreePath))) continue;
    keyValueLog(log, {
      component: "orchestrator",
      action: "prune_stale_worker_workspace",
      project: projectId,
      slice: run.sliceId ?? "",
      slug: run.slug,
      path: run.worktreePath,
    });
  }
}

async function dispatchForStatus(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  statusKey: string,
  deps: OrchestratorDispatcherDeps,
  globalSliceStatusIndex: Map<string, SliceStatus>
): Promise<DispatchResult> {
  const log = deps.log ?? console.log;
  const policy = new SliceDispatchPolicy({ config, orchestratorConfig });
  const planner = new OrchestratorRunPlanner(config, orchestratorConfig, deps);
  const statusConfig = policy.statusConfig(statusKey);
  if (!statusConfig) {
    keyValueLog(log, {
      component: "orchestrator",
      status: statusKey,
      action: "skip",
      reason: "status_not_configured",
    });
    return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };
  }

  const profile = planner.resolveProfile(statusConfig.profile);
  if (!profile) {
    keyValueLog(log, {
      component: "orchestrator",
      status: statusKey,
      action: "skip",
      reason: "profile_not_found",
      profile: statusConfig.profile,
    });
    return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };
  }

  // Only support Worker, Reviewer, and Merger slice statuses for now.
  // Other status keys are not dispatched.
  if (!policy.isSupportedStatus(statusKey)) {
    keyValueLog(log, {
      component: "orchestrator",
      status: statusKey,
      action: "skip",
      reason: "unsupported_status",
    });
    return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };
  }

  // --- Step 1: Enumerate active projects ---
  const projectResult = await (deps.listProjects ?? listProjects)(config);
  if (!projectResult.ok) {
    keyValueLog(log, {
      component: "orchestrator",
      status: statusKey,
      action: "error",
      reason: "list_projects_failed",
    });
    return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };
  }

  const activeProjects = projectResult.data.filter(
    (p) => projectStatus(p) === "active"
  );

  // --- Step 2: For each active project, gather slices in statusKey + runs ---
  const projectData = await Promise.all(
    activeProjects.map(async (project) => {
      const [slicesResult, runsResult] = await Promise.all([
        (deps.listSlices ?? listSlices)(project.absolutePath).then((slices) =>
          slices.filter((s) => s.frontmatter.status === statusKey)
        ),
        (deps.listSubagents ?? listSubagents)(config, project.id).then((r) =>
          r.ok ? r.data.items : []
        ),
      ]);
      await logStaleWorkerWorkspaces(
        log,
        config,
        orchestratorConfig,
        project.id,
        runsResult
      );
      return { project, slices: slicesResult, runs: runsResult };
    })
  );

  // --- Step 3: Build slice dispatch items ---
  const allItems: Array<SliceDispatchItem & { runs: SubagentListItem[] }> =
    projectData.flatMap(({ project, slices, runs }) =>
      slices.map((slice) => ({ slice, project, runs }))
    );
  emitReviewerFailureHitl(config, orchestratorConfig, allItems, deps);

  // --- Step 4: Active-run deduplication (keyed by sliceId) ---
  const activeBySlice = new Map<string, SubagentListItem[]>();
  for (const item of allItems) {
    const fallbackCwds = fallbackCwdsForProject(config, item.project);
    const active = policy.activeRunsForStatus(statusKey, item, fallbackCwds);
    activeBySlice.set(item.slice.id, active);
  }

  const running = [...activeBySlice.values()].reduce(
    (sum, runs) => sum + runs.length,
    0
  );
  const availableSlots = policy.availableSlots(statusKey, running);
  const nowDate = (deps.now ?? (() => new Date()))();
  const nowMs = nowDate.getTime();
  const attempts = deps.attempts;
  const dispatchKind = dispatchKindForStatus(statusKey);

  addMergerConflictHitlEvents(config, orchestratorConfig, allItems, deps);

  // --- Step 5: Blocker + cooldown filtering (per sliceId) ---
  const eligible = allItems.filter((item) => {
    const sliceId = item.slice.id;
    const decision = policy.shouldDispatchSlice({
      item,
      statusKey,
      globalSliceStatusIndex,
      activeRuns: activeBySlice.get(sliceId) ?? [],
      nowMs,
      attempts,
      hasMergerConflict: Boolean(
        latestMergerConflictState(config, orchestratorConfig, item)
      ),
    });
    if (decision.eligible) return true;
    if (decision.reason === "active_run") return false;
    if (decision.reason === "merger_conflict_parked") {
      keyValueLog(log, {
        component: "orchestrator",
        status: statusKey,
        action: "skip",
        project: item.project.id,
        slice: sliceId,
        reason: "merger_conflict_parked",
      });
      return false;
    }
    if (decision.reason === "blocked_by_pending") {
      keyValueLog(log, {
        component: "orchestrator",
        status: statusKey,
        action: "skip",
        project: item.project.id,
        slice: sliceId,
        reason: "blocked_by_pending",
        pending: decision.pending ?? [],
      });
      return false;
    }
    if (decision.reason === "failure_cooldown") {
      keyValueLog(log, {
        component: "orchestrator",
        status: statusKey,
        action: "skip",
        project: item.project.id,
        slice: sliceId,
        reason: "failure_cooldown",
      });
      return false;
    }
    return false;
  });

  const selected = eligible.slice(0, availableSlots);
  const decisions: DispatchDecision[] = [];

  keyValueLog(log, {
    component: "orchestrator",
    status: statusKey,
    action: "tick",
    running,
    eligible: eligible.length,
    available_slots: availableSlots,
  });

  const removeOrphan = deps.removeOrphanDir ?? defaultRemoveOrphanDir;

  for (const [index, item] of selected.entries()) {
    const { slice, project, runs } = item;
    const slug = planner.slugForStatus(statusKey, slice.id, nowDate, index);

    let input: Awaited<ReturnType<OrchestratorRunPlanner["buildSpawnInput"]>>;
    try {
      input = await planner.buildSpawnInput(
        statusKey,
        item,
        profile,
        slug,
        runs
      );
    } catch (error) {
      decisions.push({
        projectId: project.id,
        sliceId: slice.id,
        action: "skipped",
        reason: "spawn_failed",
      });
      keyValueLog(log, {
        component: "orchestrator",
        status: statusKey,
        action: "spawn_failed",
        project: project.id,
        slice: slice.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (!input) {
      if (statusKey === REVIEWER_SLICE_STATUS) {
        const liveWorker = hasLiveWorkerRun(
          config,
          orchestratorConfig,
          runs,
          slice.id
        );
        decisions.push({
          projectId: project.id,
          sliceId: slice.id,
          action: "skipped",
          reason: "reviewer_skipped_no_worker_workspace",
        });
        keyValueLog(log, {
          component: "orchestrator",
          status: statusKey,
          action: "reviewer_skipped_no_worker_workspace",
          project: project.id,
          slice: slice.id,
          live_worker: liveWorker ? "true" : "false",
        });
        if (!liveWorker) {
          await (deps.updateSlice ?? updateSlice)(
            project.absolutePath,
            slice.id,
            { status: "todo" }
          );
        }
        continue;
      }
      decisions.push({
        projectId: project.id,
        sliceId: slice.id,
        action: "skipped",
        reason: "unsupported_status",
      });
      continue;
    }

    let spawned: SpawnSubagentResult;
    try {
      spawned = await (deps.spawnSubagent ?? spawnSubagent)(config, input);
    } catch (error) {
      spawned = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!spawned.ok) {
      if (dispatchKind) attempts?.recordFailure(slice.id, dispatchKind, nowMs);
      decisions.push({
        projectId: project.id,
        sliceId: slice.id,
        action: "skipped",
        reason: "spawn_failed",
      });
      if (statusKey === WORKER_SLICE_STATUS) {
        try {
          await (deps.updateSlice ?? updateSlice)(
            project.absolutePath,
            slice.id,
            { status: "todo" }
          );
          keyValueLog(log, {
            component: "orchestrator",
            status: statusKey,
            action: "spawn_failed_revert",
            project: project.id,
            slice: slice.id,
            reason: spawned.error,
            status_reverted: "true",
          });
        } catch (revertError) {
          keyValueLog(log, {
            component: "orchestrator",
            status: statusKey,
            action: "revert_failed",
            project: project.id,
            slice: slice.id,
            reason:
              revertError instanceof Error
                ? revertError.message
                : String(revertError),
            spawn_reason: spawned.error,
            status_reverted: "false",
          });
        }
      } else {
        keyValueLog(log, {
          component: "orchestrator",
          status: statusKey,
          action: "spawn_failed",
          project: project.id,
          slice: slice.id,
          reason: spawned.error,
        });
      }
      // Best-effort orphan cleanup: spawnSubagent may have created the slug
      // directory before failing (e.g. mkdir succeeded, git worktree add
      // failed). Without cleanup, the UI shows ghost agent rows.
      await removeOrphan(path.join(project.absolutePath, "sessions", slug));
      continue;
    }

    if (dispatchKind) attempts?.recordSuccess(slice.id, dispatchKind);

    decisions.push({
      projectId: project.id,
      sliceId: slice.id,
      action: "spawned",
      slug,
    });
    keyValueLog(log, {
      component: "orchestrator",
      status: statusKey,
      action: "spawned",
      project: project.id,
      slice: slice.id,
      slug,
      profile: statusConfig.profile,
    });

    if (statusKey === WORKER_SLICE_STATUS) {
      // Lock: move slice todo → in_progress when Worker spawned.
      // Project status is unchanged — the project gate (active) is set by
      // the user when ready; only slices move through the kanban.
      try {
        await (deps.updateSlice ?? updateSlice)(
          project.absolutePath,
          slice.id,
          { status: "in_progress" }
        );
      } catch (lockError) {
        keyValueLog(log, {
          component: "orchestrator",
          status: statusKey,
          action: "lock_failed",
          project: project.id,
          slice: slice.id,
          reason:
            lockError instanceof Error ? lockError.message : String(lockError),
        });
        // Do not unwind the spawn; the run is already started.
      }
    }
  }

  return {
    running,
    availableSlots,
    eligible: eligible.length,
    decisions,
  };
}

async function dispatchShapingStatus(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  statusKey: string,
  nextStatus: string | undefined,
  deps: OrchestratorDispatcherDeps
): Promise<DispatchResult> {
  const log = deps.log ?? console.log;
  const planner = new OrchestratorRunPlanner(config, orchestratorConfig, deps);
  const statusConfig = shapingStatusConfigFor(orchestratorConfig, statusKey);
  if (!statusConfig) return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };
  const profile = planner.resolveProfile(statusConfig.profile);
  if (!profile) {
    keyValueLog(log, { component: "orchestrator", status: statusKey, action: "skip", reason: "profile_not_found", profile: statusConfig.profile });
    return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };
  }

  const projectResult = await (deps.listProjects ?? listProjects)(config);
  if (!projectResult.ok) return { running: 0, availableSlots: 0, eligible: 0, decisions: [] };

  const rows = await Promise.all(
    projectResult.data
      .filter((project) => projectStatus(project) === statusKey)
      .map(async (project) => ({
        project,
        runs: await (deps.listSubagents ?? listSubagents)(config, project.id).then((r) => r.ok ? r.data.items : []),
      }))
  );

  const activeProjects = new Set<string>();
  for (const { project, runs } of rows) {
    if (runs.some((run) => run.status === "running" && sourceOf(run) === "orchestrator" && isShaperRun(config, orchestratorConfig, run))) {
      activeProjects.add(project.id);
    }
  }
  const running = activeProjects.size;
  const availableSlots = Math.max(0, statusConfig.max_concurrent - running);
  const nowDate = (deps.now ?? (() => new Date()))();
  const threshold = statusConfig.stall_threshold_ms ?? orchestratorConfig.stall_threshold_ms;
  const decisions: DispatchDecision[] = [];

  const eligible: ProjectListItem[] = [];
  for (const { project } of rows) {
    if (activeProjects.has(project.id)) continue;
    const changedAt = typeof project.frontmatter.last_status_change_at === "string"
      ? Date.parse(project.frontmatter.last_status_change_at)
      : Date.parse(typeof project.frontmatter.updated_at === "string" ? project.frontmatter.updated_at : "");
    if (threshold > 0 && Number.isFinite(changedAt) && nowDate.getTime() - changedAt > threshold) {
      await (deps.appendProjectComment ?? appendProjectComment)(config, project.id, {
        author: ORCHESTRATOR_STALL_AUTHOR,
        date: nowDate.toISOString(),
        body: `Shaping stage ${statusKey} exceeded ${threshold}ms without progress; moving to shaping:blocked for human pickup.`,
      });
      await (deps.updateProject ?? updateProject)(config, project.id, { status: "shaping:blocked" });
      decisions.push({ projectId: project.id, action: "skipped", reason: "shaping_stalled" });
      continue;
    }
    eligible.push(project);
  }

  keyValueLog(log, { component: "orchestrator", status: statusKey, action: "shaping_tick", running, eligible: eligible.length, available_slots: availableSlots });
  for (const [index, project] of eligible.slice(0, availableSlots).entries()) {
    const slug = planner.slugForShapingStatus(statusKey, project.id, nowDate, index);
    let input;
    try {
      input = await planner.buildShaperSpawnInput(
        project,
        statusKey,
        nextStatus,
        profile,
        slug
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      decisions.push({
        projectId: project.id,
        action: "skipped",
        reason: "build_failed",
      });
      keyValueLog(log, {
        component: "orchestrator",
        status: statusKey,
        action: "build_failed",
        project: project.id,
        reason,
      });
      continue;
    }
    const spawned = await (deps.spawnSubagent ?? spawnSubagent)(config, input).catch((error) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (!spawned.ok) {
      decisions.push({ projectId: project.id, action: "skipped", reason: "spawn_failed" });
      keyValueLog(log, { component: "orchestrator", status: statusKey, action: "spawn_failed", project: project.id, reason: spawned.error });
      continue;
    }
    decisions.push({ projectId: project.id, action: "spawned", slug });
    keyValueLog(log, { component: "orchestrator", status: statusKey, action: "spawned", project: project.id, slug, profile: statusConfig.profile });
  }

  return { running, availableSlots, eligible: eligible.length, decisions };
}

export async function dispatchOrchestratorTick(
  config: GatewayConfig,
  orchestratorConfig: OrchestratorConfig,
  deps: OrchestratorDispatcherDeps = {}
): Promise<DispatchResult> {
  await detectStalls(config, orchestratorConfig, deps);
  const results: DispatchResult[] = [];
  await reconcileLiveRuns(config, orchestratorConfig, deps);
  await pingDoneOnIntegration(config, orchestratorConfig, deps);
  const globalSliceStatusIndex = await buildGlobalSliceStatusIndex(
    config,
    deps
  );
  const shapingKeys = configuredShapingStatusKeys(orchestratorConfig);
  for (const [index, statusKey] of shapingKeys.entries()) {
    if (statusKey === "shaping:blocked") continue;
    results.push(
      await dispatchShapingStatus(
        config,
        orchestratorConfig,
        statusKey,
        shapingKeys[index + 1] ?? "active",
        deps
      )
    );
  }
  for (const statusKey of configuredStatusKeys(orchestratorConfig)) {
    results.push(
      await dispatchForStatus(
        config,
        orchestratorConfig,
        statusKey,
        deps,
        globalSliceStatusIndex
      )
    );
  }
  return results.reduce<DispatchResult>(
    (total, result) => ({
      running: total.running + result.running,
      availableSlots: total.availableSlots + result.availableSlots,
      eligible: total.eligible + result.eligible,
      decisions: [...total.decisions, ...result.decisions],
    }),
    { running: 0, availableSlots: 0, eligible: 0, decisions: [] }
  );
}
