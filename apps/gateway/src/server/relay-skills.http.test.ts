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

type RemoteCall = { method: string; url: string; authorization: string | undefined; bytes: Buffer; contentType: string | undefined; contentLength: string | undefined };

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
      remoteCalls.push({
        method: request.method ?? "", url: `${url.pathname}${url.search}`, authorization: request.headers.authorization,
        bytes: Buffer.concat(chunks), contentType: request.headers["content-type"], contentLength: request.headers["content-length"],
      });
      const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization === "Bearer denied-bearer") return reply(403, { error: "forbidden" });
      if (request.headers.authorization !== "Bearer fake-bearer") return reply(401, { error: "unauthorized" });
      if (url.pathname === "/api/skills/import-token" && request.method === "POST") return reply(201, { id: "tok", token: "ski_fake", expiresAt: "2099-01-01T00:00:00Z", prompt: "POST to https://remote.example.test/api/skills/import" });
      if (url.pathname === "/api/skills" && request.method === "GET") return reply(200, { mine: [{ id: "remote-skill", name: "Remote" }], sharedWithMe: [], agent: [{ id: "agent:pom:a", name: "A", agentId: "pom" }] });
      reply(200, { ok: true, path: url.pathname });
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
  home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-skills-"));
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


const prefix = "/api/relay/gateways/ams";
const BOUNDARY = "----yoplaiBoundary7MA4YWxk";
const MiB = 1024 * 1024;

/** A multipart body of exactly `total` bytes, with the filler inside one file part. */
function multipartOf(total: number, boundary = BOUNDARY): Buffer {
  const open = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`);
  const close = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([open, Buffer.alloc(Math.max(0, total - open.length - close.length), 0x61), close]);
}

function upload(method: string, pathname: string, bytes: Buffer | string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, origin: trustedOrigin, ...headers },
    body: typeof bytes === "string" ? bytes : new Uint8Array(bytes),
  });
}

/** Sends the raw request bytes and returns the status line code, or 0 when the socket closes without an answer. */
function rawRequest(lines: string, body: Buffer | string, options: { closeAfterBody?: boolean; destroyAfterMs?: number } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve) => {
    const socket = net.connect(Number(new URL(base).port), "127.0.0.1", () => {
      socket.write(`${lines}\r\n\r\n`);
      socket.write(body);
      if (options.destroyAfterMs !== undefined) setTimeout(() => socket.destroy(), options.destroyAfterMs);
    });
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString("latin1"); });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text }));
    if (options.destroyAfterMs === undefined) setTimeout(() => socket.destroy(), 3000);
  });
}

/** A chunked upload with no Content-Length. Returns the status that the server sent. */
function sendChunked(pathname: string, parts: Buffer[], contentType = `multipart/form-data; boundary=${BOUNDARY}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}${pathname}`);
    const request = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { "content-type": contentType, origin: trustedOrigin, "transfer-encoding": "chunked" } }, (response) => {
      const out: Buffer[] = [];
      response.on("data", (part: Buffer) => out.push(part));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(out).toString() }));
    });
    request.on("error", (error) => { if ((error as NodeJS.ErrnoException).code !== "EPIPE" && (error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); else resolve({ status: 0, body: "" }); });
    let index = 0;
    const next = () => {
      while (index < parts.length) {
        if (!request.write(parts[index++])) return void request.once("drain", next);
      }
      request.end();
    };
    next();
  });
}

describe("real HTTP adapter: skill routes of the named gateway", () => {
  const opaque = "agent:pom@quiet:folder-skill";
  const encoded = encodeURIComponent(opaque);

  it.each([
    ["GET", "/api/skills", undefined],
    ["GET", "/api/skills/recipients", undefined],
    ["GET", "/api/skills/import-token", undefined],
    ["DELETE", "/api/skills/import-token/tok-1", undefined],
    ["GET", `/api/skills/${encoded}`, undefined],
    ["DELETE", `/api/skills/${encoded}`, undefined],
    ["GET", "/api/admin/skills", undefined],
    ["GET", `/api/skills/${encoded}/default`, undefined],
    ["GET", `/api/skills/${encoded}/versions`, undefined],
    ["POST", "/api/skills/import-token", undefined],
    ["POST", `/api/skills/${encoded}/default`, undefined],
    ["POST", `/api/skills/${encoded}/versions/v-1/restore`, undefined],
    ["PUT", `/api/skills/${encoded}/enabled`, { enabled: true }],
    ["PUT", `/api/skills/${encoded}/shares`, { shares: [{ kind: "all", mode: "read" }] }],
    ["PUT", `/api/skills/${encoded}/system`, { system: true }],
    ["PUT", `/api/skills/${encoded}/owner`, { ownerId: "u2" }],
    ["PUT", `/api/skills/${encoded}/admin`, { disabledByAdmin: true }],
  ])("sends %s %s to the named gateway with its bearer, and keeps the opaque ID unchanged", async (method, pathname, body) => {
    const response = await send(method, `${prefix}${pathname}`, body);
    expect(response.status).toBeLessThan(300);
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0]).toMatchObject({ method, url: pathname, authorization: "Bearer fake-bearer" });
    if (body !== undefined) expect(JSON.parse(remoteCalls[0].bytes.toString())).toEqual(body);
    else expect(remoteCalls[0].bytes.length).toBe(0);
  });

  it("never infers a gateway from an agent ID inside a skill ID", async () => {
    // The ID names the gateway "quiet" inside, but the request names "ams". Only "ams" sees it.
    await send("GET", `${prefix}/api/skills/${encoded}`);
    expect(remoteCalls).toHaveLength(1);
    const unprefixed = await send("GET", `/api/skills/${encoded}`);
    // Without a prefix the request stays local and the remote sees nothing more.
    expect(unprefixed.status).toBe(404);
    expect(remoteCalls).toHaveLength(1);
  });

  it("does not allow skill import through the linked bearer, whatever the method", async () => {
    for (const method of ["POST", "PUT", "GET", "DELETE"]) {
      const response = await send(method, `${prefix}/api/skills/import`, method === "GET" || method === "DELETE" ? undefined : { name: "x", files: [] });
      if (method === "GET" || method === "DELETE") {
        // These two spell a skill ID of the name "import". The route table excludes that name.
        expect(response.status).toBe(405);
      } else {
        await expectJsonError(response, 405, "relay_route_not_allowed");
      }
    }
    expect(remoteCalls).toEqual([]);
    const local = await send("POST", "/api/skills/import", { name: "x", files: [] });
    await expectJsonError(local, 401, "unauthorized");
  });

  it("refuses other methods and paths under the skill prefixes, and sends nothing", async () => {
    await expectJsonError(await send("PATCH", `${prefix}/api/skills/abc`, {}), 405, "relay_route_not_allowed");
    await expectJsonError(await send("POST", `${prefix}/api/skills/abc`, {}), 405, "relay_route_not_allowed");
    await expectJsonError(await send("PUT", `${prefix}/api/skills`, {}), 405, "relay_route_not_allowed");
    await expectJsonError(await send("DELETE", `${prefix}/api/skills`), 405, "relay_route_not_allowed");
    await expectJsonError(await send("GET", `${prefix}/api/skills/abc/content`), 405, "relay_route_not_allowed");
    await expectJsonError(await send("POST", `${prefix}/api/skills/abc/other`, {}), 405, "relay_route_not_allowed");
    await expectJsonError(await send("PUT", `${prefix}/api/skills/abc/versions/v/restore`, {}), 405, "relay_route_not_allowed");
    expect(remoteCalls).toEqual([]);
  });

  it("returns the remote refusal and an offline gateway, and an unknown gateway makes no call", async () => {
    await expectJsonError(await send("GET", "/api/relay/gateways/denied/api/skills"), 403, "forbidden");
    await expectJsonError(await send("DELETE", "/api/relay/gateways/denied/api/skills/abc"), 403, "forbidden");
    await expectJsonError(await send("GET", "/api/relay/gateways/offline/api/skills"), 502, "gateway_offline");
    await expectJsonError(await send("GET", "/api/relay/gateways/missing/api/skills"), 404, "unknown_gateway");
    expect(remoteCalls.map((call) => call.authorization)).toEqual(["Bearer denied-bearer", "Bearer denied-bearer"]);
  });

  it("sets no-store on a new import token, and keeps the linked bearer out of the answer", async () => {
    const response = await send("POST", `${prefix}/api/skills/import-token`);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).not.toContain("fake-bearer");
    expect(JSON.parse(text)).toMatchObject({ token: "ski_fake" });
  });

  it("refuses a JSON write with no trusted Origin, a wrong content type, a bad body, or an oversized body, and sends nothing", async () => {
    const target = `${prefix}/api/skills/abc/enabled`;
    await expectJsonError(await fetch(`${base}${target}`, { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" }), 403, "untrusted_origin");
    await expectJsonError(await send("PUT", target, {}, { origin: "https://evil.example.test" }), 403, "relay_unavailable");
    await expectJsonError(await send("PUT", target, "{}", { "content-type": "text/plain" }), 415, "json_required");
    await expectJsonError(await send("PUT", target, "not json"), 400, "invalid_configuration_body");
    await expectJsonError(await send("PUT", `${prefix}/api/skills/abc/shares`, { shares: [], pad: "x".repeat(MiB) }), 413, "configuration_body_too_large");
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a body on a write that must be bodyless, and sends nothing", async () => {
    await expectJsonError(await send("POST", `${prefix}/api/skills/import-token`, {}), 400, "body_not_allowed");
    await expectJsonError(await send("DELETE", `${prefix}/api/skills/abc`, "x"), 400, "body_not_allowed");
    expect(remoteCalls.filter((call) => call.method === "POST" || call.method === "DELETE").length).toBe(0);
  });

  it("keeps a local skill ID with an encoded slash local, and never refuses it as an unsafe remote path", async () => {
    const response = await send("GET", `/api/skills/${encodeURIComponent("agent:local:nested/skill")}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.not.stringMatching(/invalid_remote_path/) });
    expect(remoteCalls).toEqual([]);
    // The same ID for the named gateway is refused before any remote call, because the relay path check bans encoded separators.
    await expectJsonError(await send("GET", `${prefix}/api/skills/${encodeURIComponent("agent:pom:nested/skill")}`), 400, "invalid_remote_path");
    expect(remoteCalls).toEqual([]);
  });

  it("keeps the local skill list local", async () => {
    const response = await send("GET", "/api/skills");
    expect(response.status).toBe(200);
    expect(await response.json()).not.toMatchObject({ mine: [{ id: "remote-skill" }] });
    expect(remoteCalls).toEqual([]);
  });
});

describe("real HTTP adapter: skill uploads", () => {
  it("forwards a small upload with its exact bytes, its boundary header, and the bearer", async () => {
    const bytes = multipartOf(4096);
    const response = await upload("POST", `${prefix}/api/skills`, bytes);
    expect(response.status).toBe(200);
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0]).toMatchObject({ method: "POST", url: "/api/skills", authorization: "Bearer fake-bearer", contentType: `multipart/form-data; boundary=${BOUNDARY}` });
    expect(remoteCalls[0].bytes.equals(bytes)).toBe(true);
  });

  it("forwards a content replacement for an opaque ID unchanged", async () => {
    const id = encodeURIComponent("agent:pom@quiet:x");
    const bytes = multipartOf(2048);
    expect((await upload("PUT", `${prefix}/api/skills/${id}/content`, bytes)).status).toBe(200);
    expect(remoteCalls[0]).toMatchObject({ method: "PUT", url: `/api/skills/${id}/content` });
    expect(remoteCalls[0].bytes.equals(bytes)).toBe(true);
  });

  it("accepts an envelope of exactly 25 MiB, and refuses one byte more before any remote call", async () => {
    const exact = multipartOf(25 * MiB);
    expect(exact.length).toBe(25 * MiB);
    expect((await upload("POST", `${prefix}/api/skills`, exact)).status).toBe(200);
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].bytes.length).toBe(25 * MiB);
    remoteCalls = [];
    const over = multipartOf(25 * MiB + 1);
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, over), 413, "skill_upload_too_large");
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    const result = await rawRequest([
      `POST ${prefix}/api/skills HTTP/1.1`, "Host: 127.0.0.1", `Origin: ${trustedOrigin}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`, `Content-Length: ${25 * MiB + 1}`,
    ].join("\r\n"), "tiny", { destroyAfterMs: 200 });
    expect(result.status).toBe(413);
    expect(remoteCalls).toEqual([]);
  });

  it("stops a chunked upload with no length at the limit, and sends nothing to the remote", async () => {
    const whole = multipartOf(25 * MiB + 4096);
    const parts: Buffer[] = [];
    for (let at = 0; at < whole.length; at += 256 * 1024) parts.push(whole.subarray(at, at + 256 * 1024));
    const result = await sendChunked(`${prefix}/api/skills`, parts);
    expect([413, 0]).toContain(result.status);
    if (result.status === 413) expect(JSON.parse(result.body)).toMatchObject({ error: "skill_upload_too_large" });
    expect(remoteCalls).toEqual([]);
  });

  it("forwards a valid chunked upload with the same bytes", async () => {
    const whole = multipartOf(300 * 1024);
    const parts: Buffer[] = [];
    for (let at = 0; at < whole.length; at += 40 * 1024) parts.push(whole.subarray(at, at + 40 * 1024));
    const result = await sendChunked(`${prefix}/api/skills`, parts);
    expect(result.status).toBe(200);
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].bytes.equals(whole)).toBe(true);
  });

  it("refuses an invalid length header, and a body whose length differs from its header", async () => {
    const head = (length: string) => [
      `POST ${prefix}/api/skills HTTP/1.1`, "Host: 127.0.0.1", `Origin: ${trustedOrigin}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`, `Content-Length: ${length}`, "Connection: close",
    ].join("\r\n");
    const bytes = multipartOf(1024);
    const invalid = await rawRequest(head("12abc"), bytes);
    expect([400, 0]).toContain(invalid.status);
    // A shorter body than the header promises never completes, so the server never forwards it.
    const short = await rawRequest(head(String(bytes.length + 500)), bytes, { destroyAfterMs: 300 });
    expect(short.status).not.toBe(200);
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a body that is not multipart, a body without its delimiters, and an empty body", async () => {
    const bytes = multipartOf(2048);
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, bytes, { "content-type": "application/json" }), 415, "multipart_required");
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, bytes, { "content-type": "multipart/form-data" }), 415, "multipart_required");
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, bytes, { "content-type": `multipart/form-data; boundary=${BOUNDARY}; charset=x` }), 415, "multipart_required");
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, "no multipart at all"), 400, "invalid_multipart");
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, bytes.subarray(0, bytes.length - 20)), 400, "invalid_multipart");
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, multipartOf(2048, "otherBoundary")), 400, "invalid_multipart");
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, ""), 400, "invalid_multipart");
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a body with matching outer delimiters and a malformed inner part before any remote call", async () => {
    const part = (head: string, tail = "x") => `--${BOUNDARY}\r\n${head}\r\n\r\n${tail}\r\n--${BOUNDARY}--\r\n`;
    const bad = [
      part("not-a-header"),
      part("Content-Type: application/zip"),
      part('Content-Disposition: form-data; name="file"\r\nbroken header line'),
      part('Content-Disposition: form-data; name="file"; filename="a.zip"').replace("\r\n\r\nx", "\r\nx"),
      `--${BOUNDARY}\r\n--${BOUNDARY}--\r\n`,
    ];
    for (const body of bad) {
      for (const [method, path] of [["POST", `${prefix}/api/skills`], ["PUT", `${prefix}/api/skills/same-id/content`]]) {
        await expectJsonError(await upload(method, path, body), 400, "invalid_multipart");
      }
    }
    expect(remoteCalls).toEqual([]);
  });

  it("refuses a malformed inner part sent in chunks without a length", async () => {
    const chunks = [Buffer.from(`--${BOUNDARY}\r\nnot-a`), Buffer.from(`-header\r\n\r\nx\r\n--${BOUNDARY}--\r\n`)];
    const answer = await sendChunked(`${prefix}/api/skills`, chunks);
    expect(answer.status).toBe(400);
    expect(remoteCalls).toEqual([]);
  });

  it("still forwards a valid body with several parts and a text field, with its exact bytes", async () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n` +
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a/SKILL.md"\r\nContent-Type: text/markdown\r\n\r\n# Skill\r\n--${BOUNDARY}--\r\n`,
    );
    const response = await upload("PUT", `${prefix}/api/skills/same-id/content`, body);
    expect(response.status).toBe(200);
    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].bytes.equals(body)).toBe(true);
    expect(remoteCalls[0].contentType).toBe(`multipart/form-data; boundary=${BOUNDARY}`);
  });

  it("refuses an upload with no trusted Origin or a foreign one, and sends nothing", async () => {
    const bytes = multipartOf(2048);
    await expectJsonError(await fetch(`${base}${prefix}/api/skills`, { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` }, body: new Uint8Array(bytes) }), 403, "untrusted_origin");
    await expectJsonError(await upload("POST", `${prefix}/api/skills`, bytes, { origin: "https://evil.example.test" }), 403, "relay_unavailable");
    expect(remoteCalls).toEqual([]);
  });

  it("makes no remote call when the client aborts in the middle of an upload, and keeps serving", async () => {
    const bytes = multipartOf(64 * 1024);
    const aborted = await rawRequest([
      `POST ${prefix}/api/skills HTTP/1.1`, "Host: 127.0.0.1", `Origin: ${trustedOrigin}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`, `Content-Length: ${bytes.length}`,
    ].join("\r\n"), bytes.subarray(0, 8 * 1024), { destroyAfterMs: 100 });
    expect(aborted.status).not.toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(remoteCalls).toEqual([]);
    expect((await send("GET", `${prefix}/api/skills`)).status).toBe(200);
  });

  it("keeps a local upload local", async () => {
    const response = await upload("POST", "/api/skills", multipartOf(2048));
    expect(remoteCalls).toEqual([]);
    expect(response.status).not.toBe(403);
  });
});
