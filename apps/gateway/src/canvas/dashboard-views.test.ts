import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema, McpAppViewReferenceSchema } from "@yoplai/shared";
import type { ExtensionAgentToolContext } from "@yoplai/shared";

// Pom approved tools.execute + registry/record reads in ALG-657 comment ab217d93.
// Catches provenance and durable capture; misses runner transport and browser UI.
let home: string;
let db: Database.Database | undefined;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-views-"));
  vi.stubEnv("YOPLAI_HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  const { canvasExtension } = await import("./index.js");
  await canvasExtension.stop();
  const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
  setMultiUserRuntime(null);
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

async function fixture(multiUser = false) {
  const agent = AgentConfigSchema.parse({ id: "artist", name: "Artist", workspace: path.join(home, "workspace"), model: { provider: "test", model: "test" } });
  const config = GatewayConfigSchema.parse({ agents: [agent], canvas: { enabled: true, baseUrl: "https://chat.example.test" }, extensions: multiUser ? { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "isolated-dashboard-test-secret-32-characters" } } : {} });
  await fs.mkdir(path.join(agent.workspace, "data", "dashboards"), { recursive: true });
  await fs.writeFile(path.join(agent.workspace, "data", "dashboards", "overview.html"), "<title>Invented overview</title><h1>Original</h1>");
  const { canvasExtension } = await import("./index.js");
  await canvasExtension.start({ getDataDir: () => home } as never);
  const tools = await canvasExtension.getAgentTools!(agent, { config });
  const { getDashboardRegistry } = await import("./store.js");
  const registry = getDashboardRegistry(path.join(home, "canvas", "registry.json"));
  if (multiUser) {
    db = new Database(":memory:");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, email TEXT, approved INTEGER, role TEXT, banned INTEGER)");
    db.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?)").run("alice", "alice@example.test", 1, "superadmin", 0);
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    setMultiUserRuntime({ db } as unknown as import("../../../../packages/extensions/multi-user/src/runtime-state.js").MultiUserRuntime);
  }
  const context: ExtensionAgentToolContext = { agent, config, sessionId: "conversation", actorKind: multiUser ? "user" : "local", ...(multiUser ? { userId: "alice", actorUserId: "alice", sessionOwnerId: "alice" } : {}) };
  return { agent, config, tools, registry, context };
}

it("stores a real user's own-history conversation in the durable registration", async () => {
  const { tools, registry, context, agent } = await fixture(true);
  await tools.find(tool => tool.name === "dashboard_create")!.execute({ slug: "overview.html" }, context);
  expect((await registry.list("artist"))[0]).toMatchObject({ createdIn: { sessionId: "conversation", userId: "alice" } });
  const persisted = JSON.parse(await fs.readFile(path.join(home, "canvas", "registry.json"), "utf8"));
  expect(persisted.dashboards[0].createdIn).toEqual({ sessionId: "conversation", userId: "alice" });
  const [entry] = await registry.list("artist");
  const [original] = await registry.listVersions(entry.id);
  await fs.writeFile(path.join(agent.workspace, "data", "dashboards", "overview.html"), "<h1>Updated in another chat</h1>");
  await tools.find(tool => tool.name === "dashboard_update")!.execute({ slug: "overview.html" }, { ...context, sessionId: "later-conversation" });
  await tools.find(tool => tool.name === "dashboard_versions")!.execute({ slug: "overview.html", restore: original.id }, { ...context, sessionId: "restore-conversation" });
  expect((await registry.get(entry.id))?.createdIn).toEqual({ sessionId: "conversation", userId: "alice" });
});

it.each([
  { label: "local eval", multiUser: false, patch: { actorKind: "eval", actorUserId: "local" } },
  { label: "local service", multiUser: false, patch: { actorKind: "service" } },
  { label: "user eval", multiUser: true, patch: { actorKind: "eval" } },
  { label: "user service", multiUser: true, patch: { actorKind: "service" } },
  { label: "missing session", multiUser: true, patch: { sessionId: undefined } },
  { label: "foreign history", multiUser: true, patch: { sessionOwnerId: "bob" } },
  { label: "shared history", multiUser: true, patch: { sessionOwnerId: null } },
  { label: "missing user history owner", multiUser: true, patch: { sessionOwnerId: undefined } },
  { label: "foreign local history", multiUser: false, patch: { sessionOwnerId: "someone" } },
] satisfies { label: string; multiUser: boolean; patch: Partial<ExtensionAgentToolContext> }[])("does not attach a creating conversation for $label", async ({ multiUser, patch }) => {
  const { tools, registry, context } = await fixture(multiUser);
  await tools.find(tool => tool.name === "dashboard_create")!.execute({ slug: "overview.html" }, { ...context, ...patch });
  expect((await registry.list("artist"))[0]).not.toHaveProperty("createdIn");
});

it("returns stable dashboard ids for create, update and both link forms", async () => {
  const { tools, registry, context } = await fixture();
  const created = await tools.find(tool => tool.name === "dashboard_create")!.execute({ slug: "overview.html" }, context);
  const [entry] = await registry.list("artist");
  expect(created).toMatchObject({ id: entry.id, slug: "overview.html", link: `https://chat.example.test/d/${entry.id}` });
  expect(await tools.find(tool => tool.name === "dashboard_update")!.execute({ slug: "overview.html" }, context)).toMatchObject({ id: entry.id });
  const link = tools.find(tool => tool.name === "dashboard_link")!;
  expect(await link.execute({ slug: "overview.html" }, context)).toEqual({ id: entry.id, slug: "overview.html", link: `https://chat.example.test/d/${entry.id}` });
  expect(await link.execute({}, context)).toMatchObject({ dashboards: [{ id: entry.id, slug: "overview.html", link: `https://chat.example.test/d/${entry.id}` }] });
});

it("captures successful creates as keyed built-in dashboard views with the HTML title", async () => {
  const { tools, registry, context } = await fixture();
  const create = tools.find(tool => tool.name === "dashboard_create")!;
  await create.execute({ slug: "overview.html" }, { ...context, toolCallId: "create-overview" });
  const [entry] = await registry.list("artist");
  const { getMcpAppView, readMcpAppRecord } = await import("../mcp-apps/capture.js");
  const identity = { agentId: "artist", sessionId: "conversation" };
  expect(getMcpAppView(identity, "create-overview")).toMatchObject({ server: "yoplai", tool: "dashboard", resourceUri: "ui://yoplai/dashboard", key: entry.id });
  expect(McpAppViewReferenceSchema.parse(getMcpAppView(identity, "create-overview"))).toMatchObject({ key: entry.id });
  expect(create.mcp).toEqual({ server: "yoplai", tool: "dashboard", ui: { resourceUri: "ui://yoplai/dashboard", visibility: ["model"] } });
  expect(await readMcpAppRecord(identity, "create-overview")).toMatchObject({
    args: { slug: "overview.html" },
    result: {
      content: [{ type: "text", text: expect.stringContaining('"slug":"overview.html"') }],
      structuredContent: { id: entry.id, agentId: "artist", slug: "overview.html", title: "Invented overview", link: `https://chat.example.test/d/${entry.id}` },
    },
  });
});

it("captures updates with the same dashboard key, a new call and slug title fallback", async () => {
  const { tools, registry, context, agent } = await fixture();
  await tools.find(tool => tool.name === "dashboard_create")!.execute({ slug: "overview.html" }, { ...context, toolCallId: "create-overview" });
  const [entry] = await registry.list("artist");
  await fs.writeFile(path.join(agent.workspace, "data", "dashboards", "overview.html"), "<title> </title><h1>Updated</h1>");
  const update = tools.find(tool => tool.name === "dashboard_update")!;
  await update.execute({ slug: "overview.html" }, { ...context, toolCallId: "update-overview" });
  const { getMcpAppView, readMcpAppRecord } = await import("../mcp-apps/capture.js");
  const identity = { agentId: "artist", sessionId: "conversation" };
  expect(getMcpAppView(identity, "update-overview")).toMatchObject({ key: entry.id, resourceUri: "ui://yoplai/dashboard" });
  expect(update.mcp).toEqual({ server: "yoplai", tool: "dashboard", ui: { resourceUri: "ui://yoplai/dashboard", visibility: ["model"] } });
  expect(await readMcpAppRecord(identity, "update-overview")).toMatchObject({ result: {
    content: [{ type: "text", text: expect.stringContaining('"slug":"overview.html"') }],
    structuredContent: { id: entry.id, agentId: "artist", slug: "overview.html", title: "overview.html", link: `https://chat.example.test/d/${entry.id}` },
  } });
  expect((await registry.get(entry.id))?.createdIn).toEqual({ sessionId: "conversation", userId: "local" });
});

// Pom approved runtime.getTools.execute + record/logger observations (same comment).
// Catches self-capture dispatch and reserved-name rules; misses native rendering.
it("runtime writes one record per dashboard call silently and still warns for other reserved tools", async () => {
  const { agent, config, context } = await fixture();
  const { canvasExtension } = await import("./index.js");
  const { ExtensionRuntime } = await import("../extensions/runtime.js");
  const runtime = new ExtensionRuntime();
  runtime.load([canvasExtension, {
    ...canvasExtension, id: "reservedProbe",
    getAgentTools: () => [{
      name: "reserved_probe", description: "Reserved name fixture", parameters: {},
      mcp: { server: "yoplai", tool: "other", ui: { resourceUri: "ui://invented/other", visibility: ["model"] } },
      execute: () => ({ content: [{ type: "text", text: "Fixture" }] }),
    }],
  }]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const tools = await runtime.getTools(agent, config);
  await tools.find(tool => tool.name === "dashboard_create")!.execute({ slug: "overview.html" }, { ...context, toolCallId: "create-overview" });
  await tools.find(tool => tool.name === "dashboard_update")!.execute({ slug: "overview.html" }, { ...context, toolCallId: "update-overview" });
  expect(warn.mock.calls.flat().filter(line => String(line).includes("reserved_server"))).toEqual([]);
  const { readMcpAppRecord } = await import("../mcp-apps/capture.js");
  const identity = { agentId: "artist", sessionId: "conversation" };
  expect(await readMcpAppRecord(identity, "create-overview")).toMatchObject({ resourceUri: "ui://yoplai/dashboard" });
  expect(await readMcpAppRecord(identity, "update-overview")).toMatchObject({ resourceUri: "ui://yoplai/dashboard" });
  expect(await fs.readdir(path.join(home, "history", "mcp-apps", "artist", "conversation"))).toHaveLength(2);
  const probe = tools.find(tool => tool.name === "reserved_probe")!;
  await probe.execute({}, { ...context, toolCallId: "probe-one" });
  await probe.execute({}, { ...context, toolCallId: "probe-two" });
  expect(warn.mock.calls.flat().filter(line => String(line).includes("reserved_server"))).toHaveLength(1);
  expect(await readMcpAppRecord(identity, "probe-one")).toBeUndefined();
});

it("keeps a single-user conversation when the runner represents its history owner as null", async () => {
  const { tools, registry, context } = await fixture();
  await tools.find(tool => tool.name === "dashboard_create")!.execute({ slug: "overview.html" }, { ...context, sessionOwnerId: null });
  expect((await registry.list("artist"))[0]).toMatchObject({ createdIn: { sessionId: "conversation", userId: "local" } });
});

it("does not capture a Slack pairing return or a thrown dashboard error", async () => {
  const { tools, registry, context } = await fixture(true);
  const { registerSlackPairingLinkProvider } = await import("@yoplai/shared");
  const unregister = registerSlackPairingLinkProvider(async () => "https://chat.example.test/pair");
  const create = tools.find(tool => tool.name === "dashboard_create")!;
  const { getMcpAppView, readMcpAppRecord } = await import("../mcp-apps/capture.js");
  const identity = { agentId: "artist", sessionId: "conversation", ownerUserId: "alice" };
  try {
    expect(await create.execute({ slug: "overview.html" }, { ...context, actorKind: "service", actorUserId: undefined, toolCallId: "pairing" })).toMatchObject({ isError: true, error: "slack_pairing_required" });
    expect(await registry.all()).toEqual([]);
    expect(getMcpAppView({ agentId: "artist", sessionId: "conversation", sessionOwnerId: "alice" }, "pairing")).toBeUndefined();
    expect(await readMcpAppRecord(identity, "pairing")).toBeUndefined();
    await expect(create.execute({ slug: "missing.html" }, { ...context, toolCallId: "failed" })).rejects.toThrow();
    expect(getMcpAppView({ agentId: "artist", sessionId: "conversation", sessionOwnerId: "alice" }, "failed")).toBeUndefined();
    expect(await readMcpAppRecord(identity, "failed")).toBeUndefined();
  } finally { unregister(); }
});
