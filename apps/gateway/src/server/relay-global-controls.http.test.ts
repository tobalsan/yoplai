import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeTestV3Config } from "../test-utils/v3-config.js";

/**
 * Real `@hono/node-server` adapter on loopback ports that the OS picks. The linked remote gateways are
 * disposable local HTTP servers with fake bearers. One link points at a closed port, so it is offline.
 */

type RemoteCall = { method: string; url: string; authorization: string | undefined; body: string; contentType: string | undefined };

let home: string;
let previousHome: string | undefined;
let server: http.Server;
let remoteServer: http.Server;
let base: string;
let remoteCalls: RemoteCall[] = [];
const originalRequest = globalThis.Request;
const originalResponse = globalThis.Response;
const trustedOrigin = "http://127.0.0.1:3000";

function listen(target: http.Server): Promise<number> {
  return new Promise((resolve) => target.listen(0, "127.0.0.1", () => resolve((target.address() as AddressInfo).port)));
}

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function startRemote(): http.Server {
  return http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://remote.test");
      remoteCalls.push({ method: request.method ?? "", url: `${url.pathname}${url.search}`, authorization: request.headers.authorization, body: Buffer.concat(chunks).toString(), contentType: request.headers["content-type"] });
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization === "Bearer denied-bearer") return reply(403, { error: "forbidden" });
      if (request.headers.authorization !== "Bearer fake-bearer" && request.headers.authorization !== "Bearer other-fake-bearer") return reply(401, { error: "login_required" });
      if (url.pathname === "/api/admin/top-extensions") {
        if (request.method === "GET") return reply(200, { extensions: ["remote-ext"], mcp: [], system: { extensions: [], mcp: [] }, candidates: { extensions: [], mcp: [] } });
        if (request.method === "PUT") return reply(200, JSON.parse(Buffer.concat(chunks).toString()));
      }
      if (url.pathname === "/api/mcp/catalog" && request.method === "GET") return reply(200, { servers: [{ name: "remote-docs", url: "https://docs.example.test/mcp" }] });
      if (url.pathname === "/api/mcp/catalog" && request.method === "POST") return reply(200, { server: { name: "added", url: "https://new.example.test/mcp" } });
      if (url.pathname === "/api/mcp/catalog/update" && request.method === "POST") return reply(200, { server: { name: url.searchParams.get("server"), displayName: "Edited" } });
      if (url.pathname === "/api/mcp/catalog/remove" && request.method === "POST") return reply(200, { ok: true });
      if (url.pathname === "/api/mcp/catalog/icon/refresh" && request.method === "POST") return reply(200, { status: "unchanged", server: { name: url.searchParams.get("server") } });
      if (url.pathname === "/api/forbidden-admin") return reply(403, { error: "forbidden" });
      reply(404, { error: "not_found" });
    });
  });
}

function send(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), origin: trustedOrigin, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectJsonError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toMatchObject({ error });
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-global-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  await writeTestV3Config(home, { agents: [{ id: "local" }] });
  vi.resetModules();
  remoteServer = startRemote();
  const remotePort = await listen(remoteServer);
  const offlinePort = await closedPort();
  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", false);
  state.getRemoteGatewayStore().save({ name: "ams", url: `http://127.0.0.1:${remotePort}`, token: "fake-bearer" });
  state.getRemoteGatewayStore().save({ name: "quiet", url: `http://127.0.0.1:${remotePort}`, token: "other-fake-bearer" });
  state.getRemoteGatewayStore().save({ name: "denied", url: `http://127.0.0.1:${remotePort}`, token: "denied-bearer" });
  state.getRemoteGatewayStore().save({ name: "offline", url: `http://127.0.0.1:${offlinePort}`, token: "fake-bearer" });
  const { app } = await import("./index.js");
  const { serve } = await import("@hono/node-server");
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  remoteServer?.closeAllConnections();
  await new Promise((resolve) => remoteServer?.close(resolve));
  const state = await import("../relay/state.js");
  for (const name of ["ams", "quiet", "denied", "offline"]) state.getRemoteGatewayStore().remove(name);
  state.configureRelay("127.0.0.1", true);
  Object.defineProperty(globalThis, "Request", { value: originalRequest });
  Object.defineProperty(globalThis, "Response", { value: originalResponse });
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  remoteCalls = [];
});

describe("real HTTP adapter: configured gateway list", () => {
  it("lists every configured name, also a gateway that is offline, and nothing else", async () => {
    const response = await send("GET", "/api/relay/gateways");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ gateways: [{ name: "ams" }, { name: "quiet" }, { name: "denied" }, { name: "offline" }] });
    // No URL, no token, no store field.
    expect(text).not.toMatch(/127\.0\.0\.1|fake-bearer|token|url/i);
    expect(remoteCalls).toEqual([]);
  });

  it("answers with no Origin for a command-line client, and refuses a foreign Origin and a forwarded external client", async () => {
    expect((await fetch(`${base}/api/relay/gateways`)).status).toBe(200);
    await expectJsonError(await send("GET", "/api/relay/gateways", undefined, { origin: "https://evil.example.test" }), 403, "untrusted_origin");
    await expectJsonError(await send("GET", "/api/relay/gateways", undefined, { "x-forwarded-for": "203.0.113.9" }), 403, "untrusted_origin");
  });

  it("accepts only GET", async () => {
    const response = await send("POST", "/api/relay/gateways", {});
    await expectJsonError(response, 405, "method_not_allowed");
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("refuses with an explicit disabled result, not an empty list, while the relay is off", async () => {
    const state = await import("../relay/state.js");
    state.configureRelay("127.0.0.1", true);
    try {
      await expectJsonError(await send("GET", "/api/relay/gateways"), 403, "relay_unavailable");
    } finally {
      state.configureRelay("127.0.0.1", false);
    }
  });
});

describe("real HTTP adapter: global extension and catalog routes", () => {
  it("reads and writes the Top flags of the named gateway with its bearer, and keeps the body bytes", async () => {
    const read = await send("GET", "/api/relay/gateways/ams/api/admin/top-extensions");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ extensions: ["remote-ext"] });
    const next = { extensions: ["a"], mcp: ["https://x.example.test/mcp"], system: { extensions: [], mcp: [] } };
    const write = await send("PUT", "/api/relay/gateways/ams/api/admin/top-extensions", next);
    expect(write.status).toBe(200);
    expect(remoteCalls.map((call) => `${call.method} ${call.url}`)).toEqual(["GET /api/admin/top-extensions", "PUT /api/admin/top-extensions"]);
    expect(remoteCalls.every((call) => call.authorization === "Bearer fake-bearer")).toBe(true);
    expect(JSON.parse(remoteCalls[1].body)).toEqual(next);
  });

  it("keeps two gateways with the same route apart by their own bearer", async () => {
    await send("GET", "/api/relay/gateways/quiet/api/admin/top-extensions");
    expect(remoteCalls[0].authorization).toBe("Bearer other-fake-bearer");
  });

  it("sends each catalog write to the named gateway and keeps the server name unchanged", async () => {
    const name = "my server/é";
    const encoded = encodeURIComponent(name);
    const prefix = "/api/relay/gateways/ams/api/mcp/catalog";
    expect((await send("GET", prefix)).status).toBe(200);
    expect((await send("POST", prefix, { url: "https://new.example.test/mcp", displayName: "New" })).status).toBe(200);
    expect((await send("POST", `${prefix}/update?server=${encoded}`, { displayName: "Edited", description: "" })).status).toBe(200);
    expect((await send("POST", `${prefix}/icon/refresh?server=${encoded}`)).status).toBe(200);
    expect((await send("POST", `${prefix}/remove?server=${encoded}`)).status).toBe(200);
    expect(remoteCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /api/mcp/catalog",
      "POST /api/mcp/catalog",
      `POST /api/mcp/catalog/update?server=${encoded}`,
      `POST /api/mcp/catalog/icon/refresh?server=${encoded}`,
      `POST /api/mcp/catalog/remove?server=${encoded}`,
    ]);
    expect(JSON.parse(remoteCalls[1].body)).toEqual({ url: "https://new.example.test/mcp", displayName: "New" });
    // The bodyless writes stay bodyless.
    expect(remoteCalls[3].body).toBe("");
    expect(remoteCalls[4].body).toBe("");
  });

  it("returns the remote 403 unchanged and makes no local change", async () => {
    const before = await send("GET", "/api/admin/top-extensions");
    const refused = await send("PUT", "/api/relay/gateways/denied/api/admin/top-extensions", { extensions: ["x"] });
    await expectJsonError(refused, 403, "forbidden");
    await expectJsonError(await send("POST", "/api/relay/gateways/denied/api/mcp/catalog/remove?server=docs"), 403, "forbidden");
    expect(await (await send("GET", "/api/admin/top-extensions")).json()).toEqual(await before.json());
  });

  it("returns 502 for an offline gateway and never reaches another gateway or the local list", async () => {
    await expectJsonError(await send("GET", "/api/relay/gateways/offline/api/admin/top-extensions"), 502, "gateway_offline");
    await expectJsonError(await send("POST", "/api/relay/gateways/offline/api/mcp/catalog/remove?server=docs"), 502, "gateway_offline");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 404 for an unknown gateway and does not fall back to the local routes", async () => {
    await expectJsonError(await send("PUT", "/api/relay/gateways/missing/api/admin/top-extensions", { extensions: [] }), 404, "unknown_gateway");
    await expectJsonError(await send("POST", "/api/relay/gateways/missing/api/mcp/catalog", { url: "https://x.example.test/mcp" }), 404, "unknown_gateway");
    expect(remoteCalls).toEqual([]);
  });

  it("allows only the named methods and paths, and nothing else under these prefixes", async () => {
    await expectJsonError(await send("DELETE", "/api/relay/gateways/ams/api/mcp/catalog"), 405, "relay_route_not_allowed");
    await expectJsonError(await send("POST", "/api/relay/gateways/ams/api/admin/top-extensions", {}), 405, "relay_route_not_allowed");
    await expectJsonError(await send("GET", "/api/relay/gateways/ams/api/admin/users"), 405, "relay_route_not_allowed");
    await expectJsonError(await send("POST", "/api/relay/gateways/ams/api/mcp/catalog/other"), 405, "relay_route_not_allowed");
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a write with no trusted Origin, a foreign Origin, or a body that is not JSON, and sends nothing", async () => {
    const target = "/api/relay/gateways/ams/api/admin/top-extensions";
    await expectJsonError(await fetch(`${base}${target}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }), 403, "untrusted_origin");
    // A page of another site never reaches the relay at all.
    await expectJsonError(await send("PUT", target, {}, { origin: "https://evil.example.test" }), 403, "relay_unavailable");
    await expectJsonError(await send("PUT", target, "{}", { "content-type": "text/plain" }), 415, "json_required");
    await expectJsonError(await send("PUT", target, "not json"), 400, "invalid_configuration_body");
    expect(remoteCalls).toEqual([]);
  });

  it("returns 413 for an oversized write body and sends nothing", async () => {
    const response = await send("POST", "/api/relay/gateways/ams/api/mcp/catalog", { url: "https://x.example.test/mcp", displayName: "x".repeat(1_048_576) });
    await expectJsonError(response, 413, "configuration_body_too_large");
    expect(remoteCalls).toEqual([]);
  });

  it("keeps the local routes local: no prefix means no remote call", async () => {
    const local = await send("GET", "/api/admin/top-extensions");
    expect(local.status).toBe(200);
    expect(await local.json()).not.toMatchObject({ extensions: ["remote-ext"] });
    const catalog = await send("GET", "/api/mcp/catalog");
    expect(catalog.status).not.toBe(200);
    expect(remoteCalls).toEqual([]);
  });
});
