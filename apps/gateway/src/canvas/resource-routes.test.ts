import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { createDashboardResourceRoutes, createDashboardRoutes } from "./routes.js";
import { DashboardRegistry } from "./store.js";
import { DashboardPinStore } from "./pins.js";

let root: string;
let registry: DashboardRegistry;
let pins: DashboardPinStore;
let agent: AgentConfig;
const config = { canvas: { enabled: true, baseUrl: "https://example.test" } } as GatewayConfig;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-http-"));
  registry = new DashboardRegistry(path.join(root, "canvas", "registry.json"));
  pins = new DashboardPinStore(path.join(root, "canvas", "pins.json"));
  agent = { id: "agent", name: "Agent", workspace: root } as AgentConfig;
  await fs.mkdir(path.join(root, "data", "dashboards"), { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it("users pin and unpin owned and shared dashboards idempotently without changing anyone else's flags", async () => {
  const owned = await registry.createOwned("agent", "owned.html", "alice", "OWNED");
  const shared = await registry.createOwned("agent", "shared.html", "bob", "SHARED");
  await registry.replaceShares(shared.id, [{ kind: "all", mode: "read" }]);
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async (request) => ({ user: { id: request.headers.get("user") || "alice" } }),
    resolveActor: async (auth) => ({ userId: (auth as { user: { id: string } }).user.id, eligible: true }),
    hasAgentAccess: async () => false,
  });
  expect(await (await resources.request("/")).json()).toMatchObject({
    owned: [{ id: owned.id, pinned: false }], shared: [{ id: shared.id, pinned: false }],
  });
  for (const id of [owned.id, shared.id]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const response = await resources.request(`/${id}/pin`, { method: "PUT" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, pinned: true });
    }
  }
  expect(await (await resources.request("/")).json()).toMatchObject({
    owned: [{ id: owned.id, pinned: true }], shared: [{ id: shared.id, pinned: true }],
  });
  expect(await (await resources.request("/", { headers: { user: "bob" } })).json()).toMatchObject({
    owned: [{ id: shared.id, pinned: false }], shared: [],
  });
  for (let repeat = 0; repeat < 2; repeat++) {
    expect(await (await resources.request(`/${owned.id}/pin`, { method: "DELETE" })).json()).toEqual({ ok: true, pinned: false });
  }
  expect(await (await resources.request("/")).json()).toMatchObject({
    owned: [{ id: owned.id, pinned: false }], shared: [{ id: shared.id, pinned: true }],
  });
});

it("pin mutations conceal unavailable registrations and reject unauthenticated or ineligible actors", async () => {
  const privateEntry = await registry.createOwned("agent", "private.html", "alice", "PRIVATE");
  const publicEntry = await registry.createOwned("agent", "public.html", "alice", "PUBLIC");
  await registry.replaceShares(publicEntry.id, [{ kind: "all", mode: "read" }]);
  const legacy = await registry.link("agent", "legacy.html");
  let userId: string | undefined = "bob";
  let eligible = true;
  let authenticated = true;
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => authenticated ? {} : null,
    resolveActor: async () => ({ userId, eligible, hasAgentAccess: true }),
    hasAgentAccess: async () => true,
  });
  for (const method of ["PUT", "DELETE"]) {
    for (const id of ["unknown", legacy.id, privateEntry.id]) {
      const response = await resources.request(`/${id}/pin`, { method });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    }
    userId = undefined;
    expect((await resources.request(`/${publicEntry.id}/pin`, { method })).status).toBe(404);
    userId = "bob";
    eligible = false;
    expect((await resources.request(`/${publicEntry.id}/pin`, { method })).status).toBe(403);
    eligible = true;
    authenticated = false;
    expect((await resources.request(`/${publicEntry.id}/pin`, { method })).status).toBe(401);
    authenticated = true;
  }
});

it("concurrent users retain personal pins across fresh registry and pin-store instances", async () => {
  const entry = await registry.createOwned("agent", "everyone.html", "alice", "EVERYONE");
  await registry.replaceShares(entry.id, [{ kind: "all", mode: "read" }]);
  const resourcesFor = (userId: string) => createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent,
    registry: new DashboardRegistry(path.join(root, "canvas", "registry.json")),
    pins: new DashboardPinStore(path.join(root, "canvas", "pins.json")),
    authenticate: async () => ({}),
    resolveActor: async () => ({ userId, eligible: true }),
    hasAgentAccess: async () => false,
  });
  const responses = await Promise.all(["alice", "bob"].map((user) => resourcesFor(user).request(`/${entry.id}/pin`, { method: "PUT" })));
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(await (await resourcesFor("alice").request("/")).json()).toMatchObject({ owned: [{ id: entry.id, pinned: true }] });
  expect(await (await resourcesFor("bob").request("/")).json()).toMatchObject({ shared: [{ id: entry.id, pinned: true }] });
  await registry.replaceShares(entry.id, []);
  expect(await (await resourcesFor("bob").request("/")).json()).toEqual({ owned: [], shared: [] });
  await registry.replaceShares(entry.id, [{ kind: "all", mode: "read" }]);
  expect(await (await resourcesFor("bob").request("/")).json()).toMatchObject({ shared: [{ id: entry.id, pinned: true }] });
  expect((await resourcesFor("alice").request(`/${entry.id}`, { method: "DELETE" })).status).toBe(200);
  const recreated = await registry.createOwned("agent", "everyone.html", "alice", "RECREATED");
  expect(await (await resourcesFor("alice").request("/")).json()).toMatchObject({ owned: [{ id: recreated.id, pinned: false }], shared: [] });
});

it("single-user local actors pin dashboards and retain their preferences", async () => {
  const entry = await registry.createOwned("agent", "local.html", "local", "LOCAL");
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({}),
    resolveActor: async () => ({ userId: "local", eligible: true, hasAgentAccess: true }),
    hasAgentAccess: async () => true,
  });
  expect(await (await resources.request(`/${entry.id}/pin`, { method: "PUT" })).json()).toEqual({ ok: true, pinned: true });
  expect(await (await resources.request("/")).json()).toMatchObject({ owned: [{ id: entry.id, pinned: true }], shared: [] });
});

it("a non-member recipient sees published HTML and filtered published metadata, while a writer sees drafts", async () => {
  const entry = await registry.createOwned("agent", "parent.html", "alice", '<title>Published</title><script>YOPLAI.link("private.html")</script><h1>PUBLISHED</h1>');
  await registry.createOwned("agent", "private.html", "alice", "PRIVATE");
  await registry.replaceShares(entry.id, [{ kind: "user", id: "bob", mode: "read" }]);
  await fs.writeFile(path.join(root, "data", "dashboards", "parent.html"), "<title>Draft</title><h1>DRAFT</h1>");
  let userId = "bob";
  const deps = {
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({ user: { id: userId, name: userId } }),
    resolveActor: async () => ({ userId, eligible: true, hasAgentAccess: false }),
    hasAgentAccess: async () => false,
    listRecipients: async () => [], getOwnerName: async (id: string) => id,
  };
  const viewer = createDashboardRoutes(deps);
  const resources = createDashboardResourceRoutes(deps);
  const response = await viewer.request(`/${entry.id}`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("PUBLISHED");
  const list = await (await resources.request("/")).json();
  expect(list.shared).toMatchObject([{ title: "Published", linksTo: [], ownerName: "alice", mode: "read" }]);
  await registry.replaceShares(entry.id, [{ kind: "user", id: "bob", mode: "write" }]);
  expect(await (await viewer.request(`/${entry.id}`)).text()).toContain("DRAFT");
  userId = "stranger";
  expect((await viewer.request(`/${entry.id}`)).status).toBe(404);
});

it("owners without agent access manage eligible recipients, deny invalid grants and non-owner mutations", async () => {
  const entry = await registry.createOwned("agent", "share.html", "alice", "PUBLICATION");
  let userId = "alice";
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({ user: { id: userId } }),
    resolveActor: async () => ({ userId, eligible: true, hasAgentAccess: false }),
    hasAgentAccess: async () => false,
    listRecipients: async () => [{ id: "eve", name: "Eve", email: "eve@example.test" }],
  });
  expect(await (await resources.request("/recipients")).json()).toEqual({ users: [{ id: "eve", name: "Eve", email: "eve@example.test" }] });
  const patch = (shares: unknown) => resources.request(`/${entry.id}/sharing`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shares }) });
  expect((await patch([{ kind: "user", id: "eve", mode: "read" }])).status).toBe(200);
  expect((await patch([{ kind: "team", id: "team", mode: "write" }])).status).toBe(400);
  expect((await patch([{ kind: "user", id: "pending", mode: "read" }])).status).toBe(400);
  expect((await patch([{ kind: "all", mode: "read" }, { kind: "all", mode: "write" }])).status).toBe(400);
  userId = "eve";
  expect((await patch([])).status).toBe(404);
  expect((await resources.request(`/${entry.id}`, { method: "DELETE" })).status).toBe(404);
  userId = "alice";
  const list = await (await resources.request("/")).json();
  expect(list.owned[0].shares).toEqual([{ kind: "user", id: "eve", mode: "read" }]);
  expect((await resources.request(`/${entry.id}`, { method: "DELETE" })).status).toBe(200);
  expect(await (await resources.request("/")).json()).toEqual({ owned: [], shared: [] });
});

it("legacy claim preserves its link, publishes privately, and concurrent claims cannot overwrite the winner", async () => {
  await fs.writeFile(path.join(root, "data", "dashboards", "legacy.html"), "<h1>LEGACY</h1>");
  const entry = await registry.link("agent", "legacy.html");
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async (request) => ({ user: { id: request.headers.get("user") || "alice" } }),
    resolveActor: async (auth) => ({ userId: (auth as {user:{id:string}}).user.id, eligible: true, hasAgentAccess: true }),
    hasAgentAccess: async () => true,
  });
  const claims = await Promise.all(["alice", "dave"].map((user) => resources.request(`/${entry.id}/claim`, { method: "POST", headers: { user } })));
  expect(claims.map((response) => response.status).sort()).toEqual([200, 404]);
  const winner = await claims.find((response) => response.status === 200)!.json();
  expect(winner.dashboard).toMatchObject({ id: entry.id, isOwner: true, shares: [], legacy: false });
  expect(await registry.readPublished(entry.id)).toBe("<h1>LEGACY</h1>");
  const list = await (await resources.request("/", { headers: { user: winner.dashboard.ownerName === "alice" ? "dave" : "alice" } })).json();
  expect(list).toEqual({ owned: [], shared: [] });
});

it("non-member readers query live data with authenticated bindings, fail closed without publication, and lose access immediately", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(path.join(root, "data", "live.db"));
  db.exec("CREATE TABLE markers(value TEXT); INSERT INTO markers VALUES ('ONE')");
  const entry = await registry.createOwned("agent", "sql.html", "alice", '<script type="application/sql" data-name="marker" data-db="data/live.db">SELECT value, :viewer_email AS email FROM markers</script>');
  await registry.replaceShares(entry.id, [{ kind: "user", id: "bob", mode: "read" }]);
  await fs.writeFile(path.join(root, "data", "dashboards", "sql.html"), "DRAFT-MUST-NEVER-LEAK");
  let eligible = true;
  const viewer = createDashboardRoutes({
    getConfig: () => config, getAgent: () => agent, registry,
    authenticate: async () => ({ user: { id: "bob", email: "bob@example.test" } }),
    resolveActor: async () => ({ userId: "bob", eligible, hasAgentAccess: false }),
    hasAgentAccess: async () => false,
  });
  const first = await (await viewer.request(`/${entry.id}?viewer_email=spoof@example.test`)).text();
  expect(first).toContain('"value":"ONE","email":"bob@example.test"');
  db.exec("UPDATE markers SET value = 'TWO'");
  db.close();
  expect(await (await viewer.request(`/${entry.id}`)).text()).toContain('"value":"TWO"');
  eligible = false;
  expect((await viewer.request(`/${entry.id}`)).status).toBe(404);
  eligible = true;
  await registry.replaceShares(entry.id, []);
  expect((await viewer.request(`/${entry.id}`)).status).toBe(404);
  await registry.replaceShares(entry.id, [{ kind: "all", mode: "read" }]);
  await fs.rm(path.join(root, "canvas", "published"), { recursive: true });
  const missing = await viewer.request(`/${entry.id}`);
  expect(missing.status).toBe(404);
  expect(await missing.text()).not.toContain("DRAFT-MUST-NEVER-LEAK");
});

it("reader listing fails when published metadata is missing instead of offering a broken parameterized page", async () => {
  const entry = await registry.createOwned("agent", "detail.html", "alice", '<title>Published detail</title><meta name="yoplai:params" content="id">');
  await registry.replaceShares(entry.id, [{ kind: "user", id: "bob", mode: "read" }]);
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({ user: { id: "bob" } }),
    resolveActor: async () => ({ userId: "bob", eligible: true, hasAgentAccess: false }),
    hasAgentAccess: async () => false,
  });
  const before = await (await resources.request("/")).json();
  expect(before.shared).toEqual([expect.objectContaining({ title: "Published detail", params: ["id"] })]);
  await fs.rm(path.join(root, "canvas", "published"), { recursive: true });
  expect((await resources.request("/")).status).toBe(500);
});

it("authenticated ineligible accounts receive explicit API denial without directory or dashboard rows", async () => {
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({ user: { id: "pending" } }),
    resolveActor: async () => ({ userId: "pending", eligible: false, hasAgentAccess: false }),
    hasAgentAccess: async () => false,
    listRecipients: async () => [{ id: "alice", name: "Alice", email: "alice@example.test" }],
  });
  for (const target of ["/", "/recipients"]) {
    const response = await resources.request(target);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_ineligible" });
  }
});
