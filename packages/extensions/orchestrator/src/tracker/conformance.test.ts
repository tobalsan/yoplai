import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTrackerClient, isRelevantTrackerWebhook, orchestratorExtension, trackerScopeKey, WorkflowLoader } from "../index.js";
import type { LinearTrackerConfig, PlaneTrackerConfig, TrackerConfig } from "../index.js";

type Call = { url: string; method: string; auth: string | null; apiKey: string | null; body: any };

function recorder() {
  const calls: Call[] = [];
  const make = (responder: (call: Call) => Response): typeof fetch =>
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call: Call = { url: String(url), method: init?.method ?? "GET", auth: headers.get("authorization"), apiKey: headers.get("x-api-key"), body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return responder(call);
    }) as unknown as typeof fetch;
  return { calls, make };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

// --- Linear fixture world (single GraphQL endpoint) ---
const LINEAR_STATES = [{ id: "st-ready", name: "Ready" }, { id: "st-done", name: "Done" }, { id: "st-review", name: "In Review" }];
const linNode = (over: Record<string, any>): any => ({ description: null, url: "https://linear.test/x", labels: { nodes: [] }, inverseRelations: { nodes: [] }, parent: null, ...over });
const LIN_NODE_1 = linNode({ id: "lin_1", identifier: "ENG-1", title: "First", description: "First body", url: "https://linear.test/ENG-1", state: { name: "Ready" }, project: { name: "Project A", slugId: "proj-a" } });
const LIN_NODE_2 = linNode({ id: "lin_2", identifier: "ENG-2", title: "Blocked", state: { name: "Ready" }, project: { name: "Project A", slugId: "proj-a" }, inverseRelations: { nodes: [{ type: "blocks", issue: { id: "lin_1", identifier: "ENG-1", state: { name: "Ready" } } }] } });
const LIN_NODE_9 = linNode({ id: "lin_9", identifier: "ENG-9", title: "Foreign", state: { name: "Ready" }, project: { name: "Other", slugId: "proj-b" } });
const LIN_NODES = [LIN_NODE_1, LIN_NODE_2, LIN_NODE_9];
const LIN_EXPORT_NODE = { identifier: "ENG-1", title: "First", description: "First body", url: "https://linear.test/ENG-1", state: { name: "Ready" }, labels: { nodes: [] }, project: { name: "Project A", slugId: "proj-a" }, parent: null, assignee: { name: "Alice" }, createdAt: "2024-01-01", updatedAt: "2024-01-02", comments: { nodes: [{ body: "a comment", createdAt: "2024-01-03", user: { name: "Bob" } }] } };

function linearWorld(call: Call): Response {
  const q: string = call.body?.query ?? "";
  const v: Record<string, any> = call.body?.variables ?? {};
  if (q.includes("query Export")) return json({ data: { issues: { nodes: [LIN_EXPORT_NODE] } } });
  if (q.includes("YoplaiPoll")) return json({ data: { issues: { nodes: LIN_NODES.filter((n) => n.project.slugId === v.projectSlug && v.states.includes(n.state.name)) } } });
  if (q.includes("YoplaiIssueByIdentifier")) { const n = LIN_NODES.find((x) => x.identifier === v.identifier); return json({ data: { issues: { nodes: n ? [n] : [] } } }); }
  if (q.includes("YoplaiIssueById")) { const n = LIN_NODES.find((x) => x.id === v.id); return json({ data: { issue: n ?? null } }); }
  if (q.includes("YoplaiIssueStates")) return json({ data: { issue: { team: { states: { nodes: LINEAR_STATES } } } } });
  if (q.includes("issueUpdate")) return json({ data: { issueUpdate: { success: true } } });
  if (q.includes("commentCreate")) return json({ data: { commentCreate: { success: true } } });
  return json({ data: {} });
}

// --- Plane fixture world (REST endpoints) ---
const PLANE_PREFIX = "/api/v1/workspaces/ws-1";
const PLANE_PROJECT = { id: "pid-1", identifier: "ENG", name: "Project A" };
const PLANE_STATES = [{ id: "st-ready", name: "Ready" }, { id: "st-done", name: "Done" }, { id: "st-review", name: "In Review" }];
const PW = {
  i1: { id: "i1", sequence_id: 1, name: "First", description_stripped: "First body", state: "st-ready", project: "pid-1", parent: null, created_at: "2024-01-01", updated_at: "2024-01-02" },
  i2: { id: "i2", sequence_id: 2, name: "Blocked", description_stripped: null, state: "st-ready", project: "pid-1", parent: null },
  i3: { id: "i3", sequence_id: 3, name: "Done one", state: "st-done", project: "pid-1" },
  i9: { id: "i9", sequence_id: 9, name: "Foreign", state: "st-ready", project: "pid-OTHER" },
} as Record<string, any>;
const PLANE_BY_ID: Record<string, any> = { i1: PW.i1, i2: PW.i2, i3: PW.i3 };
const PLANE_BY_IDENTIFIER: Record<string, any> = { "ENG-1": PW.i1, "ENG-9": PW.i9 };
const PLANE_COMMENT = { created_at: "2024-01-03", actor: "Bob", comment_stripped: "a comment" };

function planeWorld(call: Call): Response {
  const u = new URL(call.url);
  const p = u.pathname.startsWith(PLANE_PREFIX) ? u.pathname.slice(PLANE_PREFIX.length) : u.pathname;
  const cursor = u.searchParams.get("cursor");
  if (call.method === "GET" && p === "/projects/pid-1/") return json(PLANE_PROJECT);
  if (call.method === "GET" && p === "/projects/pid-1/states/") return json({ results: PLANE_STATES, next_page_results: false });
  if (call.method === "GET" && p === "/projects/pid-1/work-items/") return cursor === "c2" ? json({ results: [PW.i3], next_page_results: false }) : json({ results: [PW.i1, PW.i2], next_page_results: true, next_cursor: "c2" });
  if (call.method === "GET" && p === "/projects/pid-1/modules/mid-1/module-issues/") return json({ results: [PW.i1], next_page_results: false });
  let m = p.match(/^\/projects\/pid-1\/work-items\/([^/]+)\/relations\/$/);
  if (m && call.method === "GET") return json({ blocked_by: m[1] === "i2" ? ["i1"] : [] });
  m = p.match(/^\/projects\/pid-1\/work-items\/([^/]+)\/comments\/$/);
  if (m && call.method === "GET") return json({ results: m[1] === "i1" ? [PLANE_COMMENT] : [], next_page_results: false });
  if (m && call.method === "POST") return json({ id: "cmt-1" }, { status: 201 });
  m = p.match(/^\/projects\/pid-1\/work-items\/([^/]+)\/$/);
  if (m && call.method === "GET") { const raw = PLANE_BY_ID[m[1]]; return raw ? json(raw) : json({ error: "not found" }, { status: 404 }); }
  if (m && call.method === "PATCH") return json({ id: m[1], state: call.body?.state });
  m = p.match(/^\/work-items\/([^/]+)\/$/);
  if (m && call.method === "GET") { const raw = PLANE_BY_IDENTIFIER[m[1]]; return raw ? json(raw) : json({ error: "not found" }, { status: 404 }); }
  return json({ error: `unhandled ${call.method} ${p}` }, { status: 500 });
}

const linearConfig: LinearTrackerConfig = { kind: "linear", endpoint: "https://linear.test/graphql", apiKey: "lin-key", projectSlug: "proj-a", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" };
const planeConfig: PlaneTrackerConfig = { kind: "plane", baseUrl: "https://api.plane.so", apiKey: "plane-key", authKind: "api_key", workspaceSlug: "ws-1", projectId: "pid-1", activeStates: ["Ready"], terminalStates: ["Done"], needsHuman: "Needs Human" };

type Adapter = {
  name: string;
  config: TrackerConfig;
  world: (call: Call) => Response;
  opaqueId: string;
  foreignId: string;
  commentIssueId: string;
  stateIssueId: string;
  expectedAuth: string;
  authOf: (call: Call) => string | null;
  rlHeaders: (remaining: number, reset?: number) => Record<string, string>;
  assertPollHttp: (calls: Call[]) => void;
  assertCommentHttp: (calls: Call[]) => void;
  assertSetStateHttp: (calls: Call[]) => void;
  webhook: { issue: unknown; comment: unknown; irrelevant: unknown };
};

const linearAdapter: Adapter = {
  name: "linear",
  config: linearConfig,
  world: linearWorld,
  opaqueId: "lin_2",
  foreignId: "ENG-9",
  commentIssueId: "lin_1",
  stateIssueId: "lin_1",
  expectedAuth: "lin-key",
  authOf: (c) => c.auth,
  rlHeaders: (remaining, reset) => ({ "x-ratelimit-requests-remaining": String(remaining), ...(reset !== undefined ? { "x-ratelimit-requests-reset": String(reset) } : {}) }),
  assertPollHttp: (calls) => { const polls = calls.filter((c) => (c.body?.query ?? "").includes("YoplaiPoll")); expect(polls).toHaveLength(1); expect(polls[0]!.body.variables).toEqual({ projectSlug: "proj-a", states: ["Ready"] }); },
  assertCommentHttp: (calls) => { const c = calls.find((x) => (x.body?.query ?? "").includes("commentCreate")); expect(c?.body.variables).toEqual({ issueId: "lin_1", body: "Hello\nWorld" }); },
  assertSetStateHttp: (calls) => { const c = calls.find((x) => (x.body?.query ?? "").includes("issueUpdate")); expect(c?.body.variables.id).toBe("lin_1"); expect(c?.body.variables.input).toEqual({ stateId: "st-review" }); },
  webhook: { issue: { type: "Issue", action: "update", data: { id: "lin_1", state: { name: "Done" } } }, comment: { type: "Comment", action: "create", data: { id: "c1", issue: "lin_1" } }, irrelevant: { type: "User", action: "update", data: { id: "u1" } } },
};

const planeAdapter: Adapter = {
  name: "plane",
  config: planeConfig,
  world: planeWorld,
  opaqueId: "i2",
  foreignId: "ENG-9",
  commentIssueId: "i1",
  stateIssueId: "i1",
  expectedAuth: "plane-key",
  authOf: (c) => c.apiKey,
  rlHeaders: (remaining, reset) => ({ "x-ratelimit-remaining": String(remaining), ...(reset !== undefined ? { "x-ratelimit-reset": String(reset) } : {}) }),
  assertPollHttp: (calls) => { const lists = calls.filter((c) => c.method === "GET" && /\/work-items\/$/.test(new URL(c.url).pathname)); expect(lists.length).toBeGreaterThanOrEqual(2); },
  assertCommentHttp: (calls) => { const c = calls.find((x) => x.method === "POST" && /\/work-items\/i1\/comments\/$/.test(new URL(x.url).pathname)); expect(c).toBeTruthy(); expect(c!.body).toEqual({ comment_html: "<p>Hello<br/>World</p>" }); },
  assertSetStateHttp: (calls) => { const c = calls.find((x) => x.method === "PATCH"); expect(new URL(c!.url).pathname).toMatch(/\/work-items\/i1\/$/); expect(c!.body).toEqual({ state: "st-review" }); },
  webhook: { issue: { event: "issue", action: "updated", data: { id: "i1" } }, comment: { event: "issue_comment", action: "created", data: { id: "c1", issue: "i1" } }, irrelevant: { event: "project", action: "updated", data: { id: "p1" } } },
};

for (const adapter of [linearAdapter, planeAdapter]) {
  describe(`TrackerClient conformance — ${adapter.name}`, () => {
    it("(1) pollIssues maps, filters by state, scopes, and sends the expected HTTP", async () => {
      const { calls, make } = recorder();
      const client = createTrackerClient(adapter.config, { fetchImpl: make(adapter.world) });
      const issues = await client.pollIssues({ states: ["Ready"] });
      expect(issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
      expect(issues.every((i) => i.state === "Ready")).toBe(true);
      expect(issues[0]!.title).toBe("First");
      expect(issues.find((i) => i.identifier === "ENG-2")?.blocked_by?.[0]).toMatchObject({ identifier: "ENG-1", state: "Ready" });
      adapter.assertPollHttp(calls);
      expect(adapter.authOf(calls[0]!)).toBe(adapter.expectedAuth);
    });

    it("(2) getIssue by opaque id returns the mapped issue", async () => {
      const { make } = recorder();
      const client = createTrackerClient(adapter.config, { fetchImpl: make(adapter.world) });
      expect((await client.getIssue(adapter.opaqueId))?.identifier).toBe("ENG-2");
    });

    it("(3) getIssue by human identifier returns the mapped issue", async () => {
      const { make } = recorder();
      const client = createTrackerClient(adapter.config, { fetchImpl: make(adapter.world) });
      expect((await client.getIssue("ENG-1"))?.identifier).toBe("ENG-1");
    });

    it("(4) getIssue outside the configured scope returns undefined", async () => {
      const { make } = recorder();
      const client = createTrackerClient(adapter.config, { fetchImpl: make(adapter.world) });
      expect(await client.getIssue(adapter.foreignId)).toBeUndefined();
    });

    it("(5) createComment sends the expected request", async () => {
      const { calls, make } = recorder();
      const client = createTrackerClient(adapter.config, { fetchImpl: make(adapter.world) });
      await client.createComment(adapter.commentIssueId, "Hello\nWorld");
      adapter.assertCommentHttp(calls);
    });

    it("(6) setIssueState resolves the state name and throws on an unknown one", async () => {
      const first = recorder();
      const client = createTrackerClient(adapter.config, { fetchImpl: first.make(adapter.world) });
      await client.setIssueState(adapter.stateIssueId, "In Review");
      adapter.assertSetStateHttp(first.calls);
      const second = recorder();
      const client2 = createTrackerClient(adapter.config, { fetchImpl: second.make(adapter.world) });
      await expect(client2.setIssueState(adapter.stateIssueId, "Nope")).rejects.toThrow(/state not found: Nope/i);
    });

    it("(7) waits on an exhausted bucket, retries one 429, and exposes rateLimitRemaining", async () => {
      let now = 1_000;
      const sleeps: number[] = [];
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(json({ data: { ok: true } }, { headers: adapter.rlHeaders(0, 3) }))
        .mockResolvedValueOnce(json({}, { status: 429, headers: adapter.rlHeaders(0, 5) }))
        .mockResolvedValueOnce(json({ data: { ok: true } }, { headers: adapter.rlHeaders(9) })) as unknown as typeof fetch;
      const client = createTrackerClient(adapter.config, { fetchImpl, now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms; } });
      await client.createComment(adapter.commentIssueId, "one");
      await client.createComment(adapter.commentIssueId, "two");
      expect(sleeps).toEqual([3_000, 2_000]);
      expect(client.rateLimitRemaining).toBe(9);
    });

    it("(8) export writes <identifier>.md with frontmatter and comment sections", async () => {
      const { make } = recorder();
      const client = createTrackerClient(adapter.config, { fetchImpl: make(adapter.world) });
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "aih-conf-export-"));
      const result = await client.export({ outDir });
      expect(result.exported).toBeGreaterThanOrEqual(1);
      const content = await fs.readFile(path.join(outDir, "ENG-1.md"), "utf8");
      expect(content).toContain("identifier: ENG-1");
      expect(content).toContain("## Comment —");
      expect(content).toContain("a comment");
    });

    it("(10) isRelevantTrackerWebhook accepts issue + comment payloads and rejects irrelevant ones", () => {
      expect(isRelevantTrackerWebhook(adapter.config.kind, adapter.webhook.issue)).toBe(true);
      expect(isRelevantTrackerWebhook(adapter.config.kind, adapter.webhook.comment)).toBe(true);
      expect(isRelevantTrackerWebhook(adapter.config.kind, adapter.webhook.irrelevant)).toBe(false);
    });
  });
}

describe("TrackerClient conformance — shared", () => {
  it("(9) trackerScopeKey is unique across kinds and plane project vs module scope", () => {
    const moduleConfig: PlaneTrackerConfig = { ...planeConfig, moduleId: "mid-1" };
    expect(trackerScopeKey(linearConfig)).toBe("linear:proj-a");
    expect(trackerScopeKey(planeConfig)).toBe("plane:ws-1/pid-1");
    expect(trackerScopeKey(moduleConfig)).toBe("plane:ws-1/pid-1/mid-1");
    expect(new Set([trackerScopeKey(linearConfig), trackerScopeKey(planeConfig), trackerScopeKey(moduleConfig)]).size).toBe(3);
  });
});

// --- Loader config ---
async function loadTrackerRaw(front: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aih-conf-loader-"));
  await fs.writeFile(path.join(root, "WORKFLOW.md"), `---\n${front}---\nBody\n`);
  return new WorkflowLoader(root).resolve({ projectPath: root });
}
async function loadTracker(front: string): Promise<any> {
  return (await loadTrackerRaw(front)).config.tracker;
}

describe("tracker loader config", () => {
  it("switches tracker kind and maps each kind's fields", async () => {
    expect(await loadTracker("tracker:\n  kind: linear\n  api_key: lit-key\n  project_slug: proj-a\n")).toMatchObject({ kind: "linear", endpoint: "https://api.linear.app/graphql", apiKey: "lit-key", projectSlug: "proj-a" });
    expect(await loadTracker("tracker:\n  kind: plane\n  base_url: https://plane.test/\n  workspace_slug: ws-1\n  project_id: pid-1\n  module_id: mid-1\n  api_key: plane-lit\n")).toMatchObject({ kind: "plane", baseUrl: "https://plane.test", workspaceSlug: "ws-1", projectId: "pid-1", moduleId: "mid-1", apiKey: "plane-lit", authKind: "api_key" });
  });

  it("keeps linear defaults unchanged", async () => {
    expect(await loadTracker("tracker:\n  kind: linear\n  api_key: k\n  project_slug: p\n")).toMatchObject({ endpoint: "https://api.linear.app/graphql", activeStates: ["Todo", "In Progress"], terminalStates: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"], needsHuman: "Needs Human" });
  });

  it("defaults the plane base_url and leaves module unset when absent", async () => {
    const plane = await loadTracker("tracker:\n  kind: plane\n  workspace_slug: ws-1\n  project_id: pid-1\n  api_key: k\n");
    expect(plane.baseUrl).toBe("https://api.plane.so");
    expect(plane.moduleId).toBeUndefined();
  });

  it("resolves Plane auth envs by bot, oauth, then api-key precedence", async () => {
    const prevBot = process.env.PLANE_BOT_TOKEN;
    const prevOauth = process.env.PLANE_OAUTH_TOKEN;
    const prevApi = process.env.PLANE_API_KEY;
    process.env.PLANE_BOT_TOKEN = "bot-token";
    process.env.PLANE_OAUTH_TOKEN = "oauth-token";
    process.env.PLANE_API_KEY = "api-key";
    try {
      expect(await loadTracker("tracker:\n  kind: plane\n  workspace_slug: ws-1\n  project_id: pid-1\n")).toMatchObject({ apiKey: "bot-token", authKind: "bot_token" });
      delete process.env.PLANE_BOT_TOKEN;
      expect(await loadTracker("tracker:\n  kind: plane\n  workspace_slug: ws-1\n  project_id: pid-1\n")).toMatchObject({ apiKey: "oauth-token", authKind: "oauth_token" });
      delete process.env.PLANE_OAUTH_TOKEN;
      expect(await loadTracker("tracker:\n  kind: plane\n  workspace_slug: ws-1\n  project_id: pid-1\n")).toMatchObject({ apiKey: "api-key", authKind: "api_key" });
    } finally {
      if (prevBot === undefined) delete process.env.PLANE_BOT_TOKEN; else process.env.PLANE_BOT_TOKEN = prevBot;
      if (prevOauth === undefined) delete process.env.PLANE_OAUTH_TOKEN; else process.env.PLANE_OAUTH_TOKEN = prevOauth;
      if (prevApi === undefined) delete process.env.PLANE_API_KEY; else process.env.PLANE_API_KEY = prevApi;
    }
  });

  it("reports each plane required-field error", async () => {
    const prevBot = process.env.PLANE_BOT_TOKEN;
    const prevOauth = process.env.PLANE_OAUTH_TOKEN;
    const prevApi = process.env.PLANE_API_KEY;
    delete process.env.PLANE_BOT_TOKEN;
    delete process.env.PLANE_OAUTH_TOKEN;
    delete process.env.PLANE_API_KEY;
    try {
      await expect(loadTrackerRaw("tracker:\n  kind: plane\n  workspace_slug: ws-1\n  project_id: pid-1\n")).rejects.toThrow("tracker.api_key is required");
      await expect(loadTrackerRaw("tracker:\n  kind: plane\n  api_key: k\n  project_id: pid-1\n")).rejects.toThrow("tracker.workspace_slug is required for tracker.kind: plane");
      await expect(loadTrackerRaw("tracker:\n  kind: plane\n  api_key: k\n  workspace_slug: ws-1\n")).rejects.toThrow("tracker.project_id is required for tracker.kind: plane");
    } finally {
      if (prevBot !== undefined) process.env.PLANE_BOT_TOKEN = prevBot;
      if (prevOauth !== undefined) process.env.PLANE_OAUTH_TOKEN = prevOauth;
      if (prevApi !== undefined) process.env.PLANE_API_KEY = prevApi;
    }
  });

  it("rejects an unknown tracker kind with the supported list", async () => {
    await expect(loadTrackerRaw("tracker:\n  kind: jira\n  api_key: k\n")).rejects.toThrow("Unsupported tracker.kind: jira (supported: linear, plane)");
  });
});

// --- plane_api / linear_graphql agent tools ---
async function writeLinearWorkflow(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, "WORKFLOW.md"), "---\ntracker:\n  kind: linear\n  api_key: lin-secret\n  endpoint: https://linear.test/graphql\n  project_slug: proj-a\nagent:\n  profile: default\nworkspace:\n  root: ./workspaces\n---\nBody\n");
}
async function writePlaneWorkflow(dir: string, opts: { withModule?: boolean; authKind?: "api_key" | "oauth_token" | "bot_token" } = {}): Promise<void> {
  const moduleLine = opts.withModule === false ? "" : "  module_id: mid-1\n";
  const authKindLine = opts.authKind ? `  auth_kind: ${opts.authKind}\n` : "";
  await fs.writeFile(path.join(dir, "WORKFLOW.md"), `---\ntracker:\n  kind: plane\n  base_url: https://plane.test\n  workspace_slug: ws-1\n  project_id: pid-1\n${moduleLine}  api_key: plane-secret\n${authKindLine}agent:\n  profile: default\nworkspace:\n  root: ./workspaces\n---\nBody\n`);
}

async function startTools(projects: Array<{ name: string; write: (dir: string) => Promise<void> }>): Promise<{ tools: any[]; stop: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "aih-conf-tool-"));
  const dirs: string[] = [];
  for (const project of projects) {
    const dir = path.join(home, project.name);
    await fs.mkdir(dir);
    await project.write(dir);
    dirs.push(dir);
  }
  const context = { getDataDir: () => home, getConfig: () => ({ extensions: { orchestrator: { projects: dirs } } }), emit: vi.fn() } as any;
  await orchestratorExtension.start?.(context);
  const tools = (await Promise.resolve(orchestratorExtension.getAgentTools?.(context) ?? [])) as any[];
  return { tools, stop: async () => { await orchestratorExtension.stop?.(); } };
}

describe("orchestrator plane_api tool", () => {
  it("substitutes placeholders, injects Plane auth, and never leaks the key", async () => {
    const calls: Array<{ url: string; apiKey: string | null; auth: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => { const headers = new Headers(init?.headers); calls.push({ url: String(url), apiKey: headers.get("x-api-key"), auth: headers.get("authorization") }); return json({ results: ["ok"] }); }) as any;
    const { tools, stop } = await startTools([{ name: "plane", write: (d) => writePlaneWorkflow(d) }]);
    try {
      const tool = tools.find((t) => t.name === "orchestrator.plane_api")!;
      const result = await tool.execute({ project: "plane", method: "GET", path: "workspaces/{workspace}/projects/{project}/modules/{module}/module-issues/" }, {} as any);
      expect(result).toEqual({ results: ["ok"] });
      const call = calls.find((c) => c.url.includes("module-issues"))!;
      expect(call.url).toBe("https://plane.test/api/v1/workspaces/ws-1/projects/pid-1/modules/mid-1/module-issues/");
      expect(call.apiKey).toBe("plane-secret");
      expect(call.auth).toBeNull();
      expect(JSON.stringify(result)).not.toContain("plane-secret");
    } finally {
      await stop();
      globalThis.fetch = original;
    }
  });

  it("uses Authorization bearer for Plane OAuth and bot tokens", async () => {
    const calls: Array<{ auth: string | null; apiKey: string | null }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url: any, init?: RequestInit) => { const headers = new Headers(init?.headers); calls.push({ auth: headers.get("authorization"), apiKey: headers.get("x-api-key") }); return json({ ok: true }); }) as any;
    let toolsStop = await startTools([{ name: "oauth", write: (d) => writePlaneWorkflow(d, { withModule: false, authKind: "oauth_token" }) }]);
    try {
      const tool = toolsStop.tools.find((t) => t.name === "orchestrator.plane_api")!;
      await tool.execute({ project: "oauth", method: "GET", path: "workspaces/{workspace}/projects/{project}/work-items/" }, {} as any);
      await toolsStop.stop();
      toolsStop = await startTools([{ name: "bot", write: (d) => writePlaneWorkflow(d, { withModule: false, authKind: "bot_token" }) }]);
      const botTool = toolsStop.tools.find((t) => t.name === "orchestrator.plane_api")!;
      await botTool.execute({ project: "bot", method: "GET", path: "workspaces/{workspace}/projects/{project}/work-items/" }, {} as any);
      expect(calls).toEqual([{ auth: "Bearer plane-secret", apiKey: null }, { auth: "Bearer plane-secret", apiKey: null }]);
    } finally {
      await toolsStop.stop();
      globalThis.fetch = original;
    }
  });

  it("strips a leading api/v1/ from the path and honors the method", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => { calls.push({ url: String(url), method: init?.method ?? "GET" }); return json({ id: "cmt-1" }, { status: 201 }); }) as any;
    const { tools, stop } = await startTools([{ name: "plane", write: (d) => writePlaneWorkflow(d) }]);
    try {
      const tool = tools.find((t) => t.name === "orchestrator.plane_api")!;
      await tool.execute({ project: "plane", method: "POST", path: "/api/v1/workspaces/{workspace}/projects/{project}/work-items/i1/comments/", body: { comment_html: "<p>hi</p>" } }, {} as any);
      const call = calls.find((c) => c.url.includes("comments"))!;
      expect(call.url).toBe("https://plane.test/api/v1/workspaces/ws-1/projects/pid-1/work-items/i1/comments/");
      expect(call.method).toBe("POST");
    } finally {
      await stop();
      globalThis.fetch = original;
    }
  });

  it("surfaces HTTP errors as an error field", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 404 })) as any;
    const { tools, stop } = await startTools([{ name: "plane", write: (d) => writePlaneWorkflow(d) }]);
    try {
      const tool = tools.find((t) => t.name === "orchestrator.plane_api")!;
      await expect(tool.execute({ project: "plane", method: "GET", path: "workspaces/{workspace}/projects/{project}/work-items/" }, {} as any)).resolves.toEqual({ error: "404 nope" });
    } finally {
      await stop();
      globalThis.fetch = original;
    }
  });

  it("errors when {module} is used without a configured module_id", async () => {
    const { tools, stop } = await startTools([{ name: "plane", write: (d) => writePlaneWorkflow(d, { withModule: false }) }]);
    try {
      const tool = tools.find((t) => t.name === "orchestrator.plane_api")!;
      await expect(tool.execute({ project: "plane", method: "GET", path: "workspaces/{workspace}/projects/{project}/modules/{module}/module-issues/" }, {} as any)).resolves.toEqual({ error: "project has no module_id configured" });
    } finally {
      await stop();
    }
  });

  it("rejects a linear project and points to linear_graphql", async () => {
    const { tools, stop } = await startTools([{ name: "lin", write: (d) => writeLinearWorkflow(d) }]);
    try {
      const tool = tools.find((t) => t.name === "orchestrator.plane_api")!;
      await expect(tool.execute({ project: "lin", method: "GET", path: "x" }, {} as any)).resolves.toEqual({ error: "project uses tracker.kind: linear — use orchestrator.linear_graphql" });
    } finally {
      await stop();
    }
  });

  it("rejects a plane project from linear_graphql and points to plane_api", async () => {
    const { tools, stop } = await startTools([{ name: "plane", write: (d) => writePlaneWorkflow(d) }]);
    try {
      const tool = tools.find((t) => t.name === "orchestrator.linear_graphql")!;
      await expect(tool.execute({ project: "plane", query: "query" }, {} as any)).resolves.toEqual({ error: "project uses tracker.kind: plane — use orchestrator.plane_api" });
    } finally {
      await stop();
    }
  });
});
