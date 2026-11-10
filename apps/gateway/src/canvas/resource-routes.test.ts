import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JSDOM, type DOMWindow } from "jsdom";
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
    hasAgentAccess: async () => false, sessionExists: async () => false,
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
    hasAgentAccess: async () => true, sessionExists: async () => false,
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
    hasAgentAccess: async () => false, sessionExists: async () => false,
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
    hasAgentAccess: async () => true, sessionExists: async () => false,
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
    hasAgentAccess: async () => false, sessionExists: async () => false,
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
  const denied = await viewer.request(`/${entry.id}`);
  expect(denied.status).toBe(403);
  expect(await denied.text()).toContain("<strong>Published</strong>. alice hasn't shared it with you.");
});

it("a page linking to a dashboard the viewer cannot read still loads, with that link disabled", async () => {
  const handbook = await registry.createOwned("agent", "handbook.html", "harry",
    '<!doctype html><html><head><title>People Handbook</title></head><body><nav></nav><a id="space">Personal space</a><h1 id="done"></h1><script>'
    + 'document.getElementById("space").href = YOPLAI.link("my-space.html");'
    + 'if (YOPLAI.canLink("okr.html")) { const a = document.createElement("a"); a.id = "okr"; a.href = YOPLAI.link("okr.html"); document.querySelector("nav").append(a); }'
    + 'if (YOPLAI.canLink("my-space.html")) { const a = document.createElement("a"); a.id = "nav-space"; document.querySelector("nav").append(a); }'
    + 'document.getElementById("done").textContent = "rendered";</script></body></html>');
  const okr = await registry.createOwned("agent", "okr.html", "harry", "OKR");
  await registry.createOwned("agent", "my-space.html", "phuong", "SPACE");
  await registry.replaceShares(handbook.id, [{ kind: "user", id: "melissa", mode: "read" }]);
  await registry.replaceShares(okr.id, [{ kind: "user", id: "melissa", mode: "read" }]);
  const viewer = createDashboardRoutes({
    getConfig: () => config, getAgent: () => agent, registry,
    authenticate: async () => ({ user: { id: "melissa" } }),
    resolveActor: async () => ({ userId: "melissa", eligible: true, hasAgentAccess: false }),
    hasAgentAccess: async () => false, sessionExists: async () => false,
  });
  const response = await viewer.request(`/${handbook.id}`);
  expect(response.status).toBe(200);
  const warn: unknown[] = [];
  const errors: unknown[] = [];
  const dom = new JSDOM(await response.text(), {
    url: `https://example.test/d/${handbook.id}`, runScripts: "dangerously",
    beforeParse(window) { window.console.warn = (message: unknown) => warn.push(message); window.console.error = (message: unknown) => errors.push(message); },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const document = dom.window.document;
  expect(document.getElementById("done")?.textContent).toBe("rendered");
  expect(document.getElementById("okr")?.getAttribute("href")).toBe(`/d/${okr.id}`);
  expect(document.getElementById("nav-space")).toBeNull();
  const space = document.getElementById("space")!;
  expect(space.getAttribute("aria-disabled")).toBe("true");
  expect(space.getAttribute("title")).toBe("Not shared with you");
  expect(warn).toHaveLength(1);
  expect(errors).toEqual([]);
  dom.window.close();
});

it("an eligible viewer without a share gets a friendly 403 naming the dashboard and its owner", async () => {
  const html = `<!doctype html><html><head><title>Phuong's "Space" & co</title></head><body>SECRET-CONTENT</body></html>`;
  const entry = await registry.createOwned("agent", "my-space.html", "phuong", html);
  await fs.writeFile(path.join(root, "data", "dashboards", "my-space.html"), html);
  await registry.replaceShares(entry.id, [{ kind: "user", id: "bob", mode: "read" }]);
  let actor: { userId?: string; eligible: boolean; superadmin?: boolean } = { userId: "melissa", eligible: true };
  let signedIn = true;
  const viewer = createDashboardRoutes({
    getConfig: () => config, getAgent: (id) => (id === "agent" ? agent : undefined), registry,
    authenticate: async () => (signedIn ? { user: { id: actor.userId } } : null),
    resolveActor: async () => ({ ...actor, hasAgentAccess: false }),
    hasAgentAccess: async () => false, sessionExists: async () => false,
    getOwnerName: async (id) => (id === "phuong" ? "Phuong <Tran>" : "Unknown user"),
  });
  const denied = await viewer.request(`/${entry.id}`);
  expect(denied.status).toBe(403);
  expect(denied.headers.get("Cache-Control")).toBe("no-store");
  expect(denied.headers.get("Content-Security-Policy")).toContain("sandbox allow-scripts");
  const page = await denied.text();
  expect(page).not.toContain("SECRET-CONTENT");
  const dom = new JSDOM(page);
  expect(dom.window.document.body.textContent?.replace(/\s+/g, " ")).toContain(
    "You don't have access to Phuong's \"Space\" & co. Phuong <Tran> hasn't shared it with you. Ask them to share it."
  );
  expect(dom.window.document.querySelector("strong")?.textContent).toBe('Phuong\'s "Space" & co');
  dom.window.close();

  for (const allowed of [{ userId: "phuong", eligible: true }, { userId: "bob", eligible: true }, { userId: "admin", eligible: true, superadmin: true }]) {
    actor = allowed;
    const response = await viewer.request(`/${entry.id}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("SECRET-CONTENT");
  }
  actor = { userId: "pending", eligible: false };
  expect((await viewer.request(`/${entry.id}`)).status).toBe(404);
  actor = { userId: "melissa", eligible: true };
  expect((await viewer.request("/missing-id")).status).toBe(404);
  signedIn = false;
  const login = await viewer.request(`/${entry.id}`);
  expect(login.status).toBe(302);
  expect(login.headers.get("location")).toBe(`https://example.test/login?returnTo=%2F${entry.id}`);
});

it("owners without agent access manage eligible recipients, deny invalid grants and non-owner mutations", async () => {
  const entry = await registry.createOwned("agent", "share.html", "alice", "PUBLICATION");
  let userId = "alice";
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({ user: { id: userId } }),
    resolveActor: async () => ({ userId, eligible: true, hasAgentAccess: false }),
    hasAgentAccess: async () => false, sessionExists: async () => false,
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
    hasAgentAccess: async () => true, sessionExists: async () => false,
  });
  const claims = await Promise.all(["alice", "dave"].map((user) => resources.request(`/${entry.id}/claim`, { method: "POST", headers: { user } })));
  expect(claims.map((response) => response.status).sort()).toEqual([200, 404]);
  const winner = await claims.find((response) => response.status === 200)!.json();
  expect(winner.dashboard).toMatchObject({ id: entry.id, isOwner: true, shares: [], legacy: false, chatHref: `/chat/agent?dashboard=${entry.id}&new=1` });
  expect(await registry.get(entry.id)).not.toHaveProperty("createdIn");
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
    hasAgentAccess: async () => false, sessionExists: async () => false,
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
  const revoked = await viewer.request(`/${entry.id}`);
  expect(revoked.status).toBe(403);
  const page = await revoked.text();
  expect(page).toContain("You don't have access to <strong>sql.html</strong>. The owner hasn't shared it with you.");
  expect(page).not.toContain("DRAFT-MUST-NEVER-LEAK");
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
    hasAgentAccess: async () => false, sessionExists: async () => false,
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
    hasAgentAccess: async () => false, sessionExists: async () => false,
    listRecipients: async () => [{ id: "alice", name: "Alice", email: "alice@example.test" }],
  });
  for (const target of ["/", "/recipients"]) {
    const response = await resources.request(target);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "account_ineligible" });
  }
});

it("dashboard list resumes its creator's existing conversation and falls back after deletion", async () => {
  const entry = await registry.createOwned("agent", "harbor.html", "alice", "HARBOR", { sessionId: "original", userId: "alice" });
  const history = path.join(root, "history", "alice", "agent-original.jsonl");
  await fs.mkdir(path.dirname(history), { recursive: true });
  await fs.writeFile(history, "{}\n");
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({}),
    resolveActor: async () => ({ userId: "alice", eligible: true, hasAgentAccess: true }),
    hasAgentAccess: async () => true,
    sessionExists: async (userId, agentId, sessionId) => {
      try {
        await fs.access(path.join(root, "history", userId, `${agentId}-${sessionId}.jsonl`));
        return true;
      } catch { return false; }
    },
  });
  expect(await (await resources.request("/")).json()).toMatchObject({
    owned: [{ id: entry.id, chatHref: `/chat/agent?session=original&dashboard=${entry.id}` }],
  });
  const sharing = await resources.request(`/${entry.id}/sharing`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shares: [] }),
  });
  expect(await sharing.json()).toMatchObject({ dashboard: { chatHref: `/chat/agent?session=original&dashboard=${entry.id}` } });
  await fs.rm(history);
  expect(await (await resources.request("/")).json()).toMatchObject({
    owned: [{ id: entry.id, chatHref: `/chat/agent?dashboard=${entry.id}&new=1` }],
  });
});

it("dashboard pages allow only same-origin framing and expose Chat only at top level with agent access", async () => {
  const html = "<!doctype html><html><head><title>Harbor</title></head><body><h1>Harbor</h1></body></html>";
  const entry = await registry.createOwned("agent", "harbor.html", "alice", html, { sessionId: "original", userId: "alice" });
  await fs.writeFile(path.join(root, "data", "dashboards", "harbor.html"), html);
  let hasAgentAccess = true;
  const viewer = createDashboardRoutes({
    getConfig: () => config, getAgent: () => agent, registry,
    authenticate: async () => ({}),
    resolveActor: async () => ({ userId: "alice", eligible: true, hasAgentAccess }),
    hasAgentAccess: async () => hasAgentAccess,
    sessionExists: async () => true,
  });
  const response = await viewer.request(`/${entry.id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Security-Policy")!.split("; ")).toContain("frame-ancestors 'self'");
  const rendered = await response.text();
  const dom = new JSDOM(rendered, { url: `https://example.test/d/${entry.id}`, runScripts: "dangerously" });
  await new Promise<void>((resolve) => dom.window.addEventListener("load", () => resolve(), { once: true }));
  const chat = dom.window.document.querySelector("a");
  expect(chat?.textContent).toBe("Chat");
  expect(chat?.getAttribute("href")).toBe(`/chat/agent?session=original&dashboard=${entry.id}`);
  expect(chat?.target).toBe("_blank");
  expect(chat?.rel).toBe("noopener noreferrer");
  const iframe = dom.window.document.createElement("iframe");
  dom.window.document.body.append(iframe);
  iframe.contentDocument!.open();
  iframe.contentDocument!.write(rendered);
  iframe.contentDocument!.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(iframe.contentDocument!.querySelector("a")).toBeNull();
  dom.window.close();
  hasAgentAccess = false;
  const withoutAccess = new JSDOM(await (await viewer.request(`/${entry.id}`)).text(), { runScripts: "dangerously" });
  await new Promise<void>((resolve) => withoutAccess.window.addEventListener("load", () => resolve(), { once: true }));
  expect(withoutAccess.window.document.querySelector("a")).toBeNull();
  withoutAccess.window.close();
});

it("shared viewers get new chats only with agent access and lost-access creators get no Chat action", async () => {
  const entry = await registry.createOwned("agent", "harbor.html", "alice", "HARBOR", { sessionId: "original", userId: "alice" });
  await registry.replaceShares(entry.id, [{ kind: "all", mode: "read" }]);
  let userId = "bob";
  let hasAgentAccess = true;
  const checks: string[][] = [];
  const resources = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => agent, registry, pins,
    authenticate: async () => ({}),
    resolveActor: async () => ({ userId, eligible: true, hasAgentAccess }),
    hasAgentAccess: async () => hasAgentAccess,
    sessionExists: async (...ids) => { checks.push(ids); return true; },
  });
  expect(await (await resources.request("/")).json()).toMatchObject({
    shared: [{ id: entry.id, chatHref: `/chat/agent?dashboard=${entry.id}&new=1` }],
  });
  expect(checks).toEqual([]);
  hasAgentAccess = false;
  expect(await (await resources.request("/")).json()).toMatchObject({ shared: [{ id: entry.id, chatHref: null }] });
  userId = "alice";
  expect(await (await resources.request("/")).json()).toMatchObject({ owned: [{ id: entry.id, chatHref: null }] });
  expect(checks).toEqual([]);
});

type AnnotationMessage = { channel?: string; type?: string; [key: string]: unknown };

async function framedDashboard(rendered: string) {
  const parent = new JSDOM("<!doctype html><body></body>", { url: "https://example.test/chat/agent", runScripts: "dangerously" });
  const received: AnnotationMessage[] = [];
  parent.window.addEventListener("message", (event) => received.push(event.data));
  const iframe = parent.window.document.createElement("iframe");
  parent.window.document.body.append(iframe);
  iframe.contentDocument!.open();
  iframe.contentDocument!.write(rendered);
  iframe.contentDocument!.close();
  // The page announces itself asynchronously; wait for it so a late `ready`
  // never lands after the messages a test asserts on.
  if (!rendered.includes("data-annotation")) await new Promise((resolve) => setTimeout(resolve, 10));
  else await vi.waitFor(() => expect(received.some((message) => message?.channel === "yoplai-annotate" && message.type === "ready")).toBe(true));
  const page = iframe.contentWindow as unknown as DOMWindow;
  const send = (data: unknown) => page.dispatchEvent(new page.MessageEvent("message", { data, source: parent.window as never }));
  const annotations = () => received.filter((message) => message?.channel === "yoplai-annotate");
  return { parent, page, send, annotations };
}

const GARDEN_PAGE = '<!doctype html><html><head><title>Garden plan</title></head><body><h2>Beds</h2><section id="beds"><p class="bed">Tomatoes 12</p><a id="go" href="#elsewhere">Seed catalog</a></section><script>document.getElementById("go").addEventListener("click", () => { document.body.dataset.pageClicks = String(Number(document.body.dataset.pageClicks || 0) + 1); });</script></body></html>';

async function annotationViewer(actor: { userId: string; hasAgentAccess: boolean }, shares: Array<{ kind: "user"; id: string; mode: "read" | "write" }> = [], html = GARDEN_PAGE, query: Record<string, string> = { bed: "north" }) {
  const entry = await registry.createOwned("agent", "garden-plan.html", "alice", html);
  await registry.replaceShares(entry.id, shares);
  await fs.writeFile(path.join(root, "data", "dashboards", "garden-plan.html"), html);
  const viewer = createDashboardRoutes({
    getConfig: () => config, getAgent: () => agent, registry,
    authenticate: async () => ({ user: { id: actor.userId } }),
    resolveActor: async () => ({ userId: actor.userId, eligible: true, hasAgentAccess: actor.hasAgentAccess }),
    hasAgentAccess: async () => actor.hasAgentAccess, sessionExists: async () => false,
  });
  const response = await viewer.request(`/${entry.id}?${new URLSearchParams(query)}`);
  expect(response.status).toBe(200);
  return { entry, rendered: await response.text() };
}

it("a framed dashboard announces itself to the chat when its owner can chat with the page's agent", async () => {
  const { entry, rendered } = await annotationViewer({ userId: "alice", hasAgentAccess: true });
  const { parent, annotations } = await framedDashboard(rendered);
  expect(annotations()).toEqual([{ channel: "yoplai-annotate", type: "ready", id: entry.id, slug: "garden-plan.html", agentId: "agent", title: "Garden plan", params: { bed: "north" } }]);
  parent.window.close();
});

it.each([
  { who: "a write-share user with agent access", actor: { userId: "carol", hasAgentAccess: true }, mode: "write" as const, offered: true },
  { who: "a write-share user without agent access", actor: { userId: "carol", hasAgentAccess: false }, mode: "write" as const, offered: false },
  { who: "a read-only viewer with agent access", actor: { userId: "carol", hasAgentAccess: true }, mode: "read" as const, offered: false },
  { who: "an owner who lost agent access", actor: { userId: "alice", hasAgentAccess: false }, mode: "read" as const, offered: false },
])("annotation mode is offered to $who: $offered", async ({ actor, mode, offered }) => {
  const { rendered } = await annotationViewer(actor, [{ kind: "user", id: "carol", mode }]);
  const { parent, annotations } = await framedDashboard(rendered);
  expect(annotations().map((message) => message.type)).toEqual(offered ? ["ready"] : []);
  parent.window.close();
});

it("a dashboard opened at top level stays a plain page even for its owner", async () => {
  const { rendered } = await annotationViewer({ userId: "alice", hasAgentAccess: true });
  const top = new JSDOM(rendered, { url: "https://example.test/d/garden", runScripts: "dangerously" });
  const received: unknown[] = [];
  top.window.addEventListener("message", (event) => received.push(event.data));
  await new Promise((resolve) => setTimeout(resolve, 10));
  top.window.document.getElementById("go")!.click();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(top.window.document.body.dataset.pageClicks).toBe("1");
  expect(top.window.location.hash).toBe("#elsewhere");
  expect(received).toEqual([]);
  top.window.close();
});

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const annotationUi = (page: DOMWindow) => page.document.querySelector("yoplai-annotations")!.shadowRoot!;
async function writeNote(page: DOMWindow, text: string) {
  const ui = annotationUi(page);
  const field = ui.querySelector<HTMLTextAreaElement>('textarea[aria-label="Note"]')!;
  field.value = text;
  [...ui.querySelectorAll("button")].find((button) => button.textContent === "Add")!.click();
  await tick();
}

it("in annotation mode a click notes the element for the chat instead of acting on the page, and normal clicks return when it ends", async () => {
  const { rendered } = await annotationViewer({ userId: "alice", hasAgentAccess: true });
  const { parent, page, send, annotations } = await framedDashboard(rendered);
  const link = page.document.getElementById("go")!;
  // dispatchEvent returns false when the default action (following the link) is cancelled.
  const click = () => link.dispatchEvent(new page.MouseEvent("click", { bubbles: true, cancelable: true }));
  send({ channel: "yoplai-annotate", type: "set", on: true });
  expect(click()).toBe(false);
  await writeNote(page, "Link to the spring catalog");
  expect(page.document.body.dataset.pageClicks).toBeUndefined();
  expect(annotations().at(-1)).toEqual({
    channel: "yoplai-annotate", type: "note", id: expect.any(String),
    selector: "a#go", tag: "a", text: "Seed catalog", heading: "Beds", ancestor: "section#beds",
    note: "Link to the spring catalog",
  });
  send({ channel: "yoplai-annotate", type: "set", on: false });
  expect(click()).toBe(true);
  await tick();
  expect(page.document.body.dataset.pageClicks).toBe("1");
  expect(annotations().map((message) => message.type)).toEqual(["ready", "note"]);
  parent.window.close();
});

it("noted elements carry a short CSS path, their visible text, the heading above them and the nearest identified container", async () => {
  const crewBoard = `<!doctype html><html><head><title>Crew board</title></head><body>
    <h1>Crew board</h1>
    <div data-widget="roster"><table class="dk-table striped wide"><tbody>
      <tr><td>Ann</td></tr><tr><td>Bo</td></tr><tr><td>Cy  -
        Roadmap review</td></tr>
    </tbody></table></div>
    <h2>Notes</h2>
    <div><p>${"a".repeat(300)}</p></div>
  </body></html>`;
  const { rendered } = await annotationViewer({ userId: "alice", hasAgentAccess: true }, [], crewBoard);
  const { parent, page, send, annotations } = await framedDashboard(rendered);
  send({ channel: "yoplai-annotate", type: "set", on: true });
  page.document.querySelectorAll("tr")[2].click();
  await writeNote(page, "Move to the top");
  page.document.querySelector("p")!.click();
  await writeNote(page, "Shorten");
  const [row, paragraph] = annotations().filter((message) => message.type === "note");
  expect(row).toMatchObject({
    selector: "div:nth-of-type(1) > table.dk-table.striped > tbody > tr:nth-of-type(3)",
    tag: "tr", text: "Cy - Roadmap review", heading: "Crew board", ancestor: 'div[data-widget="roster"]',
  });
  expect(paragraph).toMatchObject({
    selector: "div:nth-of-type(2) > p", tag: "p", text: `${"a".repeat(119)}…`, heading: "Notes", ancestor: "",
  });
  parent.window.close();
});

it("annotated elements show numbered markers the chat can remove or clear, Esc asks the chat to leave the mode, and other windows cannot switch it on", async () => {
  const { rendered } = await annotationViewer({ userId: "alice", hasAgentAccess: true });
  const { parent, page, send, annotations } = await framedDashboard(rendered);
  const markers = () => [...annotationUi(page).querySelectorAll(".marker")].map((marker) => marker.textContent);
  page.dispatchEvent(new page.MessageEvent("message", { data: { channel: "yoplai-annotate", type: "set", on: true }, source: page as never }));
  page.document.getElementById("go")!.click();
  await tick();
  expect(page.document.body.dataset.pageClicks).toBe("1");
  send({ channel: "yoplai-annotate", type: "set", on: true });
  page.document.querySelector("p")!.click();
  await writeNote(page, "Bigger font");
  page.document.getElementById("go")!.click();
  await writeNote(page, "Remove");
  expect(markers()).toEqual(["1", "2"]);
  const first = annotations().find((message) => message.type === "note")!;
  send({ channel: "yoplai-annotate", type: "remove", id: first.id });
  expect(markers()).toEqual(["1"]);
  send({ channel: "yoplai-annotate", type: "clear" });
  expect(markers()).toEqual([]);
  page.document.querySelector("p")!.click();
  page.document.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  expect(annotations().filter((message) => message.type === "exit")).toEqual([]);
  page.document.dispatchEvent(new page.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await tick();
  expect(annotations().filter((message) => message.type === "exit")).toEqual([{ channel: "yoplai-annotate", type: "exit" }]);
  parent.window.close();
});

it("hostile URL parameters reach the chat as plain data without adding markup to the page", async () => {
  const hostile = '"><img src=x id=injected>';
  const { rendered } = await annotationViewer({ userId: "alice", hasAgentAccess: true }, [], GARDEN_PAGE, { bed: hostile });
  const { parent, page, annotations } = await framedDashboard(rendered);
  expect(annotations()[0]).toMatchObject({ type: "ready", params: { bed: hostile } });
  expect(page.document.getElementById("injected")).toBeNull();
  parent.window.close();
});
