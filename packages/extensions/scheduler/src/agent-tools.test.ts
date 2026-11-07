import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ExtensionContext, GatewayConfig } from "@yoplai/shared";
import { schedulerExtension } from "./index.js";
import { clearSchedulerContext, setSchedulerContext, stopScheduler } from "./service.js";

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

async function writeScript(workspace: string, script: string, mode = 0o644): Promise<void> {
  const file = path.join(workspace, script);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "#!/usr/bin/env bash\necho ok\n", { mode });
  await fs.chmod(file, mode);
}

function context(config: GatewayConfig): ExtensionContext {
  return {
    getConfig: () => config,
    getDataDir: () => os.tmpdir(),
    reloadConfig: () => undefined,
    getAgent: (id) => config.agents.find((candidate) => candidate.id === id),
    getAgents: () => config.agents,
    isAgentActive: () => true,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: (candidate) => candidate.workspaceDir ?? candidate.workspace,
    runAgent: vi.fn(async () => ({ payloads: [], meta: { durationMs: 0, sessionId: "session" } })),
    getSubagentTemplates: () => [],
    resolveSessionId: vi.fn(),
    getSessionEntry: vi.fn(),
    hasSession: async () => false,
    resetSession: async () => {},
    ensureSession: async () => ({ sessionId: "session", updatedAt: 0 }),
    clearSessionEntry: vi.fn(),
    restoreSessionUpdatedAt: vi.fn(),
    deleteSession: vi.fn(),
    invalidateHistoryCache: vi.fn(),
    getSessionHistory: vi.fn(),
    saveMediaFile: vi.fn(),
    readMediaFile: vi.fn(),
    registerDeliverySink: vi.fn(() => () => {}),
    getDeliverySink: vi.fn(() => undefined),
    registerUserNotifier: () => () => {},
    getUserNotifiers: () => new Map(),
    subscribe: vi.fn(() => () => {}),
    emit: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("scheduler agent tools", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    try {
      await stopScheduler();
    } catch {
      // No scheduler context was initialized in disabled-tool tests.
    }
    clearSchedulerContext();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("offers the requester's paired Slack destination in the run prompt", async () => {
    const alpha = agent("alpha", "/tmp/fixture-agent");
    const config: GatewayConfig = { version: 3, agents: [alpha], sessions: { idleMinutes: 360 } };
    setSchedulerContext({
      ...context(config),
      getDeliveryOffers: async (_agent, { userId }) => userId === "requester-1"
        ? [{ target: "slack", label: "Slack", dm: { user: "U_FIXTURE_1" }, channel: true }]
        : [],
    });

    const prompt = await schedulerExtension.getSystemPromptContributions!(alpha, { config, userId: "requester-1" });

    expect(prompt).toContain('Do you want the results posted somewhere?');
    expect(prompt).toContain('DM to you on Slack');
    expect(prompt).toContain('"user":"U_FIXTURE_1"');
    expect(prompt).not.toContain("discord");
    expect(await schedulerExtension.getSystemPromptContributions!(alpha, { config, userId: "requester-2" }))
      .not.toContain("Do you want the results posted somewhere?");
  });

  it("describes offered targets and every-run delivery in create and update tools", async () => {
    const alpha = agent("alpha", "/tmp/fixture-agent");
    const tools = await schedulerExtension.getAgentTools!(alpha);
    for (const name of ["scheduler.create_job", "scheduler.update_job"]) {
      const parameters = tools.find((tool) => tool.name === name)!.parameters;
      expect(parameters).toMatchObject({ properties: { deliver: {
        description: expect.stringContaining("every run's result, not only errors"),
        items: { properties: { target: { description: "Delivery sink id from the offered list in the system prompt." } } },
      } } });
    }
  });

  it("tells the agent in create and update tools that scripts run on the gateway host", async () => {
    const alpha = agent("alpha", "/tmp/fixture-agent");
    const tools = await schedulerExtension.getAgentTools!(alpha);
    for (const name of ["scheduler.create_job", "scheduler.update_job"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      const scriptParameter = (tool.parameters as { properties: { script: { description: string } } }).properties.script.description;
      for (const text of [tool.description, scriptParameter]) {
        expect(text).toContain("gateway host");
        expect(text).toContain("/workspace/files");
        expect(text).toContain("chmod +x");
      }
    }
  });

  it("preserves credential guidance during discovery and when no delivery options exist", async () => {
    const alpha = agent("alpha", "/tmp/fixture-agent");
    const config: GatewayConfig = { version: 3, agents: [alpha], sessions: { idleMinutes: 360 } };
    const original = await schedulerExtension.getSystemPromptContributions!(alpha);
    expect(original).toContain("Scheduled jobs: Mine (owner)");
    expect(await schedulerExtension.getSystemPromptContributions!(alpha, { config })).toBe(original);
    setSchedulerContext({ ...context(config), getDeliveryOffers: async () => [] });
    expect(await schedulerExtension.getSystemPromptContributions!(alpha, { config })).toBe(original);
    expect(await schedulerExtension.getSystemPromptContributions!(alpha)).toBe(original);
    setSchedulerContext(context(config));
    expect(await schedulerExtension.getSystemPromptContributions!(alpha, { config })).toBe(original);
  });

  it("hides tools when scheduler is disabled", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: false } }, sessions: { idleMinutes: 360 } };

    expect(await schedulerExtension.getAgentTools?.(alpha, { config })).toEqual([]);
  });

  it("creates, lists, updates, and deletes caller agent jobs", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const beta = agent("beta", path.join(tmpDir, "beta"));
    const config: GatewayConfig = { version: 3, agents: [alpha, beta], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));

    const created = await byName.get("scheduler.create_job")!.execute(
      { name: "Digest", cron: "0 8 * * *", tz: "UTC", message: "Run", sessionId: "daily" },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string } };

    expect(created.ok).toBe(true);
    const jobId = created.job.id;
    const listed = await byName.get("scheduler.list_jobs")!.execute({}, { agent: alpha, config }) as { ok: boolean; jobs: Array<{ id: string; agentId: string }> };
    expect(listed.jobs).toMatchObject([{ id: jobId, agentId: "alpha" }]);

    const betaList = await byName.get("scheduler.list_jobs")!.execute({}, { agent: beta, config }) as { ok: boolean; jobs: unknown[] };
    expect(betaList.jobs).toEqual([]);

    const updated = await byName.get("scheduler.update_job")!.execute(
      { jobId, enabled: false, message: "Run updated" },
      { agent: alpha, config }
    ) as { ok: boolean; job: { enabled: boolean; payload: { message: string; sessionId?: string } } };
    expect(updated.job.enabled).toBe(false);
    expect(updated.job.payload).toMatchObject({ message: "Run updated", sessionId: "daily" });

    const cleared = await byName.get("scheduler.update_job")!.execute(
      { jobId, sessionId: null },
      { agent: alpha, config }
    ) as { ok: boolean; job: { payload: { message: string; sessionId?: string } } };
    expect(cleared.job.payload).toMatchObject({ message: "Run updated" });
    expect(cleared.job.payload.sessionId).toBeUndefined();

    const run = await byName.get("scheduler.run_job")!.execute({ jobId }, { agent: alpha, config }) as { ok: boolean; status?: string };
    expect(run).toMatchObject({ ok: true, status: "accepted" });
    await vi.waitFor(async () => {
      const finished = await byName.get("scheduler.list_jobs")!.execute({}, { agent: alpha, config }) as { jobs: Array<{ state?: { lastStatus?: string; runningForMs?: number } }> };
      expect(finished.jobs[0]?.state?.lastStatus).toBe("ok");
      expect(finished.jobs[0]?.state?.runningForMs).toBeUndefined();
    });
    const betaRun = await byName.get("scheduler.run_job")!.execute({ jobId }, { agent: beta, config }) as { ok: boolean };
    expect(betaRun.ok).toBe(false);

    const deleted = await byName.get("scheduler.delete_job")!.execute({ jobId }, { agent: alpha, config }) as { ok: boolean };
    expect(deleted.ok).toBe(true);
  });

  it("shares authenticated Team chat jobs and keeps default Mine jobs private", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-sharing-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools!(alpha, { config });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const alice = { agent: alpha, config, userId: "alice" };
    const bob = { agent: alpha, config, userId: "bob" };
    const input = { name: "Digest", cron: "0 8 * * *", tz: "UTC", message: "Run" };
    const team = await byName.get("scheduler.create_job")!.execute({ ...input, credentialMode: "team" }, alice) as { ok: boolean; job: { id: string; ownerUserId?: string } };
    expect(team).toMatchObject({ ok: true, job: { credentialMode: "team", createdByUserId: "alice" } });
    expect(team.job.ownerUserId).toBeUndefined();
    const mine = await byName.get("scheduler.create_job")!.execute(input, alice) as { ok: boolean; job: { id: string } };
    expect(mine).toMatchObject({ ok: true, job: { credentialMode: "owner", ownerUserId: "alice", createdByUserId: "alice" } });
    const listed = await byName.get("scheduler.list_jobs")!.execute({}, bob) as { ok: boolean; jobs: Array<{ id: string }> };
    expect(listed).toMatchObject({ ok: true, jobs: [{ id: team.job.id }] });
    expect(listed.jobs).toHaveLength(1);
    expect(await byName.get("scheduler.update_job")!.execute({ jobId: team.job.id, name: "Team digest" }, bob)).toMatchObject({ ok: true, job: { name: "Team digest", createdByUserId: "alice" } });
    expect(await byName.get("scheduler.update_job")!.execute({ jobId: mine.job.id, name: "Hidden" }, bob)).toMatchObject({ ok: false, error: "Schedule owner access required" });
  });

  it("returns structured validation errors", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const create = tools!.find((tool) => tool.name === "scheduler.create_job")!;
    const latestOutput = tools!.find((tool) => tool.name === "scheduler.get_latest_output")!;

    const result = await create.execute({ name: "Bad", cron: "", tz: "UTC", message: "Run" }, { agent: alpha, config }) as { ok: boolean; error?: string };
    const missingJobId = await latestOutput.execute({}, { agent: alpha, config }) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("cron");
    expect(latestOutput.description).toContain("scheduler.list_jobs");
    expect(latestOutput.parameters).toMatchObject({
      required: ["jobId"],
      properties: {
        jobId: { description: expect.stringContaining("scheduler.list_jobs") },
        maxChars: { description: expect.stringContaining("Defaults to 4000") },
      },
    });
    expect(missingJobId).toEqual({
      ok: false,
      error: "jobId is required. Call scheduler.list_jobs first, then pass the selected jobs[n].id as jobId.",
    });
  });

  it("creates a script-only job via the tool", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const create = tools!.find((tool) => tool.name === "scheduler.create_job")!;
    await writeScript(alpha.workspace, "scripts/rotate.sh");

    const created = await create.execute(
      { name: "Rotate token", cron: "*/5 * * * *", tz: "UTC", script: "scripts/rotate.sh", noAgent: true },
      { agent: alpha, config }
    ) as { ok: boolean; job: { payload: { script?: string; noAgent?: boolean; message?: string } } };

    expect(created.ok).toBe(true);
    expect(created.job.payload).toMatchObject({ script: "scripts/rotate.sh", noAgent: true });
    expect(created.job.payload.message).toBeUndefined();
  });

  it("creates a gated job via the tool", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const create = tools!.find((tool) => tool.name === "scheduler.create_job")!;
    await writeScript(alpha.workspace, "scripts/gate.sh");

    const created = await create.execute(
      { name: "File watch", cron: "*/5 * * * *", tz: "UTC", script: "scripts/gate.sh", message: "Investigate the change" },
      { agent: alpha, config }
    ) as { ok: boolean; job: { payload: { script?: string; noAgent?: boolean; message?: string } } };

    expect(created.ok).toBe(true);
    expect(created.job.payload).toMatchObject({
      script: "scripts/gate.sh",
      message: "Investigate the change",
    });
    expect(created.job.payload.noAgent).toBeFalsy();
  });

  it("rejects creating a job whose script is missing from the workspace and stores nothing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    await fs.mkdir(alpha.workspace, { recursive: true });
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));

    const result = await byName.get("scheduler.create_job")!.execute(
      { name: "Ticket gate", cron: "* * * * *", tz: "UTC", script: "files/ticket-monitor/monitor.py", message: "Draft a reply" },
      { agent: alpha, config }
    ) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("script not found");
    expect(result.error).toContain("run on the gateway host");
    expect(result.error).toContain("/workspace/files");
    const listed = await byName.get("scheduler.list_jobs")!.execute({}, { agent: alpha, config }) as { jobs: unknown[] };
    expect(listed.jobs).toEqual([]);
  });

  it("rejects updating a job to a missing script and leaves the job unchanged", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));
    await writeScript(alpha.workspace, "data/ticket-monitor/gate.sh");
    const created = await byName.get("scheduler.create_job")!.execute(
      { name: "Ticket gate", cron: "* * * * *", tz: "UTC", script: "data/ticket-monitor/gate.sh", message: "Draft a reply" },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string } };
    expect(created.ok).toBe(true);

    const result = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, script: "files/ticket-monitor/gate.sh", name: "Renamed gate" },
      { agent: alpha, config }
    ) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("script not found");
    expect(result.error).toContain("run on the gateway host");
    const listed = await byName.get("scheduler.list_jobs")!.execute({}, { agent: alpha, config }) as { jobs: Array<{ name: string; payload: { script?: string } }> };
    expect(listed.jobs).toMatchObject([{ name: "Ticket gate", payload: { script: "data/ticket-monitor/gate.sh" } }]);
  });

  it("adds the host/workspace hint when a container path or '..' is given as the script", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));
    await writeScript(alpha.workspace, "data/ticket-monitor/gate.sh");
    const created = await byName.get("scheduler.create_job")!.execute(
      { name: "Ticket gate", cron: "* * * * *", tz: "UTC", script: "data/ticket-monitor/gate.sh", noAgent: true },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string } };
    expect(created.ok).toBe(true);

    for (const script of ["/workspace/files/ticket-monitor/monitor.py", "../shared/monitor.py"]) {
      const onCreate = await byName.get("scheduler.create_job")!.execute(
        { name: "Other gate", cron: "* * * * *", tz: "UTC", script, noAgent: true },
        { agent: alpha, config }
      ) as { ok: boolean; error?: string };
      const onUpdate = await byName.get("scheduler.update_job")!.execute(
        { jobId: created.job.id, script },
        { agent: alpha, config }
      ) as { ok: boolean; error?: string };
      for (const result of [onCreate, onUpdate]) {
        expect(result.ok).toBe(false);
        expect(result.error).toContain("run on the gateway host");
      }
    }
    const listed = await byName.get("scheduler.list_jobs")!.execute({}, { agent: alpha, config }) as { jobs: Array<{ payload: { script?: string } }> };
    expect(listed.jobs).toMatchObject([{ payload: { script: "data/ticket-monitor/gate.sh" } }]);
  });

  it("still renames and pauses a job whose stored script has gone missing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));
    await writeScript(alpha.workspace, "scripts/sweep.sh");
    const created = await byName.get("scheduler.create_job")!.execute(
      { name: "Sweep", cron: "0 * * * *", tz: "UTC", script: "scripts/sweep.sh", noAgent: true },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string } };
    expect(created.ok).toBe(true);
    await fs.rm(path.join(alpha.workspace, "scripts/sweep.sh"));

    const updated = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, name: "Sweep (paused)", enabled: false, quietOutput: true },
      { agent: alpha, config }
    );

    expect(updated).toMatchObject({ ok: true, job: { name: "Sweep (paused)", enabled: false, payload: { script: "scripts/sweep.sh", quietOutput: true } } });
  });

  it("requires the exec bit for non-shell scripts on create and update, but not for .sh", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));
    const create = byName.get("scheduler.create_job")!;
    const update = byName.get("scheduler.update_job")!;
    await writeScript(alpha.workspace, "data/report/refresh.py", 0o644);
    await writeScript(alpha.workspace, "data/report/refresh.sh", 0o644);
    const job = { name: "Report refresh", cron: "0 7 * * 1-5", tz: "UTC", noAgent: true };

    const rejected = await create.execute({ ...job, script: "data/report/refresh.py" }, { agent: alpha, config }) as { ok: boolean; error?: string };
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("is not executable");
    expect(rejected.error).toContain("chmod +x");
    expect(rejected.error).toContain("shebang");

    const shell = await create.execute({ ...job, script: "data/report/refresh.sh" }, { agent: alpha, config }) as { ok: boolean; job: { id: string } };
    expect(shell.ok).toBe(true);
    const rejectedUpdate = await update.execute({ jobId: shell.job.id, script: "data/report/refresh.py" }, { agent: alpha, config }) as { ok: boolean; error?: string };
    expect(rejectedUpdate.ok).toBe(false);
    expect(rejectedUpdate.error).toContain("chmod +x");

    await fs.chmod(path.join(alpha.workspace, "data/report/refresh.py"), 0o755);
    expect(await update.execute({ jobId: shell.job.id, script: "data/report/refresh.py" }, { agent: alpha, config }))
      .toMatchObject({ ok: true, job: { payload: { script: "data/report/refresh.py" } } });
    expect(await create.execute({ ...job, script: "data/report/refresh.py" }, { agent: alpha, config }))
      .toMatchObject({ ok: true, job: { payload: { script: "data/report/refresh.py" } } });
  });

  it("rejects an invalid script/message combination with a readable error", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const create = tools!.find((tool) => tool.name === "scheduler.create_job")!;
    await writeScript(alpha.workspace, "scripts/rotate.sh");

    const result = await create.execute(
      { name: "Bad", cron: "0 8 * * *", tz: "UTC", script: "scripts/rotate.sh", noAgent: true, message: "Run" },
      { agent: alpha, config }
    ) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("payload.noAgent rejects payload.message");
  });

  it("switches an agent job to script-only by clearing message with null", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));
    await writeScript(alpha.workspace, "scripts/rotate.sh");

    const created = await byName.get("scheduler.create_job")!.execute(
      { name: "Digest", cron: "0 8 * * *", tz: "UTC", message: "existing message" },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string } };
    expect(created.ok).toBe(true);

    const updated = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, script: "scripts/rotate.sh", noAgent: true, message: null },
      { agent: alpha, config }
    ) as { ok: boolean; error?: string; job: { payload: { script?: string; noAgent?: boolean; message?: string } } };

    expect(updated.error).toBeUndefined();
    expect(updated.job.payload).toMatchObject({ script: "scripts/rotate.sh", noAgent: true });
    expect(updated.job.payload.message).toBeUndefined();
  });

  it("updates an existing job's script fields", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));
    await writeScript(alpha.workspace, "scripts/rotate.sh");
    await writeScript(alpha.workspace, "scripts/rotate-v2.sh");

    const created = await byName.get("scheduler.create_job")!.execute(
      { name: "Rotate token", cron: "*/5 * * * *", tz: "UTC", script: "scripts/rotate.sh", noAgent: true },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string } };
    expect(created.ok).toBe(true);

    const updated = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, script: "scripts/rotate-v2.sh", quietOutput: true },
      { agent: alpha, config }
    ) as { ok: boolean; job: { payload: { script?: string; noAgent?: boolean; quietOutput?: boolean } } };

    expect(updated.ok).toBe(true);
    expect(updated.job.payload).toMatchObject({
      script: "scripts/rotate-v2.sh",
      noAgent: true,
      quietOutput: true,
    });
  });

  it("creates a job with deliver targets, then replaces and clears them on update", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));

    const created = await byName.get("scheduler.create_job")!.execute(
      {
        name: "Digest",
        cron: "0 8 * * *",
        tz: "UTC",
        message: "Run",
        deliver: [{ target: "slack", channel: "C0123" }],
      },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string; deliver?: unknown[] } };
    expect(created.ok).toBe(true);
    expect(created.job.deliver).toEqual([{ target: "slack", channel: "C0123" }]);

    const unchanged = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, name: "Digest v2" },
      { agent: alpha, config }
    ) as { ok: boolean; job: { deliver?: unknown[] } };
    expect(unchanged.job.deliver).toEqual([{ target: "slack", channel: "C0123" }]);

    const replaced = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, deliver: [{ target: "telegram", user: "12345" }] },
      { agent: alpha, config }
    ) as { ok: boolean; job: { deliver?: unknown[] } };
    expect(replaced.job.deliver).toEqual([{ target: "telegram", user: "12345" }]);

    const cleared = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, deliver: [] },
      { agent: alpha, config }
    ) as { ok: boolean; job: { deliver?: unknown[] } };
    expect(cleared.job.deliver).toEqual([]);
  });

  it("sets a per-job model override on create and update", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const byName = new Map(tools?.map((tool) => [tool.name, tool]));

    const created = await byName.get("scheduler.create_job")!.execute(
      { name: "Check", cron: "0 8 * * *", tz: "UTC", message: "Run", model: { provider: "anthropic", model: "m1" } },
      { agent: alpha, config }
    ) as { ok: boolean; job: { id: string; model?: unknown } };
    expect(created.ok).toBe(true);
    expect(created.job.model).toEqual({ provider: "anthropic", model: "m1" });

    const unchanged = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, name: "Check v2" },
      { agent: alpha, config }
    ) as { ok: boolean; job: { model?: unknown } };
    expect(unchanged.job.model).toEqual({ provider: "anthropic", model: "m1" });

    const updated = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, model: { provider: "openai", model: "m2" } },
      { agent: alpha, config }
    ) as { ok: boolean; job: { model?: unknown } };
    expect(updated.job.model).toEqual({ provider: "openai", model: "m2" });

    const partial = await byName.get("scheduler.update_job")!.execute(
      { jobId: created.job.id, model: { provider: "openai" } },
      { agent: alpha, config }
    ) as { ok: boolean };
    expect(partial.ok).toBe(false);
  });

  it("rejects a deliver entry with both channel and user", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    const tools = await schedulerExtension.getAgentTools?.(alpha, { config });
    const create = tools!.find((tool) => tool.name === "scheduler.create_job")!;

    const result = await create.execute(
      {
        name: "Bad",
        cron: "0 8 * * *",
        tz: "UTC",
        message: "Run",
        deliver: [{ target: "slack", channel: "C0123", user: "U0123" }],
      },
      { agent: alpha, config }
    ) as { ok: boolean; error?: string };

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exactly one of channel or user");
  });
});

describe("scheduler sharing guidance", () => {
  it("explains privacy in create/update tools and the scheduler prompt", async () => {
    const alpha = agent("alpha", "/unused");
    const tools = await schedulerExtension.getAgentTools!(alpha);
    for (const name of ["scheduler.create_job", "scheduler.update_job"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(tool.description).toContain("Private to you, or shared with the team?");
      expect(tool.description).toContain("Created as a private job");
      expect(tool.description).toContain("Shared with the team");
    }
    expect(await schedulerExtension.getSystemPromptContributions!(alpha)).toContain("personal data");
  });
});
