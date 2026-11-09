import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { createDashboardRoutes } from "./routes.js";
import { DashboardRegistry } from "./store.js";
import type { DashboardActor } from "./policy.js";

let root: string;
let registry: DashboardRegistry;
let agent: AgentConfig;
const config = { canvas: { enabled: true, baseUrl: "https://example.test" } } as GatewayConfig;

type User = { id: string; email: string; name: string };
const alice: User = { id: "alice", email: "alice@example.test", name: "Alice Martin" };
const bob: User = { id: "bob", email: "bob@example.test", name: "Bob Durand" };
const carol: User = { id: "carol", email: "carol@example.test", name: "Carol Petit" };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-edit-"));
  registry = new DashboardRegistry(path.join(root, "canvas", "registry.json"));
  agent = { id: "agent", name: "Agent", workspace: root } as AgentConfig;
  await fs.mkdir(path.join(root, "data", "dashboards"), { recursive: true });
  const db = new Database(path.join(root, "data", "hr.db"));
  db.exec(`
    CREATE TABLE actions(id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled', owner TEXT, done INTEGER NOT NULL DEFAULT 0,
      pct INTEGER, status TEXT, comment TEXT, archived INTEGER NOT NULL DEFAULT 0, edited_at TEXT);
    INSERT INTO actions(id, title, owner, done, pct, status) VALUES
      (1, 'Plan onboarding', 'alice@example.test', 0, 10, 'open'),
      (2, 'Update KPI', 'bob@example.test', 0, 40, 'open'),
      (3, 'Review goals', 'carol@example.test', 0, 0, 'open');
  `);
  db.close();
});
afterEach(async () => { vi.useRealTimers(); await fs.rm(root, { recursive: true, force: true }); });

const declaration = (extra: Record<string, unknown> = {}) =>
  `<script type="application/json" data-yoplai-edit="actions">${JSON.stringify({
    db: "data/hr.db", table: "actions", key: "id", updatedAt: "edited_at",
    fields: {
      done: { type: "bool" }, pct: { type: "int", min: 0, max: 100, nullable: true },
      status: { type: "enum", values: ["open", "blocked", "closed"] }, title: { type: "text", max: 40 },
      comment: { type: "text", nullable: true }, archived: { type: "bool" },
    },
    ...extra,
  })}</script>`;
const listQuery = `<script type="application/sql" data-name="rows" data-db="data/hr.db">SELECT id, done, pct, comment FROM actions WHERE NOT archived ORDER BY id</script>`;

/** Creates an owned page (published copy and live draft) and returns its id. */
async function page(html = declaration() + listQuery, owner = alice.id): Promise<string> {
  const entry = await registry.createOwned("agent", "actions.html", owner, html);
  await fs.writeFile(path.join(root, "data", "dashboards", "actions.html"), html);
  return entry.id;
}

function routesFor(state: { user: User; impersonating?: boolean; eligible?: boolean }) {
  return createDashboardRoutes({
    getConfig: () => config, getAgent: () => agent, registry,
    authenticate: async () => ({
      user: state.user,
      ...(state.impersonating ? { impersonator: { id: "admin" } } : {}),
    }),
    resolveActor: async (auth): Promise<DashboardActor> => ({
      userId: (auth as { user: User }).user.id, eligible: state.eligible ?? true, hasAgentAccess: false,
    }),
    hasAgentAccess: async () => false, sessionExists: async () => false,
  });
}

/** Opens the page as `user` and returns what the page runtime received. */
async function open(id: string, user: User, extra: { impersonating?: boolean } = {}) {
  const routes = routesFor({ user, ...extra });
  const response = await routes.request(`/${id}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  const token = /"editToken":"([^"]+)"/.exec(html)?.[1] ?? null;
  const canWrite = /"canWrite":(true|false)/.exec(html)?.[1] === "true";
  return { html, token, canWrite, csp: response.headers.get("content-security-policy") ?? "" };
}

function post(id: string, op: "edit" | "add", body: Record<string, unknown>, user: User = alice) {
  return routesFor({ user }).request(`/${id}/${op}`, {
    method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: "null" }, body: JSON.stringify(body),
  });
}

function rows(sql: string, ...params: unknown[]) {
  const db = new Database(path.join(root, "data", "hr.db"), { readonly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}

it("the owner ticks done on a row: the value is saved with its edit time and an audit row names who changed what", async () => {
  const id = await page();
  const { token } = await open(id, alice);
  const response = await post(id, "edit", { token, edit: "actions", key: 1, field: "done", value: true });
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  const body = await response.json() as { ok: boolean; value: unknown; at: string };
  expect(body).toMatchObject({ ok: true, value: true });
  expect(Date.parse(body.at)).toBeGreaterThan(Date.now() - 60_000);
  expect(rows("SELECT done, edited_at FROM actions WHERE id = 1")).toEqual([{ done: 1, edited_at: body.at }]);
  expect(rows("SELECT * FROM dashboard_edits")).toEqual([{
    id: 1, at: body.at, dashboard_id: id, actor_user_id: "alice", actor_email: "alice@example.test", actor_name: "Alice Martin",
    edit_name: "actions", table_name: "actions", row_key: "1", field: "done", old_value: "0", new_value: "1",
  }]);
});

it("a read-only viewer edits only the rows the page guard gives them, and gets a clear refusal elsewhere", async () => {
  const id = await page(declaration({ guard: "SELECT 1 FROM actions WHERE id = :key AND owner = :viewer_email" }) + listQuery);
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  const { token, canWrite } = await open(id, bob);
  expect(canWrite).toBe(false);
  const own = await post(id, "edit", { token, edit: "actions", key: "2", field: "pct", value: 75 }, bob);
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({ ok: true, value: 75 });
  const other = await post(id, "edit", { token, edit: "actions", key: "1", field: "pct", value: 75 }, bob);
  expect(other.status).toBe(403);
  expect(await other.json()).toEqual({ ok: false, error: "You cannot edit this row" });
  expect(rows("SELECT id, pct FROM actions ORDER BY id")).toEqual([{ id: 1, pct: 10 }, { id: 2, pct: 75 }, { id: 3, pct: 0 }]);
  expect(rows("SELECT actor_user_id, actor_email, row_key, field, old_value, new_value FROM dashboard_edits")).toEqual([
    { actor_user_id: "bob", actor_email: "bob@example.test", row_key: "2", field: "pct", old_value: "40", new_value: "75" },
  ]);
});

it("a manager edits their reports' rows through a guard that follows the reporting line", async () => {
  const db = new Database(path.join(root, "data", "hr.db"));
  db.exec("CREATE TABLE people(email TEXT PRIMARY KEY, manager TEXT); INSERT INTO people VALUES ('bob@example.test', 'carol@example.test'), ('alice@example.test', NULL)");
  db.close();
  const guard = "SELECT 1 FROM actions a JOIN people p ON p.email = a.owner WHERE a.id = :key AND (a.owner = :viewer_email OR p.manager = :viewer_email)";
  const id = await page(declaration({ guard }) + listQuery);
  await registry.replaceShares(id, [{ kind: "all", mode: "read" }]);
  const { token } = await open(id, carol);
  expect((await post(id, "edit", { token, edit: "actions", key: 2, field: "status", value: "blocked" }, carol)).status).toBe(200);
  expect((await post(id, "edit", { token, edit: "actions", key: 1, field: "status", value: "blocked" }, carol)).status).toBe(403);
  expect(rows("SELECT id, status FROM actions WHERE status = 'blocked'")).toEqual([{ id: 2, status: "blocked" }]);
});

it("a write-share user edits any row; a read-only viewer on a page without guard is refused", async () => {
  const id = await page();
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "write" }, { kind: "user", id: "carol", mode: "read" }]);
  const writer = await open(id, bob);
  expect(writer.canWrite).toBe(true);
  expect((await post(id, "edit", { token: writer.token, edit: "actions", key: 3, field: "title", value: "Review 2026 goals" }, bob)).status).toBe(200);
  const reader = await open(id, carol);
  const refused = await post(id, "edit", { token: reader.token, edit: "actions", key: 3, field: "title", value: "Hijacked" }, carol);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ ok: false, error: "You can only view this dashboard" });
  expect(rows("SELECT title FROM actions WHERE id = 3")).toEqual([{ title: "Review 2026 goals" }]);
});

it("values are checked against the declaration: undeclared edits and fields, wrong types, enum and range are refused; nullable fields clear", async () => {
  const id = await page();
  const { token } = await open(id, alice);
  const edit = async (body: Record<string, unknown>) => {
    const response = await post(id, "edit", { token, edit: "actions", key: 1, ...body });
    return { status: response.status, body: await response.json() };
  };
  expect(await edit({ edit: "other", field: "done", value: true })).toEqual({ status: 400, body: { ok: false, error: "This page declares no edit named other" } });
  expect(await edit({ field: "owner", value: "bob@example.test" })).toEqual({ status: 400, body: { ok: false, error: "Field owner is not editable in actions" } });
  expect(await edit({ field: "done", value: "yes" })).toEqual({ status: 400, body: { ok: false, error: "done must be true or false" } });
  expect(await edit({ field: "pct", value: 101 })).toEqual({ status: 400, body: { ok: false, error: "pct must be at most 100" } });
  expect(await edit({ field: "pct", value: 12.5 })).toEqual({ status: 400, body: { ok: false, error: "pct must be a whole number" } });
  expect(await edit({ field: "status", value: "done" })).toEqual({ status: 400, body: { ok: false, error: "status must be one of open, blocked, closed" } });
  expect(await edit({ field: "title", value: "x".repeat(41) })).toEqual({ status: 400, body: { ok: false, error: "title must be at most 40 characters" } });
  expect(await edit({ field: "done", value: null })).toEqual({ status: 400, body: { ok: false, error: "done must be set (it cannot be empty)" } });
  expect(rows("SELECT done, pct, status, title FROM actions WHERE id = 1")).toEqual([{ done: 0, pct: 10, status: "open", title: "Plan onboarding" }]);
  expect(rows("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dashboard_edits'")).toEqual([{ n: 0 }]);
  expect(await edit({ field: "pct", value: null })).toMatchObject({ status: 200, body: { ok: true, value: null } });
  expect(rows("SELECT pct FROM actions WHERE id = 1")).toEqual([{ pct: null }]);
  expect(rows("SELECT old_value, new_value FROM dashboard_edits")).toEqual([{ old_value: "10", new_value: "null" }]);
  // Cleared text: a nullable field goes back to "not set", a required one keeps the empty text.
  expect(await edit({ field: "comment", value: "Ask IT" })).toMatchObject({ status: 200 });
  expect(await edit({ field: "comment", value: "" })).toMatchObject({ status: 200, body: { ok: true, value: null } });
  expect(await edit({ field: "title", value: "" })).toMatchObject({ status: 200, body: { ok: true, value: "" } });
  expect(rows("SELECT comment, title FROM actions WHERE id = 1")).toEqual([{ comment: null, title: "" }]);
});

it("a missing row is reported as not found and leaves no audit row", async () => {
  const id = await page();
  const { token } = await open(id, alice);
  const response = await post(id, "edit", { token, edit: "actions", key: 99, field: "done", value: true });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ ok: false, error: "Row not found" });
  expect(rows("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dashboard_edits'")).toEqual([{ n: 0 }]);
});

it("forged, foreign and expired tokens are refused with a reload hint", async () => {
  const id = await page();
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  const { token } = await open(id, bob);
  const reload = { ok: false, error: "Reload to keep editing" };
  const [payload, signature] = token!.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  const forged = `${Buffer.from(JSON.stringify({ ...claims, userId: "alice" })).toString("base64url")}.${signature}`;
  for (const bad of [forged, undefined, "garbage"]) {
    const response = await post(id, "edit", { token: bad, edit: "actions", key: 1, field: "done", value: true }, bob);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(reload);
  }
  const otherEntry = await registry.createOwned("agent", "other.html", "bob", declaration());
  await fs.writeFile(path.join(root, "data", "dashboards", "other.html"), declaration());
  const otherToken = (await open(otherEntry.id, bob)).token;
  expect((await post(id, "edit", { token: otherToken, edit: "actions", key: 1, field: "done", value: true }, bob)).status).toBe(401);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 8 * 60 * 60 * 1000 + 60_000 });
  const expired = await post(otherEntry.id, "edit", { token: otherToken, edit: "actions", key: 1, field: "done", value: true }, bob);
  expect(expired.status).toBe(401);
  expect(await expired.json()).toEqual(reload);
  expect(rows("SELECT done FROM actions WHERE id = 1")).toEqual([{ done: 0 }]);
});

it("revoking a share stops a token that was issued before, at once", async () => {
  const id = await page();
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "write" }]);
  const { token } = await open(id, bob);
  expect((await post(id, "edit", { token, edit: "actions", key: 1, field: "done", value: true }, bob)).status).toBe(200);
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  expect((await post(id, "edit", { token, edit: "actions", key: 1, field: "done", value: false }, bob)).status).toBe(403);
  await registry.replaceShares(id, []);
  const revoked = await post(id, "edit", { token, edit: "actions", key: 1, field: "done", value: false }, bob);
  expect(revoked.status).toBe(403);
  expect(await revoked.json()).toEqual({ ok: false, error: "You no longer have access to this dashboard" });
  expect(rows("SELECT done FROM actions WHERE id = 1")).toEqual([{ done: 1 }]);
});

it("legacy unowned pages get no edit token and refuse edits until claimed", async () => {
  await fs.writeFile(path.join(root, "data", "dashboards", "legacy.html"), declaration());
  const legacy = await registry.link("agent", "legacy.html");
  const routes = createDashboardRoutes({
    getConfig: () => config, getAgent: () => agent, registry,
    authenticate: async () => ({ user: alice }),
    resolveActor: async () => ({ userId: "alice", eligible: true, hasAgentAccess: true }),
    hasAgentAccess: async () => true, sessionExists: async () => false,
  });
  const html = await (await routes.request(`/${legacy.id}`)).text();
  expect(html).toContain('"editToken":null');
  const owned = await page();
  const { token } = await open(owned, alice);
  const forgedForLegacy = await routes.request(`/${legacy.id}/edit`, { method: "POST", body: JSON.stringify({ token, edit: "actions", key: 1, field: "done", value: true }) });
  expect(forgedForLegacy.status).toBe(401);
});

it("a platform admin impersonating a user gets a read-only page: no edit token, canWrite false", async () => {
  const id = await page();
  const impersonated = await open(id, alice, { impersonating: true });
  expect(impersonated.token).toBeNull();
  expect(impersonated.canWrite).toBe(false);
  expect(impersonated.html).toContain('"editToken":null');
  const normal = await open(id, alice);
  expect(normal.token).toMatch(/^[\w-]+\.[\w-]+$/);
  expect(normal.canWrite).toBe(true);
  expect(normal.csp).toContain("connect-src https://example.test/d/;");
});

it("edits show on the next render for another viewer, and a soft-deleted row leaves the page with an audit of who hid it", async () => {
  const id = await page();
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  const { token } = await open(id, alice);
  expect((await post(id, "edit", { token, edit: "actions", key: 1, field: "comment", value: "Waiting for the IT laptop" })).status).toBe(200);
  expect((await post(id, "edit", { token, edit: "actions", key: 3, field: "archived", value: true })).status).toBe(200);
  const later = await open(id, bob);
  expect(later.html).toContain('"rows":[{"id":1,"done":0,"pct":10,"comment":"Waiting for the IT laptop"},{"id":2,"done":0,"pct":40,"comment":null}]');
  expect(rows("SELECT actor_name, row_key, field, old_value, new_value FROM dashboard_edits WHERE field = 'archived'")).toEqual([
    { actor_name: "Alice Martin", row_key: "3", field: "archived", old_value: "0", new_value: "1" },
  ]);
});

it("concurrent edits of the same row both land and are both audited, last write wins", async () => {
  const id = await page();
  const { token } = await open(id, alice);
  const responses = await Promise.all([25, 50, 75, 100].map((value) =>
    post(id, "edit", { token, edit: "actions", key: 2, field: "pct", value })));
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  const audit = rows("SELECT old_value, new_value FROM dashboard_edits ORDER BY id") as Array<{ old_value: string; new_value: string }>;
  expect(audit.map((row) => row.new_value).sort()).toEqual(["100", "25", "50", "75"]);
  // Each edit saw the value the previous one wrote: the chain starts at 40 and ends at the stored value.
  expect(audit[0].old_value).toBe("40");
  for (let index = 1; index < audit.length; index++) expect(audit[index].old_value).toBe(audit[index - 1].new_value);
  expect(rows("SELECT pct FROM actions WHERE id = 2")).toEqual([{ pct: Number(audit.at(-1)!.new_value) }]);
});

it("a writer adds a row: the server assigns the key, column defaults show, and the add is audited", async () => {
  const id = await page(declaration({ create: true }) + listQuery);
  const { token } = await open(id, alice);
  const response = await post(id, "add", { token, edit: "actions", values: { title: "Book the offsite", pct: 5 } });
  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe("*");
  const body = await response.json() as { at: string };
  expect(body).toEqual({
    ok: true, key: 4, at: body.at,
    values: { done: false, pct: 5, status: null, title: "Book the offsite", comment: null, archived: false },
  });
  expect(rows("SELECT id, title, done, pct, edited_at FROM actions WHERE id = 4")).toEqual([
    { id: 4, title: "Book the offsite", done: 0, pct: 5, edited_at: body.at },
  ]);
  expect(rows("SELECT actor_user_id, row_key, field, old_value, new_value FROM dashboard_edits")).toEqual([
    { actor_user_id: "alice", row_key: "4", field: "*", old_value: null, new_value: '{"title":"Book the offsite","pct":5}' },
  ]);
  expect((await open(id, alice)).html).toContain('{"id":4,"done":0,"pct":5,"comment":null}');
});

it("adding rows is for writers on create-enabled declarations of an INTEGER PRIMARY KEY table, with valid declared values", async () => {
  const db = new Database(path.join(root, "data", "hr.db"));
  db.exec("CREATE TABLE goals(code TEXT PRIMARY KEY, label TEXT); CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.close();
  const goals = `<script type="application/json" data-yoplai-edit="goals">${JSON.stringify({ db: "data/hr.db", table: "goals", key: "code", create: true, fields: { label: { type: "text" } } })}</script>`;
  const notes = `<script type="application/json" data-yoplai-edit="notes">${JSON.stringify({ db: "data/hr.db", table: "notes", key: "id", create: true, fields: { body: { type: "text", nullable: true } } })}</script>`;
  const id = await page(declaration({ create: true, guard: "SELECT 1 FROM actions WHERE owner = :viewer_email" }) + goals + notes);
  await registry.replaceShares(id, [{ kind: "user", id: "bob", mode: "read" }]);
  const reader = await open(id, bob);
  const { token } = await open(id, alice);
  const add = async (body: Record<string, unknown>, as = alice, withToken = token) => {
    const response = await post(id, "add", { token: withToken, ...body }, as);
    return { status: response.status, body: await response.json() };
  };
  expect(await add({ edit: "actions", values: { title: "Mine" } }, bob, reader.token)).toEqual({ status: 403, body: { ok: false, error: "Only the owner or a write share can add rows" } });
  const draft = (html: string) => fs.writeFile(path.join(root, "data", "dashboards", "actions.html"), html);
  await draft(declaration() + goals);
  expect(await add({ edit: "actions", values: {} })).toEqual({ status: 400, body: { ok: false, error: 'Edit actions does not allow adding rows (set "create": true)' } });
  await draft(declaration({ create: true }) + goals + notes);
  expect(await add({ edit: "goals", values: { label: "Grow" } })).toEqual({ status: 400, body: { ok: false, error: "To add rows, code must be the INTEGER PRIMARY KEY of goals" } });
  expect(await add({ edit: "actions", values: { owner: "eve@example.test" } })).toEqual({ status: 400, body: { ok: false, error: "Field owner is not editable in actions" } });
  expect(await add({ edit: "actions", values: { status: "later" } })).toEqual({ status: 400, body: { ok: false, error: "status must be one of open, blocked, closed" } });
  expect(await add({ edit: "notes", values: {} })).toEqual({ status: 400, body: { ok: false, error: "NOT NULL constraint failed: notes.body" } });
  expect(rows("SELECT count(*) AS n FROM actions")).toEqual([{ n: 3 }]);
  expect(rows("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dashboard_edits'")).toEqual([{ n: 0 }]);
});

it("edits never write a database outside the agent workspace, even through symlinked files or a swapped workspace", async () => {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-outside-"));
  try {
    const outside = path.join(outsideDir, "victim.db");
    await fs.copyFile(path.join(root, "data", "hr.db"), outside);
    const victim = () => {
      const db = new Database(outside, { readonly: true });
      try { return db.prepare("SELECT done FROM actions WHERE id = 1").get(); } finally { db.close(); }
    };
    const linked = declaration().replace('"data/hr.db"', '"data/linked.db"');
    await fs.symlink(outside, path.join(root, "data", "linked.db"));
    const id = await page(linked);
    const { token } = await open(id, alice);
    const viaLink = await post(id, "edit", { token, edit: "actions", key: 1, field: "done", value: true });
    expect(viaLink.status).toBe(400);
    await fs.rm(path.join(root, "data", "linked.db"));
    await fs.symlink(outside, path.join(root, "data", "hr.db-journal"));
    await fs.writeFile(path.join(root, "data", "dashboards", "actions.html"), declaration());
    const viaSidecar = await post(id, "edit", { token, edit: "actions", key: 1, field: "done", value: true });
    expect(viaSidecar.status).toBe(400);
    await fs.rm(path.join(root, "data", "hr.db-journal"));
    expect(victim()).toEqual({ done: 0 });
    expect(rows("SELECT done FROM actions WHERE id = 1")).toEqual([{ done: 0 }]);
  } finally {
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

it("the edit worker refuses a workspace directory replaced after the gateway resolved it", async () => {
  const { runDashboardEditWorker } = await import("./sql.js");
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-outside-"));
  try {
    const data = path.join(root, "data");
    const stat = await fs.stat(data);
    await fs.copyFile(path.join(data, "hr.db"), path.join(outsideDir, "hr.db"));
    await fs.rename(data, path.join(root, "data-moved"));
    await fs.symlink(outsideDir, data);
    const response = await runDashboardEditWorker({
      root: data, rootDev: stat.dev, rootIno: stat.ino, database: "hr.db", table: "actions", key: "id", at: "2026-01-01T00:00:00.000Z",
      audit: { dashboardId: "d", userId: "alice", email: null, name: null, edit: "actions" },
      op: "edit", keyValue: 1, field: "done", value: 1,
    });
    expect(response.ok).toBe(false);
    const db = new Database(path.join(outsideDir, "hr.db"), { readonly: true });
    try { expect(db.prepare("SELECT done FROM actions WHERE id = 1").get()).toEqual({ done: 0 }); } finally { db.close(); }
  } finally {
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
});

it("a database path swapped back and forth to an outside file during edits never lets an edit write the outside file", async () => {
  const { spawn } = await import("node:child_process");
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-outside-"));
  const data = path.join(root, "data");
  try {
    const outside = path.join(outsideDir, "victim.db");
    await fs.copyFile(path.join(data, "hr.db"), outside);
    await fs.link(path.join(data, "hr.db"), path.join(data, "real.db"));
    const id = await page();
    const { token } = await open(id, alice);
    const swapper = spawn(process.execPath, ["-e", `
        const fs = require("node:fs"); const p = require("node:path"); const [data, outside] = process.argv.slice(1);
        const db = p.join(data, "hr.db"), link = p.join(data, ".swap-link"), real = p.join(data, ".swap-real");
        let stop = false; process.stdin.on("data", () => { stop = true; }); process.stdin.resume();
        (function loop() {
          for (let i = 0; i < 200; i++) {
            try { fs.rmSync(link, { force: true }); fs.symlinkSync(outside, link); fs.renameSync(link, db); } catch {}
            try { fs.rmSync(real, { force: true }); fs.linkSync(p.join(data, "real.db"), real); fs.renameSync(real, db); } catch {}
          }
          if (stop) { process.exit(0); } else setImmediate(loop);
        })();`, data, outside], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        await post(id, "edit", { token, edit: "actions", key: 1, field: "pct", value: attempt % 90 });
      }
    } finally {
      const exited = new Promise((resolve) => swapper.once("exit", resolve));
      swapper.stdin!.write("stop");
      await exited;
    }
    const victim = new Database(outside, { readonly: true });
    try {
      expect(victim.prepare("SELECT pct FROM actions WHERE id = 1").get()).toEqual({ pct: 10 });
      expect(victim.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dashboard_edits'").get()).toEqual({ n: 0 });
    } finally { victim.close(); }
  } finally {
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
}, 60_000);

it("edits a WAL-mode database while the agent holds its own connection open", async () => {
  const agentDb = new Database(path.join(root, "data", "hr.db"));
  try {
    agentDb.pragma("journal_mode = WAL");
    const id = await page();
    const { token } = await open(id, alice);
    const response = await post(id, "edit", { token, edit: "actions", key: 2, field: "pct", value: 90 });
    expect(response.status).toBe(200);
    expect(agentDb.prepare("SELECT pct FROM actions WHERE id = 2").get()).toEqual({ pct: 90 });
    expect(agentDb.prepare("SELECT field, new_value FROM dashboard_edits").all()).toEqual([{ field: "pct", new_value: "90" }]);
  } finally {
    agentDb.close();
  }
});

it("a database directory swapped back and forth to an outside directory during edits never lets an edit write outside", async () => {
  const { spawn } = await import("node:child_process");
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-outside-"));
  const data = path.join(root, "data");
  try {
    await fs.mkdir(path.join(data, "sub"));
    await fs.copyFile(path.join(data, "hr.db"), path.join(data, "sub", "hr.db"));
    await fs.copyFile(path.join(data, "hr.db"), path.join(outsideDir, "hr.db"));
    const id = await page(declaration().replace('"data/hr.db"', '"data/sub/hr.db"'));
    const { token } = await open(id, alice);
    const swapper = spawn(process.execPath, ["-e", `
      const fs = require("node:fs"); const p = require("node:path"); const [data, outside] = process.argv.slice(1);
      const sub = p.join(data, "sub"), parked = p.join(data, ".sub-real");
      let stop = false; process.stdin.on("data", () => { stop = true; }); process.stdin.resume();
      (function loop() {
        for (let i = 0; i < 200; i++) {
          try { fs.renameSync(sub, parked); fs.symlinkSync(outside, sub); } catch {}
          try { fs.rmSync(sub, { force: true }); fs.renameSync(parked, sub); } catch {}
        }
        if (stop) { process.exit(0); } else setImmediate(loop);
      })();`, data, outsideDir], { stdio: ["pipe", "ignore", "ignore"] });
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        await post(id, "edit", { token, edit: "actions", key: 1, field: "pct", value: attempt % 90 });
      }
    } finally {
      const exited = new Promise((resolve) => swapper.once("exit", resolve));
      swapper.stdin!.write("stop");
      await exited;
    }
    const victim = new Database(path.join(outsideDir, "hr.db"), { readonly: true });
    try {
      expect(victim.prepare("SELECT pct FROM actions WHERE id = 1").get()).toEqual({ pct: 10 });
      expect(victim.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'dashboard_edits'").get()).toEqual({ n: 0 });
    } finally { victim.close(); }
    expect(await fs.readdir(outsideDir)).toEqual(["hr.db"]);
  } finally {
    await fs.rm(outsideDir, { recursive: true, force: true });
  }
}, 60_000);
