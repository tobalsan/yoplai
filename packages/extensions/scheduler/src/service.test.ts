import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentConfig,
  DeliverySink,
  ExtensionContext,
  GatewayConfig,
  SchedulePayload,
} from "@yoplai/shared";
import { MAX_DELIVERY_CHARS } from "./deliver.js";
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

// SchedulePayloadSchema defaults noAgent/quietOutput, so the parsed type
// requires them; tests build payloads through this helper.
function jobPayload(overrides: Partial<SchedulePayload>): SchedulePayload {
  return { noAgent: false, quietOutput: false, ...overrides };
}

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

function context(
  config: GatewayConfig,
  runAgent = vi.fn(),
  sinks: Record<string, DeliverySink> = {}
): ExtensionContext {
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
    registerDeliverySink: vi.fn(() => () => {}),
    getDeliverySink: (id: string) => sinks[id],
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
      payload: jobPayload({ message: "Run" }),
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
        trace: expect.objectContaining({ surface: "scheduler" }),
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
      payload: jobPayload({ message: "Run" }),
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
      payload: jobPayload({ message: "Run" }),
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
      payload: jobPayload({ message: "one" }),
    });
    await vi.waitFor(() => expect(saveAgentJobs).toHaveBeenCalledTimes(1));
    const second = scheduler.add("alpha", {
      name: "Second",
      schedule: { cron: "0 9 * * *", tz: "UTC" },
      payload: jobPayload({ message: "two" }),
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
      payload: jobPayload({ message: "run" }),
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
      payload: jobPayload({ message: "Hang" }),
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
      payload: jobPayload({ message: "Hang" }),
    });
    await scheduler.add("beta", {
      name: "Quick",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: jobPayload({ message: "Go" }),
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
      payload: jobPayload({ message: "Hang" }),
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
      payload: jobPayload({ message: "Hang" }),
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

describe("SchedulerService script jobs", () => {
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

  async function setup(script: string, runAgent = vi.fn()) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-script-")
    );
    const workspace = path.join(tmpDir, "alpha");
    await fs.mkdir(path.join(workspace, "bin"), { recursive: true });
    await fs.writeFile(path.join(workspace, "bin", "gate.sh"), script, "utf8");
    const config: GatewayConfig = {
      version: 3,
      agents: [agent("alpha", workspace)],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config, runAgent));
    return { scheduler: new SchedulerService(), runAgent, workspace };
  }

  type JobState = {
    state?: {
      lastStatus?: string;
      lastError?: string;
      lastExitCode?: number;
      lastRunKind?: string;
      lastRunAtMs?: number;
    };
  };

  it("runs a script-only job to completion without ever calling runAgent", async () => {
    const { scheduler, runAgent } = await setup("echo rotated\n");
    const job = await scheduler.add("alpha", {
      name: "Rotate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", noAgent: true }),
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    expect(result.sessionId).toBeUndefined();
    const content = await fs.readFile(result.outputPath!, "utf8");
    expect(content).toContain("**Status:** ok");
    expect(content).not.toContain("## Prompt");
    expect(content).toContain("## Response\n\nrotated");

    const [after] = (await scheduler.list("alpha")) as JobState[];
    expect(after?.state?.lastStatus).toBe("ok");
    expect(after?.state?.lastRunKind).toBe("script_only");
  });

  it("records a silent tick without calling runAgent", async () => {
    const { scheduler, runAgent } = await setup(
      "echo '{\"wakeAgent\":false}'\n"
    );
    const job = await scheduler.add("alpha", {
      name: "Gate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", message: "Digest" }),
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.status).toBe("ok");
    const content = await fs.readFile(result.outputPath!, "utf8");
    expect(content).toContain("**Status:** ok (silent tick)");
    expect(content).toContain("## Response\n\nsilent tick");

    const [after] = (await scheduler.list("alpha")) as JobState[];
    expect(after?.state?.lastRunKind).toBe("silent_tick");
  });

  it("wakes the agent with the gate context appended to the message", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "Two new rows." }],
      meta: { durationMs: 3, sessionId: "gated-session" },
    });
    const { scheduler } = await setup(
      'echo \'{"wakeAgent":true,"context":{"count":2}}\'\n',
      runAgent
    );
    const job = await scheduler.add("alpha", {
      name: "Gate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", message: "Digest" }),
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Digest\n\nGate context:\n{"count":2}',
      })
    );
    expect(result.status).toBe("ok");
    expect(result.sessionId).toBe("gated-session");
    const content = await fs.readFile(result.outputPath!, "utf8");
    expect(content).toContain("**Status:** woke agent");
    expect(content).toContain("## Prompt\n\nDigest");
    expect(content).toContain('## Gate Output\n\n{"wakeAgent":true');
    expect(content).toContain("## Response\n\nTwo new rows.");

    const [after] = (await scheduler.list("alpha")) as JobState[];
    expect(after?.state?.lastRunKind).toBe("woke_agent");
  });

  it("records a script failure mechanically and never invokes the agent", async () => {
    const { scheduler, runAgent } = await setup("echo boom >&2\nexit 3\n");
    const job = await scheduler.add("alpha", {
      name: "Gate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", message: "Digest" }),
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(runAgent).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(result.error).toContain("script failed (exit 3)");
    const content = await fs.readFile(result.outputPath!, "utf8");
    expect(content).toContain("**Status:** script failed (exit 3)");
    expect(content).toContain("exit_code: 3");
    expect(content).toContain("boom");

    const [after] = (await scheduler.list("alpha")) as JobState[];
    expect(after?.state?.lastStatus).toBe("error");
    expect(after?.state?.lastExitCode).toBe(3);
  });

  it("skips the output file for a quiet uneventful run but still updates state", async () => {
    const { scheduler } = await setup("exit 0\n");
    const job = await scheduler.add("alpha", {
      name: "Quiet",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({
        script: "bin/gate.sh",
        noAgent: true,
        quietOutput: true,
      }),
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(result.status).toBe("ok");
    expect(result.outputPath).toBeUndefined();
    await expect(
      fs.readdir(path.join(tmpDir!, "alpha", "cron", "output", job.id))
    ).rejects.toThrow();

    const [after] = (await scheduler.list("alpha")) as JobState[];
    expect(after?.state?.lastStatus).toBe("ok");
    expect(after?.state?.lastRunKind).toBe("script_only");
    expect(after?.state?.lastRunAtMs).toBeGreaterThan(0);
  });

  it("still writes the output file for a quiet job whose script fails", async () => {
    const { scheduler } = await setup("exit 1\n");
    const job = await scheduler.add("alpha", {
      name: "Quiet",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({
        script: "bin/gate.sh",
        noAgent: true,
        quietOutput: true,
      }),
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(result.status).toBe("error");
    expect(result.outputPath).toBeDefined();
    await expect(fs.readFile(result.outputPath!, "utf8")).resolves.toContain(
      "**Status:** script failed (exit 1)"
    );
  });
});

describe("SchedulerService delivery", () => {
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

  type Delivered = { destination: unknown; text: string };

  function recordingSink(delivered: Delivered[]): DeliverySink {
    return async ({ destination, text }) => {
      delivered.push({ destination, text });
    };
  }

  async function setup(options: {
    script?: string;
    runAgent?: ReturnType<typeof vi.fn>;
    sinks: Record<string, DeliverySink>;
  }) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-scheduler-deliver-")
    );
    const workspace = path.join(tmpDir, "alpha");
    await fs.mkdir(path.join(workspace, "bin"), { recursive: true });
    if (options.script) {
      await fs.writeFile(
        path.join(workspace, "bin", "gate.sh"),
        options.script,
        "utf8"
      );
    }
    const config: GatewayConfig = {
      version: 3,
      agents: [agent("alpha", workspace)],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    const runAgent =
      options.runAgent ??
      vi.fn().mockResolvedValue({
        payloads: [{ text: "Two new rows." }],
        meta: { durationMs: 3, sessionId: "s" },
      });
    setSchedulerContext(context(config, runAgent, options.sinks));
    return { scheduler: new SchedulerService(), runAgent };
  }

  type JobDeliveryState = {
    state?: {
      lastStatus?: string;
      lastDelivery?: Array<{ target: string; ok: boolean; error?: string }>;
    };
  };

  it("delivers an agent job's response to every configured target", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      sinks: { slack: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ message: "Run" }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(delivered).toEqual([
      {
        destination: { channel: "C0123", user: undefined },
        text: "Two new rows.",
      },
    ]);
    await expect(fs.readFile(result.outputPath!, "utf8")).resolves.toContain(
      "## Delivery\n\n- slack: delivered"
    );
    const [after] = (await scheduler.list("alpha")) as JobDeliveryState[];
    expect(after?.state?.lastDelivery).toEqual([{ target: "slack", ok: true }]);
  });

  it("delivers a script-only job's stdout but stays silent on empty stdout", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      script: "exit 0\n",
      sinks: { slack: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Rotate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", noAgent: true }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(result.status).toBe("ok");
    expect(delivered).toEqual([]);
    await expect(fs.readFile(result.outputPath!, "utf8")).resolves.not.toContain(
      "## Delivery"
    );
  });

  it("delivers a script-only job's trimmed stdout", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      script: "echo rotated\n",
      sinks: { telegram: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Rotate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", noAgent: true }),
      deliver: [{ target: "telegram", user: "12345" }],
    });

    await scheduler.runNow("alpha", job.id);

    expect(delivered).toEqual([
      { destination: { channel: undefined, user: "12345" }, text: "rotated" },
    ]);
  });

  it("delivers nothing on a silent tick", async () => {
    const delivered: Delivered[] = [];
    const { scheduler, runAgent } = await setup({
      script: "echo '{\"wakeAgent\":false}'\n",
      sinks: { slack: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Gate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", message: "Digest" }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    await scheduler.runNow("alpha", job.id);

    expect(runAgent).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
  });

  it("delivers the agent's response when the gate woke it", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      script: 'echo \'{"wakeAgent":true,"context":{"count":2}}\'\n',
      sinks: { slack: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Gate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", message: "Digest" }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    await scheduler.runNow("alpha", job.id);

    expect(delivered.map((entry) => entry.text)).toEqual(["Two new rows."]);
  });

  it("always delivers an alert when the script fails", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      script: "echo boom >&2\nexit 3\n",
      sinks: { slack: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Rotate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", noAgent: true }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(result.status).toBe("error");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain('Cron job "Rotate" failed:');
    expect(delivered[0]!.text).toContain("script failed (exit 3)");
  });

  it("delivers an alert even when quietOutput skipped the output file", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      script: "exit 4\n",
      sinks: { slack: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Quiet",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({
        script: "bin/gate.sh",
        noAgent: true,
        quietOutput: true,
      }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    await scheduler.runNow("alpha", job.id);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("script failed (exit 4)");
  });

  it("keeps the run ok and records a warning for an unregistered target", async () => {
    const { scheduler } = await setup({ sinks: {} });
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ message: "Run" }),
      deliver: [{ target: "irc", channel: "#ops" }],
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(result.status).toBe("ok");
    await expect(fs.readFile(result.outputPath!, "utf8")).resolves.toContain(
      '- irc: warning: no delivery sink registered for "irc"'
    );
    const [after] = (await scheduler.list("alpha")) as JobDeliveryState[];
    expect(after?.state?.lastStatus).toBe("ok");
    expect(after?.state?.lastDelivery).toEqual([
      {
        target: "irc",
        ok: false,
        error: 'no delivery sink registered for "irc"',
      },
    ]);
  });

  it("a throwing sink is a warning and does not block the other targets", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      sinks: {
        slack: async () => {
          throw new Error("missing scope");
        },
        telegram: recordingSink(delivered),
      },
    });
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ message: "Run" }),
      deliver: [
        { target: "slack", channel: "C0123" },
        { target: "telegram", user: "12345" },
      ],
    });

    const result = await scheduler.runNow("alpha", job.id);

    expect(result.status).toBe("ok");
    expect(delivered).toHaveLength(1);
    const content = await fs.readFile(result.outputPath!, "utf8");
    expect(content).toContain("- slack: warning: missing scope");
    expect(content).toContain("- telegram: delivered");
  });

  function blockingSink(): {
    sink: DeliverySink;
    entered: Promise<void>;
    release: () => void;
  } {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      sink: async () => {
        enter();
        await blocked;
      },
      entered,
      release,
    };
  }

  // Delivery is a network call that runs after the run itself resolved; if the
  // overlap guard were released before it, another fire path would start a
  // second copy of the same job while the first is still delivering.
  it("holds the overlap guard while a script-only job is still delivering", async () => {
    const slack = blockingSink();
    const { scheduler } = await setup({
      script: "echo rotated\n",
      sinks: { slack: slack.sink },
    });
    const job = await scheduler.add("alpha", {
      name: "Rotate",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ script: "bin/gate.sh", noAgent: true }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    const firstRun = scheduler.runNow("alpha", job.id);
    await slack.entered;

    await expect(scheduler.runNow("alpha", job.id)).rejects.toBeInstanceOf(
      ScheduleAlreadyRunningError
    );

    slack.release();
    await expect(firstRun).resolves.toMatchObject({ status: "ok" });
  });

  it("holds the overlap guard while an agent job is still delivering", async () => {
    const slack = blockingSink();
    const { scheduler, runAgent } = await setup({ sinks: { slack: slack.sink } });
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ message: "Run" }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    const firstRun = scheduler.runNow("alpha", job.id);
    await slack.entered;

    await expect(scheduler.runNow("alpha", job.id)).rejects.toBeInstanceOf(
      ScheduleAlreadyRunningError
    );
    expect(runAgent).toHaveBeenCalledTimes(1);

    slack.release();
    await expect(firstRun).resolves.toMatchObject({ status: "ok" });
  });

  // A failed output write used to escape completeRun before the reschedule, so
  // nextRunAtMs stayed in the past and every tick re-fired and re-delivered.
  it("reschedules after a failed output write instead of re-delivering forever", async () => {
    const delivered: Delivered[] = [];
    const { scheduler } = await setup({
      sinks: { slack: recordingSink(delivered) },
    });
    // Make the run output undeliverable to disk: a file where cron/output goes.
    const cronDir = path.join(tmpDir!, "alpha", "cron");
    await fs.mkdir(cronDir, { recursive: true });
    await fs.writeFile(path.join(cronDir, "output"), "not a dir", "utf8");
    await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "* * * * *", tz: "UTC" },
      payload: jobPayload({ message: "Run" }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });
    const [loaded] = (await scheduler.list("alpha")) as Array<{
      state?: { nextRunAtMs?: number };
    }>;
    loaded!.state!.nextRunAtMs = Date.now() - 1;

    const internals = scheduler as unknown as { runDueJobs(): Promise<void> };
    await internals.runDueJobs();
    await internals.runDueJobs();

    expect(delivered).toHaveLength(1);
    const [after] = (await scheduler.list("alpha")) as Array<{
      state?: { nextRunAtMs?: number };
    }>;
    expect(after?.state?.nextRunAtMs).toBeGreaterThan(Date.now());
  });

  it("truncates an oversized response before delivering it", async () => {
    const delivered: Delivered[] = [];
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "x".repeat(10_000) }],
      meta: { durationMs: 3, sessionId: "s" },
    });
    const { scheduler } = await setup({
      runAgent,
      sinks: { slack: recordingSink(delivered) },
    });
    const job = await scheduler.add("alpha", {
      name: "Digest",
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: jobPayload({ message: "Run" }),
      deliver: [{ target: "slack", channel: "C0123" }],
    });

    await scheduler.runNow("alpha", job.id);

    expect(delivered[0]!.text).toHaveLength(MAX_DELIVERY_CHARS);
    expect(delivered[0]!.text.endsWith("\n[truncated]")).toBe(true);
  });
});
