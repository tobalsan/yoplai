import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";

/**
 * These checks use the real `@hono/node-server` adapter on loopback ports that the OS picks.
 * The adapter replaces the global Request and Response classes, so the test restores them.
 * The linked remote gateway is a disposable local HTTP server with a fake bearer.
 */

type RemoteCall = { method: string; url: string; authorization: string | undefined; body: string };

let home: string;
let previousHome: string | undefined;
let scheduler: typeof import("@yoplai/extension-scheduler").schedulerExtension;
let server: http.Server;
let remoteServer: http.Server;
let base: string;
let remoteCalls: RemoteCall[] = [];
let errorLog: ReturnType<typeof vi.spyOn>;
const originalRequest = globalThis.Request;
const originalResponse = globalThis.Response;
const trustedOrigin = "http://127.0.0.1:3000";
const oversizedName = "x".repeat(1_048_576);

function listen(target: http.Server): Promise<number> {
  return new Promise((resolve) => target.listen(0, "127.0.0.1", () => resolve((target.address() as AddressInfo).port)));
}

function startRemote(): http.Server {
  return http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://remote.test");
      remoteCalls.push({ method: request.method ?? "", url: `${url.pathname}${url.search}`, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== "Bearer fake-bearer") return reply(401, { error: "login_required" });
      if (url.pathname === "/api/agents") return reply(200, [{ id: "pom", name: "Pom (fixture)" }]);
      if (url.pathname === "/api/schedules" && request.method === "POST") return reply(201, { id: "remote-job" });
      if (url.pathname === "/api/oauth/google/authorize") {
        return reply(200, { kind: "oauth_authorization", provider: "google", authorizationUrl: "https://accounts.example.test/auth?state=fake" });
      }
      if (url.pathname.startsWith("/api/oauth/") && url.pathname.endsWith("/authorize")) return reply(404, { error: "unknown_provider" });
      reply(404, { error: "not_found" });
    });
  });
}

function schedulePost(agentId: string, extra: Record<string, unknown> = {}) {
  return { agentId, name: "Synthetic schedule", schedule: { runAt: "2099-01-01T00:00:00Z" }, payload: { message: "hello" }, ...extra };
}

function post(pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: trustedOrigin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectJsonError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({ error });
}

async function localJobsFile(): Promise<string | undefined> {
  return fs.readFile(path.join(home, "agents/local/cron/jobs.json"), "utf8").catch(() => undefined);
}

/** Sends a chunked body with no Content-Length. Returns the status code that the server sent. */
function sendChunked(pathname: string, totalBytes: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}${pathname}`);
    let result: { status: number; body: string } | undefined;
    const request = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": "application/json", origin: trustedOrigin, "transfer-encoding": "chunked" } },
      (response) => {
        const parts: Buffer[] = [];
        response.on("data", (part: Buffer) => parts.push(part));
        response.on("end", () => {
          result = { status: response.statusCode ?? 0, body: Buffer.concat(parts).toString() };
          resolve(result);
        });
      }
    );
    request.on("error", (error) => {
      if (!result) reject(error);
    });
    const prefix = '{"agentId":"pom@ams","name":"';
    request.write(prefix);
    let sent = prefix.length;
    const chunk = "y".repeat(64 * 1024);
    const writeMore = () => {
      while (sent < totalBytes) {
        sent += chunk.length;
        if (!request.write(chunk)) return void request.once("drain", writeMore);
      }
      request.end('"}');
    };
    writeMore();
  });
}

/** Sends headers that promise more bytes than the client sends, then closes the socket. */
function abortMidBody(pathname: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = net.connect(Number(new URL(base).port), "127.0.0.1", () => {
      socket.write(`POST ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${trustedOrigin}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"agentId":"pom@ams"`);
      setTimeout(() => socket.destroy(), 50);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve());
  });
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-http-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  await writeTestV3Config(home, { agents: [{ id: "local" }], extensions: { scheduler: {} } });
  vi.resetModules();
  const { loadConfig } = await import("../config/index.js");
  const { loadExtensions } = await import("../extensions/registry.js");
  const { createExtensionContext } = await import("../extensions/context.js");
  const { api } = await import("./api.core.js");
  const extensions = await loadExtensions(loadConfig());
  scheduler = extensions.find((item) => item.id === "scheduler")!;
  scheduler.registerRoutes!(api);
  await scheduler.start(createExtensionContext(loadConfig()));

  remoteServer = startRemote();
  const remotePort = await listen(remoteServer);
  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", false);
  state.getRemoteGatewayStore().save({ name: "ams", url: `http://127.0.0.1:${remotePort}`, token: "fake-bearer" });

  const { registerOAuthProvider } = await import("@yoplai/shared");
  registerOAuthProvider({ id: "fakeprovider", displayName: "Fake provider", authorizeUrl: "https://idp.example.test/authorize", tokenUrl: "https://idp.example.test/token", defaultScopes: [] });
  const { app } = await import("./index.js");
  const { serve } = await import("@hono/node-server");
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  errorLog?.mockRestore();
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  remoteServer?.closeAllConnections();
  await new Promise((resolve) => remoteServer?.close(resolve));
  await scheduler?.stop();
  const state = await import("../relay/state.js");
  state.getRemoteGatewayStore().remove("ams");
  state.configureRelay("127.0.0.1", true);
  Object.defineProperty(globalThis, "Request", { value: originalRequest });
  Object.defineProperty(globalThis, "Response", { value: originalResponse });
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  remoteCalls = [];
  errorLog.mockClear();
});

function expectNoDisturbedBodyError(): void {
  const text = errorLog.mock.calls.map((call: unknown[]) => call.map(String).join(" ")).join("\n");
  expect(text).not.toContain("should not be disturbed or locked");
}

describe("real HTTP adapter: oversized configuration bodies", () => {
  it.each([
    ["ordinary remote", "/api/schedules", "pom@ams"],
    ["ordinary local", "/api/schedules", "local"],
    ["explicit prefix", "/api/relay/gateways/ams/api/schedules", "pom"],
  ])("returns 413 JSON for an oversized %s schedule POST and changes nothing", async (_label, pathname, agentId) => {
    const response = await post(pathname, { agentId, name: oversizedName });
    await expectJsonError(response, 413, "configuration_body_too_large");
    expect(remoteCalls).toEqual([]);
    expect(await localJobsFile()).toBeUndefined();
    expectNoDisturbedBodyError();
  });

  it("returns 413 JSON for an oversized complete schedule body", async () => {
    const response = await post("/api/schedules", schedulePost("pom@ams", { name: oversizedName }));
    await expectJsonError(response, 413, "configuration_body_too_large");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 413 JSON for a chunked body without Content-Length", async () => {
    const result = await sendChunked("/api/schedules", 2 * 1024 * 1024);
    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toMatchObject({ error: "configuration_body_too_large" });
    expect(remoteCalls).toEqual([]);
    expectNoDisturbedBodyError();
  });

  it("keeps serving after a client closes the socket in the middle of a body", async () => {
    await abortMidBody("/api/schedules");
    await abortMidBody("/api/relay/gateways/ams/api/schedules");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    expect(remoteCalls).toEqual([]);
    expect(await localJobsFile()).toBeUndefined();
    expectNoDisturbedBodyError();
  });
});

describe("real HTTP adapter: refused configuration requests", () => {
  it.each([
    ["ordinary remote", "/api/schedules", "pom@ams"],
    ["ordinary local", "/api/schedules", "local"],
    ["explicit prefix", "/api/relay/gateways/ams/api/schedules", "pom"],
  ])("returns 400 JSON for malformed %s JSON", async (_label, pathname) => {
    await expectJsonError(await post(pathname, '{"agentId":'), 400, "invalid_configuration_body");
    expect(remoteCalls).toEqual([]);
    expect(await localJobsFile()).toBeUndefined();
  });

  it("returns 400 JSON when the body is not an object", async () => {
    await expectJsonError(await post("/api/schedules", "[1]"), 400, "invalid_configuration_body");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 403 JSON for a foreign Origin and sends nothing to the remote", async () => {
    const response = await post("/api/schedules", schedulePost("pom@ams"), { origin: "https://foreign.test" });
    await expectJsonError(response, 403, "untrusted_origin");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 403 JSON for an external forwarded client", async () => {
    const response = await post("/api/relay/gateways/ams/api/schedules", schedulePost("pom"), { "x-forwarded-for": "192.0.2.1" });
    await expectJsonError(response, 403, "relay_unavailable");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 404 JSON for an unknown gateway suffix", async () => {
    await expectJsonError(await post("/api/schedules", schedulePost("pom@missing")), 404, "unknown_gateway");
    expect(remoteCalls).toEqual([]);
  });
});

describe("real HTTP adapter: OAuth start", () => {
  const start = (body: unknown, headers: Record<string, string> = {}) => post("/api/relay/oauth/start", body, headers);
  const coreStart = { gateway: "ams", agentId: "pom", kind: "core", provider: "google", scope: "team" };

  it("returns 403 JSON when Origin is missing", async () => {
    const response = await fetch(`${base}/api/relay/oauth/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(coreStart) });
    await expectJsonError(response, 403, "untrusted_origin");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 403 JSON when Origin is foreign", async () => {
    await expectJsonError(await start(coreStart, { origin: "https://foreign.test" }), 403, "relay_unavailable");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 415 JSON when the content type is not JSON", async () => {
    await expectJsonError(await start(JSON.stringify(coreStart), { "content-type": "text/plain" }), 415, "json_required");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 413 JSON for an oversized start body", async () => {
    await expectJsonError(await start({ ...coreStart, agentId: oversizedName }), 413, "configuration_body_too_large");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 400 JSON for malformed start JSON", async () => {
    await expectJsonError(await start('{"gateway":'), 400, "invalid_configuration_body");
  });

  it("returns 404 JSON for an unknown gateway", async () => {
    await expectJsonError(await start({ ...coreStart, gateway: "missing" }), 404, "unknown_gateway");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 404 JSON for a provider that the remote does not know", async () => {
    await expectJsonError(await start({ ...coreStart, provider: "nope" }), 404, "unknown_remote_provider");
    expect(remoteCalls.map((call) => call.url)).toEqual(["/api/oauth/nope/authorize?agent=pom&scope=team"]);
  });

  it("returns the remote authorization URL for a known provider", async () => {
    const response = await start(coreStart);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ authorizationUrl: "https://accounts.example.test/auth?state=fake" });
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].authorization).toBe("Bearer fake-bearer");
  });
});

describe("real HTTP adapter: accepted requests", () => {
  it("keeps the local core OAuth scope error as JSON", async () => {
    const response = await fetch(`${base}/api/oauth/fakeprovider/authorize?agent=local&scope=bogus`, { headers: { accept: "application/json" } });
    await expectJsonError(response, 400, "invalid_scope");
  });

  it("sends an ordinary remote schedule POST to the remote gateway with the agent ID unsuffixed", async () => {
    const response = await post("/api/schedules", schedulePost("pom@ams"));
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ id: "remote-job" });
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0]).toMatchObject({ method: "POST", url: "/api/schedules", authorization: "Bearer fake-bearer" });
    expect(JSON.parse(remoteCalls[0].body)).toMatchObject({ agentId: "pom", name: "Synthetic schedule" });
    expect(await localJobsFile()).toBeUndefined();
  });

  it("sends an explicit-prefix schedule POST to the named remote gateway", async () => {
    const response = await post("/api/relay/gateways/ams/api/schedules", schedulePost("pom"));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: "remote-job" });
    expect(remoteCalls.map((call) => call.url)).toEqual(["/api/schedules"]);
    expect(JSON.parse(remoteCalls[0].body)).toMatchObject({ agentId: "pom" });
  });

  it("merges the remote agent into the local agent list", async () => {
    const response = await fetch(`${base}/api/agents`, { headers: { origin: trustedOrigin } });
    expect(response.status).toBe(200);
    const agents = (await response.json()) as Array<{ id: string }>;
    expect(agents.map((agent) => agent.id).sort()).toEqual(["local", "pom@ams"]);
  });

  it("creates a valid large local schedule and does not call the remote", async () => {
    const body = schedulePost("local", { name: "Local schedule", payload: { message: "x".repeat(400_000) } });
    const response = await post("/api/schedules", body);
    expect(response.status).toBe(201);
    const job = await response.json();
    expect(job).toMatchObject(body);
    const list = await fetch(`${base}/api/schedules?agent=local`, { headers: { origin: trustedOrigin } });
    expect(await list.json()).toEqual([job]);
    expect(remoteCalls).toEqual([]);
  });

  it("keeps the local extension gate for a disabled extension", async () => {
    const response = await fetch(`${base}/api/projects`);
    await expectJsonError(response, 404, "extension_disabled");
    expect(remoteCalls).toEqual([]);
  });
});
