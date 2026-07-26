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
    runAgent: vi.fn(),
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

  it("hides tools when scheduler is disabled", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: false } }, sessions: { idleMinutes: 360 }, agentFab: false };

    expect(await schedulerExtension.getAgentTools?.(alpha, { config })).toEqual([]);
  });

  it("creates, lists, updates, and deletes caller agent jobs", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const beta = agent("beta", path.join(tmpDir, "beta"));
    const config: GatewayConfig = { version: 3, agents: [alpha, beta], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 }, agentFab: false };
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
    expect(updated.job.payload).toEqual({ message: "Run updated", sessionId: "daily" });

    const cleared = await byName.get("scheduler.update_job")!.execute(
      { jobId, sessionId: null },
      { agent: alpha, config }
    ) as { ok: boolean; job: { payload: { message: string; sessionId?: string } } };
    expect(cleared.job.payload).toEqual({ message: "Run updated" });

    const deleted = await byName.get("scheduler.delete_job")!.execute({ jobId }, { agent: alpha, config }) as { ok: boolean };
    expect(deleted.ok).toBe(true);
  });

  it("returns structured validation errors", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-tools-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 }, agentFab: false };
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
});
