import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
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

function context(config: GatewayConfig, runAgent = vi.fn()): ExtensionContext {
  return {
    getConfig: () => config,
    getDataDir: () => os.tmpdir(),
    reloadConfig: () => undefined,
    getAgent: (id) => config.agents.find((candidate) => candidate.id === id),
    getAgents: () => config.agents,
    isAgentActive: () => true,
    isAgentStreaming: () => false,
    resolveWorkspaceDir: (candidate) => candidate.workspaceDir ?? candidate.workspace,
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

describe("scheduler routes", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    try {
      await stopScheduler();
    } catch {
      // Route tests may not start the singleton scheduler.
    }
    clearSchedulerContext();
    vi.restoreAllMocks();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("POST /schedules/:agentId/:id/run triggers one immediate run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const runAgent = vi.fn().mockResolvedValue({
      payloads: [{ text: "route output" }],
      meta: { durationMs: 4, sessionId: "route-session" },
    });
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
      agentFab: false,
    };
    setSchedulerContext(context(config, runAgent));
    const app = new Hono().basePath("/api");
    schedulerExtension.registerRoutes!(app);

    const createResponse = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha",
        name: "Digest",
        schedule: { cron: "0 8 * * *", tz: "UTC" },
        payload: { message: "Run" },
      }),
    });
    const job = (await createResponse.json()) as { id: string };

    const runResponse = await app.request(`/api/schedules/alpha/${job.id}/run`, {
      method: "POST",
    });
    const result = (await runResponse.json()) as {
      status: string;
      outputPath?: string;
      sessionId?: string;
    };

    expect(runResponse.status).toBe(200);
    expect(result).toMatchObject({ status: "ok", sessionId: "route-session" });
    expect(result.outputPath).toContain(path.join("cron", "output", job.id));
    expect(runAgent).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(result.outputPath!, "utf8")).resolves.toContain(
      "route output"
    );
  });
});
