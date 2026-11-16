import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { writeTestV3Config } from "../test-utils/v3-config.js";

/**
 * The remote side of the gateway link through the real gateway server, the real multi-user middleware, the real link
 * routes, a real Better Auth (email and password), and the real key plugin. Requests go over raw TCP sockets, so the
 * request target, the duplicate headers, and the forged headers reach the server as written. Every account, key, and
 * secret is synthetic. No browser, no external service, and no real credential is involved.
 */

const SECRET = "synthetic-session-secret-with-32-chars!";
const AUTH_PORT = 4999;
const WEB_ORIGIN = `http://127.0.0.1:${AUTH_PORT}`;
const CALLBACK_URI = "http://127.0.0.1:4555/api/relay/link/callback";

let home: string;
let previousHome: string | undefined;
let port: number;
let server: ReturnType<typeof import("./index.js").startServer>;
let auth: import("../../../../packages/extensions/multi-user/src/auth.js").MultiUserAuth;
let db: import("better-sqlite3").Database;
let service: import("../../../../packages/extensions/multi-user/src/gateway-link.js").GatewayLinkService;
let multiUserLoaded = true;
const closers: Array<() => Promise<void> | void> = [];

type Account = { id: string; email: string; cookie: string };
type RawResponse = { status: number; headers: Record<string, string>; body: string };

function parseResponse(data: string): RawResponse {
  const split = data.indexOf("\r\n\r\n");
  if (split === -1) return { status: 0, headers: {}, body: "" };
  const head = data.slice(0, split).split("\r\n");
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "")?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  let body = data.slice(split + 4);
  if (headers["transfer-encoding"]?.includes("chunked")) {
    let decoded = "";
    for (;;) {
      const lineEnd = body.indexOf("\r\n");
      if (lineEnd === -1) break;
      const size = parseInt(body.slice(0, lineEnd), 16);
      if (!size) break;
      decoded += body.slice(lineEnd + 2, lineEnd + 2 + size);
      body = body.slice(lineEnd + 2 + size + 2);
    }
    body = decoded;
  }
  return { status, headers, body };
}

/** Writes the bytes as given and reads until the server closes the socket. */
function sendRaw(text: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5000, () => socket.destroy(new Error("raw request timed out")));
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(parseResponse(data)));
    socket.on("error", (error) => ((error as NodeJS.ErrnoException).code === "ECONNRESET" ? resolve(parseResponse(data)) : reject(error)));
    socket.write(text);
  });
}

/** One header line for each pair, so a test can repeat a name. */
function rawRequest(method: string, target: string, headers: Array<[string, string]> = [], body?: unknown): Promise<RawResponse> {
  const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const lines = [`${method} ${target} HTTP/1.1`];
  const names = new Set(headers.map(([name]) => name.toLowerCase()));
  if (!names.has("host")) lines.push(`Host: 127.0.0.1:${port}`);
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  if (body !== undefined) {
    if (!names.has("content-type")) lines.push("Content-Type: application/json");
    lines.push(`Content-Length: ${Buffer.byteLength(payload)}`);
  }
  lines.push("Connection: close");
  return sendRaw(`${lines.join("\r\n")}\r\n\r\n${payload}`);
}

const json = (response: RawResponse) => JSON.parse(response.body) as Record<string, any>;

async function signUp(name: string): Promise<Account> {
  const email = `${name}@example.test`;
  const response = await auth.handler(
    new Request(`${WEB_ORIGIN}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: WEB_ORIGIN },
      body: JSON.stringify({ email, name, password: "synthetic-password-for-isolated-test" }),
    })
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const session = await auth.api.getSession({ headers: new Headers({ Cookie: cookie }) });
  return { id: session!.user.id, email, cookie };
}

const accounts: Record<string, Account> = {};
let sourceCounter = 0;

/** Each call uses a new forwarded address, which a loopback peer may name, so the start limit never blocks a test. */
async function start(options: { replaceLinkId?: string } = {}) {
  const { createHash, randomBytes } = await import("node:crypto");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const response = await rawRequest(
    "POST",
    "/api/auth/gateway-link/requests",
    [["X-Forwarded-For", `192.0.2.1, 10.${(++sourceCounter >> 8) & 255}.${sourceCounter & 255}.9`]],
    {
      challenge: createHash("sha256").update(verifier).digest("base64url"),
      state,
      callbackUri: CALLBACK_URI,
      deviceLabel: "Raw laptop",
      ...(options.replaceLinkId ? { replaceLinkId: options.replaceLinkId } : {}),
    }
  );
  expect(response.status).toBe(201);
  return { requestId: json(response).requestId as string, verifier, state };
}

async function consent(account: Account, requestId: string) {
  const response = await rawRequest("GET", `/api/auth/gateway-link/requests/${requestId}`, [["Cookie", account.cookie]]);
  expect(response.status).toBe(200);
  return json(response) as { nonce: string; status: string };
}

const act = (account: Account, action: "approve" | "deny", requestId: string, nonce: string, extra: Array<[string, string]> = [["Origin", WEB_ORIGIN]]) =>
  rawRequest("POST", `/api/auth/gateway-link/${action}`, [["Cookie", account.cookie], ...extra], { requestId, nonce });

const token = (code: string, verifier: string, extra: Array<[string, string]> = []) =>
  rawRequest("POST", "/api/auth/gateway-link/token", extra, { code, verifier, callbackUri: CALLBACK_URI });

async function linkDevice(account: Account, options: { replaceLinkId?: string } = {}) {
  const begun = await start(options);
  const view = await consent(account, begun.requestId);
  const approved = await act(account, "approve", begun.requestId, view.nonce);
  expect(approved.status).toBe(200);
  const code = new URLSearchParams(new URL(json(approved).redirectUrl).hash.slice(1)).get("code")!;
  const exchanged = await token(code, begun.verifier);
  expect(exchanged.status).toBe(200);
  const body = json(exchanged);
  const keyId = (db.prepare("SELECT keyId FROM gateway_links WHERE id = ?").get(body.link.id) as { keyId: string }).keyId;
  return { key: body.key as string, linkId: body.link.id as string, keyId };
}

const me = (key: string) => rawRequest("GET", "/api/me", [["Authorization", `Bearer ${key}`]]);
const enabled = (keyId: string) => (db.prepare("SELECT enabled FROM apikey WHERE id = ?").get(keyId) as { enabled: number }).enabled;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "gateway-link-raw-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  await writeTestV3Config(home, { agents: [], extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: SECRET } } });
  vi.resetModules();
  vi.doMock("../extensions/registry.js", async () => {
    const actual = await vi.importActual<typeof import("../extensions/registry.js")>("../extensions/registry.js");
    const enabledNow = (id: string) => id === "multiUser" && multiUserLoaded;
    return {
      ...actual,
      getLoadedExtensions: () => (multiUserLoaded ? [{ id: "multiUser" }] : []),
      isMultiUserLoaded: () => multiUserLoaded,
      isExtensionLoaded: enabledNow,
      getExtensionRuntime: () => ({ isEnabled: enabledNow, getRouteMatchers: () => [] }),
    };
  });
  const { GatewayConfigSchema } = await import("@yoplai/shared");
  const authMod = await import("../../../../packages/extensions/multi-user/src/auth.js");
  const dbMod = await import("../../../../packages/extensions/multi-user/src/db.js");
  const { createGatewayLinkService } = await import("../../../../packages/extensions/multi-user/src/gateway-link.js");
  const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
  db = dbMod.initializeMultiUserDatabase(home);
  const config = GatewayConfigSchema.parse({ version: 2, agents: [], gateway: { port: AUTH_PORT }, extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: SECRET } } });
  const multiUser = config.extensions?.multiUser;
  if (!multiUser?.enabled) throw new Error("Expected multi-user fixture");
  auth = await authMod.createMultiUserAuth(config, multiUser, db);
  dbMod.ensureManagedKeyPrefixIndex(db);
  service = createGatewayLinkService({ db, auth: auth.api, secret: SECRET, getAllowedOrigins: () => authMod.getTrustedOrigins(config) });
  service.recover();
  setMultiUserRuntime({ auth, db, gatewayLinks: service, assignments: { getAssignmentsForUser: () => [] }, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never);
  closers.push(() => { setMultiUserRuntime(null); db.close(); });

  const { clearConfigCacheForTests } = await import("../config/index.js");
  clearConfigCacheForTests();
  const { api } = await import("./api.core.js");
  const { registerMultiUserRoutes } = await import("../../../../packages/extensions/multi-user/src/routes.js");
  registerMultiUserRoutes(api);
  const serverMod = await import("./index.js");
  server = serverMod.startServer(0, "127.0.0.1");
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
  port = (server.address() as AddressInfo).port;
  closers.push(async () => { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); });

  // The first account is the bootstrap superadmin. The second is an ordinary approved user.
  accounts.alice = await signUp("alice");
  accounts.bob = await signUp("bob");
});

afterAll(async () => {
  for (const closer of closers.reverse()) await closer();
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("capabilities", () => {
  it("advertises gatewayLink only for a ready multi-user remote", async () => {
    const ready = json(await rawRequest("GET", "/api/capabilities"));
    expect(ready).toMatchObject({ multiUser: true, gatewayLink: { version: 1, method: "loopback-pkce" } });
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    const { createGatewayLinkService } = await import("../../../../packages/extensions/multi-user/src/gateway-link.js");
    const cold = createGatewayLinkService({ db, auth: auth.api, secret: SECRET, getAllowedOrigins: () => [] });
    setMultiUserRuntime({ auth, db, gatewayLinks: cold, assignments: { getAssignmentsForUser: () => [] } } as never);
    try {
      expect(json(await rawRequest("GET", "/api/capabilities")).gatewayLink).toBeUndefined();
    } finally {
      setMultiUserRuntime({ auth, db, gatewayLinks: service, assignments: { getAssignmentsForUser: () => [] }, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never);
    }
    multiUserLoaded = false;
    try {
      expect(json(await rawRequest("GET", "/api/capabilities")).gatewayLink).toBeUndefined();
    } finally {
      multiUserLoaded = true;
    }
  });
});

describe("one link over real sockets", () => {
  it("links, signs in with the key, replaces it, and revokes it", async () => {
    const first = await linkDevice(accounts.alice);
    expect((await me(first.key)).status).toBe(200);
    const second = await linkDevice(accounts.alice, { replaceLinkId: first.linkId });
    expect(second.linkId).toBe(first.linkId);
    expect((await me(first.key)).status).toBe(401);
    expect((await me(second.key)).status).toBe(200);
    const revoked = await rawRequest("POST", "/api/auth/gateway-link/revoke", [["Authorization", `Bearer ${second.key}`]], {});
    expect(revoked.status).toBe(200);
    expect((await me(second.key)).status).toBe(401);
  });
});

describe("request target, header, and forged-context rules", () => {
  it("never lets an encoded, dotted, or double-slash spelling skip a consent check", async () => {
    const begun = await start();
    const view = await consent(accounts.alice, begun.requestId);
    const targets = [
      "/api/auth/gateway-link/%61pprove",
      "/api/auth/gateway-link/./approve",
      "/api/auth/gateway-link/x/../approve",
      "/api/auth/gateway-link/%2e%2e/gateway-link/approve",
      "//api/auth/gateway-link/approve",
      "/api/auth/gateway-link/approve/",
      "/API/auth/gateway-link/approve",
    ];
    for (const target of targets) {
      // No Origin: every spelling must fail or miss. None may approve.
      const response = await rawRequest("POST", target, [["Cookie", accounts.alice.cookie]], { requestId: begun.requestId, nonce: view.nonce });
      expect(response.status, target).not.toBe(200);
    }
    expect((await consent(accounts.alice, begun.requestId)).status).toBe("pending");
  });

  it("never lets an aliased key route update a managed key", async () => {
    const device = await linkDevice(accounts.alice);
    const replaced = await linkDevice(accounts.alice, { replaceLinkId: device.linkId });
    expect(enabled(device.keyId)).toBe(0);
    const targets = [
      "/api/auth/api-key/update",
      "/api/auth/api-key/%75pdate",
      "/api/auth/api-key/./update",
      "/api/auth/gateway-link/../api-key/update",
      "/api/auth/api-key/%2e/update",
      "/api/auth/api-key/update/",
      "/api/auth/api-key//update",
    ];
    for (const target of targets) {
      const response = await rawRequest("POST", target, [["Cookie", accounts.alice.cookie], ["Origin", WEB_ORIGIN]], { keyId: device.keyId, enabled: true });
      expect(response.status, target).not.toBe(200);
      expect(enabled(device.keyId), target).toBe(0);
    }
    expect((await me(device.key)).status).toBe(401);
    expect((await me(replaced.key)).status).toBe(200);
    // The reserved prefix is refused in each spelling too.
    for (const target of ["/api/auth/api-key/create", "/api/auth/api-key/%63reate", "/api/auth/api-key/./create"]) {
      const response = await rawRequest("POST", target, [["Cookie", accounts.alice.cookie], ["Origin", WEB_ORIGIN]], { name: "forged", prefix: "gl_forgedforgedforged" });
      expect(response.status, target).not.toBe(200);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM apikey WHERE name = 'forged'").get()).toEqual({ count: 0 });
  });

  it("refuses repeated and conflicting headers on a consent write", async () => {
    const begun = await start();
    const view = await consent(accounts.alice, begun.requestId);
    const base: Array<[string, string]> = [["Cookie", accounts.alice.cookie]];
    // Two Origin lines are joined by the server and no longer equal the one web origin.
    expect((await act(accounts.alice, "approve", begun.requestId, view.nonce, [["Origin", WEB_ORIGIN], ["Origin", WEB_ORIGIN]])).status).toBe(403);
    // A second Origin of another site fails in the same way.
    expect((await act(accounts.alice, "approve", begun.requestId, view.nonce, [["Origin", WEB_ORIGIN], ["Origin", "https://evil.example.test"]])).status).toBe(403);
    // Conflicting Host lines give a request no Origin, so the consent check still fails. The Host decides no authority.
    const hosts = await rawRequest("POST", "/api/auth/gateway-link/approve", [["Host", `127.0.0.1:${port}`], ["Host", "evil.example.test"], ...base], { requestId: begun.requestId, nonce: view.nonce });
    expect(hosts.status).not.toBe(200);
    // Two lengths are a malformed request. The server refuses or closes, and nothing changes.
    const body = JSON.stringify({ requestId: begun.requestId, nonce: view.nonce });
    const lengths = await sendRaw(
      `POST /api/auth/gateway-link/approve HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${accounts.alice.cookie}\r\nOrigin: ${WEB_ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nContent-Length: ${body.length + 5}\r\nConnection: close\r\n\r\n${body}`
    );
    expect(lengths.status).not.toBe(200);
    expect((await consent(accounts.alice, begun.requestId)).status).toBe("pending");
  });

  it("gives a forged auth context, a session string, or a verified marker no authority", async () => {
    const device = await linkDevice(accounts.alice);
    const claim = Buffer.from(JSON.stringify({ user: { id: accounts.alice.id, role: "superadmin" }, session: { id: `apikey:${device.keyId}`, userId: accounts.alice.id } })).toString("base64url");
    const forged: Array<[string, string]> = [["X-Yoplai-Auth-Context", claim], ["X-Aihub-Auth-Context", claim], ["X-Multi-User-Bearer-Verified", "true"]];
    expect((await rawRequest("GET", "/api/auth/gateway-link/links", forged)).status).toBe(401);
    // No Origin fails the write check first. With the Origin, the missing session fails.
    expect([401, 403]).toContain((await rawRequest("POST", "/api/auth/gateway-link/revoke", forged, { linkId: device.linkId })).status);
    expect((await rawRequest("POST", "/api/auth/gateway-link/revoke", [...forged, ["Origin", WEB_ORIGIN]], { linkId: device.linkId })).status).toBe(401);
    // A real cookie of another account acts as that account: bob sees no link and cannot revoke alice's.
    expect(json(await rawRequest("GET", "/api/auth/gateway-link/links", [...forged, ["Cookie", accounts.bob.cookie]])).links).toEqual([]);
    expect((await rawRequest("POST", "/api/auth/gateway-link/revoke", [...forged, ["Cookie", accounts.bob.cookie], ["Origin", WEB_ORIGIN]], { linkId: device.linkId })).status).toBe(404);
    expect((await me(device.key)).status).toBe(200);
  });

  it("keys the start limit by the last forwarded entry from a loopback proxy, and ignores a spoofed first entry", async () => {
    const body = { challenge: "A".repeat(43), state: "B".repeat(43), callbackUri: CALLBACK_URI, deviceLabel: "Limit" };
    const statuses: number[] = [];
    for (let index = 0; index < 6; index++) {
      statuses.push((await rawRequest("POST", "/api/auth/gateway-link/requests", [["X-Forwarded-For", `10.0.0.${index}, 203.0.113.77`]], body)).status);
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    expect((await rawRequest("POST", "/api/auth/gateway-link/requests", [["X-Forwarded-For", "203.0.113.78"]], body)).status).toBe(201);
  });

  it("refuses an Origin on request creation and exchange, over the socket", async () => {
    const body = { challenge: "A".repeat(43), state: "B".repeat(43), callbackUri: CALLBACK_URI, deviceLabel: "Origin" };
    for (const origin of [WEB_ORIGIN, "null", "http://127.0.0.1:4555"]) {
      expect((await rawRequest("POST", "/api/auth/gateway-link/requests", [["Origin", origin]], body)).status).toBe(403);
      expect((await token("code", "v".repeat(43), [["Origin", origin]])).status).toBe(403);
    }
  });
});

describe("real /ws and /ws/device upgrades with a managed key", () => {
  const open = (pathname: string, headers: Record<string, string>) =>
    new Promise<"open" | number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers });
      socket.on("open", () => {
        socket.close();
        resolve("open");
      });
      socket.on("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      socket.on("error", () => undefined);
    });

  it("accepts an active key and refuses a replaced, revoked, and expired key on both paths", async () => {
    const first = await linkDevice(accounts.alice);
    for (const pathname of ["/ws", "/ws/device"]) expect(await open(pathname, { Authorization: `Bearer ${first.key}` })).toBe("open");
    const second = await linkDevice(accounts.alice, { replaceLinkId: first.linkId });
    for (const pathname of ["/ws", "/ws/device"]) {
      expect(await open(pathname, { Authorization: `Bearer ${first.key}` })).toBe(401);
      expect(await open(pathname, { Authorization: `Bearer ${second.key}` })).toBe("open");
    }
    // A cookie of another account carries no weight next to a bad key, and a missing credential fails.
    expect(await open("/ws/device", { Authorization: `Bearer ${first.key}`, Cookie: accounts.bob.cookie })).toBe(401);
    expect(await open("/ws", {})).toBe(401);
    service.revokeOwnedLink(accounts.alice.id, second.linkId);
    for (const pathname of ["/ws", "/ws/device"]) expect(await open(pathname, { Authorization: `Bearer ${second.key}` })).toBe(401);
    const third = await linkDevice(accounts.alice, { replaceLinkId: second.linkId });
    db.prepare("UPDATE gateway_links SET expiresAt = ? WHERE id = ?").run(Date.now() - 1, third.linkId);
    for (const pathname of ["/ws", "/ws/device"]) expect(await open(pathname, { Authorization: `Bearer ${third.key}` })).toBe(401);
  });
});
