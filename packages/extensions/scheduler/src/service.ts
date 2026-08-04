import crypto from "node:crypto";
import type {
  AgentConfig,
  ScheduleJob,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  ExtensionContext,
} from "@yoplai/shared";
import { deliverRunResult, type DeliveryOutcome } from "./deliver.js";
import { PerAgentScheduleStore, type ScheduleStore } from "./store.js";
import { computeNextRunAtMs } from "./schedule.js";
import {
  formatScheduleForOutput,
  latestAssistantText,
  writeCronRunOutput,
} from "./output.js";
import {
  parseWakeAgent,
  runScript,
  terminateRunningScripts,
  type RunScriptResult,
} from "./script.js";

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export type SchedulerRunKind = "script_only" | "silent_tick" | "woke_agent";

export type SchedulerState = {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastExitCode?: number;
  lastRunKind?: SchedulerRunKind;
  /** Per-target delivery outcomes of the last run; absent when nothing was pushed. */
  lastDelivery?: DeliveryOutcome[];
  runningForMs?: number;
};

export type SchedulerRunResult = {
  job: ScheduleJob;
  status: "ok" | "error" | "skipped";
  firedAt: string;
  finishedAt: string;
  sessionId?: string;
  outputPath?: string;
  error?: string;
};

type JobWithState = ScheduleJob & {
  state?: SchedulerState;
  timeoutMs?: number;
};

type CompleteRunInput = {
  job: JobWithState;
  agent: AgentConfig;
  workspaceDir: string;
  model: { provider: string; model: string };
  firedAt: Date;
  sessionId?: string;
  status: "ok" | "error";
  statusLabel: string;
  runKind?: SchedulerRunKind;
  exitCode?: number;
  prompt?: string;
  response?: string;
  gateOutput?: string;
  error?: unknown;
  errorMessage?: string;
};

let schedulerCtx: ExtensionContext | null = null;

export class ScheduleAlreadyRunningError extends Error {
  constructor(agentId: string, id: string) {
    super(`Schedule already running: ${agentId}/${id}`);
    this.name = "ScheduleAlreadyRunningError";
  }
}

function uuidv7(): string {
  const bytes = crypto.randomBytes(16);
  const ts = Date.now();
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts >>> 24) & 0xff;
  bytes[3] = (ts >>> 16) & 0xff;
  bytes[4] = (ts >>> 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Pulls the exit code back out of a `runScript` failure message so the run is
 * recorded mechanically instead of from an LLM self-report.
 */
function parseScriptExitCode(message: string | undefined): number | undefined {
  const match = /^script failed \(exit (-?\d+)\)/.exec(message ?? "");
  return match ? Number(match[1]) : undefined;
}

function errorStatusLabel(message: string | undefined): string {
  const firstLine = message?.split("\n")[0] ?? "";
  return firstLine.startsWith("script failed (exit ") ? firstLine : "error";
}

export function hasSchedulerContext(): boolean {
  return schedulerCtx !== null;
}

export function getSchedulerContext(): ExtensionContext {
  if (!schedulerCtx) {
    throw new Error("Scheduler context not initialized");
  }
  return schedulerCtx;
}

export function setSchedulerContext(ctx: ExtensionContext): void {
  schedulerCtx = ctx;
}

export function clearSchedulerContext(): void {
  schedulerCtx = null;
  instance = null;
}

export class SchedulerService {
  private store: ScheduleStore = { version: 1, jobs: [] };
  private jobStore: PerAgentScheduleStore;
  private timer: NodeJS.Timeout | null = null;
  private loaded = false;
  private stopped = false;
  private agentSaveChains = new Map<string, Promise<void>>();
  private executingJobs = new Set<string>();
  private runningJobStartedAtMs = new Map<string, number>();
  private executingJobControllers = new Map<string, AbortController>();
  private skippedScheduledFireKeys = new Set<string>();

  constructor() {
    const ctx = getSchedulerContext();
    this.jobStore = new PerAgentScheduleStore(
      ctx.getAgents(),
      (agent) => ctx.resolveWorkspaceDir(agent),
      ctx.getDataDir(),
      (message) => ctx.logger.warn(message)
    );
  }

  async start() {
    this.stopped = false;
    await this.load();
    const config = getSchedulerContext().getConfig();
    if (config.extensions?.scheduler?.enabled === false) {
      console.log("[scheduler] Disabled");
      return;
    }

    this.recomputeNextRuns();
    this.armTimer();
    console.log(`[scheduler] Started with ${this.store.jobs.length} job(s)`);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Script children are detached, so without this a shutdown mid-run leaves
    // them running with no timeout left to enforce and a second copy spawning
    // when the gateway comes back.
    terminateRunningScripts();
    console.log("[scheduler] Stopped");
  }

  async refreshFromDisk() {
    const ctx = getSchedulerContext();
    this.jobStore = new PerAgentScheduleStore(
      ctx.getAgents(),
      (agent) => ctx.resolveWorkspaceDir(agent),
      ctx.getDataDir(),
      (message) => ctx.logger.warn(message)
    );
    this.store = await this.jobStore.load();
    this.loaded = true;
    this.recomputeNextRuns();
    this.armTimer();
  }

  async list(agentId?: string): Promise<ScheduleJob[]> {
    await this.load();
    const now = Date.now();
    return (this.store.jobs as JobWithState[])
      .filter((job) => !agentId || job.agentId === agentId)
      .map((job) => {
        const key = this.executionKey(job);
        const startedAt = this.runningJobStartedAtMs.get(key);
        if (startedAt !== undefined) {
          return {
            ...job,
            state: { ...(job.state ?? {}), runningForMs: now - startedAt },
          };
        }
        return job;
      });
  }

  async add(
    agentId: string,
    input: Omit<CreateScheduleRequest, "agentId">
  ): Promise<ScheduleJob> {
    await this.load();
    const ctx = getSchedulerContext();
    if (!ctx.getAgent(agentId)) throw new Error(`Agent not found: ${agentId}`);
    const id = crypto.randomUUID();
    const job: JobWithState = {
      id,
      name: input.name,
      agentId,
      enabled: true,
      schedule: input.schedule,
      model: input.model,
      payload: input.payload,
      deliver: input.deliver,
      timeoutMs: input.timeoutMs,
      createdAt: new Date().toISOString(),
      state: {},
    };

    job.state!.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
    this.store.jobs.push(job);
    await this.saveAgent(agentId);
    this.armTimer();

    return job;
  }

  async update(
    agentId: string,
    id: string,
    patch: UpdateScheduleRequest
  ): Promise<ScheduleJob> {
    await this.load();
    const job = this.findJob(agentId, id);
    if (!job) throw new Error(`Schedule not found: ${agentId}/${id}`);

    if (patch.name !== undefined) job.name = patch.name;
    if (patch.enabled !== undefined) job.enabled = patch.enabled;
    if (patch.schedule) job.schedule = patch.schedule;
    if (patch.model) job.model = patch.model;
    if (patch.payload) job.payload = patch.payload;
    if (patch.deliver !== undefined) job.deliver = patch.deliver;
    if (patch.timeoutMs !== undefined) job.timeoutMs = patch.timeoutMs;

    if (job.enabled) {
      job.state = job.state ?? {};
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
    }

    await this.saveAgent(agentId);
    this.armTimer();

    return job;
  }

  async remove(agentId: string, id: string): Promise<{ removed: boolean }> {
    await this.load();
    const before = this.store.jobs.length;
    this.store.jobs = this.store.jobs.filter(
      (job) => !(job.agentId === agentId && job.id === id)
    );
    const removed = this.store.jobs.length !== before;
    if (removed) {
      await this.saveAgent(agentId);
      this.armTimer();
    }
    return { removed };
  }

  async runNow(agentId: string, id: string): Promise<SchedulerRunResult> {
    await this.load();
    const job = this.findJob(agentId, id);
    if (!job) throw new Error(`Schedule not found: ${agentId}/${id}`);

    const key = this.executionKey(job);
    const previousNextRunAtMs = job.state?.nextRunAtMs;
    const result = await this.executeJob(job);
    const skippedScheduledFire = this.skippedScheduledFireKeys.delete(key);

    if (!skippedScheduledFire) {
      job.state = job.state ?? {};
      if (previousNextRunAtMs === undefined) {
        delete job.state.nextRunAtMs;
      } else {
        job.state.nextRunAtMs = previousNextRunAtMs;
      }
    }
    await this.saveAgent(agentId);
    this.armTimer();

    return result;
  }

  private async load() {
    if (this.loaded) return;
    this.store = await this.jobStore.load();
    this.loaded = true;
  }

  private findJob(agentId: string, id: string): JobWithState | undefined {
    return this.store.jobs.find(
      (job) => job.agentId === agentId && job.id === id
    ) as JobWithState | undefined;
  }

  private recomputeNextRuns() {
    const now = Date.now();
    for (const job of this.store.jobs as JobWithState[]) {
      if (!job.enabled) continue;
      job.state = job.state ?? {};
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
    }
  }

  private async saveAgent(agentId: string) {
    const previous = this.agentSaveChains.get(agentId) ?? Promise.resolve();
    const operation = previous.then(() =>
      this.jobStore.saveAgentJobs(
        agentId,
        this.store.jobs.filter((job) => job.agentId === agentId)
      )
    );
    const chain = operation.catch(() => {});
    this.agentSaveChains.set(agentId, chain);
    chain.finally(() => {
      if (this.agentSaveChains.get(agentId) === chain) {
        this.agentSaveChains.delete(agentId);
      }
    });
    await operation;
  }

  armTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.stopped) return;

    const config = getSchedulerContext().getConfig();
    if (config.extensions?.scheduler?.enabled === false) return;

    const nextAt = this.getNextWakeAt();
    if (!nextAt) return;

    const delay = Math.max(nextAt - Date.now(), 0);
    this.timer = setTimeout(() => this.tick(), delay);
    this.timer.unref?.();
  }

  private getNextWakeAt(): number | undefined {
    const enabled = (this.store.jobs as JobWithState[]).filter(
      (j) => j.enabled && j.state?.nextRunAtMs
    );
    if (enabled.length === 0) return undefined;
    return Math.min(...enabled.map((j) => j.state!.nextRunAtMs!));
  }

  async tick() {
    try {
      await this.runDueJobs();
    } finally {
      // Re-arm in finally so a hung or erroring job never wedges the scheduler loop.
      this.armTimer();
    }
  }

  async runDueJobs() {
    const now = Date.now();
    const due = (this.store.jobs as JobWithState[]).filter((j) => {
      if (!j.enabled) return false;
      return j.state?.nextRunAtMs && now >= j.state.nextRunAtMs;
    });

    // Run all due jobs concurrently so one slow/hung job doesn't delay others.
    await Promise.allSettled(
      due.map(async (job) => {
        try {
          await this.executeJob(job);
        } catch (error) {
          if (error instanceof ScheduleAlreadyRunningError) {
            getSchedulerContext().logger.warn(error.message);
            job.state = job.state ?? {};
            job.state.nextRunAtMs = computeNextRunAtMs(
              job.schedule,
              Date.now()
            );
            this.skippedScheduledFireKeys.add(this.executionKey(job));
            await this.saveAgent(job.agentId);
            return;
          }
          getSchedulerContext().logger.error(
            `[scheduler] Unexpected error executing job ${job.name}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      })
    );
  }

  private executionKey(job: Pick<ScheduleJob, "agentId" | "id">): string {
    return `${job.agentId}/${job.id}`;
  }

  private async executeJob(job: JobWithState): Promise<SchedulerRunResult> {
    const key = this.executionKey(job);
    if (this.executingJobs.has(key)) {
      throw new ScheduleAlreadyRunningError(job.agentId, job.id);
    }
    this.executingJobs.add(key);
    this.runningJobStartedAtMs.set(key, Date.now());

    const ctx = getSchedulerContext();
    const config = ctx.getConfig();
    const defaultTimeoutMs =
      config.extensions?.scheduler?.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
    const timeoutMs = job.timeoutMs ?? defaultTimeoutMs;

    const agent = ctx.getAgent(job.agentId);
    const firedAt = new Date();
    const sessionId =
      job.payload.sessionId ?? `scheduler:${job.id}:${uuidv7()}`;

    if (!agent) {
      console.error(`[scheduler] Agent not found: ${job.agentId}`);
      this.executingJobs.delete(key);
      this.runningJobStartedAtMs.delete(key);
      job.state = job.state ?? {};
      job.state.lastStatus = "error";
      job.state.lastError = "Agent not found";
      job.state.lastRunAtMs = firedAt.getTime();
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
      return {
        job,
        status: "error",
        firedAt: firedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        sessionId,
        error: "Agent not found",
      };
    }

    // Skip if agent not active (single-agent mode filter)
    if (!ctx.isAgentActive(job.agentId)) {
      this.executingJobs.delete(key);
      this.runningJobStartedAtMs.delete(key);
      job.state = job.state ?? {};
      job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
      return {
        job,
        status: "skipped",
        firedAt: firedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        sessionId,
        error: "Agent not active",
      };
    }

    console.log(`[scheduler] Running job: ${job.name} -> ${agent.name}`);

    const workspaceDir = ctx.resolveWorkspaceDir(agent);
    const outputModel = job.model ?? {
      provider: agent.model.provider ?? "",
      model: agent.model.model,
    };

    let prompt = job.payload.message ?? "";
    let gateOutput: string | undefined;
    let runKind: SchedulerRunKind | undefined;

    // A `script` payload runs the script itself before (or instead of) the LLM,
    // so a deterministic job's success signal is its exit code, not a model's
    // self-report. The script enforces its own timeout, so it stays outside the
    // AbortController race below.
    if (job.payload.script) {
      let script: RunScriptResult;
      try {
        script = await runScript({
          workspaceDir,
          script: job.payload.script,
          timeoutMs,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] Job script failed: ${job.name}`, err);
        return this.completeAndRelease(key, {
          job,
          agent,
          workspaceDir,
          model: outputModel,
          firedAt,
          status: "error",
          statusLabel: errorStatusLabel(message),
          exitCode: parseScriptExitCode(message),
          prompt: job.payload.message,
          error: err,
          errorMessage: message,
        });
      }

      if (job.payload.noAgent) {
        return this.completeAndRelease(key, {
          job,
          agent,
          workspaceDir,
          model: outputModel,
          firedAt,
          status: "ok",
          statusLabel: "ok",
          runKind: "script_only",
          response: script.stdout,
        });
      }

      const gate = parseWakeAgent(script.finalStdoutLine);
      if (!gate.wake) {
        return this.completeAndRelease(key, {
          job,
          agent,
          workspaceDir,
          model: outputModel,
          firedAt,
          status: "ok",
          statusLabel: "ok (silent tick)",
          runKind: "silent_tick",
          prompt: job.payload.message,
          response: "silent tick",
        });
      }

      runKind = "woke_agent";
      gateOutput = script.stdout;
      if (gate.context) prompt = `${prompt}\n\nGate context:\n${gate.context}`;
    }

    // Each execution gets its own AbortController so timeout can cancel the run.
    const controller = new AbortController();
    this.executingJobControllers.set(key, controller);

    // Start the underlying run. executingJobs stays populated until runPromise
    // actually settles — even if executeJob returns early due to timeout —
    // so the next scheduled fire cannot overlap with a still-aborting run.
    const runPromise = ctx.runAgent({
      agentId: job.agentId,
      message: prompt,
      sessionId,
      model: job.model,
      source: "scheduler",
      // Without an explicit surface the tracer falls back to "chat", so
      // scheduled runs would show up as yoplai:chat:<agent> in Langfuse.
      trace: {
        surface: "scheduler",
        metadata: { jobId: job.id, jobName: job.name },
      },
      signal: controller.signal,
    });

    const runSettled = runPromise.catch(() => {}).then(() => {
      this.executingJobControllers.delete(key);
    });

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`Job timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timeoutId.unref?.();
    });

    let runStatus: "ok" | "error" = "ok";
    let runSessionId = sessionId;
    let response: string | undefined;
    let runError: string | undefined;
    let errorValue: unknown;

    try {
      const result = await Promise.race([runPromise, timeoutPromise]);

      runSessionId = result.meta.sessionId;
      response = latestAssistantText(result.payloads);
    } catch (err) {
      runStatus = "error";
      errorValue = err;
      runError = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Job failed: ${job.name}`, err);
    } finally {
      clearTimeout(timeoutId);
    }

    try {
      return await this.completeRun({
        job,
        agent,
        workspaceDir,
        model: outputModel,
        firedAt,
        sessionId: runSessionId,
        status: runStatus,
        statusLabel:
          runStatus === "error"
            ? errorStatusLabel(runError)
            : runKind === "woke_agent"
              ? "woke agent"
              : "ok",
        runKind,
        prompt: job.payload.message,
        response,
        gateOutput,
        error: errorValue,
        errorMessage: runError,
      });
    } finally {
      // Release only once the underlying run has settled too: a timed-out run
      // may still be aborting, and the next fire must not overlap with it.
      void runSettled.then(() => this.releaseExecution(key));
    }
  }

  /**
   * Completes a run while still holding the overlap guard. completeRun pushes
   * the result to network sinks and only then reschedules, so releasing before
   * it would let the next fire start a second copy of the same job.
   */
  private async completeAndRelease(
    key: string,
    input: CompleteRunInput
  ): Promise<SchedulerRunResult> {
    try {
      return await this.completeRun(input);
    } finally {
      this.releaseExecution(key);
    }
  }

  private releaseExecution(key: string) {
    this.executingJobs.delete(key);
    this.runningJobStartedAtMs.delete(key);
  }

  /**
   * Common tail for every fire path: records runtime state, writes the run's
   * output file (unless `quietOutput` suppresses an uneventful run) and
   * reschedules. Runtime state is updated on every tick regardless.
   */
  private async completeRun(
    input: CompleteRunInput
  ): Promise<SchedulerRunResult> {
    const { job, firedAt } = input;
    job.state = job.state ?? {};
    job.state.lastStatus = input.status;
    job.state.lastError = input.errorMessage;
    job.state.lastExitCode = input.exitCode;
    job.state.lastRunKind = input.runKind;

    // Delivery is runtime behavior, not an LLM tool call, and runs for every job
    // shape — including one whose `quietOutput` skipped the file below.
    const delivery = await deliverRunResult({
      ctx: getSchedulerContext(),
      agent: input.agent,
      targets: job.deliver,
      run: {
        jobName: job.name,
        status: input.status,
        silentTick: input.runKind === "silent_tick",
        response: input.response,
        errorMessage: input.errorMessage,
      },
    });
    job.state.lastDelivery = delivery.length > 0 ? delivery : undefined;

    const uneventful =
      job.payload.quietOutput === true &&
      input.status === "ok" &&
      (input.runKind === "silent_tick" ||
        (input.runKind === "script_only" &&
          (input.response ?? "").trim() === ""));

    let outputPath: string | undefined;
    if (!uneventful) {
      try {
        outputPath = await writeCronRunOutput({
          workspaceDir: input.workspaceDir,
          jobId: job.id,
          agentId: job.agentId,
          sessionId: input.sessionId,
          model: input.model,
          runType: "cron",
          name: job.name,
          prompt: input.prompt,
          schedule: formatScheduleForOutput(job.schedule),
          firedAt,
          finishedAt: new Date(),
          status: input.status,
          statusLabel: input.statusLabel,
          exitCode: input.exitCode,
          durationMs: Date.now() - firedAt.getTime(),
          response: input.response,
          gateOutput: input.gateOutput,
          error: input.error,
          delivery,
        });
      } catch (err) {
        // An unwritable output dir must not skip the reschedule below: leaving
        // nextRunAtMs in the past re-fires the job on every tick, re-delivering
        // the result each time.
        getSchedulerContext().logger.error(
          `[scheduler] Failed to write output for job ${job.name}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const finishedAt = new Date();
    job.state.lastRunAtMs = firedAt.getTime();
    job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
    await this.saveAgent(job.agentId);
    return {
      job,
      status: input.status,
      firedAt: firedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      sessionId: input.sessionId,
      outputPath,
      error: input.errorMessage,
    };
  }
}

let instance: SchedulerService | null = null;

export function getScheduler(): SchedulerService {
  if (!instance) {
    instance = new SchedulerService();
  }
  return instance;
}

export async function startScheduler() {
  await getScheduler().start();
}

export async function stopScheduler() {
  await getScheduler().stop();
}
