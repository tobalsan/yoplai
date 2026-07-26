import crypto from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { Extension, ExtensionContext, ExtensionAgentTool } from "@yoplai/shared";
import { OrchestratorExtensionConfigSchema } from "@yoplai/shared";
import { LinearClient } from "./linear/client.js";
import { WorkflowLoader } from "./workflow/loader.js";
import { StateStore } from "./state/store.js";
import { ClaimsRegistry } from "./daemon/claims.js";
import { OrchestratorDaemon } from "./daemon/daemon.js";
import { createTrackerClient, isRelevantTrackerWebhook } from "./tracker/client.js";
import { isRelevantLinearWebhook } from "./linear/tracker.js";
import { planeAuthHeaders } from "./plane/auth.js";
import type { TrackerConfig } from "./types.js";
import { runHook } from "./hooks/runner.js";
import { WorkspaceLayout } from "./workspace/layout.js";
import { resolveProjects } from "./projects/registry.js";

let ctx: ExtensionContext | undefined;
let store: StateStore | undefined;
let daemon: OrchestratorDaemon | undefined;
let sharedWorkflowLoader: WorkflowLoader | undefined;
const claims = new ClaimsRegistry();

function enabled(): boolean { return Boolean(daemon); }
function config(): z.infer<typeof OrchestratorExtensionConfigSchema> { return OrchestratorExtensionConfigSchema.parse(ctx?.getConfig().extensions?.orchestrator ?? {}); }
function workflowLoader() { return sharedWorkflowLoader ??= new WorkflowLoader(ctx!.getDataDir()); }
function unavailable(c: any) { return c.json({ error: "orchestrator disabled" }, 503); }

const REDACTED = "[redacted]";

function redactWorkflowSnapshot<T extends Record<string, any>>(snapshot: T): T {
  return {
    ...snapshot,
    frontmatter: {
      ...snapshot.frontmatter,
      tracker: { ...snapshot.frontmatter?.tracker, api_key: REDACTED },
    },
    config: {
      ...snapshot.config,
      tracker: { ...snapshot.config?.tracker, apiKey: REDACTED },
    },
  };
}

async function runBeforeRemove(row: Record<string, unknown> | undefined) {
  if (!row || !store || !ctx) return;
  const workspace = typeof row.workspace === "string" ? row.workspace : undefined;
  const runId = typeof row.run_id === "string" ? row.run_id : undefined;
  const projectPath = typeof row.workflow_path === "string" ? path.dirname(row.workflow_path) : undefined;
  if (!workspace || !runId || !projectPath) return;
  const workflow = await workflowLoader().resolve({ projectPath, allowStale: true });
  await runHook({
    command: workflow.config.hooks?.before_remove,
    phase: "before_remove",
    cwd: workspace,
    runId,
    store,
    env: {
      YOPLAI_PROJECT_ID: typeof row.project_id === "string" ? row.project_id : undefined,
      YOPLAI_ISSUE_ID: typeof row.issue_id === "string" ? row.issue_id : undefined,
      YOPLAI_ISSUE_IDENTIFIER: typeof row.identifier === "string" ? row.identifier : undefined,
      YOPLAI_WORKSPACE: workspace,
      LINEAR_API_KEY: undefined,
    },
  }).catch((error) => store?.appendEvent(runId, "hook.before_remove.error", { error: error instanceof Error ? error.message : String(error) }, typeof row.project_id === "string" ? row.project_id : undefined));
}

function eventPayload(row: Record<string, unknown>): unknown {
  const payload = row.payload;
  if (typeof payload !== "string") return payload;
  try { return JSON.parse(payload); } catch { return payload; }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const ANSI_ESCAPE_REGEX = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`,
  "g"
);

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "").replace(/\[[0-9;]*m/g, "");
}

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    const record = recordValue(part);
    const text = record?.text ?? record?.thinking;
    return typeof text === "string" ? [text] : [];
  });
  return parts.length ? stripAnsi(parts.join("\n")) : undefined;
}

function eventLogText(type: string | undefined, payload: unknown): string {
  const record = recordValue(payload);
  if (type === "worker.pi.message_update" || type === "worker.pi.thinking") return "";
  const item = recordValue(record?.item);
  const delta = recordValue(record?.delta);
  const assistant = recordValue(record?.assistantMessageEvent);
  const content = recordValue(record?.content);
  const message = recordValue(record?.message);
  const assistantType = typeof assistant?.type === "string" ? assistant.type : "";
  const messageRole = typeof message?.role === "string" ? message.role : "";
  if (type === "worker.pi.message" && messageRole === "user") return "";
  if (type === "worker.pi.message" && (!messageRole || assistantType.endsWith("_delta") || assistantType.endsWith("_start"))) return "";
  const recordMessage = typeof record?.message === "string" ? record.message : undefined;
  const text = record?.text ?? recordMessage ?? record?.error ?? item?.text ?? item?.message ?? item?.command ?? item?.aggregated_output ?? delta?.text ?? delta?.partial_json ?? assistant?.text ?? assistant?.delta ?? content?.text ?? message?.content;
  if (typeof text === "string") return stripAnsi(text);
  return contentText(message?.content) ?? contentText(assistant?.partial) ?? "";
}

function normalizeLogType(type: string | undefined): string | undefined {
  if (!type) return type;
  if (type.endsWith(".message") || type.endsWith(".message_update") || type.endsWith(".agent_message")) return "assistant";
  if (type.endsWith(".thinking")) return "thinking";
  if (type.endsWith(".user_prompt")) return "user";
  if (type.endsWith(".tool_output")) return "tool_output";
  if (type.endsWith(".tool") || type.includes("commandExecution") || type.includes("tool_execution")) return "tool_call";
  if (type.endsWith(".stderr") || type.endsWith(".process.error") || type.endsWith(".start.error") || type.endsWith(".protocol.error")) return "error";
  return type;
}

function workerLogs(runId: string, since: number): { cursor: number; events: Array<Record<string, unknown>> } {
  const rows = (store?.listEvents(runId, since) ?? []) as Array<Record<string, unknown>>;
  return {
    cursor: rows.reduce((max, row) => Math.max(max, Number(row.id ?? 0)), since),
    events: rows.map((row) => {
      const payload = eventPayload(row);
      const rawType = typeof row.type === "string" ? row.type : undefined;
      return { id: row.id, type: normalizeLogType(rawType), rawType, timestamp: row.created_at, text: eventLogText(rawType, payload), payload };
    }),
  };
}

function workerSummary(runId: string): Record<string, unknown> {
  const rows = (store?.listEvents(runId, 0) ?? []) as Array<Record<string, unknown>>;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const type = typeof row?.type === "string" ? row.type : "";
    if (type !== "worker.status" && type !== "worker.started") continue;
    const payload = eventPayload(row);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const record = payload as Record<string, unknown>;
    return {
      worker_id: typeof record.id === "string" ? record.id : undefined,
      worker_kind: typeof record.kind === "string" ? record.kind : undefined,
      worker_status: typeof record.status === "string" ? record.status : type === "worker.started" ? "running" : undefined,
      worker_exit_code: typeof record.exitCode === "number" ? record.exitCode : undefined,
    };
  }
  return {};
}

function activeRuns(project?: string, issue?: string): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const claim of claims.list({ projectId: project })) {
    if (issue && claim.issueId !== issue && claim.runId !== issue) continue;
    const run = store?.getRun(claim.runId, claim.projectId) ?? store?.getOpenRunByIssue(claim.issueId, claim.projectId);
    const worker = typeof run?.worker_id === "string" ? run.worker_id : undefined;
    const summary = workerSummary(claim.runId);
    seen.add(claim.runId);
    rows.push({
      ...claim,
      run,
      ...summary,
      identifier: typeof run?.identifier === "string" ? run.identifier : undefined,
      worker_id: typeof summary.worker_id === "string" ? summary.worker_id : worker,
    });
  }
  for (const run of store?.listOpenRuns(project) ?? []) {
    const runId = typeof run.run_id === "string" ? run.run_id : "";
    if (!runId || seen.has(runId)) continue;
    if (issue && run.issue_id !== issue && run.identifier !== issue && runId !== issue) continue;
    const summary = workerSummary(runId);
    rows.push({
      projectId: run.project_id,
      issueId: run.issue_id,
      runId,
      identifier: run.identifier,
      claimedAt: run.started_at,
      lastEventAt: run.started_at,
      run,
      ...summary,
      worker_id: typeof summary.worker_id === "string" ? summary.worker_id : run.worker_id,
    });
  }
  return rows;
}

export function verifyWebhookSignature(secret: string, body: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  const actual = signature.replace(/^sha256=/, "");
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

export const isRelevantWebhook = isRelevantLinearWebhook;

async function projectDescriptors() {
  if (!ctx) return [];
  return resolveProjects({ paths: config().projects, dataDir: ctx.getDataDir() });
}

function register(app: Hono) {
  app.get("/orchestrator/health", (c) => c.json({ status: enabled() ? "ok" : "disabled", lastTickAt: daemon?.lastTickAt, activeClaims: claims.list().length, rateLimitRemaining: daemon?.rateLimitRemaining }));
  app.use("/orchestrator/*", async (c, next) => {
    if (c.req.path.endsWith("/health")) return next();
    if (!enabled()) return unavailable(c);
    return next();
  });
  app.get("/orchestrator/projects", async (c) => c.json({ items: await projectDescriptors() }));
  app.get("/orchestrator/workflow", async (c) => {
    const projectId = c.req.query("project");
    const project = (await projectDescriptors()).find((item) => !projectId || item.id === projectId || item.path === projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    return c.json(redactWorkflowSnapshot(await workflowLoader().resolve({ projectPath: project.path, allowStale: true })));
  });
  app.get("/orchestrator/runs", (c) => {
    const issue = c.req.query("issue");
    const project = c.req.query("project");
    const limit = Number(c.req.query("limit") ?? 50);
    const offset = Number(c.req.query("offset") ?? 0);
    const active = activeRuns(project, issue);
    const recent = (store?.listRecent(limit, project, offset) ?? []).filter((run: any) => !issue || run.issue_id === issue || run.issueId === issue);
    const total = store?.countRecent(project) ?? 0;
    return c.json({ active, recent, total });
  });
  app.get("/orchestrator/runs/:id", (c) => {
    const id = c.req.param("id");
    const project = c.req.query("project");
    const run = store?.getRun(id, project);
    const runId = typeof run?.run_id === "string" ? run.run_id : id;
    return c.json({ claim: claims.get(id, project), run, events: store?.listEvents(runId, Number(c.req.query("since") ?? 0)) ?? [] });
  });
  app.get("/orchestrator/runs/:id/logs", async (c) => {
    const run = store?.getRun(c.req.param("id"), c.req.query("project"));
    const runId = typeof run?.run_id === "string" ? run.run_id : c.req.param("id");
    return c.json(workerLogs(runId, Number(c.req.query("since") ?? 0)));
  });
  app.post("/orchestrator/runs/:issueId/release", async (c) => {
    const id = c.req.param("issueId");
    const project = c.req.query("project");
    const row = store?.getRun(id, project);
    const projectId = typeof row?.project_id === "string" ? row.project_id : project ?? "default";
    const issueId = typeof row?.issue_id === "string" ? row.issue_id : id;
    await daemon?.releaseRun(projectId, issueId, "released");
    if (!daemon) { claims.release(issueId, projectId); store?.release(issueId, projectId); }
    return c.json({ ok: true });
  });
  app.post("/orchestrator/runs/:id/interrupt", async (c) => {
    const id = c.req.param("id");
    const project = c.req.query("project");
    await daemon?.interruptWorker(id, project);
    return c.json({ ok: true });
  });
  app.post("/orchestrator/runs/:id/kill", async (c) => {
    const id = c.req.param("id");
    const project = c.req.query("project");
    const row = store?.getRun(id, project);
    await daemon?.interruptWorker(id, project).catch(() => undefined);
    await runBeforeRemove(row);
    const identifier = typeof row?.identifier === "string" ? row.identifier : undefined;
    const workflowPath = typeof row?.workflow_path === "string" ? row.workflow_path : undefined;
    if (identifier && workflowPath) {
      const workflow = await workflowLoader().resolve({ projectPath: path.dirname(workflowPath), allowStale: true });
      await new WorkspaceLayout(workflow.config.workspace.root).remove({ identifier }).catch(() => undefined);
    }
    claims.release(String(row?.issue_id ?? id), typeof row?.project_id === "string" ? row.project_id : project);
    store?.release(String(row?.issue_id ?? id), typeof row?.project_id === "string" ? row.project_id : project);
    const runId = typeof row?.run_id === "string" ? row.run_id : undefined;
    const projectId = typeof row?.project_id === "string" ? row.project_id : project;
    if (runId) {
      store?.finishRun(runId, "killed");
      ctx?.emit("orchestrator.run.finished", { issueId: String(row?.issue_id ?? id), projectId, runId, outcome: "killed" });
    }
    return c.json({ ok: true });
  });
  app.post("/orchestrator/issues/:issueId/claim", async (c) => {
    if (!daemon) return c.json({ error: "orchestrator daemon not started" }, 503);
    const result = await daemon.claimNow(c.req.param("issueId"), c.req.query("project"));
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 404 | 409 | 503);
    return c.json(result, 201);
  });
  app.post("/orchestrator/export", async (c) => {
    const projectId = c.req.query("project");
    const project = (await projectDescriptors()).find((item) => !projectId || item.id === projectId || item.path === projectId);
    if (!project) return c.json({ error: "project not found" }, 404);
    const workflow = await workflowLoader().resolve({ projectPath: project.path, allowStale: true });
    const outDir = c.req.query("out") ?? path.join(ctx!.getDataDir(), "exports", workflow.config.tracker.kind, project.id);
    return c.json(await createTrackerClient(workflow.config.tracker).export({ outDir }));
  });
  app.post("/orchestrator/tick", async (c) => {
    if (!enabled()) return unavailable(c);
    if (!daemon) return c.json({ error: "orchestrator daemon not started" }, 503);
    return c.json({ ok: true, ...(await daemon.tick(c.req.query("project"))) });
  });
  app.post("/orchestrator/webhook", async (c) => {
    const webhook = config().webhook;
    if (!webhook?.enabled) return c.json({ error: "not found" }, 404);
    if (!webhook.secret) return c.json({ error: "webhook secret required" }, 503);
    const body = await c.req.text();
    const signature = c.req.header("linear-signature") ?? c.req.header("x-linear-signature") ?? c.req.header("x-plane-signature");
    if (!verifyWebhookSignature(webhook.secret, body, signature)) return c.json({ error: "invalid signature" }, 401);
    const payload = JSON.parse(body) as unknown;
    const kinds = new Set<TrackerConfig["kind"]>();
    try {
      for (const project of await projectDescriptors()) {
        try {
          const workflow = await workflowLoader().resolve({ projectPath: project.path, allowStale: true });
          kinds.add(workflow.config.tracker.kind);
        } catch {
          // Project workflow may be unresolvable (stale/missing config); skip it.
        }
      }
    } catch {
      // Failing to enumerate projects shouldn't block the webhook response.
    }
    const kindList = kinds.size ? [...kinds] : (["linear", "plane"] as TrackerConfig["kind"][]);
    const relevant = kindList.some((kind) => isRelevantTrackerWebhook(kind, payload));
    if (relevant) daemon?.enqueueTick();
    return c.json({ ok: true, queued: relevant });
  });
}

export const orchestratorExtension: Extension = {
  id: "orchestrator",
  displayName: "Orchestrator",
  factory: true,
  description: "Linear-backed issue orchestrator",
  dependencies: [],
  configSchema: OrchestratorExtensionConfigSchema,
  routePrefixes: ["/api/orchestrator"],
  validateConfig(raw) { const parsed = OrchestratorExtensionConfigSchema.safeParse(raw ?? {}); return { valid: parsed.success, errors: parsed.success ? [] : parsed.error.issues.map((i) => i.message) }; },
  registerRoutes: register,
  async start(context) {
    ctx = context;
    sharedWorkflowLoader = new WorkflowLoader(context.getDataDir());
    store = new StateStore(path.join(context.getDataDir(), "orchestrator", "state.db"));
    store.bootstrap();
    store.heartbeat();
    daemon = new OrchestratorDaemon({ ctx: context, store, claims, getConfig: config, workflowLoader: sharedWorkflowLoader, createTrackerClient: ({ config: trackerConfig }) => createTrackerClient(trackerConfig) });
    try { await daemon.start(); } catch (error) { daemon.notifyStartupError(error); throw error; }
  },
  async stop() { await daemon?.stop(); store?.close(); ctx = undefined; store = undefined; daemon = undefined; sharedWorkflowLoader = undefined; },
  capabilities() { return ["orchestrator"]; },
  getAgentTools(): ExtensionAgentTool[] {
    const tools: ExtensionAgentTool[] = [];
    if (config().linear?.exposeGraphqlTool !== false) tools.push({ name: "orchestrator.linear_graphql", description: "Execute Linear GraphQL using workflow auth. Project is required so calls use the owning project endpoint/api_key.", parameters: { type: "object", properties: { project: { type: "string" }, query: { type: "string" }, variables: { type: "object" } }, required: ["project", "query"] }, execute: async (args) => { try { const parsed = z.object({ project: z.string(), query: z.string(), variables: z.record(z.unknown()).optional() }).parse(args); const project = (await projectDescriptors()).find((item) => item.id === parsed.project || item.path === parsed.project); if (!project) return { error: "project not found" }; const workflow = await workflowLoader().resolve({ projectPath: project.path, allowStale: true }); if (workflow.config.tracker.kind !== "linear") return { error: "project uses tracker.kind: plane — use orchestrator.plane_api" }; return await new LinearClient(workflow.config.tracker.apiKey, workflow.config.tracker.endpoint).graphql(parsed.query, parsed.variables); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } } });
    if (config().plane?.exposeApiTool !== false) tools.push({ name: "orchestrator.plane_api", description: "Execute a raw Plane REST API call using the owning project's workflow auth (base URL, workspace slug, auth header are injected). Project is required. `path` is relative to /api/v1/ and supports placeholders {workspace}, {project}, {module} which expand to the project's configured workspace slug, project id, and module id. Examples: GET 'workspaces/{workspace}/projects/{project}/work-items/?per_page=100', POST 'workspaces/{workspace}/projects/{project}/work-items/{id}/comments/' with body {\"comment_html\":\"<p>hi</p>\"}. Responses are JSON; list endpoints paginate via ?cursor=.", parameters: { type: "object", properties: { project: { type: "string" }, method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] }, path: { type: "string" }, body: { type: "object" } }, required: ["project", "method", "path"] }, execute: async (args) => { try { const parsed = z.object({ project: z.string(), method: z.enum(["GET", "POST", "PATCH", "DELETE"]), path: z.string(), body: z.record(z.unknown()).optional() }).parse(args); const project = (await projectDescriptors()).find((item) => item.id === parsed.project || item.path === parsed.project); if (!project) return { error: "project not found" }; const workflow = await workflowLoader().resolve({ projectPath: project.path, allowStale: true }); const tracker = workflow.config.tracker; if (tracker.kind !== "plane") return { error: "project uses tracker.kind: linear — use orchestrator.linear_graphql" }; if (parsed.path.includes("{module}") && !tracker.moduleId) return { error: "project has no module_id configured" }; const rel = parsed.path.replace(/{workspace}/g, tracker.workspaceSlug).replace(/{project}/g, tracker.projectId).replace(/{module}/g, tracker.moduleId ?? "").replace(/^\/+/, "").replace(/^api\/v1\//, ""); const response = await fetch(`${tracker.baseUrl}/api/v1/${rel}`, { method: parsed.method, headers: { "content-type": "application/json", ...planeAuthHeaders({ kind: tracker.authKind, token: tracker.apiKey }) }, body: parsed.body === undefined ? undefined : JSON.stringify(parsed.body) }); if (response.status === 204) return { status: 204 }; const text = await response.text(); if (!response.ok) return { error: `${response.status} ${text}` }; return text ? JSON.parse(text) : {}; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } } });
    return tools;
  },
};

export { registerOrchestratorCommands } from "./cli/index.js";
export { LinearClient } from "./linear/client.js";
export { LinearTracker, isRelevantLinearWebhook } from "./linear/tracker.js";
export { PlaneTracker, isRelevantPlaneWebhook } from "./plane/tracker.js";
export { PlaneClient } from "./plane/client.js";
export { createTrackerClient, trackerScopeKey, isRelevantTrackerWebhook } from "./tracker/client.js";
export type { TrackerClient, TrackerClientFactory, TrackerClientOptions, TrackerExportResult } from "./tracker/client.js";
export type { TrackerConfig, LinearTrackerConfig, PlaneTrackerConfig, TrackerIssue, LinearIssue } from "./types.js";
export { WorkflowLoader } from "./workflow/loader.js";
export { resolveProjects, InvalidProjectsError } from "./projects/registry.js";
export { WorkspaceLayout, sanitizeIdentifier } from "./workspace/layout.js";
export { resolveProfile } from "./profile/resolver.js";
export { ConcurrencyLimiter } from "./concurrency/limiter.js";
export { ClaimsRegistry } from "./daemon/claims.js";
export { StateStore } from "./state/store.js";
export { RetryPolicy } from "./retry/policy.js";
export { OrchestratorDaemon } from "./daemon/daemon.js";
export { WorkflowWorkerRunner, FakeWorkerRunner, CliWorkerRunner } from "./worker-runner/runner.js";
export { CodexAppServerRunner } from "./worker-runner/codex-app-server.js";
export { PiRpcRunner } from "./worker-runner/pi-rpc.js";
export { ClaudeRpcRunner } from "./worker-runner/claude-rpc.js";
export type { WorkerRunner, WorkerRunnerHandle, WorkerRunnerStatus, WorkerRunnerStartInput } from "./worker-runner/runner.js";
