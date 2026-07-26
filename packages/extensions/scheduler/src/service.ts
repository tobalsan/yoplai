import crypto from "node:crypto";
import type {
  ScheduleJob,
  CreateScheduleRequest,
  UpdateScheduleRequest,
  ExtensionContext,
} from "@yoplai/shared";
import { PerAgentScheduleStore, type ScheduleStore } from "./store.js";
import { computeNextRunAtMs } from "./schedule.js";
import {
  formatScheduleForOutput,
  latestAssistantText,
  writeCronRunOutput,
} from "./output.js";

const DEFAULT_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export type SchedulerState = {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
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

type JobWithState = ScheduleJob & { state?: SchedulerState; timeoutMs?: number };

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
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
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

  async add(agentId: string, input: Omit<CreateScheduleRequest, "agentId">): Promise<ScheduleJob> {
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
    await this.jobStore.saveAgentJobs(
      agentId,
      this.store.jobs.filter((job) => job.agentId === agentId)
    );
  }

  armTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

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
            job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
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
    const sessionId = job.payload.sessionId ?? `scheduler:${job.id}:${uuidv7()}`;

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

    // Each execution gets its own AbortController so timeout can cancel the run.
    const controller = new AbortController();
    this.executingJobControllers.set(key, controller);

    // Start the underlying run. executingJobs stays populated until runPromise
    // actually settles — even if executeJob returns early due to timeout —
    // so the next scheduled fire cannot overlap with a still-aborting run.
    const runPromise = ctx.runAgent({
      agentId: job.agentId,
      message: job.payload.message,
      sessionId,
      model: job.model,
      source: "scheduler",
      signal: controller.signal,
    });

    runPromise.catch(() => {}).finally(() => {
      this.executingJobs.delete(key);
      this.runningJobStartedAtMs.delete(key);
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

    let runStatus: SchedulerRunResult["status"] = "ok";
    let runSessionId = sessionId;
    let outputPath: string | undefined;
    let runError: string | undefined;

    try {
      const result = await Promise.race([runPromise, timeoutPromise]);

      runSessionId = result.meta.sessionId;
      job.state = job.state ?? {};
      job.state.lastStatus = "ok";
      job.state.lastError = undefined;
      outputPath = await writeCronRunOutput({
        workspaceDir: ctx.resolveWorkspaceDir(agent),
        jobId: job.id,
        agentId: job.agentId,
        sessionId: result.meta.sessionId,
        model: job.model ?? {
          provider: agent.model.provider ?? "",
          model: agent.model.model,
        },
        runType: "cron",
        name: job.name,
        prompt: job.payload.message,
        schedule: formatScheduleForOutput(job.schedule),
        firedAt,
        finishedAt: new Date(),
        status: "ok",
        durationMs: Date.now() - firedAt.getTime(),
        response: latestAssistantText(result.payloads),
      });
    } catch (err) {
      runStatus = "error";
      runError = err instanceof Error ? err.message : String(err);
      job.state = job.state ?? {};
      job.state.lastStatus = "error";
      job.state.lastError = runError;
      console.error(`[scheduler] Job failed: ${job.name}`, err);
      outputPath = await writeCronRunOutput({
        workspaceDir: ctx.resolveWorkspaceDir(agent),
        jobId: job.id,
        agentId: job.agentId,
        sessionId,
        model: job.model ?? {
          provider: agent.model.provider ?? "",
          model: agent.model.model,
        },
        runType: "cron",
        name: job.name,
        prompt: job.payload.message,
        schedule: formatScheduleForOutput(job.schedule),
        firedAt,
        finishedAt: new Date(),
        status: "error",
        durationMs: Date.now() - firedAt.getTime(),
        error: err,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const finishedAt = new Date();
    job.state!.lastRunAtMs = firedAt.getTime();
    job.state!.nextRunAtMs = computeNextRunAtMs(job.schedule, Date.now());
    await this.saveAgent(job.agentId);
    return {
      job,
      status: runStatus,
      firedAt: firedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      sessionId: runSessionId,
      outputPath,
      error: runError,
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
