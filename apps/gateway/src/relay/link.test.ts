import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GATEWAY_LINK_CALLBACK_PATH } from "@yoplai/shared";
import { RelayLinkService, checkRemoteOrigin, type LinkDeps } from "./link.js";
import { createFileRemoteGatewayStore, type RemoteGatewayStore } from "./store.js";

/** The remote side is a scripted fake. Every key, code, and account here is synthetic. */
const ORIGIN = "https://remote.example.test";
const PORT = 4555;
const KEY = "synthetic-link-key-not-real";
const CALLBACK = `http://127.0.0.1:${PORT}${GATEWAY_LINK_CALLBACK_PATH}`;

type Call = { method: string; path: string; headers: Headers; body: Record<string, unknown> | undefined; redirect: string | undefined };
type Handler = (call: Call) => Response | Promise<Response>;

const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MULTI_USER_CAPABILITIES = { version: 2, extensions: {}, agents: [], multiUser: true, gatewayLink: { version: 1, method: "loopback-pkce" } };

const tokenAnswer = (overrides: Record<string, unknown> = {}) =>
  jsonResponse(200, {
    key: KEY,
    link: {
      id: "link-1",
      deviceLabel: "Test laptop",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-04-01T00:00:00.000Z",
      revokedAt: null,
      account: { email: "user@example.test", name: null },
    },
    ...overrides,
  });

let dir: string;
let store: RemoteGatewayStore;
let calls: Call[];
let handlers: Record<string, Handler>;
let clock: { now: number };
let callbackPort: number | undefined;
let connections: ReturnType<LinkDeps["connections"]>;
let service: RelayLinkService;

const defaultHandlers = (): Record<string, Handler> => ({
  "GET /api/capabilities": () => jsonResponse(200, MULTI_USER_CAPABILITIES),
  "POST /api/auth/gateway-link/requests": () => jsonResponse(201, { requestId: "req-1", expiresAt: new Date(clock.now + 5 * 60_000).toISOString() }),
  "POST /api/auth/gateway-link/token": () => tokenAnswer(),
  "POST /api/auth/gateway-link/revoke": () => jsonResponse(200, { id: "link-1" }),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-link-"));
  store = createFileRemoteGatewayStore(path.join(dir, "remote-gateways.json"));
  calls = [];
  clock = { now: Date.parse("2026-01-01T00:00:00.000Z") };
  callbackPort = PORT;
  connections = [];
  handlers = defaultHandlers();
  service = new RelayLinkService({
    store: () => store,
    now: () => clock.now,
    callbackPort: () => callbackPort,
    deviceLabel: () => "Test laptop",
    connections: () => connections,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
      const call: Call = { method: init?.method ?? "GET", path: url.pathname, headers: new Headers(init?.headers), body, redirect: init?.redirect };
      calls.push(call);
      const handler = handlers[`${call.method} ${call.path}`];
      if (!handler) throw new Error(`no handler for ${call.method} ${call.path}`);
      return handler(call);
    },
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function begin(extra: { name?: string } = {}) {
  const result = await service.start({ remote: ORIGIN, ...extra });
  if (!result.ok || result.value.kind !== "pending") throw new Error(`start failed: ${JSON.stringify(result)}`);
  const request = calls.filter((call) => call.path === "/api/auth/gateway-link/requests").at(-1)!;
  return { attempt: result.value.attempt, state: request.body!.state as string, challenge: request.body!.challenge as string };
}

describe("checkRemoteOrigin", () => {
  it.each([
    ["https://gateway.example.com", "https://gateway.example.com"],
    ["https://gateway.example.com/", "https://gateway.example.com"],
    ["HTTPS://Gateway.Example.com:8443", "https://gateway.example.com:8443"],
    ["http://127.0.0.1:4100", "http://127.0.0.1:4100"],
    ["http://[::1]:4100/", "http://[::1]:4100"],
  ])("accepts %s", (input, origin) => {
    const result = checkRemoteOrigin(input);
    expect(result.ok && result.value.origin).toBe(origin);
  });

  it.each([
    "https://gateway.example.com/app",
    "https://gateway.example.com/?next=1",
    "https://gateway.example.com/#frag",
    "https://user:secret@gateway.example.com",
    "https://gateway.example.com\\@evil.test",
    "http://gateway.example.com",
    "http://localhost:4100",
    "http://127.0.0.1.nip.io",
    "http://127.0.0.2:4100",
    "http://2130706433",
    "http://0x7f.0.0.1",
    "http://0x7f000001",
    "http://127.1",
    "http://017700000001",
    "https://2130706433",
    "https://0x7f000001",
    "https://127.1",
    "https://gateway.example.com:0",
    "https://gateway.example.com:99999",
    "https://gateway.example.com:08080",
    "https://gateway..example.com",
    "https://.example.com",
    "ftp://gateway.example.com",
    "gateway.example.com",
    "https://",
    "https://gateway.example.com//",
  ])("rejects %s", (input) => {
    expect(checkRemoteOrigin(input).ok).toBe(false);
  });
});

describe("start", () => {
  it("creates one attempt and gives the consent address, never the state or the verifier", async () => {
    const { attempt, state, challenge } = await begin({ name: "work" });
    expect(attempt.consentUrl).toBe(`${ORIGIN}/gateway-link?request=req-1`);
    expect(attempt.attemptId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.controlToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(attempt)).not.toContain(state);
    const request = calls.find((call) => call.path === "/api/auth/gateway-link/requests")!;
    expect(request.body).toEqual({ challenge, state, callbackUri: CALLBACK, deviceLabel: "Test laptop" });
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Browser state is sent to the remote only through the request. No cookie, no Origin, and no redirect.
    for (const call of calls) {
      expect(call.redirect).toBe("manual");
      expect(call.headers.get("cookie")).toBeNull();
      expect(call.headers.get("origin")).toBeNull();
      expect(call.headers.get("authorization")).toBeNull();
    }
  });

  it("refuses before any remote request while the listener cannot take the callback", async () => {
    callbackPort = undefined;
    const result = await service.start({ remote: ORIGIN, name: "work" });
    expect(result).toMatchObject({ ok: false, status: 409, error: "link_callback_unavailable" });
    expect(calls).toEqual([]);
  });

  it("refuses an address that breaks the transport rule before any request", async () => {
    const result = await service.start({ remote: "http://gateway.example.com" });
    expect(result).toMatchObject({ ok: false, error: "invalid_remote" });
    expect(calls).toEqual([]);
  });

  it("refuses a name that another link uses, and a manual link of the same name", async () => {
    store.save({ name: "work", url: ORIGIN, token: "manual-token" });
    expect(await service.start({ remote: ORIGIN, name: "work" })).toMatchObject({ ok: false, error: "name_in_use" });
    store.save({ name: "other", url: "https://other.example.test", token: KEY, managed: { linkId: "l", account: { email: null, name: null }, deviceLabel: "x", expiresAt: null, linkedAt: "2026-01-01T00:00:00.000Z" } });
    expect(await service.start({ remote: ORIGIN, name: "other" })).toMatchObject({ ok: false, error: "name_in_use" });
    expect(calls).toEqual([]);
  });

  it("names the stored link ID when a browser link starts again", async () => {
    await begin({ name: "work" });
    const { state } = await begin({ name: "work2" });
    await service.complete({ state, code: "code-1" });
    calls.length = 0;
    await service.start({ remote: ORIGIN, name: "work2" });
    const request = calls.filter((call) => call.path === "/api/auth/gateway-link/requests").at(-1)!;
    expect(request.body!.replaceLinkId).toBe("link-1");
  });

  it("refuses a multi-user remote with no browser sign-in and points to the token option", async () => {
    handlers["GET /api/capabilities"] = () => jsonResponse(200, { version: 2, extensions: {}, agents: [], multiUser: true });
    const result = await service.start({ remote: ORIGIN, name: "work" });
    expect(result).toMatchObject({ ok: false, error: "remote_not_supported" });
    expect(calls.map((call) => call.path)).toEqual(["/api/capabilities"]);
  });

  it("limits the open attempts", async () => {
    for (let i = 0; i < 20; i++) await begin({ name: `g${i}` });
    expect(await service.start({ remote: ORIGIN, name: "one-more" })).toMatchObject({ ok: false, status: 429, error: "too_many_attempts" });
  });

  it("answers a failed or unreachable remote with a plain error", async () => {
    handlers["GET /api/capabilities"] = () => {
      throw new Error("connect refused");
    };
    expect(await service.start({ remote: ORIGIN, name: "work" })).toMatchObject({ ok: false, error: "remote_unreachable" });
    handlers = defaultHandlers();
    handlers["POST /api/auth/gateway-link/requests"] = () => jsonResponse(429, { error: "rate_limited" });
    expect(await service.start({ remote: ORIGIN, name: "work" })).toMatchObject({ ok: false, status: 429 });
  });
});

describe("single-user remote", () => {
  const open = () => {
    handlers["GET /api/capabilities"] = () => jsonResponse(200, { version: 2, extensions: {}, agents: [], multiUser: false });
    handlers["GET /api/agents"] = () => jsonResponse(200, []);
  };

  it("links with no token, no consent page, and no key", async () => {
    open();
    const result = await service.start({ remote: ORIGIN, name: "open" });
    expect(result).toEqual({ ok: true, value: { kind: "linked", name: "open" } });
    expect(store.list()[0]).toMatchObject({ name: "open", url: ORIGIN });
    expect(store.list()[0].token).toBeUndefined();
    expect(calls.map((call) => call.path)).toEqual(["/api/capabilities", "/api/agents"]);
  });

  it.each([401, 403, 500])("never counts an answer of %s from the agent list as an open gateway", async (status) => {
    open();
    handlers["GET /api/agents"] = () => jsonResponse(status, { error: "x" });
    expect(await service.start({ remote: ORIGIN, name: "open" })).toMatchObject({ ok: false });
    expect(store.list()).toEqual([]);
  });

  it("does not link when the agent list is not a list", async () => {
    open();
    handlers["GET /api/agents"] = () => jsonResponse(200, { agents: [] });
    expect(await service.start({ remote: ORIGIN, name: "open" })).toMatchObject({ ok: false });
    expect(store.list()).toEqual([]);
  });

  it.each([
    ["a timeout", () => { throw new Error("timeout"); }],
    ["a redirect", () => new Response(null, { status: 302, headers: { location: "https://evil.example.test" } })],
    ["a malformed body", () => new Response("not json", { status: 200 })],
    ["a missing multiUser field", () => jsonResponse(200, { version: 2, extensions: {}, agents: [] })],
    ["a 401", () => jsonResponse(401, { error: "unauthorized" })],
  ])("never counts %s of the capability call as an open gateway", async (_label, answer) => {
    open();
    handlers["GET /api/capabilities"] = answer;
    expect(await service.start({ remote: ORIGIN, name: "open" })).toMatchObject({ ok: false });
    expect(calls.map((call) => call.path)).not.toContain("/api/agents");
    expect(store.list()).toEqual([]);
  });
});

describe("complete", () => {
  it("exchanges the code with the verifier, saves the key, and reports a linked attempt", async () => {
    const { attempt, state, challenge } = await begin({ name: "work" });
    const result = await service.complete({ state, code: "code-1" });
    expect(result).toEqual({ ok: true, value: { status: "linked" } });
    const exchange = calls.find((call) => call.path === "/api/auth/gateway-link/token")!;
    expect(exchange.body).toMatchObject({ code: "code-1", callbackUri: CALLBACK });
    expect(createHash("sha256").update(String(exchange.body!.verifier)).digest("base64url")).toBe(challenge);
    expect(store.list()[0]).toMatchObject({
      name: "work",
      url: ORIGIN,
      token: KEY,
      managed: { linkId: "link-1", deviceLabel: "Test laptop", account: { email: "user@example.test" }, expiresAt: "2026-04-01T00:00:00.000Z" },
    });
    const status = service.status(attempt.attemptId, attempt.controlToken);
    expect(status).toMatchObject({ ok: true, value: { status: "linked", name: "work", remote: ORIGIN, linkId: "link-1" } });
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(status)).not.toContain(state);
  });

  it("works once per state", async () => {
    const { state } = await begin({ name: "work" });
    await service.complete({ state, code: "code-1" });
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: false, status: 404 });
    expect(calls.filter((call) => call.path === "/api/auth/gateway-link/token")).toHaveLength(1);
  });

  it("starts one exchange when two callbacks arrive together", async () => {
    const { state } = await begin({ name: "work" });
    const [first, second] = await Promise.all([service.complete({ state, code: "code-1" }), service.complete({ state, code: "code-2" })]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect(calls.filter((call) => call.path === "/api/auth/gateway-link/token")).toHaveLength(1);
  });

  it("changes nothing for a state that no attempt owns", async () => {
    await begin({ name: "work" });
    const before = calls.length;
    expect(await service.complete({ state: "x".repeat(43), code: "code-1" })).toMatchObject({ ok: false, status: 404 });
    expect(await service.complete({ state: "x".repeat(43), error: "access_denied" })).toMatchObject({ ok: false, status: 404 });
    expect(calls).toHaveLength(before);
    expect(store.list()).toEqual([]);
  });

  it("ends the attempt as denied and never exchanges", async () => {
    const { attempt, state } = await begin({ name: "work" });
    expect(await service.complete({ state, error: "access_denied" })).toMatchObject({ ok: true, value: { status: "denied" } });
    expect(service.status(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: true, value: { status: "denied" } });
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/gateway-link/token");
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: false });
  });

  it("refuses a state after the attempt expired", async () => {
    const { attempt, state } = await begin({ name: "work" });
    clock.now += 7 * 60_000;
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: false, status: 410 });
    expect(service.status(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: true, value: { status: "expired" } });
    expect(store.list()).toEqual([]);
  });

  it("ends as failed when the remote refuses the code", async () => {
    handlers["POST /api/auth/gateway-link/token"] = () => jsonResponse(400, { error: "invalid_grant" });
    const { attempt, state } = await begin({ name: "work" });
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(service.status(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(store.list()).toEqual([]);
  });

  it.each([
    ["a lost answer", () => { throw new Error("socket closed"); }],
    ["a server error", () => jsonResponse(500, { error: "x" })],
    ["a redirect", () => new Response(null, { status: 307, headers: { location: "https://evil.example.test" } })],
    ["a malformed key answer", () => jsonResponse(200, { key: "", link: {} })],
  ])("tells the user to revoke at the owner page after %s of the first exchange", async (_label, answer) => {
    handlers["POST /api/auth/gateway-link/token"] = answer;
    const { attempt, state } = await begin({ name: "work" });
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: true, value: { status: "uncertain" } });
    const status = service.status(attempt.attemptId, attempt.controlToken);
    expect(status).toMatchObject({ ok: true, value: { status: "uncertain", ownerPageUrl: `${ORIGIN}/account/gateway-links` } });
    expect(status.ok && status.value.message).toContain(`${ORIGIN}/account/gateway-links`);
    expect(status.ok && status.value.message).toContain("link again");
    expect(store.list()).toEqual([]);
    // A fresh start for the same remote repeats the instruction. There is no retry of the same link and no selector.
    handlers["POST /api/auth/gateway-link/token"] = () => tokenAnswer();
    const fresh = await service.start({ remote: ORIGIN, name: "work" });
    expect(fresh.ok && fresh.value.kind === "pending" && fresh.value.attempt.recoveryNote).toContain(`${ORIGIN}/account/gateway-links`);
  });

  it("revokes the new key when the stored link changed during the exchange", async () => {
    const { attempt, state } = await begin({ name: "work" });
    handlers["POST /api/auth/gateway-link/token"] = () => {
      store.save({ name: "work", url: "https://another.example.test", token: "manual-token" });
      return tokenAnswer();
    };
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: true, value: { status: "failed" } });
    const revoke = calls.find((call) => call.path === "/api/auth/gateway-link/revoke")!;
    expect(revoke.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(store.list()[0].token).toBe("manual-token");
    expect(service.status(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: true, value: { status: "failed" } });
  });

  it("revokes the new key when the store cannot save", async () => {
    const { state } = await begin({ name: "work" });
    store.saveIfGeneration = () => {
      throw new Error("disk full");
    };
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(calls.map((call) => call.path)).toContain("/api/auth/gateway-link/revoke");
  });

  it("gives the owner page and the link ID when the revoke after a lost race also fails", async () => {
    const { attempt, state } = await begin({ name: "work" });
    handlers["POST /api/auth/gateway-link/token"] = () => {
      store.save({ name: "work", url: ORIGIN, token: "manual-token" });
      return tokenAnswer();
    };
    handlers["POST /api/auth/gateway-link/revoke"] = () => jsonResponse(503, { error: "unavailable" });
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: true, value: { status: "uncertain" } });
    expect(service.status(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: true, value: { status: "uncertain", linkId: "link-1", ownerPageUrl: `${ORIGIN}/account/gateway-links` } });
  });

  it("lets a second link of the same name win only once", async () => {
    const first = await begin({ name: "work" });
    const second = await begin({ name: "work" });
    expect(await service.complete({ state: first.state, code: "code-1" })).toMatchObject({ ok: true, value: { status: "linked" } });
    expect(await service.complete({ state: second.state, code: "code-2" })).toMatchObject({ ok: true, value: { status: "failed" } });
    expect(store.list()).toHaveLength(1);
  });
});

describe("status and cancel", () => {
  it("answer only with the control token of the attempt", async () => {
    const { attempt } = await begin({ name: "work" });
    expect(service.status(attempt.attemptId, "x".repeat(43))).toMatchObject({ ok: false, status: 404 });
    expect(service.cancel(attempt.attemptId, "x".repeat(43))).toMatchObject({ ok: false, status: 404 });
    expect(service.status("y".repeat(43), attempt.controlToken)).toMatchObject({ ok: false, status: 404 });
    expect(service.status(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: true, value: { status: "pending" } });
  });

  it("cancels an attempt so its state no longer works", async () => {
    const { attempt, state } = await begin({ name: "work" });
    expect(service.cancel(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(await service.complete({ state, code: "code-1" })).toMatchObject({ ok: false, status: 404 });
    expect(calls.map((call) => call.path)).not.toContain("/api/auth/gateway-link/token");
  });

  it("refuses a cancel while the exchange runs", async () => {
    const { attempt, state } = await begin({ name: "work" });
    let release!: () => void;
    handlers["POST /api/auth/gateway-link/token"] = () => new Promise((resolve) => (release = () => resolve(tokenAnswer())));
    const done = service.complete({ state, code: "code-1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.cancel(attempt.attemptId, attempt.controlToken)).toMatchObject({ ok: false, status: 409 });
    release();
    expect(await done).toMatchObject({ ok: true, value: { status: "linked" } });
  });
});

describe("saved links", () => {
  const managed = { linkId: "link-1", account: { email: "user@example.test", name: null }, deviceLabel: "Test laptop", expiresAt: "2026-04-01T00:00:00.000Z", linkedAt: "2026-01-01T00:00:00.000Z" };

  it("lists each link with key state apart from connection state, and unknown fields for a manual link", () => {
    store.save({ name: "browser", url: ORIGIN, token: KEY, managed });
    store.save({ name: "manual", url: "https://manual.example.test", token: "manual-token" });
    store.save({ name: "open", url: "https://open.example.test" });
    connections = [{ name: "browser", connected: false, status: "connecting" }];
    const rows = service.list();
    expect(rows.find((row) => row.name === "browser")).toEqual({
      name: "browser", remote: ORIGIN, kind: "browser", account: "user@example.test", deviceLabel: "Test laptop",
      linkId: "link-1", expiresAt: "2026-04-01T00:00:00.000Z", keyState: "active", connection: "connecting",
    });
    expect(rows.find((row) => row.name === "manual")).toMatchObject({ kind: "token", account: null, deviceLabel: null, linkId: null, expiresAt: null, keyState: "unknown", connection: "offline" });
    expect(rows.find((row) => row.name === "open")).toMatchObject({ kind: "open", keyState: "none" });
    expect(JSON.stringify(rows)).not.toContain(KEY);
    expect(JSON.stringify(rows)).not.toContain("manual-token");
  });

  it("shows an expired key and a rejected key, and keeps an offline device apart from the key", () => {
    store.save({ name: "browser", url: ORIGIN, token: KEY, managed });
    clock.now = Date.parse("2026-05-01T00:00:00.000Z");
    expect(service.list()[0]).toMatchObject({ keyState: "expired", connection: "offline" });
    clock.now = Date.parse("2026-01-01T00:00:00.000Z");
    connections = [{ name: "browser", connected: false, status: "unauthorized" }];
    expect(service.list()[0]).toMatchObject({ keyState: "rejected", connection: "unauthorized" });
    connections = [{ name: "browser", connected: false, status: "replaced" }];
    expect(service.list()[0]).toMatchObject({ keyState: "active", connection: "replaced" });
  });

  it("revokes a browser link on the remote before it removes the entry", async () => {
    store.save({ name: "browser", url: ORIGIN, token: KEY, managed });
    expect(await service.disconnect("browser")).toEqual({ ok: true, value: { name: "browser", revoked: "remote" } });
    const revoke = calls.find((call) => call.path === "/api/auth/gateway-link/revoke")!;
    expect(revoke.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(revoke.body).toEqual({ linkId: "link-1" });
    expect(store.list()).toEqual([]);
  });

  it("removes the entry when the remote no longer accepts the key", async () => {
    handlers["POST /api/auth/gateway-link/revoke"] = () => jsonResponse(401, { error: "unauthorized" });
    store.save({ name: "browser", url: ORIGIN, token: KEY, managed });
    expect(await service.disconnect("browser")).toEqual({ ok: true, value: { name: "browser", revoked: "already" } });
    expect(store.list()).toEqual([]);
  });

  it("keeps the entry while the remote cannot confirm, and removes it only for a local-only choice", async () => {
    handlers["POST /api/auth/gateway-link/revoke"] = () => {
      throw new Error("offline");
    };
    store.save({ name: "browser", url: ORIGIN, token: KEY, managed });
    expect(await service.disconnect("browser")).toMatchObject({ ok: false, status: 502, error: "revoke_failed" });
    expect(store.list()).toHaveLength(1);
    calls.length = 0;
    expect(await service.disconnect("browser", { localOnly: true })).toEqual({ ok: true, value: { name: "browser", revoked: "skipped" } });
    expect(store.list()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("removes a manual link with no remote call, and answers 404 for an unknown name", async () => {
    store.save({ name: "manual", url: ORIGIN, token: "manual-token" });
    expect(await service.disconnect("manual")).toEqual({ ok: true, value: { name: "manual", revoked: "not_needed" } });
    expect(calls).toEqual([]);
    expect(await service.disconnect("manual")).toMatchObject({ ok: false, status: 404 });
  });
});
