import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";
import { DASHBOARD_EMBED_HEADERS, encodeDashboardEmbedMeta, type DashboardEmbedMeta } from "../canvas/embed-contract.js";

/**
 * The linked remote is a disposable local HTTP server with fake bearers.
 * These tests call the viewer middleware in process. The Node adapter
 * file next to the server code checks the final wire behavior.
 */

type RemoteCall = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };
type RemoteHandler = (request: http.IncomingMessage, response: http.ServerResponse, call: RemoteCall) => void;

const UI = "http://127.0.0.1:3000";
const BEARER = "bearer-ams-secret";
const OTHER_BEARER = "bearer-other-secret";
const ID = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const SIBLING = "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4";
const TOKEN = "fake-edit-token-not-a-real-credential";

let home: string;
let previousHome: string | undefined;
let remote: http.Server;
let remoteUrl: string;
let calls: RemoteCall[] = [];
let handler: RemoteHandler;
let closed = 0;
let state: typeof import("./state.js");
let snapshots: typeof import("./dashboard-view-snapshots.js");
let views: typeof import("./dashboard-views.js");
let app: Hono;
const gatewayDir = fileURLToPath(new URL("../..", import.meta.url));
const storeModule = new URL("./store.ts", import.meta.url).href;
const defaultLimits = { htmlBytes: 5 * 1024 * 1024, editBytes: 256 * 1024, queryBytes: 8 * 1024, createBytes: 12 * 1024, createDeadlineMs: 5_000, createPending: 16, capabilitiesBytes: 64 * 1024, deadlineMs: 30_000, concurrencyPerGateway: 8 };

const defaultSnapshotLimits = { ttlMs: 30 * 60 * 1000, deliveryMs: 2 * 60 * 1000, count: 128, bytes: 32 * 1024 * 1024 };

const metaFor = (id: string, overrides: Partial<DashboardEmbedMeta> = {}): DashboardEmbedMeta => ({
  dashboardId: id, agentId: "pom", canWrite: true, canEdit: true, chat: { sessionId: "session-1" }, annotation: true, ...overrides,
});

function embedHeaders(id: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    [DASHBOARD_EMBED_HEADERS.version]: "1",
    [DASHBOARD_EMBED_HEADERS.assets]: "v3",
    [DASHBOARD_EMBED_HEADERS.policy]: "1",
    [DASHBOARD_EMBED_HEADERS.meta]: encodeDashboardEmbedMeta(metaFor(id)),
    ...extra,
  };
}

const embedMarker = { [DASHBOARD_EMBED_HEADERS.version]: "1", [DASHBOARD_EMBED_HEADERS.assets]: "v3", [DASHBOARD_EMBED_HEADERS.policy]: "1" };

function sendHtml(response: http.ServerResponse, id: string, html = "<h1>Remote page</h1>", extra: Record<string, string> = {}): void {
  response.writeHead(200, embedHeaders(id, extra));
  response.end(html);
}

function sendJson(response: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...extra });
  response.end(JSON.stringify(body));
}

const defaultHandler: RemoteHandler = (request, response, call) => {
  const url = new URL(call.url, "http://remote.test");
  const embed = /^\/d\/([^/]+)\/embed$/.exec(url.pathname);
  if (embed && request.method === "GET") return sendHtml(response, embed[1]);
  if (/^\/d\/[^/]+\/(?:edit|add)$/.test(url.pathname) && request.method === "POST") return sendJson(response, 200, { ok: true, value: 1 });
  if (url.pathname === "/api/capabilities") return sendJson(response, 200, { version: 2, extensions: {}, agents: [] });
  sendJson(response, 404, { error: "not_found" });
};

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-views-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  await writeTestV3Config(home, { agents: [{ id: "local" }] });
  vi.resetModules();
  state = await import("./state.js");
  snapshots = await import("./dashboard-view-snapshots.js");
  views = await import("./dashboard-views.js");
  remote = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    response.on("close", () => { closed += 1; });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const call: RemoteCall = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks).toString() };
      calls.push(call);
      handler(request, response, call);
    });
  });
  remoteUrl = `http://127.0.0.1:${await listen(remote)}`;
  app = new Hono();
  app.use("*", views.dashboardViewHttp());
  app.all("*", (c) => c.text("fell through", 299 as 200));
});

afterAll(async () => {
  remote.closeAllConnections();
  await new Promise((resolve) => remote.close(resolve));
  state.getRemoteGatewayStore().remove("ams");
  state.getRemoteGatewayStore().remove("other");
  state.configureRelay("127.0.0.1", true);
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  closed = 0;
  handler = defaultHandler;
  Object.assign(views.dashboardViewLimits, defaultLimits);
  snapshots.resetDashboardViewSnapshotsForTests();
  Object.assign(snapshots.dashboardViewSnapshotLimits, defaultSnapshotLimits);
  state.configureRelay("127.0.0.1", false);
  state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: BEARER });
  state.getRemoteGatewayStore().save({ name: "other", url: remoteUrl, token: OTHER_BEARER });
});

afterEach(() => {
  vi.useRealTimers();
});

const createHeaders = (extra: Record<string, string> = {}) => ({ origin: UI, "content-type": "application/json", "sec-fetch-site": "same-origin", ...extra });
const navigation = (extra: Record<string, string> = {}) => ({ "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin", ...extra });
const opaque = (extra: Record<string, string> = {}) => ({ origin: "null", "content-type": "text/plain;charset=UTF-8", ...extra });

async function expectNoSecrets(response: Response, ...extra: string[]): Promise<string> {
  const text = await response.text();
  const wire = `${text}\n${JSON.stringify([...response.headers.entries()])}`;
  for (const secret of [BEARER, OTHER_BEARER, ...extra]) expect(wire).not.toContain(secret);
  return text;
}

/** Runs store code in a separate Node process, like `yoplai connect` and `yoplai disconnect` do. */
function inAnotherProcess(code: string): void {
  const script = `import { createFileRemoteGatewayStore } from ${JSON.stringify(storeModule)};
const store = createFileRemoteGatewayStore(${JSON.stringify(path.join(home, "remote-gateways.json"))});
${code}`;
  const result = spawnSync(process.execPath, ["--conditions=development", "--import", "tsx", "--input-type=module", "-e", script], {
    cwd: gatewayDir, env: { ...process.env, YOPLAI_HOME: home }, encoding: "utf8", timeout: 20_000,
  });
  expect(result.stderr).not.toContain("Error");
  expect(result.status).toBe(0);
}

async function localTree(): Promise<string[]> {
  const entries = await fs.readdir(home, { recursive: true });
  return entries.filter((entry) => !entry.startsWith("remote-gateways.json")).sort();
}

const NS = "/api/relay/dashboard-views";
const H43 = "G".repeat(43);

type Opened = { handle: string; instance: string; shellUrl: string; frameUrl: string; expiresAt: string };

/** One prepare request, as the trusted UI sends it. */
async function prepare(body: unknown = { gateway: "ams", dashboardId: ID }, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
  return app.request(NS, { method: "POST", headers: createHeaders(headers), body: typeof body === "string" ? body : JSON.stringify(body), signal });
}

/** A prepare request that must succeed. */
async function open(gateway = "ams", dashboardId = ID, extra: Record<string, unknown> = {}): Promise<Opened> {
  const response = await prepare({ gateway, dashboardId, ...extra });
  expect(response.status).toBe(201);
  const body = await response.json() as { handle: string; instance: string; shellUrl: string; expiresAt: string };
  return { ...body, frameUrl: `${NS}/${body.handle}/frame` };
}

const frame = (handle: string, headers: Record<string, string> = navigation()) => app.request(`${NS}/${handle}/frame`, { headers });
const shell = (handle: string, headers: Record<string, string> = navigation()) => app.request(`${NS}/${handle}/shell`, { headers });
const readView = (body: unknown, headers: Record<string, string> = {}) =>
  app.request(`${NS}/read`, { method: "POST", headers: createHeaders(headers), body: typeof body === "string" ? body : JSON.stringify(body) });
const stateOf = async (handle: string) => (await readView({ handle })).status;

/** A prepared snapshot whose bytes one frame took, so its write routes are open. */
async function delivered(gateway = "ams", dashboardId = ID): Promise<Opened> {
  const opened = await open(gateway, dashboardId);
  expect((await frame(opened.handle)).status).toBe(200);
  return opened;
}

describe("snapshots", () => {
  it("prepares a 30-minute snapshot for the exact UI origin with one checked remote read", async () => {
    const before = Date.now();
    const response = await prepare({ gateway: "ams", dashboardId: ID, theme: "dark", query: "region=emea" });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response.json() as { handle: string; instance: string; shellUrl: string; expiresAt: string; gateway: string; dashboardId: string };
    expect(body.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.instance).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.shellUrl).toBe(`${NS}/${body.handle}/shell`);
    expect(body).toMatchObject({ gateway: "ams", dashboardId: ID });
    expect(Object.keys(body).sort()).toEqual(["dashboardId", "expiresAt", "gateway", "handle", "instance", "shellUrl"]);
    expect(Date.parse(body.expiresAt) - before).toBeGreaterThanOrEqual(30 * 60 * 1000 - 50);
    expect(Date.parse(body.expiresAt) - before).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);
    expect(calls.map((call) => call.url)).toEqual([`/d/${ID}/embed?region=emea`]);
    const other = await open();
    expect(other.handle).not.toBe(body.handle);
    expect(other.instance).not.toBe(body.instance);
  });

  it.each([
    ["no Origin", { origin: "" }, 403, "untrusted_origin"],
    ["a foreign Origin", { origin: "https://evil.example.test" }, 403, "untrusted_origin"],
    ["a different loopback port", { origin: "http://127.0.0.1:9999" }, 403, "untrusted_origin"],
    ["an opaque Origin", { origin: "null" }, 403, "untrusted_origin"],
    ["a cross-site context", { "sec-fetch-site": "cross-site" }, 403, "same_origin_required"],
    ["no fetch context", { "sec-fetch-site": "" }, 403, "same_origin_required"],
    ["a form content type", { "content-type": "text/plain" }, 415, "json_required"],
    ["an external forwarded client", { "x-forwarded-for": "203.0.113.9" }, 403, "relay_unavailable"],
  ])("refuses a prepare request with %s before any remote call", async (_label, headers, status, error) => {
    const unset = Object.fromEntries(Object.entries(headers).filter(([, value]) => value === "").map(([key]) => [key, ""]));
    const response = await app.request(NS, {
      method: "POST",
      headers: Object.fromEntries(Object.entries({ ...createHeaders(), ...headers }).filter(([key]) => !(key in unset))),
      body: JSON.stringify({ gateway: "ams", dashboardId: ID }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(calls).toEqual([]);
  });

  it.each([
    ["an unknown gateway", { gateway: "nowhere", dashboardId: ID }, 404, "unknown_gateway"],
    ["a version identifier", { gateway: "ams", dashboardId: "abc-0123456789ab" }, 400, "invalid_dashboard_id"],
    ["an encoded separator", { gateway: "ams", dashboardId: `${ID.slice(0, 20)}%2F..%2Fx` }, 400, "invalid_dashboard_id"],
    ["a short identifier", { gateway: "ams", dashboardId: ID.slice(1) }, 400, "invalid_dashboard_id"],
    ["an extra field", { gateway: "ams", dashboardId: ID, url: "http://evil.test" }, 400, "invalid_dashboard_view_request"],
    ["a missing field", { gateway: "ams" }, 400, "invalid_dashboard_view_request"],
    ["a theme that is not light or dark", { gateway: "ams", dashboardId: ID, theme: "purple" }, 400, "invalid_dashboard_view_request"],
    ["a query that is not text", { gateway: "ams", dashboardId: ID, query: 5 }, 400, "invalid_dashboard_view_request"],
    ["malformed JSON", "{not json", 400, "invalid_dashboard_view_request"],
  ])("refuses %s before any remote call", async (_label, body, status, error) => {
    const response = await prepare(body);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(calls).toEqual([]);
  });

  it("refuses an oversized prepare body", async () => {
    const response = await prepare(JSON.stringify({ gateway: "ams", dashboardId: ID, pad: "x".repeat(13 * 1024) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "request_too_large" });
  });

  it("refuses everything when the relay is not in a supported mode", async () => {
    const { handle } = await open();
    state.configureRelay("127.0.0.1", true);
    expect((await prepare()).status).toBe(403);
    for (const response of [await frame(handle), await shell(handle), await readView({ handle })]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "relay_unavailable" });
    }
    expect(calls).toHaveLength(1);
    state.configureRelay("127.0.0.1", false);
  });

  it("caps stored snapshots at 128, refuses before the remote call, and accepts a new one when old ones end", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 128; i++) expect((await prepare()).status).toBe(201);
    calls = [];
    const refused = await prepare();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toEqual({ error: "too_many_dashboard_views" });
    expect(calls).toEqual([]);
    vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1000);
    expect((await prepare()).status).toBe(201);
    expect(snapshots.dashboardViewStoreSizeForTests().count).toBe(1);
  });

  it("caps the stored bytes of all snapshots, refuses with a typed error, and frees bytes at delivery and expiry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    snapshots.dashboardViewSnapshotLimits.bytes = 1000;
    handler = (_request, response) => sendHtml(response, ID, "x".repeat(400));
    const first = await open();
    const second = await open();
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 2, bytes: 800 });
    const refused = await prepare();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    expect(await refused.json()).toEqual({ error: "dashboard_view_storage_full" });
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 2, bytes: 800 });
    // A delivery gives its bytes back at once. The metadata stays.
    expect((await frame(first.handle)).status).toBe(200);
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 2, bytes: 400 });
    const third = await open();
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 3, bytes: 800 });
    // Undelivered bytes end with their snapshot after the delivery window.
    vi.setSystemTime(Date.now() + snapshots.dashboardViewSnapshotLimits.deliveryMs + 1000);
    expect(await stateOf(second.handle)).toBe(410);
    expect(await stateOf(third.handle)).toBe(410);
    expect(await stateOf(first.handle)).toBe(200);
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 1, bytes: 0 });
    // The whole snapshot ends at expiry.
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    expect(await stateOf(first.handle)).toBe(410);
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 0, bytes: 0 });
  });

  it("stores no snapshot and no bytes when the remote read fails or the client leaves", async () => {
    handler = (_request, response) => sendJson(response, 404, { error: "not_found" }, embedMarker);
    expect((await prepare()).status).toBe(404);
    handler = (_request, response) => { response.writeHead(200, embedHeaders(ID)); response.write("<h1>Partial"); };
    const controller = new AbortController();
    const pending = prepare(undefined, {}, controller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 0, bytes: 0 });
  });

  it("keeps the metadata for 30 minutes and ends the snapshot after that", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { handle } = await delivered();
    vi.setSystemTime(Date.now() + 30 * 60 * 1000 - 1000);
    expect(await stateOf(handle)).toBe(200);
    vi.setSystemTime(Date.now() + 2000);
    const expired = await readView({ handle });
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ state: "expired", error: "dashboard_view_expired", status: 410 });
  });

  it("ends a snapshot that nobody delivers within two minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { handle } = await open();
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 - 1000);
    expect(await stateOf(handle)).toBe(200);
    vi.setSystemTime(Date.now() + 2000);
    expect(await stateOf(handle)).toBe(410);
    const late = await frame(handle);
    expect(late.status).toBe(410);
    expect(await late.json()).toEqual({ state: "expired", error: "dashboard_view_expired", status: 410 });
  });

  it("ends a snapshot when its gateway is unlinked or relinked with another address or bearer", async () => {
    const first = await open();
    const second = await open();
    const third = await open();
    const unaffected = await open("other");
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: BEARER });
    expect(await stateOf(first.handle)).toBe(200);
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: "bearer-ams-rotated" });
    expect(await stateOf(second.handle)).toBe(410);
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: BEARER });
    // A snapshot that ended stays gone, even after the original link returns.
    expect(await stateOf(second.handle)).toBe(410);
    state.getRemoteGatewayStore().remove("ams");
    expect(await stateOf(third.handle)).toBe(410);
    expect(await stateOf(unaffected.handle)).toBe(200);
  });

  it("ends a snapshot when another process removes the link and creates it again with equal values", async () => {
    const opened = await delivered();
    const unaffected = await open("other");
    expect(await stateOf(opened.handle)).toBe(200);
    calls = [];
    // No gateway check runs between the removal and the new link.
    inAnotherProcess(`store.remove("ams"); store.save({ name: "ams", url: ${JSON.stringify(remoteUrl)}, token: ${JSON.stringify(BEARER)} });`);
    const stopped = await readView({ handle: opened.handle });
    expect(stopped.status).toBe(410);
    expect(await stopped.json()).toEqual({ state: "expired", error: "dashboard_view_expired", status: 410 });
    const write = await app.request(`${NS}/${opened.handle}/edit`, { method: "POST", headers: opaque(), body: JSON.stringify({ token: TOKEN }) });
    expect(write.status).toBe(410);
    expect(calls).toEqual([]);
    expect(await stateOf(unaffected.handle)).toBe(200);
    // The new link starts its own snapshots.
    expect((await prepare()).status).toBe(201);
  });

  it("ends a snapshot when another process changes the URL or the bearer, and keeps it for an equal save", async () => {
    const first = await open();
    const second = await open();
    inAnotherProcess(`store.save({ name: "ams", url: ${JSON.stringify(remoteUrl)}, token: ${JSON.stringify(BEARER)} });`);
    expect(await stateOf(first.handle)).toBe(200);
    inAnotherProcess(`store.save({ name: "ams", url: ${JSON.stringify(remoteUrl)}, token: "bearer-ams-rotated" });`);
    calls = [];
    expect(await stateOf(first.handle)).toBe(410);
    expect(await stateOf(second.handle)).toBe(410);
    expect(calls).toEqual([]);
  });

  it("ends the snapshot of an older link file with no generation when a new save starts the link again", async () => {
    await fs.writeFile(path.join(home, "remote-gateways.json"), `${JSON.stringify([{ name: "ams", url: remoteUrl, token: BEARER }])}\n`);
    const { handle } = await open();
    expect(await stateOf(handle)).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(home, "remote-gateways.json"), "utf8"))[0]).not.toHaveProperty("generation");
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: BEARER });
    calls = [];
    expect(await stateOf(handle)).toBe(410);
    expect(calls).toEqual([]);
  });

  it("forgets every snapshot on restart", async () => {
    const { handle } = await open();
    snapshots.resetDashboardViewSnapshotsForTests();
    expect(await stateOf(handle)).toBe(410);
  });

  it("never shows another dashboard: one snapshot, one dashboard, and a new read for the next", async () => {
    const first = await open("ams", ID);
    const second = await open("ams", SIBLING);
    expect(calls.map((call) => call.url)).toEqual([`/d/${ID}/embed`, `/d/${SIBLING}/embed`]);
    expect(first.handle).not.toBe(second.handle);
    expect(await (await frame(first.handle)).text()).toContain("Remote page");
    const firstRead = await (await readView({ handle: first.handle })).json() as { dashboardId: string; meta: { dashboardId: string } };
    const secondRead = await (await readView({ handle: second.handle })).json() as { dashboardId: string; meta: { dashboardId: string } };
    expect([firstRead.dashboardId, firstRead.meta.dashboardId]).toEqual([ID, ID]);
    expect([secondRead.dashboardId, secondRead.meta.dashboardId]).toEqual([SIBLING, SIBLING]);
    // No URL names a dashboard, so no URL can select another one.
    for (const suffix of [`${SIBLING}/frame`, `frame/${SIBLING}`, `${SIBLING}/edit`, `${SIBLING}/`]) {
      const response = await app.request(`${NS}/${first.handle}/${suffix}`, { headers: navigation() });
      expect(response.status).toBe(404);
    }
    expect(calls).toHaveLength(2);
  });
});

/**
 * The store frees bytes and metadata at their deadlines while the viewer is idle.
 * These checks never call a store function that sweeps, so only the timer can
 * explain a freed entry. The size helper reads the map and sweeps nothing.
 */
describe("idle cleanup of snapshots", () => {
  const MINUTE = 60 * 1000;
  const newSnapshot = (bytes = 100) => ({ dashboardId: ID, query: "", theme: null, meta: metaFor(ID), bytes: Buffer.alloc(bytes, 0x61) });
  const link = () => state.getRemoteGatewayStore().list().find((gateway) => gateway.name === "ams")!;
  const store = (bytes = 100) => {
    const stored = snapshots.storeDashboardViewSnapshot(link(), UI, newSnapshot(bytes));
    if (typeof stored === "string") throw new Error(`store refused: ${stored}`);
    return stored;
  };
  const size = () => snapshots.dashboardViewStoreSizeForTests();

  it("releases undelivered bytes and metadata at the delivery deadline, with no later request", async () => {
    snapshots.dashboardViewSnapshotLimits.deliveryMs = 20;
    await open();
    expect(size().bytes).toBeGreaterThan(0);
    await vi.waitFor(() => expect(size()).toEqual({ count: 0, bytes: 0 }), { timeout: 2000, interval: 5 });
  });

  it("releases undelivered bytes exactly at the delivery deadline", () => {
    vi.useFakeTimers();
    store();
    vi.advanceTimersByTime(2 * MINUTE - 1);
    expect(size()).toEqual({ count: 1, bytes: 100 });
    vi.advanceTimersByTime(1);
    expect(size()).toEqual({ count: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps delivered metadata until its own deadline and removes it with no later request", () => {
    vi.useFakeTimers();
    const { handle } = store();
    expect(snapshots.claimDashboardViewBytes(handle)).toHaveLength(100);
    expect(size()).toEqual({ count: 1, bytes: 0 });
    vi.advanceTimersByTime(2 * MINUTE + 1);
    expect(size()).toEqual({ count: 1, bytes: 0 });
    vi.advanceTimersByTime(28 * MINUTE - 2);
    expect(size()).toEqual({ count: 1, bytes: 0 });
    vi.advanceTimersByTime(1);
    expect(size()).toEqual({ count: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes metadata that nobody read or delivered at the first deadline, and leaves no timer", () => {
    vi.useFakeTimers();
    snapshots.dashboardViewSnapshotLimits.ttlMs = 30_000;
    store();
    vi.advanceTimersByTime(30_000);
    expect(size()).toEqual({ count: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles overlapping deadlines and sets the timer again after storage, delivery and deletion", () => {
    vi.useFakeTimers();
    const first = store(100);
    vi.advanceTimersByTime(30_000);
    const second = store(200);
    vi.advanceTimersByTime(30_000);
    expect(snapshots.claimDashboardViewBytes(second.handle)).toHaveLength(200);
    expect(size()).toEqual({ count: 2, bytes: 100 });
    // The first snapshot ends at 2 minutes. The delivered second one stays.
    vi.advanceTimersByTime(MINUTE - 1);
    expect(size()).toEqual({ count: 2, bytes: 100 });
    vi.advanceTimersByTime(1);
    expect(size()).toEqual({ count: 1, bytes: 0 });
    expect(snapshots.resolveDashboardViewSnapshot(first.handle)).toBeUndefined();
    // A snapshot with an earlier deadline that comes later replaces the waiting timer.
    snapshots.dashboardViewSnapshotLimits.deliveryMs = 10_000;
    store(300);
    vi.advanceTimersByTime(10_000);
    expect(size()).toEqual({ count: 1, bytes: 0 });
    // The delivered second snapshot ends 30 minutes after its storage at 30 seconds. Now is 130 seconds.
    vi.advanceTimersByTime(30 * MINUTE + 30_000 - 130_000 - 1);
    expect(size().count).toBe(1);
    vi.advanceTimersByTime(1);
    expect(size()).toEqual({ count: 0, bytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer in the test reset and never brings back a deleted snapshot", () => {
    vi.useFakeTimers();
    const { handle } = store();
    expect(vi.getTimerCount()).toBe(1);
    snapshots.resetDashboardViewSnapshotsForTests();
    expect(vi.getTimerCount()).toBe(0);
    expect(size()).toEqual({ count: 0, bytes: 0 });
    vi.advanceTimersByTime(40 * MINUTE);
    expect(size()).toEqual({ count: 0, bytes: 0 });
    expect(snapshots.resolveDashboardViewSnapshot(handle)).toBeUndefined();
    // A new snapshot after the reset keeps its own full life.
    const next = store(50);
    vi.advanceTimersByTime(2 * MINUTE - 1);
    expect(size()).toEqual({ count: 1, bytes: 50 });
    expect(snapshots.claimDashboardViewBytes(next.handle)).toHaveLength(50);
  });

  it("ends a snapshot at the timer when its link changed", () => {
    vi.useFakeTimers();
    store();
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: "bearer-ams-rotated" });
    expect(size().count).toBe(1);
    vi.advanceTimersByTime(2 * MINUTE);
    expect(size()).toEqual({ count: 0, bytes: 0 });
  });

  it("does not keep the process alive", () => {
    const refs = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
    const before = refs();
    store();
    expect(refs()).toBe(before);
    snapshots.resetDashboardViewSnapshotsForTests();
  });
});

describe("overlapping prepare requests", () => {
  it("keeps each snapshot on its own dashboard when the reads finish in the opposite order", async () => {
    const waiting: Array<() => void> = [];
    handler = (_request, response, call) => {
      const id = /\/d\/([^/]+)\/embed/.exec(call.url)![1];
      // The first read waits for the second one to finish.
      if (id === ID) waiting.push(() => sendHtml(response, id, "<h1>Page A</h1>"));
      else { sendHtml(response, id, "<h1>Page B</h1>"); waiting.forEach((finish) => finish()); }
    };
    const a = prepare({ gateway: "ams", dashboardId: ID });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const b = prepare({ gateway: "ams", dashboardId: SIBLING });
    const [first, second] = await Promise.all([a, b]);
    const [bodyA, bodyB] = [await first.json() as { handle: string; dashboardId: string }, await second.json() as { handle: string; dashboardId: string }];
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(await (await frame(bodyA.handle)).text()).toContain("Page A");
    expect(await (await frame(bodyB.handle)).text()).toContain("Page B");
    const readA = await (await readView({ handle: bodyA.handle })).json() as { dashboardId: string; meta: { dashboardId: string } };
    const readB = await (await readView({ handle: bodyB.handle })).json() as { dashboardId: string; meta: { dashboardId: string } };
    expect([readA.dashboardId, readA.meta.dashboardId, readB.dashboardId, readB.meta.dashboardId]).toEqual([ID, ID, SIBLING, SIBLING]);
  });

  it("does not store a snapshot for a prepare request that the client cancelled before the headers", async () => {
    handler = () => undefined;
    const controller = new AbortController();
    const pending = prepare(undefined, {}, controller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 0, bytes: 0 });
    handler = defaultHandler;
    expect((await prepare()).status).toBe(201);
    expect(snapshots.dashboardViewStoreSizeForTests().count).toBe(1);
  });
});

describe("body bounds of prepare and read", () => {
  it("refuses a declared length over the limit before it reads the body", async () => {
    const { stream, cancelled } = stalledBody();
    const response = await createWithStream(stream, { "content-length": "20000" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "request_too_large" });
    await vi.waitFor(() => expect(cancelled()).toBe(true));
    expect(calls).toEqual([]);
  });

  it.each(["", "/read"])("ends a body that stalls at the deadline and cancels the reader (%j)", async (suffix) => {
    views.dashboardViewLimits.createDeadlineMs = 100;
    const { stream, cancelled } = stalledBody();
    const started = Date.now();
    const response = await createWithStream(stream, {}, undefined, suffix);
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "request_timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(cancelled()).toBe(true);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("cancels the reader and frees the slot when the client aborts", async () => {
    views.dashboardViewLimits.createPending = 1;
    const first = stalledBody();
    const controller = new AbortController();
    const pending = createWithStream(first.stream, {}, controller.signal);
    // The pending read holds the only slot.
    await vi.waitFor(async () => {
      const second = stalledBody();
      const refused = await createWithStream(second.stream);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(await refused.json()).toEqual({ error: "too_many_dashboard_view_requests" });
      expect(second.cancelled()).toBe(true);
    });
    controller.abort();
    expect((await pending).status).toBe(499);
    expect(first.cancelled()).toBe(true);
    expect((await prepare()).status).toBe(201);
  });

  it("counts pending reads apart from stored snapshots", async () => {
    views.dashboardViewLimits.createPending = 2;
    views.dashboardViewLimits.createDeadlineMs = 150;
    const waiting = [stalledBody(), stalledBody()];
    const pending = waiting.map((item) => createWithStream(item.stream));
    const refused = await createWithStream(stalledBody().stream);
    expect(refused.status).toBe(429);
    for (const response of await Promise.all(pending)) expect(response.status).toBe(408);
    for (const item of waiting) expect(item.cancelled()).toBe(true);
    expect(snapshots.dashboardViewStoreSizeForTests().count).toBe(0);
  });

  it("keeps the small defaults", () => {
    expect(defaultLimits).toMatchObject({ createBytes: 12 * 1024, createDeadlineMs: 5_000, createPending: 16 });
    expect(views.dashboardViewLimits).toMatchObject(defaultLimits);
    expect(defaultSnapshotLimits).toEqual({ ttlMs: 30 * 60 * 1000, deliveryMs: 2 * 60 * 1000, count: 128, bytes: 32 * 1024 * 1024 });
    expect(snapshots.dashboardViewSnapshotLimits).toEqual(defaultSnapshotLimits);
  });
});

/** A request body that sends one byte and then waits. It records when the reader cancels it. */
function stalledBody(): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
    cancel() { cancelled = true; },
  });
  return { stream, cancelled: () => cancelled };
}

const createWithStream = (stream: ReadableStream<Uint8Array>, extra: Record<string, string> = {}, signal?: AbortSignal, suffix = "") =>
  app.request(`${NS}${suffix}`, { method: "POST", headers: createHeaders(extra), body: stream, duplex: "half", signal } as RequestInit);

describe("route ownership", () => {
  it.each([
    `${NS}/`,
    `${NS}/x`,
    `${NS}/${H43}`,
    `${NS}/${H43}/`,
    `${NS}/${H43}/frame/`,
    `${NS}/${H43}/frame/extra`,
    `${NS}/${H43}/shell/`,
    `${NS}/${H43}/Frame`,
    `${NS}/${H43}/current`,
    `${NS}/${H43}/${ID}/`,
    `${NS}/${H43}/${ID}/edit`,
    `${NS}/${H43}/edit/`,
    `${NS}/${H43}/add/extra`,
    `${NS}/${H43}/frame%2Fextra`,
    `${NS}/${H43}/%2e%2e/frame`,
    `${NS}/${"G".repeat(42)}/frame`,
    `${NS}/%47${"G".repeat(42)}/frame`,
    `${NS}/read/`,
    `${NS}/Read`,
    `${NS}/read/extra`,
    `/api/relay/dashboard-views%2F${H43}/frame`,
    `/api/relay/dashboard-views%252F${H43}/frame`,
    `/api/relay/dashboard%2Dviews/${H43}/frame`,
    `/api/relay/dashboard%2dviews%2F${H43}/shell`,
    `/api/relay/dashboard-views/${H43}%zz/frame`,
    "/api/relay/dashboard-viewsX",
    `/api/Relay/Dashboard-Views/${H43}/frame`,
    `/API/RELAY/DASHBOARD-VIEWS/${H43}/shell`,
    `/api/relay%2Fdashboard-views/${H43}/frame`,
    `/api%2Frelay/dashboard-views/${H43}/frame`,
    `/%61pi/relay/dashboard-views/${H43}/frame`,
    `/api/%72elay/dashboard-views/${H43}/frame`,
    `/api/relay/%64ashboard-views/${H43}/frame`,
    `/api/%2552elay/dashboard-views/${H43}/frame`,
    `/api/Relay%2FDashboard-Views/${H43}%zz/frame`,
  ])("answers a malformed owned path %s locally, with no remote call and no fallthrough", async (pathname) => {
    for (const method of ["GET", "POST"]) {
      const response = await app.request(pathname, { method, headers: { ...navigation(), ...opaque() }, body: method === "POST" ? "{}" : undefined });
      expect(response.status).not.toBe(299);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(await response.json()).toEqual({ error: "invalid_dashboard_view_route" });
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ["the frame", "frame", "GET"],
    ["the shell", "shell", "GET"],
    ["an edit", "edit", "POST"],
    ["an add", "add", "POST"],
    ["a read", "../read", "POST"],
    ["a prepare", "../", "POST"],
  ])("refuses any query on a valid path: %s", async (_label, suffix, method) => {
    const { handle } = await open();
    calls = [];
    const base = suffix === "../" ? NS : suffix === "../read" ? `${NS}/read` : `${NS}/${handle}/${suffix}`;
    for (const query of ["?x=1", "?", "?region=emea", `?handle=${handle}`, "?%00"]) {
      const response = await app.request(`${base}${query}`, { method, headers: { ...navigation(), ...createHeaders(), ...opaque() }, body: method === "POST" ? "{}" : undefined });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "invalid_dashboard_view_route" });
    }
    expect(calls).toEqual([]);
    expect(snapshots.dashboardViewStoreSizeForTests().bytes).toBeGreaterThan(0);
  });

  it("answers an owned path with a wrong method with 405 and the allowed method", async () => {
    const { handle } = await open();
    for (const [pathname, method, allow] of [
      [NS, "GET", "POST"],
      [`${NS}/read`, "GET", "POST"],
      [`${NS}/${handle}/frame`, "POST", "GET"],
      [`${NS}/${handle}/frame`, "PUT", "GET"],
      [`${NS}/${handle}/frame`, "HEAD", "GET"],
      [`${NS}/${handle}/frame`, "OPTIONS", "GET"],
      [`${NS}/${handle}/shell`, "POST", "GET"],
      [`${NS}/${handle}/edit`, "GET", "POST"],
      [`${NS}/${handle}/add`, "DELETE", "POST"],
    ] as const) {
      const response = await app.request(pathname, { method, headers: opaque() });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allow);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(calls).toHaveLength(1);
  });

  it("leaves other relay paths and every unrelated path to later handlers", async () => {
    for (const pathname of ["/api/relay/gateways/ams/api/agents", "/api/relay", "/api/relayx/dashboard-views", "/api/agents", "/health", "/d/x/embed", "/"]) {
      const response = await app.request(pathname);
      expect(response.status, pathname).toBe(299);
      expect(await response.text()).toBe("fell through");
    }
    expect(calls).toEqual([]);
  });
});

describe("prepare: the remote request", () => {
  it("sends the linked bearer only on this call and nothing that identifies the browser", async () => {
    const response = await prepare({ gateway: "ams", dashboardId: ID, query: "region=emea&__yoplai_pad=1&q=a+b", theme: "dark" }, {
      cookie: "session=local-session; yoplai-theme=light",
      authorization: "Bearer local-browser-credential",
      referer: `${UI}/remote-dashboards/ams/${ID}`,
      "x-forwarded-for": "127.0.0.1",
      "x-yoplai-user-id": "local-admin",
    });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`/d/${ID}/embed?region=emea&q=a+b`);
    expect(call.headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(call.headers.accept).toBe("text/html");
    // The theme comes from the request body, not from a cookie.
    expect(call.headers[DASHBOARD_EMBED_HEADERS.theme.toLowerCase()]).toBe("dark");
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-yoplai-user-id", "forwarded", "proxy-authorization"]) expect(call.headers[name]).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain("local-browser-credential");
    await expectNoSecrets(response);
  });

  it("passes a checked theme, ignores the cookie, and accepts a leading question mark in the query", async () => {
    await prepare({ gateway: "ams", dashboardId: ID, theme: "light", query: "?a=1" }, { cookie: "yoplai-theme=dark" });
    await prepare({ gateway: "ams", dashboardId: ID }, { cookie: "yoplai-theme=dark" });
    expect(calls[0].url).toBe(`/d/${ID}/embed?a=1`);
    expect(calls[0].headers[DASHBOARD_EMBED_HEADERS.theme.toLowerCase()]).toBe("light");
    expect(calls[1].url).toBe(`/d/${ID}/embed`);
    expect(calls[1].headers[DASHBOARD_EMBED_HEADERS.theme.toLowerCase()]).toBeUndefined();
  });

  it("bounds the query to 8 KiB after it removes transport-only fields", async () => {
    const refused = await prepare({ gateway: "ams", dashboardId: ID, query: `pad=${"x".repeat(8200)}` });
    expect(refused.status).toBe(414);
    expect(await refused.json()).toEqual({ error: "query_too_large" });
    expect(calls).toEqual([]);
    const accepted = await prepare({ gateway: "ams", dashboardId: ID, query: `__yoplai_pad=${"x".repeat(9000)}&keep=1` });
    expect(accepted.status).toBe(201);
    expect(calls[0].url).toBe(`/d/${ID}/embed?keep=1`);
  });

  it("ties each snapshot to its own query: the same dashboard with another query is another snapshot", async () => {
    const first = await open("ams", ID, { query: "region=emea" });
    const second = await open("ams", ID, { query: "region=apac" });
    expect(first.handle).not.toBe(second.handle);
    expect(calls.map((call) => call.url)).toEqual([`/d/${ID}/embed?region=emea`, `/d/${ID}/embed?region=apac`]);
  });
});

describe("frame delivery", () => {
  it("delivers the page under the viewer policy, with exact CSP and sandbox and without remote headers", async () => {
    handler = (_request, response) => sendHtml(response, ID, "<h1>Remote page</h1>", {
      "set-cookie": "remote=1; Path=/",
      refresh: "0; url=https://evil.example.test/",
      "content-security-policy": "default-src *; sandbox allow-same-origin allow-popups allow-top-navigation",
      "content-disposition": 'attachment; filename="x.html"',
      "access-control-allow-origin": "*",
      "access-control-allow-credentials": "true",
      "report-to": '{"group":"x"}',
      "reporting-endpoints": 'x="https://evil.example.test/r"',
      link: "<https://evil.example.test/>; rel=preload",
      "x-frame-options": "ALLOWALL",
      "content-security-policy-report-only": "default-src *",
    });
    const { handle } = await open();
    const response = await frame(handle);
    expect(response.status).toBe(200);
    const viewer = `${NS}/${handle}`;
    expect(response.headers.get("content-security-policy")).toBe([
      "sandbox allow-scripts allow-downloads allow-modals",
      "default-src 'none'",
      `script-src 'unsafe-inline' ${UI}/d-assets/`,
      `style-src 'unsafe-inline' ${UI}/d-assets/`,
      "img-src data: blob:",
      `font-src data: ${UI}/d-assets/`,
      `connect-src ${UI}${viewer}/edit ${UI}${viewer}/add`,
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'self'",
      "form-action 'none'",
    ].join("; "));
    const csp = response.headers.get("content-security-policy")!;
    for (const forbidden of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms"]) expect(csp).not.toContain(forbidden);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    for (const name of ["set-cookie", "refresh", "content-disposition", "access-control-allow-origin", "access-control-allow-credentials", "report-to", "reporting-endpoints", "link", "x-frame-options", "content-security-policy-report-only", "location", DASHBOARD_EMBED_HEADERS.meta]) {
      expect(response.headers.get(name)).toBeNull();
    }
    await expectNoSecrets(response);
  });

  it("delivers the stored bytes to one iframe, once, and never another document", async () => {
    handler = (_request, response) => sendHtml(response, ID, "<h1>First read</h1>");
    const { handle } = await open();
    // A later remote change does not reach this snapshot.
    handler = (_request, response) => sendHtml(response, ID, "<h1>Second read</h1>");
    const first = await frame(handle);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("First read");
    const secondFrame = await frame(handle);
    expect(secondFrame.status).toBe(409);
    expect(await secondFrame.json()).toEqual({ error: "dashboard_view_delivered" });
    expect(secondFrame.headers.get("content-type")).toContain("application/json");
    expect(calls).toHaveLength(1);
    expect(snapshots.dashboardViewStoreSizeForTests().bytes).toBe(0);
    const read = await (await readView({ handle })).json() as { state: string; meta: object };
    expect(read.state).toBe("delivered");
    expect(read.meta).toEqual(metaFor(ID));
  });

  it("answers a top-level or other non-iframe request with a sandboxed refusal that consumes nothing", async () => {
    const { handle } = await open();
    const destinations: Array<Record<string, string>> = [{}, { "sec-fetch-dest": "document" }, { "sec-fetch-dest": "empty" }, { "sec-fetch-dest": "script" }, { "sec-fetch-dest": "image" }, { "sec-fetch-dest": "frame" }, { "sec-fetch-dest": "embed" }, { "sec-fetch-dest": "object" }];
    for (const headers of destinations) {
      const response = await frame(handle, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "navigation_required" });
      expect(response.headers.get("content-security-policy")).toContain("sandbox");
      expect(response.headers.get("content-type")).toContain("application/json");
    }
    expect(snapshots.dashboardViewStoreSizeForTests().bytes).toBeGreaterThan(0);
    expect((await readView({ handle })).status).toBe(200);
    // The refusals left the delivery for the real frame.
    expect((await frame(handle, navigation({ "sec-fetch-site": "cross-site" }))).status).toBe(200);
  });

  it("lets one delivery win a race between two frames, and the loser gets a refusal", async () => {
    const { handle } = await open();
    const results = await Promise.all([frame(handle), frame(handle), frame(handle)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409, 409]);
    const winner = results.find((response) => response.status === 200)!;
    expect(await winner.text()).toContain("Remote page");
    const read = await (await readView({ handle })).json() as { dashboardId: string };
    expect(read.dashboardId).toBe(ID);
  });

  it("refuses an unknown handle with no remote call", async () => {
    for (const response of [await frame("U".repeat(43)), await shell("U".repeat(43))]) {
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ state: "expired", error: "dashboard_view_expired", status: 410 });
    }
    expect(calls).toEqual([]);
  });

  it("refuses a request from an external client before it reads the snapshot", async () => {
    const { handle } = await open();
    const response = await frame(handle, navigation({ "x-forwarded-for": "203.0.113.9" }));
    expect(response.status).toBe(403);
    expect(snapshots.dashboardViewStoreSizeForTests().bytes).toBeGreaterThan(0);
  });

  it("returns exactly the bytes that it counted, also for invalid UTF-8 and multi-byte text", async () => {
    views.dashboardViewLimits.htmlBytes = 64;
    const invalid = Buffer.alloc(64, 0xff);
    handler = (_request, response) => { response.writeHead(200, embedHeaders(ID)); response.end(invalid); };
    const broken = await frame((await open()).handle);
    expect(broken.status).toBe(200);
    const brokenBytes = Buffer.from(await broken.arrayBuffer());
    expect(brokenBytes.byteLength).toBe(64);
    expect(brokenBytes.equals(invalid)).toBe(true);
    // The same bytes with one more byte are refused, so the limit is exact.
    handler = (_request, response) => { response.writeHead(200, embedHeaders(ID)); response.end(Buffer.alloc(65, 0xff)); };
    const over = await prepare();
    expect(over.status).toBe(502);
    expect(await over.json()).toEqual({ error: "remote_response_too_large" });
    // Valid multi-byte text keeps its bytes. A BOM is not removed or doubled.
    const text = Buffer.from("\uFEFF<p>é €</p>\u{1F600}", "utf8");
    views.dashboardViewLimits.htmlBytes = text.byteLength;
    handler = (_request, response) => { response.writeHead(200, embedHeaders(ID)); response.end(text); };
    const valid = await frame((await open()).handle);
    expect(valid.status).toBe(200);
    expect(Buffer.from(await valid.arrayBuffer()).equals(text)).toBe(true);
  });
});

describe("trusted shell", () => {
  const scriptOf = (html: string) => /<script>([\s\S]*)<\/script>/.exec(html)![1];

  it("serves only local code under a response policy that allows exactly one frame path", async () => {
    handler = (_request, response) => sendHtml(response, ID, "<h1>Remote page</h1>");
    const { handle, instance } = await open();
    const response = await shell(handle);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const html = await response.text();
    expect(html).not.toContain("Remote page");
    expect(html).toContain(instance);
    expect(html).toContain(`${NS}/${handle}/frame`);
    const csp = response.headers.get("content-security-policy")!;
    const directives = Object.fromEntries(csp.split("; ").map((part) => [part.split(" ")[0], part.split(" ").slice(1).join(" ")]));
    expect(directives["frame-src"]).toBe(`${UI}${NS}/${handle}/frame`);
    expect(directives["default-src"]).toBe("'none'");
    expect(directives["connect-src"]).toBe("'none'");
    expect(directives["frame-ancestors"]).toBe("'self'");
    expect(directives["base-uri"]).toBe("'none'");
    expect(directives["form-action"]).toBe("'none'");
    expect(directives["object-src"]).toBe("'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|blob:|data:|\*|dashboard-views\/?(;|$| )/);
    // One script hash, and it matches the one inline script of the shell.
    expect(directives["script-src"]).toBe(`'sha256-${createHash("sha256").update(scriptOf(html)).digest("base64")}'`);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toContain(BEARER);
    expect(html).not.toContain(TOKEN);
  });

  it("gives every shell its own script-independent identity: instance and frame path only", async () => {
    const first = await open();
    const second = await open();
    const [a, b] = [await (await shell(first.handle)).text(), await (await shell(second.handle)).text()];
    expect(scriptOf(a)).toBe(scriptOf(b));
    expect(a).toContain(first.instance);
    expect(a).not.toContain(second.instance);
    expect(a).not.toContain(second.handle);
  });

  it("loads once, only as a same-origin iframe, and a refused request consumes nothing", async () => {
    const { handle } = await open();
    for (const headers of [{}, { "sec-fetch-dest": "document", "sec-fetch-site": "same-origin" }, { "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" }] as Array<Record<string, string>>) {
      const refused = await shell(handle, headers);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: "navigation_required" });
    }
    const crossSite = await shell(handle, navigation({ "sec-fetch-site": "cross-site" }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toEqual({ error: "same_origin_required" });
    expect((await shell(handle)).status).toBe(200);
    const again = await shell(handle);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "dashboard_view_shell_delivered" });
    // The renderer delivery is separate and still open.
    expect((await frame(handle)).status).toBe(200);
  });
});

describe("read: checked metadata for the trusted host", () => {
  it("returns checked metadata for a strict same-origin JSON body, never the edit token, and the delivery state", async () => {
    handler = (_request, response) => sendHtml(response, ID, `<h1>Page</h1><script>var r={"editToken":"${TOKEN}"}</script>`);
    const { handle, expiresAt } = await open();
    const ready = await readView({ handle }, { origin: UI });
    expect(ready.status).toBe(200);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    expect(ready.headers.get("access-control-allow-origin")).toBeNull();
    const text = await ready.text();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toEqual({ expiresAt, state: "ready", gateway: "ams", dashboardId: ID, meta: metaFor(ID) });
    expect((await frame(handle)).status).toBe(200);
    expect(await (await readView({ handle })).json()).toEqual({ expiresAt, state: "delivered", gateway: "ams", dashboardId: ID, meta: metaFor(ID) });
    // Another dashboard needs another snapshot, so it cannot change this answer.
    handler = defaultHandler;
    await open("ams", SIBLING);
    expect(((await (await readView({ handle })).json()) as { dashboardId: string }).dashboardId).toBe(ID);
  });

  it("never returns success fields with an error", async () => {
    const expired = await (await readView({ handle: "U".repeat(43) })).json() as Record<string, unknown>;
    expect(Object.keys(expired).sort()).toEqual(["error", "state", "status"]);
    expect(expired).not.toHaveProperty("meta");
    expect(expired).not.toHaveProperty("dashboardId");
  });

  it.each([
    ["no Origin", { origin: "" }, 403, "untrusted_origin"],
    ["a foreign Origin", { origin: "https://evil.example.test" }, 403, "untrusted_origin"],
    ["an opaque Origin", { origin: "null" }, 403, "untrusted_origin"],
    ["no fetch context", { "sec-fetch-site": "" }, 403, "same_origin_required"],
    ["a cross-site context", { "sec-fetch-site": "cross-site" }, 403, "same_origin_required"],
    ["a form content type", { "content-type": "text/plain" }, 415, "json_required"],
    ["an external forwarded client", { "x-forwarded-for": "203.0.113.9" }, 403, "relay_unavailable"],
  ])("refuses a read request with %s", async (_label, headers, status, error) => {
    const { handle } = await open();
    const response = await app.request(`${NS}/read`, {
      method: "POST",
      headers: Object.fromEntries(Object.entries({ ...createHeaders(), ...headers }).filter(([, value]) => value !== "")),
      body: JSON.stringify({ handle }),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
  });

  it("refuses a body with an extra field, a bad handle, and a handle in the URL", async () => {
    const { handle } = await open();
    for (const body of [{ handle, extra: 1 }, {}, { handle: 5 }, "not json", "[]"]) {
      expect((await readView(body)).status).toBe(400);
    }
    expect((await readView({ handle: "short" })).status).toBe(410);
    // The handle never belongs in a query string. The route refuses it before it reads anything.
    const inUrl = await app.request(`${NS}/read?handle=${handle}`, { method: "POST", headers: createHeaders(), body: JSON.stringify({ handle }) });
    expect(inUrl.status).toBe(404);
    expect((await app.request(`${NS}/${handle}/current`, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(404);
  });

  it("answers only the issuer origin", async () => {
    const { handle } = await open();
    const allowed = ["http://localhost:3000", UI];
    const other = allowed.find((origin) => origin !== UI)!;
    const response = await readView({ handle }, { origin: other });
    // The other origin is an allowed UI origin only when the gateway lists it. Either way it is not the issuer.
    expect([403]).toContain(response.status);
    expect(await response.json()).toEqual({ error: "untrusted_origin" });
  });
});

describe("prepare: remote results", () => {
  const expectError = async (status: number, error: string, extra: Record<string, unknown> = {}, body: unknown = { gateway: "ams", dashboardId: ID }) => {
    const response = await prepare(body);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await expectNoSecrets(response);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ error, ...extra });
    expect(parsed).not.toHaveProperty("handle");
    expect(parsed).not.toHaveProperty("meta");
    return response;
  };

  it("maps a remote 401 and a login redirect to unauthorized without a second request", async () => {
    handler = (_request, response) => sendJson(response, 401, { error: "unauthorized" }, embedMarker);
    await expectError(401, "remote_unauthorized");
    calls = [];
    handler = (_request, response) => {
      response.writeHead(302, { location: "/login?returnTo=%2Fd%2Fx", "set-cookie": "a=b" });
      response.end("<h1>login</h1>");
    };
    const redirected = await expectError(401, "remote_unauthorized");
    expect(redirected.headers.get("location")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("refuses another redirect as an invalid remote response and never follows it", async () => {
    handler = (_request, response) => {
      response.writeHead(302, { location: "https://evil.example.test/steal" });
      response.end();
    };
    const result = await expectError(502, "invalid_remote_response");
    expect(result.headers.get("location")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns a bounded 403 and never remote HTML", async () => {
    handler = (_request, response) => sendJson(response, 403, { error: "forbidden", ownerName: "Alice Martin" }, embedMarker);
    await expectError(403, "forbidden", { ownerName: "Alice Martin" });
    handler = (_request, response) => {
      response.writeHead(403, { "content-type": "text/html" });
      response.end("<script>alert(1)</script><h1>Not shared</h1>");
    };
    const unmarked = await prepare();
    expect(unmarked.status).toBe(403);
    expect(await unmarked.text()).not.toContain("<script>");
  });

  it("tells a missing dashboard, a disabled Canvas and an old remote apart", async () => {
    const marker = embedMarker;
    handler = (_request, response) => sendJson(response, 404, { error: "not_found" }, marker);
    await expectError(404, "not_found");
    expect(calls).toHaveLength(1);
    handler = (_request, response) => sendJson(response, 404, { error: "not_found" }, { ...marker, [DASHBOARD_EMBED_HEADERS.reason]: "canvas_disabled" });
    await expectError(404, "canvas_disabled");
    // An unmarked 404 is not proof of an old remote. The remote capabilities decide.
    calls = [];
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 200, { version: 2, extensions: {}, agents: [] });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(409, "remote_update_required", { reason: "missing_capability" });
    expect(calls.map((call) => call.url)).toEqual([`/d/${ID}/embed`, "/api/capabilities"]);
    expect(calls[1].headers.authorization).toBe(`Bearer ${BEARER}`);
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 200, { version: 2, dashboardEmbed: { version: 1, assetVersion: "v3", policyVersion: 1, enabled: true } });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(404, "not_found");
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 401, { error: "unauthorized" });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(401, "remote_unauthorized");
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 403, { error: "forbidden" });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(403, "forbidden");
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return void response.end("<html>proxy</html>");
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(502, "invalid_remote_response");
  });

  it.each<[string, unknown, number, string, Record<string, unknown>]>([
    ["a missing capability", undefined, 409, "remote_update_required", { reason: "missing_capability" }],
    ["a newer embed version", { version: 2, assetVersion: "v3", policyVersion: 1, enabled: true }, 409, "remote_update_required", { reason: "embed_version" }],
    ["an older embed version", { version: 0, assetVersion: "v3", policyVersion: 1, enabled: true }, 409, "remote_update_required", { reason: "embed_version" }],
    ["an unsupported asset version", { version: 1, assetVersion: "v9", policyVersion: 1, enabled: true }, 409, "remote_update_required", { reason: "asset_version" }],
    ["a different policy version", { version: 1, assetVersion: "v3", policyVersion: 2, enabled: true }, 409, "remote_update_required", { reason: "policy_version" }],
    ["a newer version that is disabled", { version: 2, assetVersion: "v3", policyVersion: 1, enabled: false }, 409, "remote_update_required", { reason: "embed_version" }],
    ["a disabled Canvas", { version: 1, assetVersion: "v3", policyVersion: 1, enabled: false }, 404, "canvas_disabled", {}],
    ["an enabled Canvas, so the dashboard is missing", { version: 1, assetVersion: "v3", policyVersion: 1, enabled: true }, 404, "not_found", {}],
    ["a compatible capability with extra fields", { version: 1, assetVersion: "v3", policyVersion: 1, enabled: true, note: "later" }, 404, "not_found", {}],
    ["an empty object", {}, 502, "invalid_remote_response", {}],
    ["a null value", null, 502, "invalid_remote_response", {}],
    ["a string", "yes", 502, "invalid_remote_response", {}],
    ["a list", [1], 502, "invalid_remote_response", {}],
    ["a missing enabled field", { version: 1, assetVersion: "v3", policyVersion: 1 }, 502, "invalid_remote_response", {}],
    ["an enabled field that is not a boolean", { version: 1, assetVersion: "v3", policyVersion: 1, enabled: "true" }, 502, "invalid_remote_response", {}],
    ["a version that is not a number", { version: "1", assetVersion: "v3", policyVersion: 1, enabled: true }, 502, "invalid_remote_response", {}],
    ["an asset version that is not text", { version: 1, assetVersion: 3, policyVersion: 1, enabled: true }, 502, "invalid_remote_response", {}],
  ])("classifies an unmarked 404 by the remote capability: %s", async (_label, capability, status, error, extra) => {
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 200, { version: 2, extensions: {}, agents: [], ...(capability === undefined ? {} : { dashboardEmbed: capability }) });
      sendJson(response, 404, { error: "not_found" });
    };
    const answer = await prepare();
    expect(answer.status).toBe(status);
    expect(await answer.json()).toEqual({ error, ...extra });
    expect(calls.map((call) => call.url)).toEqual([`/d/${ID}/embed`, "/api/capabilities"]);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    // A second prepare reads the capability again, so nothing is cached.
    calls = [];
    expect((await prepare()).status).toBe(status);
    expect(calls.map((call) => call.url)).toEqual([`/d/${ID}/embed`, "/api/capabilities"]);
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 0, bytes: 0 });
  });

  it.each<[string, Record<string, string>, string]>([
    ["no marker on a page", { [DASHBOARD_EMBED_HEADERS.version]: "" }, "missing_embed_marker"],
    ["a newer embed version", { [DASHBOARD_EMBED_HEADERS.version]: "2" }, "embed_version"],
    ["an unsupported asset version", { [DASHBOARD_EMBED_HEADERS.assets]: "v9" }, "asset_version"],
    ["no asset version", { [DASHBOARD_EMBED_HEADERS.assets]: "" }, "asset_version"],
    ["a different security policy version", { [DASHBOARD_EMBED_HEADERS.policy]: "2" }, "policy_version"],
  ])("asks for an update when the remote sends %s", async (_label, change, reason) => {
    handler = (_request, response) => {
      const headers = { ...embedHeaders(ID), ...change };
      for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
      response.writeHead(200, headers);
      response.end("<h1>Remote page</h1>");
    };
    await expectError(409, "remote_update_required", { reason });
  });

  it("refuses invalid metadata, a metadata ID that differs from the request, and a non-HTML page", async () => {
    for (const meta of [
      "not-base64-json",
      Buffer.from(JSON.stringify({ dashboardId: ID })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...metaFor(ID), extra: 1 })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...metaFor(ID), editToken: TOKEN })).toString("base64url"),
      Buffer.from(JSON.stringify({ ...metaFor(ID), annotation: true, chat: null })).toString("base64url"),
      Buffer.from(JSON.stringify(metaFor(SIBLING))).toString("base64url"),
      "A".repeat(3000),
    ]) {
      handler = (_request, response) => {
        response.writeHead(200, embedHeaders(ID, { [DASHBOARD_EMBED_HEADERS.meta]: meta }));
        response.end("<h1>Remote page</h1>");
      };
      await expectError(502, "invalid_remote_response");
    }
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID, { "content-type": "application/json" }));
      response.end("{}");
    };
    await expectError(502, "invalid_remote_response");
    handler = (_request, response) => sendJson(response, 500, { error: "boom" });
    await expectError(502, "invalid_remote_response", { remoteStatus: 500 });
    expect(snapshots.dashboardViewStoreSizeForTests()).toEqual({ count: 0, bytes: 0 });
  });

  it("reports an offline remote, and a relinked gateway ends the old snapshot", async () => {
    const { handle } = await open();
    state.getRemoteGatewayStore().save({ name: "ams", url: "http://127.0.0.1:1", token: BEARER });
    expect(await stateOf(handle)).toBe(410);
    await expectError(502, "gateway_offline", { gateway: "ams" });
  });

  it("binds a snapshot to the link that it was read through, even when the link changes during the read", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    handler = (_request, response) => { void held.then(() => sendHtml(response, ID)); };
    const pending = prepare();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: "bearer-ams-rotated" });
    release();
    const body = await (await pending).json() as { handle: string };
    // The read used the old bearer, so the new link must not own its snapshot.
    expect(await stateOf(body.handle)).toBe(410);
  });
});

describe("prepare: bounds", () => {
  it("refuses a page that declares more than 5 MiB and a page that streams more, and cancels the body", async () => {
    expect(views.dashboardViewLimits.htmlBytes).toBe(5 * 1024 * 1024);
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID, { "content-length": String(5 * 1024 * 1024 + 1) }));
      response.write("x");
    };
    const declared = await prepare();
    expect(declared.status).toBe(502);
    expect(await declared.json()).toEqual({ error: "remote_response_too_large" });
    await vi.waitFor(() => expect(closed).toBe(1));
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID));
      const chunk = Buffer.alloc(256 * 1024, "x");
      for (let i = 0; i < 21; i++) response.write(chunk);
      response.end();
    };
    const streamed = await prepare();
    expect(streamed.status).toBe(502);
    expect(await streamed.json()).toEqual({ error: "remote_response_too_large" });
    handler = (_request, response) => sendHtml(response, ID, "x".repeat(5 * 1024 * 1024 - 100));
    expect((await prepare()).status).toBe(201);
    expect(snapshots.dashboardViewStoreSizeForTests().bytes).toBeGreaterThan(5 * 1024 * 1024 - 200);
  });

  it("times out stalled headers and a stalled body, and closes the remote connection", async () => {
    views.dashboardViewLimits.deadlineMs = 150;
    handler = () => undefined;
    const headers = await prepare();
    expect(headers.status).toBe(504);
    expect(await headers.json()).toMatchObject({ error: "remote_timeout" });
    await vi.waitFor(() => expect(closed).toBe(1));
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID));
      response.write("<h1>Partial");
    };
    const body = await prepare();
    expect(body.status).toBe(504);
    expect(await body.json()).toMatchObject({ error: "remote_timeout" });
    await vi.waitFor(() => expect(closed).toBe(2));
    expect(snapshots.dashboardViewStoreSizeForTests().count).toBe(0);
  });

  it("aborts the remote call when the browser disconnects and frees the slot", async () => {
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID));
      response.write("<h1>Partial");
    };
    for (let i = 0; i < 10; i++) {
      const controller = new AbortController();
      const pending = prepare(undefined, {}, controller.signal);
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1));
      controller.abort();
      expect((await pending).status).toBe(499);
      await vi.waitFor(() => expect(closed).toBe(i + 1));
    }
    handler = defaultHandler;
    expect((await prepare()).status).toBe(201);
  });

  it("limits each gateway to eight active calls, and the limit does not touch another gateway", async () => {
    const held: http.ServerResponse[] = [];
    handler = (request, response) => {
      if (request.headers.authorization === `Bearer ${BEARER}`) {
        response.writeHead(200, embedHeaders(ID));
        response.write("<h1>Held");
        held.push(response);
        return;
      }
      sendHtml(response, ID);
    };
    const pending = Array.from({ length: 8 }, () => prepare());
    await vi.waitFor(() => expect(held).toHaveLength(8));
    const refused = await prepare();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.json()).toEqual({ error: "too_many_dashboard_view_requests" });
    expect(calls).toHaveLength(8);
    expect((await prepare({ gateway: "other", dashboardId: ID })).status).toBe(201);
    for (const response of held) response.end("</h1>");
    for (const response of await Promise.all(pending)) expect(response.status).toBe(201);
    handler = defaultHandler;
    expect((await prepare()).status).toBe(201);
  });
});

describe("edit and add", () => {
  const post = (handle: string, op: "edit" | "add", body: unknown, headers: Record<string, string> = opaque()) =>
    app.request(`${NS}/${handle}/${op}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it.each(["edit", "add"] as const)("forwards a token-authenticated %s to the dashboard of the snapshot, without the bearer or any browser identity", async (op) => {
    const { handle } = await delivered("ams", SIBLING);
    calls = [];
    const before = await localTree();
    const raw = `{"token":"${TOKEN}","edit":"actions",  "key":7,"field":"done","value":true}`;
    handler = (_request, response) => sendJson(response, 200, { ok: true, value: true, at: "2026-01-01T00:00:00Z" });
    const response = await post(handle, op, raw, opaque({ cookie: "session=local", authorization: "Bearer browser", referer: UI }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect([call.method, call.url, call.body]).toEqual(["POST", `/d/${SIBLING}/${op}`, raw]);
    for (const name of ["authorization", "cookie", "origin", "referer", "proxy-authorization", "x-forwarded-for"]) expect(call.headers[name]).toBeUndefined();
    expect(call.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(JSON.parse(await expectNoSecrets(response, handle))).toEqual({ ok: true, value: true, at: "2026-01-01T00:00:00Z" });
    expect(await localTree()).toEqual(before);
  });

  it("names no dashboard in the URL, so no URL change can write to another dashboard", async () => {
    const { handle } = await delivered();
    calls = [];
    for (const path of [`${NS}/${handle}/${SIBLING}/edit`, `${NS}/${handle}/edit/${SIBLING}`, `${NS}/${handle}/edit/`, `${NS}/${handle}/Edit`, `${NS}/${handle}/edit?id=${SIBLING}`]) {
      const response = await app.request(path, { method: "POST", headers: opaque(), body: JSON.stringify({ token: TOKEN }) });
      expect(response.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("refuses a write before the bytes were delivered", async () => {
    const { handle } = await open();
    calls = [];
    const response = await post(handle, "edit", { token: TOKEN });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "dashboard_view_not_delivered" });
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(calls).toEqual([]);
  });

  it("passes remote refusals with their status, and the opaque page can read them", async () => {
    const { handle } = await delivered();
    for (const [status, body] of [[400, { ok: false, error: "Invalid request" }], [401, { ok: false, error: "Reload to keep editing" }], [403, { ok: false, error: "You can only view this dashboard" }], [404, { ok: false, error: "Not found" }], [503, { ok: false, error: "Busy" }]] as const) {
      handler = (_request, response) => sendJson(response, status, body);
      const response = await post(handle, "edit", { token: TOKEN });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get("access-control-allow-origin")).toBe("null");
    }
  });

  it("gives a snapshot no write authority without a valid edit token", async () => {
    const { handle } = await delivered();
    calls = [];
    for (const body of ["{}", '{"token":""}', '{"token":5}', "[]", "not json", ""]) {
      const response = await post(handle, "edit", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_edit_request" });
    }
    expect(calls).toEqual([]);
  });

  it("requires Origin null and text/plain", async () => {
    const { handle } = await delivered();
    calls = [];
    const body = JSON.stringify({ token: TOKEN });
    for (const headers of [{ "content-type": "text/plain" } as Record<string, string>, { origin: UI, "content-type": "text/plain" }, { origin: "https://evil.example.test", "content-type": "text/plain" }]) {
      const response = await post(handle, "edit", body, headers);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const type of ["application/json", "multipart/form-data", "application/x-www-form-urlencoded", ""]) {
      const response = await post(handle, "edit", body, opaque({ "content-type": type }));
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "text_plain_required" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses an unknown handle, a request from an external client and a disabled relay without a remote call", async () => {
    const { handle } = await delivered();
    calls = [];
    const unknown = await post("U".repeat(43), "edit", { token: TOKEN });
    expect(unknown.status).toBe(410);
    expect(unknown.headers.get("access-control-allow-origin")).toBe("null");
    expect((await post(handle, "edit", { token: TOKEN }, opaque({ "x-forwarded-for": "203.0.113.9" }))).status).toBe(403);
    state.configureRelay("127.0.0.1", true);
    expect((await post(handle, "edit", { token: TOKEN })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a request over 256 KiB before it reads the whole body or calls the remote", async () => {
    const { handle } = await delivered();
    calls = [];
    const big = JSON.stringify({ token: TOKEN, value: "x".repeat(256 * 1024) });
    const declared = await post(handle, "edit", big, opaque({ "content-length": String(big.length) }));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "request_too_large" });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024))); },
    });
    const streamed = await app.request(`${NS}/${handle}/edit`, { method: "POST", headers: opaque(), body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(calls).toEqual([]);
    const justUnder = JSON.stringify({ token: TOKEN, value: "x".repeat(256 * 1024 - 200) });
    expect((await post(handle, "edit", justUnder)).status).toBe(200);
  });

  it("refuses a redirect, an HTML answer, a non-object answer and an oversized answer from the remote", async () => {
    const { handle } = await delivered();
    calls = [];
    const reasons: Array<[RemoteHandler, number, string]> = [
      [(_request, response) => { response.writeHead(307, { location: `${remoteUrl}/elsewhere` }); response.end(); }, 502, "invalid_remote_response"],
      [(_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<script>alert(1)</script>"); }, 502, "invalid_remote_response"],
      [(_request, response) => sendJson(response, 200, [1, 2]), 502, "invalid_remote_response"],
      [(_request, response) => sendJson(response, 200, { value: 1 }), 502, "invalid_remote_response"],
      [(_request, response) => sendJson(response, 500, { ok: false }), 502, "invalid_remote_response"],
      [(_request, response) => sendJson(response, 200, { ok: true, pad: "x".repeat(256 * 1024) }), 502, "remote_response_too_large"],
      [(_request, response) => { response.writeHead(200, { "content-type": "application/json", "content-length": String(300 * 1024) }); response.write("{"); }, 502, "remote_response_too_large"],
    ];
    for (const [remoteHandler, status, error] of reasons) {
      handler = remoteHandler;
      const response = await post(handle, "edit", { token: TOKEN });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
      expect(response.headers.get("location")).toBeNull();
    }
    expect(calls).toHaveLength(reasons.length);
  });

  it("times out a stalled write and frees the slot after a disconnect", async () => {
    const { handle } = await delivered();
    calls = [];
    views.dashboardViewLimits.deadlineMs = 150;
    handler = () => undefined;
    const stalled = await post(handle, "edit", { token: TOKEN });
    expect(stalled.status).toBe(504);
    expect(await stalled.json()).toMatchObject({ error: "remote_timeout" });
    views.dashboardViewLimits.deadlineMs = 30_000;
    for (let i = 0; i < 9; i++) {
      const controller = new AbortController();
      const pending = app.request(`${NS}/${handle}/edit`, { method: "POST", headers: opaque(), body: JSON.stringify({ token: TOKEN }), signal: controller.signal });
      await vi.waitFor(() => expect(calls).toHaveLength(i + 2));
      controller.abort();
      expect((await pending).status).toBe(499);
    }
    handler = defaultHandler;
    expect((await post(handle, "edit", { token: TOKEN })).status).toBe(200);
  });

  it("counts writes in the per-gateway limit", async () => {
    const { handle } = await delivered();
    const held: http.ServerResponse[] = [];
    handler = (_request, response) => { held.push(response); };
    const pending = Array.from({ length: 8 }, () => post(handle, "edit", { token: TOKEN }));
    await vi.waitFor(() => expect(held).toHaveLength(8));
    const refused = await post(handle, "add", { token: TOKEN });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("access-control-allow-origin")).toBe("null");
    for (const response of held) sendJson(response, 200, { ok: true });
    for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
  });
});
