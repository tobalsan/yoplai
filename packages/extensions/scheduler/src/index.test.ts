import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono, type Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ExtensionContext, FullHistoryMessage, GatewayConfig } from "@yoplai/shared";
import { schedulerExtension } from "./index.js";
import { clearSchedulerContext, getScheduler, setSchedulerContext, stopScheduler } from "./service.js";

const creatorLookup = vi.hoisted(() => vi.fn());
const agentAccess = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@yoplai/extension-multi-user", async (importOriginal) => ({
  ...await importOriginal<typeof import("@yoplai/extension-multi-user")>(),
  getMultiUserRuntime: () => ({ db: { prepare: () => ({ get: creatorLookup }) } }),
  getRequestAuthContext: (c: Context) => c.get("multiUserAuthContext"),
  hasAgentAccess: agentAccess,
}));

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

  it("gates history and authorizes past runs against the job's current Mine/Team mode", async () => {
    creatorLookup.mockReturnValue({ id: "alice", name: "Alice", email: "alice@example.test", approved: 1, role: "user", banned: 0 });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-runs-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = {
      agents: [alpha], extensions: { scheduler: { enabled: true }, multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "test-session-secret-at-least-32-characters" } },
      sessions: { idleMinutes: 360 },
    };
    const runAgent = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      meta: { sessionId }, payloads: [{ text: "Done" }],
    }));
    const ctx = context(config, runAgent);
    const messages: FullHistoryMessage[] = [
      { role: "user", content: [{ type: "text", text: "Run privately" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "thinking", thinking: "Reason" }, { type: "toolCall", id: "tc", name: "read", arguments: { path: "notes" } }], timestamp: 2, meta: { stopReason: "toolUse", model: "test" } },
      { role: "toolResult", toolCallId: "tc", toolName: "read", content: [{ type: "text", text: "Result" }], timestamp: 3, isError: true },
    ];
    ctx.getFullSessionHistory = vi.fn(async () => ({ messages }));
    setSchedulerContext(ctx);
    const app = new Hono().basePath("/api");
    let userId = "alice";
    app.use("*", async (c, next) => {
      (c as unknown as Context<{ Variables: { multiUserAuthContext: { session: { userId: string } } } }>).set("multiUserAuthContext", { session: { userId } });
      await next();
    });
    schedulerExtension.registerRoutes!(app);
    const scheduler = getScheduler();
    const job = await scheduler.add("alpha", {
      name: "Private one-shot", schedule: { runAt: "2099-01-01T00:00:00Z" },
      payload: { message: "Run privately" },
    }, "alice");
    const url = `/api/schedules/alpha/${job.id}/runs`;
    expect((await app.request(url)).status).toBe(404);
    config.enableCronMonitoring = true;
    expect(await (await app.request(url)).json()).toEqual({ runs: [] });
    await scheduler.runNow("alpha", job.id);
    expect((await scheduler.list("alpha"))[0]?.enabled).toBe(false);
    const history = await (await app.request(url)).json();
    expect(history).toMatchObject({ runs: [{ status: "ok", storageOwnerId: "alice", prompt: "Run privately" }] });
    const traceUrl = `${url}/${history.runs[0].id}/trace`;
    expect(await (await app.request(traceUrl)).json()).toEqual({ run: history.runs[0], messages });
    expect((await app.request(`${url}/unknown/trace`)).status).toBe(404);
    userId = "bob";
    expect((await app.request(url)).status).toBe(403);
    expect((await app.request(traceUrl)).status).toBe(403);
    userId = "alice";
    expect((await app.request(`/api/schedules/alpha/${job.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentialMode: "team" }),
    })).status).toBe(200);
    userId = "bob";
    expect(await (await app.request(url)).json()).toEqual(history);
    expect(await (await app.request(traceUrl)).json()).toEqual({ run: history.runs[0], messages });
    expect(ctx.getFullSessionHistory).toHaveBeenLastCalledWith("alpha", history.runs[0].sessionId, "alice");
    agentAccess.mockResolvedValueOnce(false);
    expect((await app.request(url)).status).toBe(403);
    agentAccess.mockResolvedValueOnce(false);
    expect((await app.request(traceUrl)).status).toBe(403);
    delete ctx.getFullSessionHistory;
    expect((await app.request(traceUrl)).status).toBe(503);
    config.enableCronMonitoring = false;
    expect((await app.request(url)).status).toBe(404);
    expect((await app.request(traceUrl)).status).toBe(404);
  });

  it("shares a private job on Mine → Team and makes it private to the Team → Mine switcher", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-owner-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    creatorLookup.mockReturnValue({ name: "Alice Example" });
    const ctx = context(config);
    const record = vi.fn();
    ctx.audit = { record };
    setSchedulerContext(ctx);
    const app = new Hono().basePath("/api");
    let userId = "alice";
    app.use("*", async (c, next) => {
      (c as unknown as Context<{ Variables: { multiUserAuthContext: { session: { userId: string } } } }>).set("multiUserAuthContext", { session: { userId } });
      await next();
    });
    schedulerExtension.registerRoutes!(app);
    const created = await app.request("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "alpha", name: "Digest", ownerUserId: "bob", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Run" } }) });
    const job = (await created.json()) as { id: string; ownerUserId: string; credentialMode: string };
    expect(job).toMatchObject({ ownerUserId: "alice", credentialMode: "owner" });
    userId = "bob";
    expect((await app.request("/api/schedules?agent=alpha")).status).toBe(200);
    expect(await (await app.request("/api/schedules?agent=alpha")).json()).toEqual([]);
    expect((await app.request(`/api/schedules/alpha/${job.id}/run`, { method: "POST" })).status).toBe(403);
    userId = "alice";
    for (let attempt = 0; attempt < 2; attempt++) {
      const changed = await app.request(`/api/schedules/alpha/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credentialMode: "team" }) });
      expect(changed.status).toBe(200);
    }
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: "alice", action: "schedule.credential_mode", agentId: "alpha", targetType: "schedule", targetId: job.id,
      changes: [{ field: "credentialMode", before: "owner", after: "team" }, { field: "ownerUserId", before: "alice", after: undefined }] }));
    userId = "bob";
    expect(await (await app.request("/api/schedules?agent=alpha")).json()).toEqual([expect.objectContaining({ createdByUserId: "alice", createdByDisplayName: "Alice Example" })]);
    const changed = await app.request(`/api/schedules/alpha/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credentialMode: "owner" }) });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ ownerUserId: "bob", createdByUserId: "alice" });
    userId = "alice";
    const run = await app.request(`/api/schedules/alpha/${job.id}/run`, { method: "POST" });
    expect(run.status).toBe(403);
  });

  it("lists signed-in Team creations for another member with the server-resolved creator name", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-team-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    creatorLookup.mockReturnValue({ name: "Alice Example" });
    const app = new Hono().basePath("/api");
    let userId = "alice";
    app.use("*", async (c, next) => {
      (c as unknown as Context<{ Variables: { multiUserAuthContext: { session: { userId: string } } } }>).set("multiUserAuthContext", { session: { userId } });
      await next();
    });
    schedulerExtension.registerRoutes!(app);
    const response = await app.request("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "alpha", name: "Team digest", credentialMode: "team", createdByUserId: "spoofed", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Run" } }) });
    expect(response.status).toBe(201);
    const job = await response.json();
    expect(job).toMatchObject({ credentialMode: "team", createdByUserId: "alice" });
    expect(job).not.toHaveProperty("ownerUserId");
    userId = "bob";
    const jobs = await (await app.request("/api/schedules?agent=alpha")).json();
    expect(jobs).toEqual([expect.objectContaining({ id: job.id, createdByUserId: "alice", createdByDisplayName: "Alice Example" })]);
    expect(creatorLookup).toHaveBeenCalledWith("alice");
    creatorLookup.mockImplementation(() => { throw new Error("Unavailable"); });
    const unavailable = await (await app.request("/api/schedules?agent=alpha")).json();
    expect(unavailable[0]).toMatchObject({ id: job.id, createdByUserId: "alice" });
    expect(unavailable[0]).not.toHaveProperty("createdByDisplayName");
    creatorLookup.mockReset();
    expect((await app.request(`/api/schedules/alpha/${job.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Updated by Bob" }) })).status).toBe(200);
  });

  it("keeps legacy creator-less Team jobs unlabeled when multi-user lookup is unavailable", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-legacy-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = { version: 3, agents: [alpha], extensions: { scheduler: { enabled: true } }, sessions: { idleMinutes: 360 } };
    setSchedulerContext(context(config));
    creatorLookup.mockImplementation(() => { throw new Error("Unavailable"); });
    const app = new Hono().basePath("/api");
    schedulerExtension.registerRoutes!(app);
    await app.request("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "alpha", name: "Legacy", schedule: { cron: "0 8 * * *", tz: "UTC" }, payload: { message: "Run" } }) });
    const jobs = await (await app.request("/api/schedules?agent=alpha")).json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).not.toHaveProperty("createdByUserId");
    expect(jobs[0]).not.toHaveProperty("createdByDisplayName");
    creatorLookup.mockReset();
  });

  it("POST /schedules/:agentId/:id/run starts one immediate run", async () => {
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
      sessionId?: string;
    };

    expect(runResponse.status).toBe(202);
    expect(result).toMatchObject({ status: "accepted" });
    expect(result.sessionId).toContain(`scheduler:${job.id}:`);
    await vi.waitFor(() => expect(runAgent).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => {
      const files = await fs.readdir(path.join(tmpDir!, "alpha", "cron", "output", job.id));
      expect(files.length).toBeGreaterThan(0);
    });
  });

  it("POST /schedules creates a script-only job without a message", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
    };
    setSchedulerContext(context(config));
    const app = new Hono().basePath("/api");
    schedulerExtension.registerRoutes!(app);

    const createResponse = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha",
        name: "Rotate token",
        schedule: { cron: "*/5 * * * *", tz: "UTC" },
        payload: { script: "scripts/rotate.sh", noAgent: true },
      }),
    });
    const job = (await createResponse.json()) as {
      payload: { script?: string; noAgent?: boolean; message?: string };
    };

    expect(createResponse.status).toBe(201);
    expect(job.payload).toMatchObject({ script: "scripts/rotate.sh", noAgent: true });
    expect(job.payload.message).toBeUndefined();
  });

  it("POST /schedules rejects an invalid script/message combination with a readable error", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
    };
    setSchedulerContext(context(config));
    const app = new Hono().basePath("/api");
    schedulerExtension.registerRoutes!(app);

    const response = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha",
        name: "Bad",
        schedule: { cron: "0 8 * * *", tz: "UTC" },
        payload: { script: "scripts/rotate.sh", noAgent: true, message: "Run" },
      }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("payload.noAgent rejects payload.message");
  });

  it("POST /schedules creates a job with deliver targets", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
    };
    setSchedulerContext(context(config));
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
        deliver: [{ target: "slack", channel: "C0123" }],
      }),
    });
    const job = (await createResponse.json()) as { deliver?: unknown[] };

    expect(createResponse.status).toBe(201);
    expect(job.deliver).toEqual([{ target: "slack", channel: "C0123" }]);
  });

  it("POST /schedules rejects a deliver entry with neither channel nor user", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-routes-"));
    const alpha = agent("alpha", path.join(tmpDir, "alpha"));
    const config: GatewayConfig = {
      version: 3,
      agents: [alpha],
      extensions: { scheduler: { enabled: true } },
      sessions: { idleMinutes: 360 },
    };
    setSchedulerContext(context(config));
    const app = new Hono().basePath("/api");
    schedulerExtension.registerRoutes!(app);

    const response = await app.request("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "alpha",
        name: "Bad",
        schedule: { cron: "0 8 * * *", tz: "UTC" },
        payload: { message: "Run" },
        deliver: [{ target: "slack" }],
      }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("exactly one of channel or user");
  });
});
