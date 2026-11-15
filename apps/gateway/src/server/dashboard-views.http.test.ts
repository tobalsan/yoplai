import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { writeTestV3Config } from "../test-utils/v3-config.js";
import { DASHBOARD_EMBED_HEADERS, encodeDashboardEmbedMeta } from "../canvas/embed-contract.js";

/**
 * These checks use the real `@hono/node-server` adapter, the real global
 * middleware of the local gateway, and a second adapter server that runs the
 * real remote dashboard renderer. Both listen on loopback ports that the OS
 * picks. The adapter replaces the global Request and Response classes, so the
 * test restores them. All bearers and users are fake. No browser is involved.
 */

const UI = "http://127.0.0.1:3000";
const ALICE_BEARER = "fake-bearer-alice";
const BOB_BEARER = "fake-bearer-bob";
const CAROL_BEARER = "fake-bearer-carol";
const users: Record<string, { id: string; email: string; name: string }> = {
  [ALICE_BEARER]: { id: "alice", email: "alice@example.test", name: "Alice Martin" },
  [BOB_BEARER]: { id: "bob", email: "bob@example.test", name: "Bob Durand" },
  [CAROL_BEARER]: { id: "carol", email: "carol@example.test", name: "Carol Petit" },
};

let home: string;
let remoteRoot: string;
let previousHome: string | undefined;
let localServer: http.Server;
let remoteServer: http.Server;
let local: string;
let remoteUrl: string;
let dashboardId: string;
let stall = false;
/** When set, the fake remote answers every embed request with these exact bytes. */
let rawEmbedBody: Buffer | undefined;
let remoteSocketsClosed = 0;
let remoteCalls: Array<{ method: string; url: string; authorization: string | undefined }> = [];
let logs: string[] = [];
let state: typeof import("../relay/state.js");
let views: typeof import("../relay/dashboard-views.js");
const defaultLimits = { htmlBytes: 5 * 1024 * 1024, editBytes: 256 * 1024, queryBytes: 8 * 1024, createBytes: 1024, createDeadlineMs: 5_000, createPending: 16, capabilitiesBytes: 64 * 1024, deadlineMs: 30_000, concurrencyPerGateway: 8 };
const originalRequest = globalThis.Request;
const originalResponse = globalThis.Response;

const declaration = `<script type="application/json" data-yoplai-edit="actions">${JSON.stringify({
  db: "data/hr.db", table: "actions", key: "id", updatedAt: "edited_at", create: true,
  fields: { done: { type: "bool" }, title: { type: "text", max: 40 } },
  guard: "SELECT 1 FROM actions WHERE id = :key AND owner = :viewer_email",
})}</script>`;
const listQuery = `<script type="application/sql" data-name="rows" data-db="data/hr.db">SELECT id, title, done FROM actions ORDER BY id</script>`;

function rows(): unknown[] {
  const db = new Database(path.join(remoteRoot, "data", "hr.db"), { readonly: true });
  try { return db.prepare("SELECT id, title, done FROM actions ORDER BY id").all(); } finally { db.close(); }
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-views-http-local-"));
  remoteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-views-http-remote-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  await writeTestV3Config(home, { agents: [{ id: "local" }] });
  vi.resetModules();

  const { DashboardRegistry } = await import("../canvas/store.js");
  const { createDashboardRoutes } = await import("../canvas/routes.js");
  const registry = new DashboardRegistry(path.join(remoteRoot, "canvas", "registry.json"));
  const agent = { id: "pom", name: "Pom", workspace: remoteRoot } as AgentConfig;
  await fs.mkdir(path.join(remoteRoot, "data", "dashboards"), { recursive: true });
  const db = new Database(path.join(remoteRoot, "data", "hr.db"));
  db.exec(`CREATE TABLE actions(id INTEGER PRIMARY KEY, title TEXT NOT NULL DEFAULT 'Untitled', owner TEXT, done INTEGER NOT NULL DEFAULT 0, edited_at TEXT);
    INSERT INTO actions(id, title, owner) VALUES (1, 'Alice task', 'alice@example.test'), (2, 'Bob task', 'bob@example.test');`);
  db.close();
  const html = `${declaration}${listQuery}<h1>Actions</h1>`;
  const entry = await registry.createOwned("pom", "actions.html", "alice", html);
  await fs.writeFile(path.join(remoteRoot, "data", "dashboards", "actions.html"), html);
  await registry.replaceShares(entry.id, [{ kind: "user", id: "bob", mode: "read" }]);
  dashboardId = entry.id;

  const config = { canvas: { enabled: true, baseUrl: "https://remote.example.test" } } as GatewayConfig;
  const remoteApp = new Hono();
  remoteApp.route("/d", createDashboardRoutes({
    getConfig: () => config,
    getAgent: (id) => (id === "pom" ? agent : undefined),
    registry,
    authenticate: async (request) => {
      const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const user = bearer ? users[bearer] : undefined;
      return user ? { user } : null;
    },
    resolveActor: async (auth) => ({ userId: (auth as { user: { id: string } }).user.id, eligible: true, hasAgentAccess: true }),
    hasAgentAccess: async () => true,
    getOwnerName: async () => "Alice Martin",
    sessionExists: async () => false,
  }));
  remoteApp.get("/api/capabilities", (c) => c.json({ version: 2, extensions: {}, agents: [], dashboardEmbed: { version: 1, assetVersion: "v3", policyVersion: 1, enabled: true } }));

  state = await import("../relay/state.js");
  views = await import("../relay/dashboard-views.js");
  state.configureRelay("127.0.0.1", false);
  const { serve } = await import("@hono/node-server");
  remoteServer = serve({
    fetch: (request) => {
      remoteCalls.push({ method: request.method, url: new URL(request.url).pathname, authorization: request.headers.get("authorization") ?? undefined });
      if (rawEmbedBody && /\/embed$/.test(new URL(request.url).pathname)) {
        return Promise.resolve(new Response(new Uint8Array(rawEmbedBody), {
          headers: { "content-type": "text/html; charset=utf-8", [DASHBOARD_EMBED_HEADERS.version]: "1", [DASHBOARD_EMBED_HEADERS.assets]: "v3", [DASHBOARD_EMBED_HEADERS.policy]: "1",
            [DASHBOARD_EMBED_HEADERS.meta]: encodeDashboardEmbedMeta({ dashboardId, agentId: "pom", canWrite: false, canEdit: false, chat: null, annotation: false }) },
        }));
      }
      return stall ? new Promise<Response>(() => undefined) : remoteApp.fetch(request);
    },
    port: 0,
    hostname: "127.0.0.1",
  }) as http.Server;
  if (!remoteServer.listening) await new Promise((resolve) => remoteServer.once("listening", resolve));
  remoteServer.on("connection", (socket) => socket.on("close", () => { remoteSocketsClosed += 1; }));
  remoteUrl = `http://127.0.0.1:${(remoteServer.address() as AddressInfo).port}`;

  const { app } = await import("./index.js");
  localServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
  if (!localServer.listening) await new Promise((resolve) => localServer.once("listening", resolve));
  local = `http://127.0.0.1:${(localServer.address() as AddressInfo).port}`;
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
});

afterAll(async () => {
  vi.restoreAllMocks();
  localServer?.closeAllConnections();
  await new Promise((resolve) => localServer?.close(resolve) ?? resolve(undefined));
  remoteServer?.closeAllConnections();
  await new Promise((resolve) => remoteServer?.close(resolve) ?? resolve(undefined));
  state.getRemoteGatewayStore().remove("ams");
  state.configureRelay("127.0.0.1", true);
  Object.defineProperty(globalThis, "Request", { value: originalRequest });
  Object.defineProperty(globalThis, "Response", { value: originalResponse });
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(remoteRoot, { recursive: true, force: true });
});

beforeEach(() => {
  const db = new Database(path.join(remoteRoot, "data", "hr.db"));
  db.exec("DELETE FROM actions WHERE id > 2; UPDATE actions SET done = 0, edited_at = NULL");
  db.close();
  stall = false;
  rawEmbedBody = undefined;
  remoteCalls = [];
  logs = [];
  remoteSocketsClosed = 0;
  Object.assign(views.dashboardViewLimits, defaultLimits);
  state.configureRelay("127.0.0.1", false);
  link(ALICE_BEARER);
});

function link(bearer: string): void {
  state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: bearer });
}

type Headers = Record<string, string>;
const jsonHeaders = (extra: Headers = {}): Headers => ({ origin: UI, "content-type": "application/json", "sec-fetch-site": "same-origin", ...extra });
const navigation = (extra: Headers = {}): Headers => ({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", ...extra });
const opaque = (extra: Headers = {}): Headers => ({ origin: "null", "content-type": "text/plain;charset=UTF-8", ...extra });

async function openView(): Promise<{ grant: string; frameUrl: string }> {
  const response = await fetch(`${local}/api/relay/dashboard-views`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ gateway: "ams", dashboardId }) });
  expect(response.status).toBe(201);
  const { frameUrl } = await response.json() as { frameUrl: string };
  return { grant: frameUrl.split("/")[4], frameUrl };
}

async function page(frameUrl: string, headers: Headers = navigation()): Promise<{ response: Response; html: string; token: string | undefined }> {
  const response = await fetch(`${local}${frameUrl}`, { headers, redirect: "manual" });
  const html = await response.text();
  return { response, html, token: /"editToken":"([^"]+)"/.exec(html)?.[1] };
}

const write = (frameUrl: string, op: "edit" | "add", body: unknown, headers: Headers = opaque()) =>
  fetch(`${local}${frameUrl}${op}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function expectJsonError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({ error });
}

describe("real adapter: owned routes", () => {
  it("refuses malformed paths, wrong methods, unsupported mode and external clients with local JSON", async () => {
    const { grant, frameUrl } = await openView();
    for (const pathname of [
      "/api/relay/dashboard-views/",
      `/api/relay/dashboard-views/${grant}/${dashboardId}`,
      `/api/relay/dashboard-views/${grant}/${dashboardId}/other`,
      `/api/relay/dashboard-views/${grant}/%2e%2e/${dashboardId}/`,
      `/api/relay/dashboard-views%2F${grant}/${dashboardId}/`,
    ]) {
      for (const method of ["GET", "POST"]) {
        await expectJsonError(await fetch(`${local}${pathname}`, { method, headers: { ...navigation(), ...opaque() }, body: method === "POST" ? "{}" : undefined }), 404, "invalid_dashboard_view_route");
      }
    }
    const wrongMethod = await fetch(`${local}${frameUrl}`, { method: "POST", headers: opaque(), body: "{}" });
    await expectJsonError(wrongMethod, 405, "method_not_allowed");
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    await expectJsonError(await fetch(`${local}${frameUrl}`, { headers: navigation({ "x-forwarded-for": "203.0.113.9" }) }), 403, "relay_unavailable");
    state.configureRelay("127.0.0.1", true);
    await expectJsonError(await fetch(`${local}${frameUrl}`, { headers: navigation() }), 403, "relay_unavailable");
    await expectJsonError(await fetch(`${local}/api/relay/dashboard-views`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ gateway: "ams", dashboardId }) }), 403, "relay_unavailable");
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a foreign or opaque Origin for a grant and a form post for a write", async () => {
    const body = JSON.stringify({ gateway: "ams", dashboardId });
    for (const origin of ["https://evil.example.test", "null"]) {
      await expectJsonError(await fetch(`${local}/api/relay/dashboard-views`, { method: "POST", headers: jsonHeaders({ origin }), body }), 403, "untrusted_origin");
    }
    await expectJsonError(await fetch(`${local}/api/relay/dashboard-views`, { method: "POST", headers: jsonHeaders({ "content-type": "text/plain" }), body }), 415, "json_required");
    const { frameUrl } = await openView();
    await expectJsonError(await write(frameUrl, "edit", { token: "x" }, opaque({ "content-type": "application/x-www-form-urlencoded" })), 415, "text_plain_required");
    expect((await write(frameUrl, "edit", { token: "x" }, { origin: UI, "content-type": "text/plain" })).status).toBe(403);
    expect(remoteCalls).toEqual([]);
  });
});

describe("real adapter: owner flow through the real remote renderer", () => {
  it("views the page under the exact viewer headers and edits with only the remote token", async () => {
    const { grant, frameUrl } = await openView();
    const { response, html, token } = await page(frameUrl);
    expect(response.status).toBe(200);
    expect(html).toContain("Actions");
    expect(token).toBeTruthy();
    const viewer = `/api/relay/dashboard-views/${grant}/${dashboardId}`;
    const csp = response.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts allow-downloads allow-modals;");
    expect(csp).toContain(`connect-src ${UI}${viewer}/edit ${UI}${viewer}/add;`);
    for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"]) expect(csp).not.toContain(forbidden);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(remoteCalls.map((call) => [call.method, call.url, call.authorization])).toEqual([["GET", `/d/${dashboardId}/embed`, `Bearer ${ALICE_BEARER}`]]);
    expect(html).not.toContain(ALICE_BEARER);

    const saved = await write(frameUrl, "edit", { token, edit: "actions", key: 1, field: "done", value: true });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("access-control-allow-origin")).toBe("null");
    expect(saved.headers.get("vary")).toBe("Origin");
    expect(saved.headers.get("access-control-allow-credentials")).toBeNull();
    expect(await saved.json()).toMatchObject({ ok: true, value: true });
    expect(rows()).toEqual([{ id: 1, title: "Alice task", done: 1 }, { id: 2, title: "Bob task", done: 0 }]);
    // The write call carried no linked bearer.
    expect(remoteCalls[1]).toEqual({ method: "POST", url: `/d/${dashboardId}/edit`, authorization: undefined });
  });

  it("lets the owner add a row, and keeps the bearer and the token out of local errors", async () => {
    const { frameUrl } = await openView();
    const { token } = await page(frameUrl);
    const added = await write(frameUrl, "add", { token, edit: "actions", values: { title: "From the viewer" } });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ ok: true, key: 3 });
    expect(rows()).toContainEqual({ id: 3, title: "From the viewer", done: 0 });
    const refused = await write(frameUrl, "edit", { token: "forged.token", edit: "actions", key: 1, field: "done", value: true });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ ok: false, error: "Reload to keep editing" });
  });

  it("gives the trusted host checked metadata through its own fetch, without the edit token", async () => {
    const { grant, frameUrl } = await openView();
    const { token } = await page(frameUrl);
    const response = await fetch(`${local}/api/relay/dashboard-views/${grant}/current`, { headers: { "sec-fetch-site": "same-origin", origin: UI } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(token!);
    expect(JSON.parse(text).view).toEqual({
      seq: 1, dashboardId, ok: true,
      meta: { dashboardId, agentId: "pom", canWrite: true, canEdit: true, chat: { sessionId: null }, annotation: true },
    });
  });
});

describe("real adapter: reader flow and relink", () => {
  it("keeps a guarded reader's own-row edit, refuses other rows and adds, and ends the old grant on relink", async () => {
    const owner = await openView();
    link(BOB_BEARER);
    await expectJsonError(await fetch(`${local}${owner.frameUrl}`, { headers: navigation() }), 410, "dashboard_view_expired");
    const reader = await openView();
    const { token, response } = await page(reader.frameUrl);
    expect(response.status).toBe(200);
    expect(token).toBeTruthy();
    const meta = await (await fetch(`${local}/api/relay/dashboard-views/${reader.grant}/current`, { headers: { "sec-fetch-site": "same-origin" } })).json() as { view: { meta: object } };
    expect(meta.view.meta).toMatchObject({ canWrite: false, canEdit: true, annotation: false });
    expect((await write(reader.frameUrl, "edit", { token, edit: "actions", key: 2, field: "done", value: true })).status).toBe(200);
    const other = await write(reader.frameUrl, "edit", { token, edit: "actions", key: 1, field: "done", value: true });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ ok: false, error: "You cannot edit this row" });
    const add = await write(reader.frameUrl, "add", { token, edit: "actions", values: { title: "Nope" } });
    expect(add.status).toBe(403);
    expect(await add.json()).toEqual({ ok: false, error: "Only the owner or a write share can add rows" });
    expect(rows()).toEqual([{ id: 1, title: "Alice task", done: 0 }, { id: 2, title: "Bob task", done: 1 }]);
  });

  it("returns a bounded 403 for a user with no share and no HTML", async () => {
    link(CAROL_BEARER);
    const { frameUrl } = await openView();
    const { response, html } = await page(frameUrl);
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(html)).toEqual({ error: "forbidden", ownerName: "Alice Martin" });
  });

  it("reports unauthorized for a rotated bearer without following a login redirect", async () => {
    link("fake-bearer-rotated");
    const { frameUrl } = await openView();
    await expectJsonError(await fetch(`${local}${frameUrl}`, { headers: navigation() }), 401, "remote_unauthorized");
    expect(remoteCalls).toHaveLength(1);
  });
});

describe("real adapter: final headers through the global middleware", () => {
  it("adds no CORS grant to viewer HTML, even for an allowed Origin", async () => {
    const { frameUrl } = await openView();
    const { response } = await page(frameUrl, navigation({ origin: UI }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("content-security-policy")!.split("sandbox").length).toBe(2);
  });

  it("answers an asset load from an opaque origin without credentials, and leaves other origins unchanged", async () => {
    for (const asset of ["/d-assets/v3/kit.js", "/d-assets/v3/kit.css", "/d-assets/theme.css", "/d-assets/v3/echarts.js"]) {
      const opaqueLoad = await fetch(`${local}${asset}`, { headers: { origin: "null" } });
      expect(opaqueLoad.status).toBe(200);
      expect(opaqueLoad.headers.get("access-control-allow-origin")).toBe("*");
      expect(opaqueLoad.headers.get("access-control-allow-credentials")).toBeNull();
      expect(opaqueLoad.headers.get("vary")).toContain("Origin");
      const plain = await fetch(`${local}${asset}`);
      expect(plain.headers.get("access-control-allow-origin")).toBeNull();
      const known = await fetch(`${local}${asset}`, { headers: { origin: UI } });
      expect(known.headers.get("access-control-allow-origin")).toBe(UI);
      expect(known.headers.get("access-control-allow-credentials")).toBe("true");
      const foreign = await fetch(`${local}${asset}`, { headers: { origin: "https://evil.example.test" } });
      expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    }
    const redirect = await fetch(`${local}/d-assets/kit.js`, { headers: { origin: "null" }, redirect: "manual" });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("does not widen CORS on the local API for an opaque origin", async () => {
    const response = await fetch(`${local}/api/relay/dashboard-views`, { method: "POST", headers: jsonHeaders({ origin: "null" }), body: "{}" });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const api = await fetch(`${local}/health`, { headers: { origin: "null" } });
    expect(api.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("real adapter: logs, bounds and disconnects", () => {
  it("never logs a grant path", async () => {
    const { grant, frameUrl } = await openView();
    await page(frameUrl);
    await write(frameUrl, "edit", { token: "x" });
    await fetch(`${local}/api/relay/dashboard-views/${grant}/current`, { headers: { "sec-fetch-site": "same-origin" } });
    await fetch(`${local}${frameUrl}other`);
    expect(logs.some((line) => line.includes("dashboard-views"))).toBe(true);
    expect(logs.join("\n")).not.toContain(grant);
    expect(logs.join("\n")).not.toContain(ALICE_BEARER);
  });

  it("redacts the complete target of canonical and encoded viewer requests", async () => {
    const { grant, frameUrl } = await openView();
    const canonical = [frameUrl, `${frameUrl}?region=emea`, `/api/relay/dashboard-views/${grant}/current`];
    for (const path of canonical) {
      const response = await fetch(`${local}${path}`, { headers: navigation({ "sec-fetch-site": "same-origin" }) });
      expect(response.status).toBe(200);
    }
    await write(frameUrl, "edit", { token: "x" });
    const aliases = [
      `/api/relay/dashboard-views%2F${grant}/${dashboardId}/`,
      `/api/relay/dashboard-views%252F${grant}/${dashboardId}/`,
      `/api/relay/dashboard%2Dviews/${grant}/${dashboardId}/?region=emea`,
      `/api/Relay/Dashboard-Views/${grant}/${dashboardId}/`,
      `/api/relay/dashboard-views/${grant}%zz/${dashboardId}/`,
    ];
    for (const path of aliases) {
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`${local}${path}`, { method, headers: { ...navigation(), ...opaque() }, body: method === "POST" ? "{}" : undefined });
        // The refusal and the log use the same ownership test. Routing is case sensitive, so a mixed case path reaches no viewer handler.
        if (path.startsWith("/api/Relay")) expect(response.status).toBe(404);
        else await expectJsonError(response, 404, "invalid_dashboard_view_route");
      }
    }
    const text = logs.join("\n");
    expect(text).not.toContain(grant);
    expect(text).not.toContain(dashboardId);
    expect(text).not.toContain("emea");
    const viewerLines = logs.filter((line) => line.includes("dashboard-views"));
    // The grant request, the three reads, the write, and two methods for each alias.
    expect(viewerLines).toHaveLength(1 + canonical.length + 1 + aliases.length * 2);
    for (const line of viewerLines) expect(line).toMatch(/^--> (?:GET|POST) \/api\/relay\/dashboard-views\/\[redacted\] \d{3} \S+$/);
  });

  it("sends no more HTML bytes on the wire than the limit, also for invalid UTF-8", async () => {
    const { frameUrl } = await openView();
    views.dashboardViewLimits.htmlBytes = 64;
    rawEmbedBody = Buffer.alloc(64, 0xff);
    const wire = await new Promise<{ status: number; bytes: Buffer; encoding: string | undefined }>((resolve, reject) => {
      const url = new URL(`${local}${frameUrl}`);
      http.get({ hostname: url.hostname, port: url.port, path: url.pathname, headers: navigation(), agent: false }, (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, bytes: Buffer.concat(parts), encoding: response.headers["content-encoding"] }));
      }).on("error", reject);
    });
    expect(wire.status).toBe(200);
    expect(wire.encoding).toBeUndefined();
    expect(wire.bytes.byteLength).toBe(64);
    expect(wire.bytes.equals(rawEmbedBody)).toBe(true);
    rawEmbedBody = Buffer.alloc(65, 0xff);
    await expectJsonError(await fetch(`${local}${frameUrl}`, { headers: navigation() }), 502, "remote_response_too_large");
  });

  it("answers a grant request that stops sending its body, and one that declares too much, without waiting", async () => {
    views.dashboardViewLimits.createDeadlineMs = 200;
    const send = (headers: Headers, firstChunk: string) => new Promise<{ status: number; body: string; ms: number }>((resolve, reject) => {
      const started = Date.now();
      const url = new URL(`${local}/api/relay/dashboard-views`);
      const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers, agent: false }, (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts).toString(), ms: Date.now() - started }));
      });
      request.on("error", reject);
      request.write(firstChunk);
      // The request never ends. The gateway must answer on its own deadline.
    });
    const stalled = await send({ ...jsonHeaders(), "content-length": "100" }, "{");
    expect(stalled.status).toBe(408);
    expect(JSON.parse(stalled.body)).toEqual({ error: "request_timeout" });
    expect(stalled.ms).toBeLessThan(3000);
    const declared = await send({ ...jsonHeaders(), "content-length": "5000" }, "{");
    expect(declared.status).toBe(413);
    expect(JSON.parse(declared.body)).toEqual({ error: "request_too_large" });
    expect(remoteCalls).toEqual([]);
    views.dashboardViewLimits.createDeadlineMs = 5_000;
    expect((await fetch(`${local}/health`)).status).toBe(200);
    await openView();
  });

  it("frees pending grant requests when the client disconnects", async () => {
    views.dashboardViewLimits.createPending = 2;
    const sockets: net.Socket[] = [];
    const hold = () => new Promise<void>((resolve) => {
      const socket = net.connect(Number(new URL(local).port), "127.0.0.1", () => {
        socket.write(`POST /api/relay/dashboard-views HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${UI}\r\nSec-Fetch-Site: same-origin\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
        resolve();
      });
      socket.on("error", () => undefined);
      sockets.push(socket);
    });
    await hold();
    await hold();
    await vi.waitFor(async () => {
      const refused = await fetch(`${local}/api/relay/dashboard-views`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ gateway: "ams", dashboardId }) });
      expect(refused.status).toBe(429);
    });
    for (const socket of sockets) socket.destroy();
    await vi.waitFor(async () => {
      const accepted = await fetch(`${local}/api/relay/dashboard-views`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ gateway: "ams", dashboardId }) });
      expect(accepted.status).toBe(201);
    });
  });

  it("returns a readable 413 for a streamed oversized write", async () => {
    const { frameUrl } = await openView();
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const url = new URL(`${local}${frameUrl}edit`);
      const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { ...opaque(), "transfer-encoding": "chunked" } }, (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(parts).toString() }));
      });
      request.on("error", reject);
      const chunk = "x".repeat(64 * 1024);
      let sent = 0;
      const more = () => {
        while (sent < 512 * 1024) {
          sent += chunk.length;
          if (!request.write(chunk)) return void request.once("drain", more);
        }
        request.end();
      };
      more();
    });
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: "request_too_large" });
    expect(remoteCalls).toEqual([]);
  });

  it("times out a stalled remote and aborts the remote call when the browser disconnects", async () => {
    const { frameUrl } = await openView();
    stall = true;
    views.dashboardViewLimits.deadlineMs = 200;
    await expectJsonError(await fetch(`${local}${frameUrl}`, { headers: navigation() }), 504, "remote_timeout");
    await vi.waitFor(() => expect(remoteSocketsClosed).toBeGreaterThanOrEqual(1));
    views.dashboardViewLimits.deadlineMs = 30_000;
    // More aborted calls than the per-gateway limit: the slots must come back.
    for (let i = 0; i < 10; i++) {
      const before = remoteCalls.length;
      const closedBefore = remoteSocketsClosed;
      const url = new URL(`${local}${frameUrl}`);
      const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, headers: navigation(), agent: false });
      request.on("error", () => undefined);
      request.end();
      await vi.waitFor(() => expect(remoteCalls.length).toBe(before + 1));
      request.destroy();
      await vi.waitFor(() => expect(remoteSocketsClosed).toBeGreaterThan(closedBefore));
    }
    stall = false;
    expect((await fetch(`${local}${frameUrl}`, { headers: navigation() })).status).toBe(200);
  });

  it("answers a socket that closes mid-body to a write with no remote call and keeps serving", async () => {
    const { frameUrl } = await openView();
    await new Promise<void>((resolve) => {
      const socket = net.connect(Number(new URL(local).port), "127.0.0.1", () => {
        socket.write(`POST ${frameUrl}edit HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: null\r\nContent-Type: text/plain\r\nContent-Length: 5000\r\n\r\n{"token":"x"`);
        setTimeout(() => socket.destroy(), 50);
      });
      socket.on("error", () => undefined);
      socket.on("close", () => resolve());
    });
    expect(remoteCalls).toEqual([]);
    expect((await fetch(`${local}/health`)).status).toBe(200);
    expect((await fetch(`${local}${frameUrl}`, { headers: navigation() })).status).toBe(200);
  });
});
