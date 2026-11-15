import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
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
let grants: typeof import("./dashboard-view-grants.js");
let views: typeof import("./dashboard-views.js");
let app: Hono;
const gatewayDir = fileURLToPath(new URL("../..", import.meta.url));
const storeModule = new URL("./store.ts", import.meta.url).href;
const defaultLimits = { htmlBytes: 5 * 1024 * 1024, editBytes: 256 * 1024, queryBytes: 8 * 1024, createBytes: 1024, capabilitiesBytes: 64 * 1024, deadlineMs: 30_000, concurrencyPerGateway: 8 };

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
  grants = await import("./dashboard-view-grants.js");
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
  app.use("/api/relay/*", views.dashboardViewHttp());
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
  grants.resetDashboardViewGrantsForTests();
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

async function create(body: unknown = { gateway: "ams", dashboardId: ID }, headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/api/relay/dashboard-views", { method: "POST", headers: createHeaders(headers), body: typeof body === "string" ? body : JSON.stringify(body) });
}

async function grant(gateway = "ams", dashboardId = ID): Promise<{ grant: string; frameUrl: string }> {
  const response = await create({ gateway, dashboardId });
  expect(response.status).toBe(201);
  const body = await response.json() as { frameUrl: string };
  return { grant: body.frameUrl.split("/")[4], frameUrl: body.frameUrl };
}

const pathFor = (grantId: string, id: string, suffix = "") => `/api/relay/dashboard-views/${grantId}/${id}/${suffix}`;
const view = (frameUrl: string, headers: Record<string, string> = navigation()) => app.request(frameUrl, { headers });

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

describe("view grants", () => {
  it("creates a 30-minute grant bound to the exact UI origin and makes no remote call", async () => {
    const before = Date.now();
    const response = await create();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = await response.json() as { frameUrl: string; expiresAt: string; gateway: string; dashboardId: string };
    expect(body.frameUrl).toMatch(new RegExp(`^/api/relay/dashboard-views/[A-Za-z0-9_-]{43}/${ID}/$`));
    expect(body).toMatchObject({ gateway: "ams", dashboardId: ID });
    expect(Date.parse(body.expiresAt) - before).toBeGreaterThanOrEqual(30 * 60 * 1000 - 50);
    expect(Date.parse(body.expiresAt) - before).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);
    expect(calls).toEqual([]);
    const other = await grant();
    expect(other.grant).not.toBe(body.frameUrl.split("/")[4]);
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
  ])("refuses a grant request with %s", async (_label, headers, status, error) => {
    const unset = Object.fromEntries(Object.entries(headers).filter(([, value]) => value === "").map(([key]) => [key, ""]));
    const response = await app.request("/api/relay/dashboard-views", {
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
    ["malformed JSON", "{not json", 400, "invalid_dashboard_view_request"],
  ])("refuses %s before any remote call", async (_label, body, status, error) => {
    const response = await create(body);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error });
    expect(calls).toEqual([]);
  });

  it("refuses an oversized grant request body", async () => {
    const response = await create(JSON.stringify({ gateway: "ams", dashboardId: ID, pad: "x".repeat(2000) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "request_too_large" });
  });

  it("refuses everything when the relay is not in a supported mode", async () => {
    const { frameUrl } = await grant();
    state.configureRelay("127.0.0.1", true);
    expect((await create()).status).toBe(403);
    const refused = await view(frameUrl);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "relay_unavailable" });
    expect(calls).toEqual([]);
    state.configureRelay("127.0.0.1", false);
  });

  it("caps active grants at 128 and accepts a new one when old ones expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 128; i++) expect((await create()).status).toBe(201);
    const refused = await create();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
    vi.setSystemTime(Date.now() + 30 * 60 * 1000 + 1000);
    expect((await create()).status).toBe(201);
  });

  it("expires a grant after 30 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { frameUrl } = await grant();
    vi.setSystemTime(Date.now() + 30 * 60 * 1000 - 1000);
    expect((await view(frameUrl)).status).toBe(200);
    vi.setSystemTime(Date.now() + 2000);
    const expired = await view(frameUrl);
    expect(expired.status).toBe(410);
    expect(await expired.json()).toEqual({ error: "dashboard_view_expired" });
  });

  it("stops a grant when its gateway is unlinked or relinked with another address or bearer", async () => {
    const first = await grant();
    const second = await grant();
    const third = await grant();
    const unaffected = await grant("other");
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: BEARER });
    expect((await view(first.frameUrl)).status).toBe(200);
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: "bearer-ams-rotated" });
    expect((await view(second.frameUrl)).status).toBe(410);
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: BEARER });
    // A grant that failed once stays gone, even after the original link returns.
    expect((await view(second.frameUrl)).status).toBe(410);
    state.getRemoteGatewayStore().remove("ams");
    expect((await view(third.frameUrl)).status).toBe(410);
    expect((await view(unaffected.frameUrl)).status).toBe(200);
  });

  it("stops a grant when another process removes the link and creates it again with equal values", async () => {
    const { frameUrl } = await grant();
    const unaffected = await grant("other");
    expect((await view(frameUrl)).status).toBe(200);
    calls = [];
    // No gateway check runs between the removal and the new link.
    inAnotherProcess(`store.remove("ams"); store.save({ name: "ams", url: ${JSON.stringify(remoteUrl)}, token: ${JSON.stringify(BEARER)} });`);
    const stopped = await view(frameUrl);
    expect(stopped.status).toBe(410);
    expect(await stopped.json()).toEqual({ error: "dashboard_view_expired" });
    expect(calls).toEqual([]);
    expect((await view(unaffected.frameUrl)).status).toBe(200);
    // The new link starts its own grants.
    calls = [];
    const fresh = await grant();
    expect((await view(fresh.frameUrl)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("stops a grant when another process changes the URL or the bearer, and keeps it for an equal save", async () => {
    const first = await grant();
    const second = await grant();
    inAnotherProcess(`store.save({ name: "ams", url: ${JSON.stringify(remoteUrl)}, token: ${JSON.stringify(BEARER)} });`);
    expect((await view(first.frameUrl)).status).toBe(200);
    inAnotherProcess(`store.save({ name: "ams", url: ${JSON.stringify(remoteUrl)}, token: "bearer-ams-rotated" });`);
    calls = [];
    expect((await view(first.frameUrl)).status).toBe(410);
    expect((await view(second.frameUrl)).status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("ends the old grant of an older link file with no generation when a new save starts the link again", async () => {
    await fs.writeFile(path.join(home, "remote-gateways.json"), `${JSON.stringify([{ name: "ams", url: remoteUrl, token: BEARER }])}\n`);
    const { frameUrl } = await grant();
    expect((await view(frameUrl)).status).toBe(200);
    expect(JSON.parse(await fs.readFile(path.join(home, "remote-gateways.json"), "utf8"))[0]).not.toHaveProperty("generation");
    state.getRemoteGatewayStore().save({ name: "ams", url: remoteUrl, token: BEARER });
    calls = [];
    expect((await view(frameUrl)).status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("forgets every grant on restart", async () => {
    const { frameUrl } = await grant();
    grants.resetDashboardViewGrantsForTests();
    expect((await view(frameUrl)).status).toBe(410);
  });

  it("lets one grant view other dashboards on its own gateway only, with a remote read check each time", async () => {
    const { grant: id } = await grant();
    const sibling = await view(pathFor(id, SIBLING));
    expect(sibling.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([`/d/${SIBLING}/embed`]);
    expect(calls[0].headers.authorization).toBe(`Bearer ${BEARER}`);
    const second = await view(pathFor(id, ID));
    expect(second.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("route ownership", () => {
  it.each([
    "/api/relay/dashboard-views/",
    "/api/relay/dashboard-views/x",
    `/api/relay/dashboard-views/${"G".repeat(43)}`,
    `/api/relay/dashboard-views/${"G".repeat(43)}/${ID}`,
    `/api/relay/dashboard-views/${"G".repeat(43)}/${ID}/edit/`,
    `/api/relay/dashboard-views/${"G".repeat(43)}/${ID}/other`,
    `/api/relay/dashboard-views/${"G".repeat(43)}/%2e%2e/${ID}/`,
    `/api/relay/dashboard-views/${"G".repeat(43)}/${ID.slice(0, 20)}%2F${ID.slice(21)}/`,
    `/api/relay/dashboard-views/${"G".repeat(43)}/abc-0123456789ab/`,
    `/api/relay/dashboard-views/${"G".repeat(42)}/${ID}/`,
    `/api/relay/dashboard-views%2F${"G".repeat(43)}/${ID}/`,
    `/api/relay/dashboard%2Dviews/${"G".repeat(43)}/${ID}/`,
    `/api/relay/dashboard-views/${"G".repeat(43)}/${ID}/edit%2Fx`,
    `/api/relay/dashboard-views/%47${"G".repeat(42)}/${ID}/`,
    "/api/relay/dashboard-viewsX",
  ])("answers a malformed owned path %s locally, with no remote call and no fallthrough", async (pathname) => {
    for (const method of ["GET", "POST"]) {
      const response = await app.request(pathname, { method, headers: { ...navigation(), ...opaque() }, body: method === "POST" ? "{}" : undefined });
      expect(response.status).not.toBe(299);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "invalid_dashboard_view_route" });
    }
    expect(calls).toEqual([]);
  });

  it("answers an owned path with a wrong method with 405 and the allowed method", async () => {
    const { grant: id } = await grant();
    for (const [pathname, method, allow] of [
      ["/api/relay/dashboard-views", "GET", "POST"],
      [pathFor(id, ID), "POST", "GET"],
      [pathFor(id, ID), "PUT", "GET"],
      [pathFor(id, ID), "HEAD", "GET"],
      [pathFor(id, ID, "edit"), "GET", "POST"],
      [pathFor(id, ID, "add"), "DELETE", "POST"],
      [`/api/relay/dashboard-views/${id}/current`, "POST", "GET"],
      [pathFor(id, ID), "OPTIONS", "GET"],
    ] as const) {
      const response = await app.request(pathname, { method, headers: opaque() });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allow);
      expect(response.headers.get("location")).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("leaves other relay paths to later handlers", async () => {
    const response = await app.request("/api/relay/gateways/ams/api/agents");
    expect(response.status).toBe(299);
  });
});

describe("viewer GET", () => {
  it("sends the linked bearer only on this call and nothing that identifies the browser", async () => {
    const { frameUrl } = await grant();
    const response = await view(`${frameUrl}?region=emea&__yoplai_pad=1&q=a+b`, navigation({
      cookie: "session=local-session; yoplai-theme=dark",
      authorization: "Bearer local-browser-credential",
      referer: `${UI}/remote-dashboards/ams/${ID}`,
      origin: UI,
      "x-forwarded-for": "127.0.0.1",
      "x-yoplai-user-id": "local-admin",
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Remote page");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`/d/${ID}/embed?region=emea&q=a+b`);
    expect(call.headers.authorization).toBe(`Bearer ${BEARER}`);
    expect(call.headers.accept).toBe("text/html");
    expect(call.headers[DASHBOARD_EMBED_HEADERS.theme.toLowerCase()]).toBe("dark");
    for (const name of ["cookie", "origin", "referer", "x-forwarded-for", "x-yoplai-user-id", "forwarded", "proxy-authorization"]) expect(call.headers[name]).toBeUndefined();
    expect(JSON.stringify(call.headers)).not.toContain("local-browser-credential");
  });

  it("returns the page under the viewer policy, with exact CSP and sandbox and without remote headers", async () => {
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
    const { grant: id, frameUrl } = await grant();
    const response = await view(frameUrl);
    expect(response.status).toBe(200);
    const viewer = `/api/relay/dashboard-views/${id}/${ID}`;
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

  it("requires a document or iframe navigation", async () => {
    const { frameUrl } = await grant();
    const destinations: Array<Record<string, string>> = [{}, { "sec-fetch-dest": "empty" }, { "sec-fetch-dest": "script" }, { "sec-fetch-dest": "image" }, { "sec-fetch-dest": "frame" }, { "sec-fetch-dest": "embed" }];
    for (const headers of destinations) {
      const response = await view(frameUrl, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "navigation_required" });
    }
    expect(calls).toEqual([]);
    expect((await view(frameUrl, { "sec-fetch-dest": "document" })).status).toBe(200);
    // A frame navigation that the opaque frame starts has a cross-site context, and it works with the grant.
    expect((await view(frameUrl, { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" })).status).toBe(200);
  });

  it("refuses an unknown grant with no remote call", async () => {
    const response = await view(pathFor("U".repeat(43), ID));
    expect(response.status).toBe(410);
    expect(calls).toEqual([]);
  });

  it("refuses a request from an external client before the grant is read", async () => {
    const { frameUrl } = await grant();
    const response = await view(frameUrl, navigation({ "x-forwarded-for": "203.0.113.9" }));
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("passes a light theme cookie as a checked value and ignores an invalid one", async () => {
    const { frameUrl } = await grant();
    await view(frameUrl, navigation({ cookie: "yoplai-theme=light" }));
    await view(frameUrl, navigation({ cookie: "yoplai-theme=%3Cscript%3E" }));
    expect(calls[0].headers[DASHBOARD_EMBED_HEADERS.theme.toLowerCase()]).toBe("light");
    expect(calls[1].headers[DASHBOARD_EMBED_HEADERS.theme.toLowerCase()]).toBeUndefined();
  });

  it("bounds the query to 8 KiB after it removes transport-only fields", async () => {
    const { frameUrl } = await grant();
    const refused = await view(`${frameUrl}?pad=${"x".repeat(8200)}`);
    expect(refused.status).toBe(414);
    expect(await refused.json()).toEqual({ error: "query_too_large" });
    expect(calls).toEqual([]);
    const accepted = await view(`${frameUrl}?__yoplai_pad=${"x".repeat(9000)}&keep=1`);
    expect(accepted.status).toBe(200);
    expect(calls[0].url).toBe(`/d/${ID}/embed?keep=1`);
  });
});

describe("viewer GET: remote results", () => {
  const expectError = async (frameUrl: string, status: number, error: string, extra: Record<string, unknown> = {}) => {
    const response = await view(frameUrl);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await expectNoSecrets(response, frameUrl.split("/")[4]);
    expect(JSON.parse(text)).toMatchObject({ error, ...extra });
    return response;
  };

  it("maps a remote 401 and a login redirect to unauthorized without a second request", async () => {
    const { frameUrl } = await grant();
    handler = (_request, response) => sendJson(response, 401, { error: "unauthorized" }, embedMarker);
    await expectError(frameUrl, 401, "remote_unauthorized");
    calls = [];
    handler = (_request, response) => {
      response.writeHead(302, { location: "/login?returnTo=%2Fd%2Fx", "set-cookie": "a=b" });
      response.end("<h1>login</h1>");
    };
    const redirected = await expectError(frameUrl, 401, "remote_unauthorized");
    expect(redirected.headers.get("location")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("refuses another redirect as an invalid remote response and never follows it", async () => {
    const { frameUrl } = await grant();
    handler = (_request, response) => {
      response.writeHead(302, { location: "https://evil.example.test/steal" });
      response.end();
    };
    const result = await expectError(frameUrl, 502, "invalid_remote_response");
    expect(result.headers.get("location")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("returns a bounded 403 and never remote HTML", async () => {
    const { frameUrl } = await grant();
    handler = (_request, response) => sendJson(response, 403, { error: "forbidden", ownerName: "Alice Martin" }, embedMarker);
    await expectError(frameUrl, 403, "forbidden", { ownerName: "Alice Martin" });
    handler = (_request, response) => {
      response.writeHead(403, { "content-type": "text/html" });
      response.end("<script>alert(1)</script><h1>Not shared</h1>");
    };
    const unmarked = await view(frameUrl);
    expect(unmarked.status).toBe(403);
    expect(await unmarked.text()).not.toContain("<script>");
  });

  it("tells a missing dashboard, a disabled Canvas and an old remote apart", async () => {
    const { frameUrl } = await grant();
    const marker = embedMarker;
    handler = (_request, response) => sendJson(response, 404, { error: "not_found" }, marker);
    await expectError(frameUrl, 404, "not_found");
    expect(calls).toHaveLength(1);
    handler = (_request, response) => sendJson(response, 404, { error: "not_found" }, { ...marker, [DASHBOARD_EMBED_HEADERS.reason]: "canvas_disabled" });
    await expectError(frameUrl, 404, "canvas_disabled");
    // An unmarked 404 is not proof of an old remote. The remote capabilities decide.
    calls = [];
    handler = (request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 200, { version: 2, extensions: {}, agents: [] });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(frameUrl, 409, "remote_update_required", { reason: "missing_capability" });
    expect(calls.map((call) => call.url)).toEqual([`/d/${ID}/embed`, "/api/capabilities"]);
    expect(calls[1].headers.authorization).toBe(`Bearer ${BEARER}`);
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 200, { version: 2, dashboardEmbed: { version: 1, assetVersion: "v3", policyVersion: 1, enabled: true } });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(frameUrl, 404, "not_found");
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 401, { error: "unauthorized" });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(frameUrl, 401, "remote_unauthorized");
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return sendJson(response, 403, { error: "forbidden" });
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(frameUrl, 403, "forbidden");
    handler = (_request, response, call) => {
      if (call.url === "/api/capabilities") return void response.end("<html>proxy</html>");
      sendJson(response, 404, { error: "not_found" });
    };
    await expectError(frameUrl, 502, "invalid_remote_response");
  });

  it.each<[string, Record<string, string>, string]>([
    ["no marker on a page", { [DASHBOARD_EMBED_HEADERS.version]: "" }, "missing_embed_marker"],
    ["a newer embed version", { [DASHBOARD_EMBED_HEADERS.version]: "2" }, "embed_version"],
    ["an unsupported asset version", { [DASHBOARD_EMBED_HEADERS.assets]: "v9" }, "asset_version"],
    ["no asset version", { [DASHBOARD_EMBED_HEADERS.assets]: "" }, "asset_version"],
    ["a different security policy version", { [DASHBOARD_EMBED_HEADERS.policy]: "2" }, "policy_version"],
  ])("asks for an update when the remote sends %s", async (_label, change, reason) => {
    const { frameUrl } = await grant();
    handler = (_request, response) => {
      const headers = { ...embedHeaders(ID), ...change };
      for (const [name, value] of Object.entries(headers)) if (value === "") delete headers[name];
      response.writeHead(200, headers);
      response.end("<h1>Remote page</h1>");
    };
    await expectError(frameUrl, 409, "remote_update_required", { reason });
  });

  it("refuses invalid metadata, a metadata ID that differs from the request, and a non-HTML page", async () => {
    const { frameUrl } = await grant();
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
      await expectError(frameUrl, 502, "invalid_remote_response");
    }
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID, { "content-type": "application/json" }));
      response.end("{}");
    };
    await expectError(frameUrl, 502, "invalid_remote_response");
    handler = (_request, response) => sendJson(response, 500, { error: "boom" });
    await expectError(frameUrl, 502, "invalid_remote_response", { remoteStatus: 500 });
  });

  it("reports an offline remote", async () => {
    const { frameUrl } = await grant();
    state.getRemoteGatewayStore().save({ name: "ams", url: "http://127.0.0.1:1", token: BEARER });
    // The link changed, so the old grant stops. A fresh grant meets the offline remote.
    expect((await view(frameUrl)).status).toBe(410);
    const fresh = await grant();
    await expectError(fresh.frameUrl, 502, "gateway_offline", { gateway: "ams" });
  });

  it("records the latest view for the trusted host, with checked metadata and no edit token", async () => {
    const { grant: id, frameUrl } = await grant();
    const current = `/api/relay/dashboard-views/${id}/current`;
    const empty = await app.request(current, { headers: { "sec-fetch-site": "same-origin" } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ view: null });
    handler = (_request, response) => sendHtml(response, ID, `<h1>Page</h1><script>var r={"editToken":"${TOKEN}"}</script>`);
    expect((await view(frameUrl)).status).toBe(200);
    const ok = await app.request(current, { headers: { "sec-fetch-site": "same-origin", origin: UI } });
    const text = await ok.text();
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text).view).toEqual({ seq: 1, dashboardId: ID, ok: true, meta: metaFor(ID) });
    handler = (_request, response) => sendJson(response, 404, { error: "not_found" }, embedMarker);
    await view(pathFor(id, SIBLING));
    const failed = await (await app.request(current, { headers: { "sec-fetch-site": "same-origin" } })).json() as { view: object };
    expect(failed.view).toEqual({ seq: 2, dashboardId: SIBLING, ok: false, error: "not_found", status: 404 });
  });

  it("gives the host record only to a same-origin fetch from the grant's own origin", async () => {
    const { grant: id } = await grant();
    const current = `/api/relay/dashboard-views/${id}/current`;
    const contexts: Array<Record<string, string>> = [{}, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-origin", origin: "null" }, { "sec-fetch-site": "same-origin", origin: "http://localhost:3000" }];
    for (const headers of contexts) {
      expect((await app.request(current, { headers })).status).toBe(403);
    }
    expect((await app.request(`/api/relay/dashboard-views/${"Q".repeat(43)}/current`, { headers: { "sec-fetch-site": "same-origin" } })).status).toBe(410);
  });
});

describe("viewer GET: bounds", () => {
  it("refuses a page that declares more than 5 MiB and a page that streams more, and cancels the body", async () => {
    expect(views.dashboardViewLimits.htmlBytes).toBe(5 * 1024 * 1024);
    const { frameUrl } = await grant();
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID, { "content-length": String(5 * 1024 * 1024 + 1) }));
      response.write("x");
    };
    const declared = await view(frameUrl);
    expect(declared.status).toBe(502);
    expect(await declared.json()).toEqual({ error: "remote_response_too_large" });
    await vi.waitFor(() => expect(closed).toBe(1));
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID));
      const chunk = Buffer.alloc(256 * 1024, "x");
      for (let i = 0; i < 21; i++) response.write(chunk);
      response.end();
    };
    const streamed = await view(frameUrl);
    expect(streamed.status).toBe(502);
    expect(await streamed.json()).toEqual({ error: "remote_response_too_large" });
    handler = (_request, response) => sendHtml(response, ID, "x".repeat(5 * 1024 * 1024 - 100));
    expect((await view(frameUrl)).status).toBe(200);
  });

  it("times out stalled headers and a stalled body, and closes the remote connection", async () => {
    views.dashboardViewLimits.deadlineMs = 150;
    const { frameUrl } = await grant();
    handler = () => undefined;
    const headers = await view(frameUrl);
    expect(headers.status).toBe(504);
    expect(await headers.json()).toMatchObject({ error: "remote_timeout" });
    await vi.waitFor(() => expect(closed).toBe(1));
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID));
      response.write("<h1>Partial");
    };
    const body = await view(frameUrl);
    expect(body.status).toBe(504);
    expect(await body.json()).toMatchObject({ error: "remote_timeout" });
    await vi.waitFor(() => expect(closed).toBe(2));
  });

  it("aborts the remote call when the browser disconnects and frees the slot", async () => {
    const { frameUrl } = await grant();
    handler = (_request, response) => {
      response.writeHead(200, embedHeaders(ID));
      response.write("<h1>Partial");
    };
    for (let i = 0; i < 10; i++) {
      const controller = new AbortController();
      const pending = app.request(frameUrl, { headers: navigation(), signal: controller.signal });
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1));
      controller.abort();
      expect((await pending).status).toBe(499);
      await vi.waitFor(() => expect(closed).toBe(i + 1));
    }
    handler = defaultHandler;
    expect((await view(frameUrl)).status).toBe(200);
  });

  it("limits each gateway to eight active calls, and the limit does not touch another gateway", async () => {
    const { frameUrl } = await grant();
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
    const pending = Array.from({ length: 8 }, () => view(frameUrl));
    await vi.waitFor(() => expect(held).toHaveLength(8));
    const refused = await view(frameUrl);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("1");
    expect(await refused.json()).toEqual({ error: "too_many_dashboard_view_requests" });
    expect(calls).toHaveLength(8);
    const other = await grant("other");
    expect((await view(other.frameUrl)).status).toBe(200);
    for (const response of held) response.end("</h1>");
    for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
    handler = defaultHandler;
    expect((await view(frameUrl)).status).toBe(200);
  });
});

describe("edit and add", () => {
  const post = (frameUrl: string, op: "edit" | "add", body: unknown, headers: Record<string, string> = opaque()) =>
    app.request(`${frameUrl}${op}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

  it.each(["edit", "add"] as const)("forwards a token-authenticated %s without the bearer or any browser identity", async (op) => {
    const { grant: id, frameUrl } = await grant();
    const before = await localTree();
    const raw = `{"token":"${TOKEN}","edit":"actions",  "key":7,"field":"done","value":true}`;
    handler = (_request, response) => sendJson(response, 200, { ok: true, value: true, at: "2026-01-01T00:00:00Z" });
    const response = await post(frameUrl, op, raw, opaque({ cookie: "session=local", authorization: "Bearer browser", referer: UI }));
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("null");
    expect(response.headers.get("vary")).toBe("Origin");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect([call.method, call.url, call.body]).toEqual(["POST", `/d/${ID}/${op}`, raw]);
    for (const name of ["authorization", "cookie", "origin", "referer", "proxy-authorization", "x-forwarded-for"]) expect(call.headers[name]).toBeUndefined();
    expect(call.headers["content-type"]).toBe("text/plain;charset=UTF-8");
    expect(JSON.parse(await expectNoSecrets(response, id))).toEqual({ ok: true, value: true, at: "2026-01-01T00:00:00Z" });
    expect(await localTree()).toEqual(before);
  });

  it("passes remote refusals with their status, and the opaque page can read them", async () => {
    const { frameUrl } = await grant();
    for (const [status, body] of [[400, { ok: false, error: "Invalid request" }], [401, { ok: false, error: "Reload to keep editing" }], [403, { ok: false, error: "You can only view this dashboard" }], [404, { ok: false, error: "Not found" }], [503, { ok: false, error: "Busy" }]] as const) {
      handler = (_request, response) => sendJson(response, status, body);
      const response = await post(frameUrl, "edit", { token: TOKEN });
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get("access-control-allow-origin")).toBe("null");
    }
  });

  it("gives a grant no write authority without a valid edit token", async () => {
    const { frameUrl } = await grant();
    for (const body of ["{}", '{"token":""}', '{"token":5}', "[]", "not json", ""]) {
      const response = await post(frameUrl, "edit", body);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_edit_request" });
    }
    expect(calls).toEqual([]);
  });

  it("requires Origin null and text/plain", async () => {
    const { frameUrl } = await grant();
    const body = JSON.stringify({ token: TOKEN });
    for (const headers of [{ "content-type": "text/plain" } as Record<string, string>, { origin: UI, "content-type": "text/plain" }, { origin: "https://evil.example.test", "content-type": "text/plain" }]) {
      const response = await post(frameUrl, "edit", body, headers);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const type of ["application/json", "multipart/form-data", "application/x-www-form-urlencoded", ""]) {
      const response = await post(frameUrl, "edit", body, opaque({ "content-type": type }));
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: "text_plain_required" });
    }
    expect(calls).toEqual([]);
  });

  it("refuses an unknown grant, a request from an external client and a disabled relay without a remote call", async () => {
    const { frameUrl } = await grant();
    const unknown = await post(pathFor("U".repeat(43), ID), "edit", { token: TOKEN });
    expect(unknown.status).toBe(410);
    expect(unknown.headers.get("access-control-allow-origin")).toBe("null");
    expect((await post(frameUrl, "edit", { token: TOKEN }, opaque({ "x-forwarded-for": "203.0.113.9" }))).status).toBe(403);
    state.configureRelay("127.0.0.1", true);
    expect((await post(frameUrl, "edit", { token: TOKEN })).status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses a request over 256 KiB before it reads the whole body or calls the remote", async () => {
    const { frameUrl } = await grant();
    const big = JSON.stringify({ token: TOKEN, value: "x".repeat(256 * 1024) });
    const declared = await post(frameUrl, "edit", big, opaque({ "content-length": String(big.length) }));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: "request_too_large" });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024))); },
    });
    const streamed = await app.request(`${frameUrl}edit`, { method: "POST", headers: opaque(), body: stream, duplex: "half" } as RequestInit);
    expect(streamed.status).toBe(413);
    expect(calls).toEqual([]);
    const justUnder = JSON.stringify({ token: TOKEN, value: "x".repeat(256 * 1024 - 200) });
    expect((await post(frameUrl, "edit", justUnder)).status).toBe(200);
  });

  it("refuses a redirect, an HTML answer, a non-object answer and an oversized answer from the remote", async () => {
    const { frameUrl } = await grant();
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
      const response = await post(frameUrl, "edit", { token: TOKEN });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error });
      expect(response.headers.get("location")).toBeNull();
    }
    expect(calls).toHaveLength(reasons.length);
  });

  it("times out a stalled write and frees the slot after a disconnect", async () => {
    views.dashboardViewLimits.deadlineMs = 150;
    const { frameUrl } = await grant();
    handler = () => undefined;
    const stalled = await post(frameUrl, "edit", { token: TOKEN });
    expect(stalled.status).toBe(504);
    expect(await stalled.json()).toMatchObject({ error: "remote_timeout" });
    views.dashboardViewLimits.deadlineMs = 30_000;
    for (let i = 0; i < 9; i++) {
      const controller = new AbortController();
      const pending = app.request(`${frameUrl}edit`, { method: "POST", headers: opaque(), body: JSON.stringify({ token: TOKEN }), signal: controller.signal });
      await vi.waitFor(() => expect(calls).toHaveLength(i + 2));
      controller.abort();
      expect((await pending).status).toBe(499);
    }
    handler = defaultHandler;
    expect((await post(frameUrl, "edit", { token: TOKEN })).status).toBe(200);
  });

  it("counts writes in the per-gateway limit", async () => {
    const { frameUrl } = await grant();
    const held: http.ServerResponse[] = [];
    handler = (_request, response) => { held.push(response); };
    const pending = Array.from({ length: 8 }, () => post(frameUrl, "edit", { token: TOKEN }));
    await vi.waitFor(() => expect(held).toHaveLength(8));
    const refused = await post(frameUrl, "add", { token: TOKEN });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("access-control-allow-origin")).toBe("null");
    for (const response of held) sendJson(response, 200, { ok: true });
    for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
  });
});
