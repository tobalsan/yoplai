import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConfig,
  ExtensionContext,
  GatewayConfig,
} from "@yoplai/shared";
import {
  ScheduleAlreadyRunningError,
  SchedulerService,
  clearSchedulerContext,
  setSchedulerContext,
  stopScheduler,
} from "./service.js";

type SchedulerWithInternals = {
  runDueJobs(): Promise<void>;
  armTimer(): void;
  tick(): Promise<void>;
  timer: NodeJS.Timeout | null;
};

function agent(id: string, workspace: string): AgentConfig {
  return {
    id,
    name: id,
    workspace,
    workspaceDir: workspace,
    model: { provider: "test", model: "test" },
    queueMode: "queue",
  };
}

function context(config: GatewayConfig, runAgent = vi.fn()): ExtensionContext {
  return {
    getConfig: () => config,
    getDataDir: () => os.tmpdir(),
    reloadConfig: () => undefined,
    getAgent: (id) => config.agents.find((candidate) => candidate.id === id),
    getAgents: () => config.agents,
    isAgentActive: () => true,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: (candidate) =>
      candidate.workspaceDir ?? candidate.workspace,
    runAgent,
    getSubagentTemplates: () => [],
    resolveSessionId: vi.fn(),
    getSessionEntry: vi.fn(),
    clearSessionEntry: vi.fn(),
    restoreSessionUpdatedAt: vi.fn(),
    deleteSession: vi.fn(),
    invalidateHistoryCache: vi.fn(),
    getSessionHistory: vi.fn(),
    saveMediaFile: vi.fn(),
    readMediaFile: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    emit: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("SchedulerService.runNow", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    try {
      await stopScheduler();
    } catch {
      // Tests create the service directly and may not start it.
    }
    clearSchedulerContext();
    vi.restoreAllMocks();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("runs a disabled job immediately without changing its next scheduled fire", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-service-")
    );
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 12, sessionId: "manual-session" },
    });
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config, runAgent));
    const scheduler = new SchedulerService();
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: { message: "Run" },
    });
    const disabled = (await scheduler.update("alpha", job.id, {
      enabled: false,
    })) as {
      state?: { nextRunAtMs?: number };
    };
    const previousNextRunAtMs = disabled.state?.nextRunAtMs;

    const result = await scheduler.runNow("alpha", job.id);

    expect(result.status).toBe("ok");
    expect(result.sessionId).toBe("manual-session");
    expect(result.outputPath).toContain(path.join("cron", "output", job.id));
    await expect(fs.readFile(result.outputPath!, "utf8")).resolves.toContain(
      "done"
    );
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "alpha",
        message: "Run",
        source: "scheduler",
      })
    );

    const [after] = (await scheduler.list("alpha")) as Array<{
      enabled?: boolean;
      state?: { nextRunAtMs?: number; lastStatus?: string };
    }>;
    expect(after?.enabled).toBe(false);
    expect(after?.state?.nextRunAtMs).toBe(previousNextRunAtMs);
    expect(after?.state?.lastStatus).toBe("ok");
  });

  it("rejects a second manual run while the same job is executing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-service-")
    );
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    let finishRun!: (value: unknown) => void;
    const runStarted = new Promise<void>((resolve) => {
      const runAgent = vi.fn(
        () =>
          new Promise((finish) => {
            finishRun = finish;
            resolve();
          })
      );
      const config: GatewayConfig = {
        version: 3,
        agents: [alpha],
        extensions: { scheduler: { enabled: true } },
        sessions: { idleMinutes: 360 },
        agentFab: false,
      };
      setSchedulerContext(context(config, runAgent));
    });
    const scheduler = new SchedulerService();
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: { message: "Run" },
    });

    const firstRun = scheduler.runNow("alpha", job.id);
    await runStarted;

    await expect(scheduler.runNow("alpha", job.id)).rejects.toBeInstanceOf(
      ScheduleAlreadyRunningError
    );

    finishRun({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1, sessionId: "s" },
    });
    await expect(firstRun).resolves.toMatchObject({ status: "ok" });
  });

  it("skips and reschedules a due scheduled fire that collides with a manual run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-service-")
    );
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    let finishRun!: (value: unknown) => void;
    const runStarted = new Promise<void>((resolve) => {
      const runAgent = vi.fn(
        () =>
          new Promise((finish) => {
            finishRun = finish;
            resolve();
          })
      );
      const config: GatewayConfig = {
        version: 3,
        agents: [alpha],
        extensions: { scheduler: { enabled: true } },
        sessions: { idleMinutes: 360 },
        agentFab: false,
      };
      setSchedulerContext(context(config, runAgent));
    });
    const scheduler = new SchedulerService();
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: { message: "Run" },
    });
    const [loadedJob] = (await scheduler.list("alpha")) as Array<{
      state?: { nextRunAtMs?: number };
    }>;
    loadedJob!.state = { nextRunAtMs: Date.now() - 1 };

    const manualRun = scheduler.runNow("alpha", job.id);
    await runStarted;

    await (
      scheduler as unknown as { runDueJobs(): Promise<void> }
    ).runDueJobs();

    finishRun({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1, sessionId: "s" },
    });
    await expect(manualRun).resolves.toMatchObject({ status: "ok" });

    const [after] = (await scheduler.list("alpha")) as Array<{
      state?: { nextRunAtMs?: number };
    }>;
    expect(after?.state?.nextRunAtMs).toBeGreaterThan(Date.now());
  });
});

describe("SchedulerService persistence and lifecycle", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    try {
      await stopScheduler();
    } catch {
      // Tests create the service directly and may not start it.
    }
    clearSchedulerContext();
    vi.restoreAllMocks();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("serializes saves for concurrent mutations of one agent", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-save-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config));
    const scheduler = new SchedulerService();
    await scheduler.list();

    let releaseFirst!: () => void;
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const snapshots: string[][] = [];
    const saveAgentJobs = vi.fn(
      async (_agentId: string, jobs: Array<{ name: string }>) => {
        activeSaves++;
        maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
        snapshots.push(jobs.map((job) => job.name));
        if (snapshots.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        activeSaves--;
      }
    );
    (
      scheduler as unknown as {
        jobStore: { saveAgentJobs: typeof saveAgentJobs };
      }
    ).jobStore = {
      saveAgentJobs,
    };

    const first = scheduler.add("alpha", {
      name: "First",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: { message: "one" },
    });
    await vi.waitFor(() => expect(saveAgentJobs).toHaveBeenCalledTimes(1));
    const second = scheduler.add("alpha", {
      name: "Second",
      schedule: { cron: "0 9 * * *", tz: "UTC" },
      payload: { message: "two" },
    });

    await Promise.resolve();
    expect(maxActiveSaves).toBe(1);
    expect(saveAgentJobs).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(snapshots).toEqual([["First"], ["First", "Second"]]);
    expect(maxActiveSaves).toBe(1);
  });

  it("does not re-arm a timer after stop while a tick is pending", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-stop-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config));
    const scheduler = new SchedulerService();
    await scheduler.add("alpha", {
      name: "Future",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: { message: "run" },
    });

    let finishTick!: () => void;
    const internals = scheduler as unknown as SchedulerWithInternals;
    internals.runDueJobs = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTick = resolve;
        })
    );

    const tick = internals.tick();
    await scheduler.stop();
    finishTick();
    await tick;

    expect(internals.timer).toBeNull();
  });
});

describe("SchedulerService timeout and loop isolation", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    try {
      await stopScheduler();
    } catch {
      // ignore
    }
    clearSchedulerContext();
    vi.restoreAllMocks();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("times out a hung runAgent and marks the run error, then re-arms the timer", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-timeout-")
    );
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));

    // runAgent never resolves — simulates a hung tool call
    const runAgent = vi.fn(() => new Promise<never>(() => {}));
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true, jobTimeoutMs: 500 } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config, runAgent));
    const scheduler = new SchedulerService();
    await scheduler.add("alpha", {
      name: "Hung",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: { message: "Hang" },
    });

    // Force the job to be due now
    const [loadedJob] = (await scheduler.list("alpha")) as Array<{
      state?: { nextRunAtMs?: number };
    }>;
    loadedJob!.state = { nextRunAtMs: Date.now() - 1 };

    const internals = scheduler as unknown as SchedulerWithInternals;

    // Drive tick() directly — its finally block must re-arm even after the hung job times out.
    const tickPromise = internals.tick();
    await vi.advanceTimersByTimeAsync(600);
    await tickPromise;

    // tick()'s finally block must have called armTimer(), setting a future timer.
    expect(internals.timer).not.toBeNull();

    // Job state should reflect the timeout error
    const [after] = (await scheduler.list("alpha")) as Array<{
      state?: { lastStatus?: string; lastError?: string; nextRunAtMs?: number };
    }>;
    expect(after?.state?.lastStatus).toBe("error");
    expect(after?.state?.lastError).toMatch(/timed out/i);
    expect(after?.state?.nextRunAtMs).toBeGreaterThan(Date.now());

    vi.useRealTimers();
  });

  it("a hung job does not block unrelated due jobs from running", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-isolation-")
    );
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const beta = agent("beta", path.join(tmpDir, "beta"));

    let betaFinished = false;
    const runAgent = vi.fn((args: { agentId: string }) => {
      if (args.agentId === "alpha") return new Promise<never>(() => {}); // hangs forever
      betaFinished = true;
      return Promise.resolve({
        payloads: [{ text: "beta done" }],
        meta: { durationMs: 1, sessionId: "beta-session" },
      });
    });

    const config: GatewayConfig = {
      version: 3,
      agents: [alpha, beta],
      extensions: { scheduler: { enabled: true, jobTimeoutMs: 500 } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config, runAgent));
    const scheduler = new SchedulerService();

    // Add one job per agent, both due now
    await scheduler.add("alpha", {
      name: "Hung",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: { message: "Hang" },
    });
    await scheduler.add("beta", {
      name: "Quick",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: { message: "Go" },
    });

    const jobs = (await scheduler.list()) as Array<{
      state?: { nextRunAtMs?: number };
    }>;
    for (const j of jobs) j.state = { nextRunAtMs: Date.now() - 1 };

    const internals = scheduler as unknown as SchedulerWithInternals;
    const tickPromise = internals.runDueJobs();
    await vi.advanceTimersByTimeAsync(600);
    await tickPromise;

    expect(betaFinished).toBe(true);

    const [, betaJob] = (await scheduler.list()) as Array<{
      state?: { lastStatus?: string };
    }>;
    expect(betaJob?.state?.lastStatus).toBe("ok");

    vi.useRealTimers();
  });

  it("abort signal is fired on runAgent when job times out", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-abort-")
    );
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));

    let receivedSignal: AbortSignal | undefined;
    const runAgent = vi.fn((params: { signal?: AbortSignal }) => {
      receivedSignal = params.signal;
      return new Promise<never>(() => {}); // hangs forever
    });

    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true, jobTimeoutMs: 20 } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config, runAgent));
    const scheduler = new SchedulerService();
    await scheduler.add("alpha", {
      name: "Hung",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: { message: "Hang" },
    });

    const [loadedJob] = (await scheduler.list("alpha")) as Array<{
      state?: { nextRunAtMs?: number };
    }>;
    loadedJob!.state = { nextRunAtMs: Date.now() - 1 };

    const internals = scheduler as unknown as SchedulerWithInternals;
    await internals.runDueJobs();

    // The abort signal passed to runAgent must have been aborted on timeout.
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });

  it("executingJobs stays populated after timeout until runAgent actually resolves, blocking overlap", async () => {
    // Real timers with a very short jobTimeoutMs to avoid fake-timer / I/O deadlocks.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-overlap-")
    );
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));

    const rejectCallbacks: Array<(err: Error) => void> = [];
    const runAgent = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          rejectCallbacks.push(reject);
        })
    );

    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true, jobTimeoutMs: 20 } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config, runAgent));
    const scheduler = new SchedulerService();
    await scheduler.add("alpha", {
      name: "Hung",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: { message: "Hang" },
    });

    const [loadedJob] = (await scheduler.list("alpha")) as Array<{
      state?: { nextRunAtMs?: number };
    }>;

    const internals = scheduler as unknown as SchedulerWithInternals;

    // First fire — job hangs and times out after 20ms.
    loadedJob!.state = { nextRunAtMs: Date.now() - 1 };
    await internals.runDueJobs();

    // runDueJobs has returned but the underlying runPromise (#1) is still pending.
    // executingJobs must still hold the key, blocking the next fire.
    loadedJob!.state!.nextRunAtMs = Date.now() - 1;
    await internals.runDueJobs();

    // Only one call to runAgent: the second fire was blocked by ScheduleAlreadyRunningError.
    expect(runAgent).toHaveBeenCalledTimes(1);

    // Simulate abort completing: the original run rejects.
    rejectCallbacks[0]!(new Error("aborted"));
    // Drain microtasks so runPromise.finally() clears executingJobs.
    await new Promise<void>((r) => setTimeout(r, 0));

    // Now executingJobs is clear — the next fire should start a fresh run.
    loadedJob!.state!.nextRunAtMs = Date.now() - 1;
    await internals.runDueJobs();

    expect(runAgent).toHaveBeenCalledTimes(2);

    // Clean up: reject run #2 so its promise settles before afterEach deletes tmpDir.
    if (rejectCallbacks[1]) rejectCallbacks[1](new Error("aborted"));
    await new Promise<void>((r) => setTimeout(r, 50));
  });
});
