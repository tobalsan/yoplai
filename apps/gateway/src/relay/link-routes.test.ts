import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayLinkService } from "./link.js";
import { relayLinkApi } from "./link-routes.js";
import { configureRelay, getLinkCallbackPort, isLoopbackAddress, isLoopbackForwardedFor, setGatewayListener } from "./state.js";
import { createFileRemoteGatewayStore, type RemoteGatewayStore } from "./store.js";

/** The remote is a scripted fake. Every key and code is synthetic. */
const REMOTE = "https://remote.example.test";
const PORT = 4010;
const GATEWAY_ORIGIN = `http://127.0.0.1:${PORT}`;
const UI_ORIGIN = "http://localhost:3000";
const KEY = "synthetic-route-key-not-real";

type Env = { incoming: { socket: { remoteAddress: string } } };
const peerEnv = (remoteAddress = "127.0.0.1"): Env => ({ incoming: { socket: { remoteAddress } } });

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let dir: string;
let store: RemoteGatewayStore;
let remoteCalls: string[];
let enabled: boolean;
let listener: { address: string; port: number } | undefined;
let app: Hono;
let remoteTokenAnswer: () => Response;
let capturedState = "";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-link-routes-"));
  store = createFileRemoteGatewayStore(path.join(dir, "remote-gateways.json"));
  remoteCalls = [];
  enabled = true;
  listener = { address: "127.0.0.1", port: PORT };
  remoteTokenAnswer = () =>
    jsonResponse(200, {
      key: KEY,
      link: { id: "link-1", deviceLabel: "Laptop", status: "active", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-04-01T00:00:00.000Z", revokedAt: null, account: { email: "user@example.test", name: null } },
    });
  const service = new RelayLinkService({
    store: () => store,
    now: Date.now,
    callbackPort: () => (enabled && listener?.address === "127.0.0.1" ? listener.port : undefined),
    deviceLabel: () => "Laptop",
    connections: () => [],
    fetch: async (input, init) => {
      const url = new URL(String(input));
      remoteCalls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/capabilities") return jsonResponse(200, { version: 2, extensions: {}, agents: [], multiUser: true, gatewayLink: { version: 1, method: "loopback-pkce" } });
      if (url.pathname === "/api/auth/gateway-link/requests") {
        capturedState = (JSON.parse(String(init?.body)) as { state: string }).state;
        return jsonResponse(201, { requestId: "req-1", expiresAt: new Date(Date.now() + 300_000).toISOString() });
      }
      if (url.pathname === "/api/auth/gateway-link/token") return remoteTokenAnswer();
      if (url.pathname === "/api/auth/gateway-link/revoke") return jsonResponse(200, {});
      throw new Error(`unexpected ${url.pathname}`);
    },
  });
  app = new Hono();
  app.use(
    "*",
    relayLinkApi({
      service: () => service,
      isEnabled: () => enabled,
      listener: () => listener,
      configuredOrigins: () => [UI_ORIGIN, "http://127.0.0.1:3000", GATEWAY_ORIGIN, `http://localhost:${PORT}`, "https://yoplai.example.test"],
      peerAddress: (c) => (c.env as Env | undefined)?.incoming?.socket?.remoteAddress,
    })
  );
  app.all("*", (c) => c.text("next"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setGatewayListener(undefined);
  configureRelay("127.0.0.1", true);
  vi.restoreAllMocks();
});

type Init = { method?: string; origin?: string | null; host?: string; headers?: Record<string, string>; body?: unknown; raw?: string; env?: Env };

function call(route: string, init: Init = {}) {
  const headers: Record<string, string> = { host: init.host ?? `127.0.0.1:${PORT}`, ...(init.headers ?? {}) };
  if (init.origin) headers.origin = init.origin;
  const hasBody = init.body !== undefined || init.raw !== undefined;
  if (hasBody) headers["content-type"] ??= "application/json";
  return app.request(`http://127.0.0.1:${PORT}${route}`, { method: init.method ?? (hasBody ? "POST" : "GET"), headers, body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)) }, init.env ?? peerEnv());
}

async function startAttempt(init: Init = {}) {
  const response = await call("/api/relay/link/start", { origin: UI_ORIGIN, body: { remote: REMOTE, name: "work" }, ...init });
  expect(response.status).toBe(201);
  const attempt = (await response.json()) as { attemptId: string; controlToken: string; consentUrl: string };
  return attempt;
}

/** The state that the fake remote saw. The attempt response never holds it, so the test reads it from the request body. */
async function startWithState() {
  const attempt = await startAttempt();
  return { attempt, state: capturedState };
}

const complete = (body: unknown, init: Init = {}) =>
  call("/api/relay/link/complete", { origin: GATEWAY_ORIGIN, body, ...init });

describe("loopback address checks", () => {
  it.each(["::ffff:::1", "::ffff:", "127.0.0.256", "localhost", "unknown", "203.0.113.9"])("refuses %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(false);
    expect(isLoopbackForwardedFor(address)).toBe(false);
  });

  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"])("accepts %s", (address) => {
    expect(isLoopbackAddress(address)).toBe(true);
    expect(isLoopbackForwardedFor(address)).toBe(true);
  });

  it.each([undefined, null, "", "127.0.0.1, ::1, ::ffff:127.0.0.2"])("accepts a forwarded value of %s", (value) => {
    expect(isLoopbackForwardedFor(value)).toBe(true);
  });

  it.each(["[::1]:1234", "127.0.0.1, 203.0.113.9"])("refuses a forwarded value of %s", (value) => {
    expect(isLoopbackForwardedFor(value)).toBe(false);
  });
});

describe("route policy", () => {
  it.each([
    ["forwarded", 'for="[::1]:443", proto=http'],
    ["forwarded", "for=127.0.0.1;by=192.0.2.1"],
    ["forwarded", "for=127.0.0.1;broken"],
    ["x-forwarded-for", "[::1]junk"],
    ["x-real-ip", "127.0.0.1:65536"],
  ])("rejects malformed or nonlocal forwarding: %s: %s", async (name, value) => {
    const response = await call("/api/relay/link/callback", { headers: { [name]: value } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "untrusted_peer" });
  });
  it("answers 403 while the relay is off", async () => {
    enabled = false;
    expect((await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {} })).status).toBe(403);
    expect((await call("/api/relay/link/callback")).status).toBe(403);
  });

  it.each(["192.0.2.7", "::ffff:192.0.2.7", "2001:db8::1", "::ffff:", "127.0.0.256"])("refuses a socket peer of %s", async (peer) => {
    const response = await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {}, env: peerEnv(peer) });
    expect(response.status).toBe(403);
  });

  it.each(["127.0.0.1", "127.0.0.9", "::1", "::ffff:127.0.0.1"])("accepts a socket peer of %s", async (peer) => {
    expect((await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {}, env: peerEnv(peer) })).status).toBe(200);
  });

  it("refuses a request with no socket peer, whatever the headers say", async () => {
    const response = await app.request(`http://127.0.0.1:${PORT}/api/relay/link/metadata`, { method: "POST", headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json", "x-forwarded-for": "127.0.0.1" }, body: "{}" });
    expect(response.status).toBe(403);
  });

  it.each([
    ["x-forwarded-for", "203.0.113.9"],
    ["x-forwarded-for", "127.0.0.1, 203.0.113.9"],
    ["x-real-ip", "203.0.113.9"],
    ["forwarded", "for=203.0.113.9;proto=https"],
    ["forwarded", 'for="[2001:db8::1]:4711"'],
    ["x-forwarded-for", "unknown"],
    ["x-forwarded-for", "localhost"],
    ["x-forwarded-for", "127.0.0.256"],
    ["x-forwarded-for", ""],
    ["x-real-ip", "::ffff:"],
  ])("refuses %s with value %j", async (header, value) => {
    const response = await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {}, headers: { [header]: value } });
    expect(response.status).toBe(403);
  });

  it.each([
    ["x-forwarded-for", "127.0.0.1"],
    ["x-forwarded-for", "::1"],
    ["x-forwarded-for", "::ffff:127.0.0.1"],
    ["x-forwarded-for", "[::1]:1234"],
    ["x-forwarded-for", "127.0.0.1, ::1, ::ffff:127.0.0.2"],
    ["x-real-ip", "127.0.0.1:1234"],
    ["forwarded", 'for="[::1]:1234";proto=https'],
  ])("accepts %s with value %j", async (header, value) => {
    const response = await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {}, headers: { [header]: value } });
    expect(response.status).toBe(200);
  });

  it.each(["evil.example.test:4010", "127.0.0.1:9999", "127.0.0.1", "127.0.0.1:4010, evil.example.test", "0.0.0.0:4010"])("refuses the Host %s", async (host) => {
    expect((await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {}, host })).status).toBe(403);
  });

  it.each(["localhost:4010", "[::1]:4010", "127.0.0.1:4010"])("accepts the Host %s", async (host) => {
    expect((await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {}, host })).status).toBe(200);
  });

  it("owns every spelling of its namespace and never falls through", async () => {
    for (const route of ["/api/relay/link/unknown", "/api/relay/link", "/API/Relay/Link/start", "/api/relay/link%2Fstart", "/api/relay/link%252Fmetadata", "/api/relay/link/start/", "/api/relay/link/status"]) {
      const response = await call(route, { origin: UI_ORIGIN, body: {} });
      expect(await response.text(), route).not.toBe("next");
      expect(response.status, route).toBeGreaterThanOrEqual(400);
    }
    expect(await (await call("/api/relay/linked")).text()).toBe("next");
  });

  it("refuses a query string on every route", async () => {
    expect((await call("/api/relay/link/metadata?x=1", { origin: UI_ORIGIN, body: {} })).status).toBe(404);
    expect((await call("/api/relay/link/callback?code=abc")).status).toBe(404);
  });
});

describe("origin rules", () => {
  it("lets a UI origin and an originless CLI start, and refuses another site", async () => {
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, body: { remote: REMOTE, name: "a" } })).status).toBe(201);
    expect((await call("/api/relay/link/start", { body: { remote: REMOTE, name: "b" } })).status).toBe(201);
    expect((await call("/api/relay/link/start", { origin: "https://evil.example.test", body: { remote: REMOTE, name: "c" } })).status).toBe(403);
    expect((await call("/api/relay/link/start", { origin: "null", body: { remote: REMOTE, name: "d" } })).status).toBe(403);
  });

  it.each(["start", "cancel", "metadata", "disconnect"])("never lets the callback origin call %s", async (route) => {
    const body = route === "start" ? { remote: REMOTE, name: "a" } : route === "cancel" ? { attemptId: "A".repeat(43) } : route === "disconnect" ? { name: "a" } : {};
    for (const origin of [GATEWAY_ORIGIN, `http://localhost:${PORT}`]) {
      const response = await call(`/api/relay/link/${route}`, { origin, body, headers: { "x-link-control": "A".repeat(43) } });
      expect(response.status, `${route} ${origin}`).toBe(403);
    }
    expect(remoteCalls).toEqual([]);
  });

  it("never lets the callback origin read a status", async () => {
    const attempt = await startAttempt();
    const response = await call(`/api/relay/link/status/${attempt.attemptId}`, { origin: GATEWAY_ORIGIN, headers: { "x-link-control": attempt.controlToken } });
    expect(response.status).toBe(403);
  });

  it("answers CORS for a UI origin only", async () => {
    const allowed = await call("/api/relay/link/start", { method: "OPTIONS", origin: UI_ORIGIN });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(UI_ORIGIN);
    expect(allowed.headers.get("access-control-allow-headers")).toContain("x-link-control");
    expect((await call("/api/relay/link/start", { method: "OPTIONS", origin: GATEWAY_ORIGIN })).status).toBe(403);
    expect((await call("/api/relay/link/start", { method: "OPTIONS", origin: "https://evil.example.test" })).status).toBe(403);
    const answer = await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {} });
    expect(answer.headers.get("access-control-allow-origin")).toBe(UI_ORIGIN);
    expect(answer.headers.get("cache-control")).toBe("no-store");
  });
});

describe("body rules", () => {
  it("needs a JSON body of at most four KiB with one value for each field", async () => {
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, headers: { "content-type": "text/plain" }, body: { remote: REMOTE } })).status).toBe(415);
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, raw: JSON.stringify({ remote: REMOTE, name: "x".repeat(5000) }) })).status).toBe(413);
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, raw: `{"remote":"${REMOTE}","remote":"${REMOTE}"}` })).status).toBe(400);
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, raw: "not json" })).status).toBe(400);
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, raw: "[]" })).status).toBe(400);
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, body: { remote: REMOTE, callback: "http://evil.example.test" } })).status).toBe(400);
    expect((await call("/api/relay/link/start", { origin: UI_ORIGIN, body: { remote: 5 } })).status).toBe(400);
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a callback host that the browser supplies", async () => {
    const response = await call("/api/relay/link/start", { origin: UI_ORIGIN, body: { remote: REMOTE, callbackUri: "http://127.0.0.1:1/api/relay/link/callback" } });
    expect(response.status).toBe(400);
  });
});

describe("browser link over HTTP", () => {
  it("starts, completes through the callback origin, and reports a linked attempt without a secret", async () => {
    const { attempt, state } = await startWithState();
    expect(attempt.consentUrl).toBe(`${REMOTE}/gateway-link?request=req-1`);
    const done = await complete({ code: "code-1", state });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ status: "linked" });
    const status = await call(`/api/relay/link/status/${attempt.attemptId}`, { origin: UI_ORIGIN, headers: { "x-link-control": attempt.controlToken } });
    const text = await status.text();
    expect(JSON.parse(text)).toMatchObject({ status: "linked", name: "work" });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(state);
    expect(store.list()[0].token).toBe(KEY);
    const metadata = await call("/api/relay/link/metadata", { origin: UI_ORIGIN, body: {} });
    const rows = await metadata.text();
    expect(JSON.parse(rows).gateways[0]).toMatchObject({ name: "work", account: "user@example.test", linkId: "link-1" });
    expect(rows).not.toContain(KEY);
  });

  it("reaches denied when the remote reports a refusal", async () => {
    const { attempt, state } = await startWithState();
    expect(await (await complete({ error: "access_denied", state })).json()).toEqual({ status: "denied", message: expect.any(String) });
    const status = await call(`/api/relay/link/status/${attempt.attemptId}`, { origin: UI_ORIGIN, headers: { "x-link-control": attempt.controlToken } });
    expect(await status.json()).toMatchObject({ status: "denied" });
    expect(store.list()).toEqual([]);
  });

  it("completes only from the callback origin on the literal callback host", async () => {
    const { state } = await startWithState();
    expect((await complete({ code: "code-1", state }, { origin: UI_ORIGIN })).status).toBe(403);
    expect((await complete({ code: "code-1", state }, { origin: undefined, headers: {} })).status).toBe(403);
    expect((await complete({ code: "code-1", state }, { origin: `http://localhost:${PORT}`, host: `localhost:${PORT}` })).status).toBe(403);
    expect((await complete({ code: "code-1", state }, { origin: "https://evil.example.test" })).status).toBe(403);
    expect((await complete({ code: "code-1", state }, { origin: GATEWAY_ORIGIN, host: `localhost:${PORT}` })).status).toBe(403);
    expect(store.list()).toEqual([]);
  });

  it("accepts exactly one outcome and no repeated or unknown field", async () => {
    const { state } = await startWithState();
    expect((await complete({ code: "code-1", error: "access_denied", state })).status).toBe(400);
    expect((await complete({ error: "server_error", state })).status).toBe(400);
    expect((await complete({ state })).status).toBe(400);
    expect((await complete({ code: "", state })).status).toBe(400);
    expect((await complete({ code: "code-1", state, extra: 1 })).status).toBe(400);
    expect((await complete({ code: "code-1", state: "short" })).status).toBe(400);
    expect((await complete(undefined, { raw: `{"code":"a","code":"b","state":"${state}"}` })).status).toBe(400);
    expect(store.list()).toEqual([]);
    // The attempt still works after those refusals.
    expect((await complete({ code: "code-1", state })).status).toBe(200);
  });

  it("answers 404 for a state that no attempt owns", async () => {
    await startWithState();
    expect((await complete({ code: "code-1", state: "z".repeat(43) })).status).toBe(404);
  });

  it("needs the control token for status and cancel", async () => {
    const attempt = await startAttempt();
    expect((await call(`/api/relay/link/status/${attempt.attemptId}`, { origin: UI_ORIGIN })).status).toBe(404);
    expect((await call(`/api/relay/link/status/${attempt.attemptId}`, { origin: UI_ORIGIN, headers: { "x-link-control": "B".repeat(43) } })).status).toBe(404);
    expect((await call("/api/relay/link/cancel", { origin: UI_ORIGIN, body: { attemptId: attempt.attemptId } })).status).toBe(400);
    expect((await call("/api/relay/link/cancel", { origin: UI_ORIGIN, body: { attemptId: attempt.attemptId }, headers: { "x-link-control": "B".repeat(43) } })).status).toBe(404);
    const cancelled = await call("/api/relay/link/cancel", { origin: UI_ORIGIN, body: { attemptId: attempt.attemptId }, headers: { "x-link-control": attempt.controlToken } });
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
  });

  it("disconnects a link from the UI and reports a missing link", async () => {
    store.save({ name: "manual", url: REMOTE, token: "manual-token" });
    const removed = await call("/api/relay/link/disconnect", { origin: UI_ORIGIN, body: { name: "manual" } });
    expect(await removed.json()).toEqual({ name: "manual", revoked: "not_needed" });
    expect((await call("/api/relay/link/disconnect", { origin: UI_ORIGIN, body: { name: "manual" } })).status).toBe(404);
    expect((await call("/api/relay/link/disconnect", { origin: UI_ORIGIN, body: { name: "manual", localOnly: "yes" } })).status).toBe(400);
  });
});

describe("callback page", () => {
  it("is fixed local code with a script hash, no cache, and no referrer", async () => {
    const response = await call("/api/relay/link/callback", { origin: "https://remote.example.test" });
    expect(response.status).toBe(200);
    const html = await response.text();
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\//);
    // The fragment leaves the address bar before the first request.
    expect(html.indexOf("replaceState")).toBeGreaterThan(-1);
    expect(html.indexOf("replaceState")).toBeLessThan(html.indexOf("fetch("));
  });

  it("changes no link state and accepts no write", async () => {
    const attempt = await startAttempt();
    const before = JSON.stringify(store.list());
    await call("/api/relay/link/callback");
    expect(JSON.stringify(store.list())).toBe(before);
    expect((await call("/api/relay/link/callback", { method: "POST", origin: GATEWAY_ORIGIN, body: {} })).status).toBe(405);
    expect(attempt.attemptId).toBeTruthy();
  });
});

describe("callback reachability", () => {
  /** Binds a real listener and returns its address, or undefined when this machine has no such loopback address. */
  async function bound(host: string): Promise<{ address: string; port: number; close: () => void } | undefined> {
    const server = net.createServer();
    const result = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(0, host, () => resolve(true));
    });
    if (!result) return undefined;
    const address = server.address() as net.AddressInfo;
    return { address: address.address, port: address.port, close: () => server.close() };
  }

  it("takes the callback only from a listener that accepts 127.0.0.1", async () => {
    configureRelay("127.0.0.1", false);
    const outcomes: Record<string, number | undefined> = {};
    for (const host of ["127.0.0.1", "127.0.0.2", "::1"]) {
      const listening = await bound(host);
      if (!listening) {
        // macOS has only 127.0.0.1 on its loopback interface, and a host with no IPv6 has no ::1.
        outcomes[host] = -1;
        continue;
      }
      setGatewayListener({ address: listening.address, port: listening.port });
      outcomes[host] = getLinkCallbackPort();
      listening.close();
    }
    expect(outcomes["127.0.0.1"]).toBeGreaterThan(0);
    for (const host of ["127.0.0.2", "::1"]) expect([undefined, -1]).toContain(outcomes[host]);
  });

  it.each([
    ["127.0.0.1", true],
    ["127.0.0.2", false],
    ["::1", false],
    ["0.0.0.0", false],
  ])("a listener bound to %s gives a callback port: %s", (address, usable) => {
    configureRelay("127.0.0.1", false);
    setGatewayListener({ address, port: 4321 });
    expect(getLinkCallbackPort()).toBe(usable ? 4321 : undefined);
  });

  it("gives no callback port while the relay is off or before the listener is known", () => {
    configureRelay("127.0.0.1", true);
    setGatewayListener({ address: "127.0.0.1", port: 4321 });
    expect(getLinkCallbackPort()).toBeUndefined();
    configureRelay("127.0.0.1", false);
    setGatewayListener(undefined);
    expect(getLinkCallbackPort()).toBeUndefined();
  });

  it("rejects a start before the remote request while the listener cannot take the callback", async () => {
    for (const address of ["127.0.0.2", "::1"]) {
      listener = { address, port: PORT };
      const response = await call("/api/relay/link/start", { origin: UI_ORIGIN, body: { remote: REMOTE, name: "work" } });
      expect(response.status, address).toBe(409);
      expect((await response.json()) as { error: string }).toMatchObject({ error: "link_callback_unavailable" });
    }
    expect(remoteCalls).toEqual([]);
  });
});
