import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeSkillId } from "@yoplai/shared/skill-id-wire";
import { writeTestV3Config } from "../test-utils/v3-config.js";

/**
 * The skill ID alias through the real Node adapter. The local gateway is the real server. The linked remotes are real
 * Node servers that run the actual skill handlers over a real store and a real policy. Only the account lookup is a
 * stand-in: a linked bearer names the account. An old peer is a plain server with no alias route.
 */

type Call = { method: string; url: string; authorization: string | undefined; bytes: number };
type Remote = { server: http.Server; port: number; calls: Call[]; home: string; store: import("../skills/store.js").SkillStore };

const wire = encodeSkillId;
const trustedOrigin = "http://127.0.0.1:3000";
const BOUNDARY = "----yoplaiBoundary7MA4YWxk";
const MiB = 1024 * 1024;
const nested = "agent:hr:category/folder-name";
const second = "agent:hr:category/second";
const skillText = (name: string) => `---\nname: ${name}\ndescription: About ${name}.\n---\nBody of ${name}.`;
const originalRequest = globalThis.Request;
const originalResponse = globalThis.Response;

let home: string;
let previousHome: string | undefined;
let local: http.Server;
let base: string;
let east: Remote;
let west: Remote;
let old: { server: http.Server; calls: Call[] };
const closers: Array<() => Promise<void>> = [];

const listen = (target: http.Server): Promise<number> => new Promise((resolve) => target.listen(0, "127.0.0.1", () => resolve((target.address() as AddressInfo).port)));
const close = (target: http.Server) => async () => { target.closeAllConnections(); await new Promise((resolve) => target.close(resolve)); };

async function startRemote(label: string, nestedName: string): Promise<Remote> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `skill-alias-${label}-`));
  const agentDir = path.join(dir, "agents/hr");
  await fs.mkdir(path.join(agentDir, "category/folder-name"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "category/folder-name/SKILL.md"), skillText(nestedName));
  await fs.mkdir(path.join(agentDir, "category/second"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "category/second/SKILL.md"), skillText("second-skill"));
  const { SkillStore } = await import("../skills/store.js");
  const { SkillAccessPolicy } = await import("../skills/access.js");
  const { ImportTokenStore } = await import("../skills/import-tokens.js");
  const { createSkillRoutes } = await import("../skills/routes.js");
  const { getEligibleAccount } = await import("@yoplai/extension-multi-user");
  const { default: Database } = await import("better-sqlite3");
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE user(id TEXT, name TEXT, email TEXT, role TEXT, approved INTEGER, banned INTEGER)");
  const insert = db.prepare("INSERT INTO user VALUES (?, ?, ?, ?, ?, ?)");
  for (const id of ["root", "alice", "banned"]) insert.run(id, id, `${id}@test.invalid`, id === "root" ? "superadmin" : "user", 1, id === "banned" ? 1 : 0);
  const store = new SkillStore(dir);
  const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => getEligibleAccount(db, id) });
  const calls: Call[] = [];
  const app = new Hono();
  app.use("*", async (c, next) => {
    const bytes = c.req.method === "GET" || c.req.method === "DELETE" ? 0 : (await c.req.raw.clone().arrayBuffer()).byteLength;
    calls.push({ method: c.req.method, url: new URL(c.req.url).pathname, authorization: c.req.header("authorization"), bytes });
    await next();
  });
  app.route("/api", createSkillRoutes({
    getContext: async () => ({ store, policy, multiUser: true }), tokens: new ImportTokenStore(dir),
    getActor: async (c) => {
      const id = ({ "Bearer bearer-root": "root", "Bearer bearer-alice": "alice", "Bearer bearer-banned": "banned" } as Record<string, string>)[c.req.header("authorization") ?? ""];
      const account = id ? getEligibleAccount(db, id) : undefined;
      return account ? { userId: account.id, role: account.role } : undefined;
    },
    getAgents: async () => [{ id: "hr", name: "HR", directory: agentDir }], getOwnerName: async (id) => id,
    getRecipients: async () => ["root", "alice"].map((id) => ({ id, name: id, email: `${id}@test.invalid` })),
    publicBaseUrl: () => "https://skills.example.test",
  }));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
  const port = server.listening ? (server.address() as AddressInfo).port : await listen(server).catch(() => (server.address() as AddressInfo).port);
  closers.push(close(server), async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { server, port, calls, home: dir, store };
}

function startOldPeer() {
  const calls: Call[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      calls.push({ method: request.method ?? "", url: new URL(request.url ?? "/", "http://old.test").pathname, authorization: request.headers.authorization, bytes: Buffer.concat(chunks).length });
      // The shape of an older gateway: a known legacy route answers, every other route is a plain 404.
      if (request.url?.startsWith("/api/skills/")) { response.writeHead(200, { "content-type": "application/json" }); return response.end(JSON.stringify({ ok: true })); }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404 Not Found");
    });
  });
  closers.push(close(server));
  return { server, calls };
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-skill-alias-"));
  previousHome = process.env.YOPLAI_HOME;
  process.env.YOPLAI_HOME = home;
  await writeTestV3Config(home, { agents: [{ id: "local" }] });
  vi.resetModules();
  east = await startRemote("east", "east-nested");
  west = await startRemote("west", "west-nested");
  old = startOldPeer();
  const oldPort = await listen(old.server);
  const state = await import("../relay/state.js");
  state.configureRelay("127.0.0.1", false);
  const links = state.getRemoteGatewayStore();
  links.save({ name: "east", url: `http://127.0.0.1:${east.port}`, token: "bearer-root" });
  links.save({ name: "west", url: `http://127.0.0.1:${west.port}`, token: "bearer-alice" });
  links.save({ name: "banned", url: `http://127.0.0.1:${east.port}`, token: "bearer-banned" });
  links.save({ name: "old", url: `http://127.0.0.1:${oldPort}`, token: "bearer-root" });
  const { app } = await import("./index.js");
  const { serve } = await import("@hono/node-server");
  local = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
  if (!local.listening) await new Promise((resolve) => local.once("listening", resolve));
  base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  closers.push(close(local));
});

afterAll(async () => {
  for (const closer of closers.reverse()) await closer();
  const state = await import("../relay/state.js");
  for (const name of ["east", "west", "banned", "old"]) state.getRemoteGatewayStore().remove(name);
  state.configureRelay("127.0.0.1", true);
  Object.defineProperty(globalThis, "Request", { value: originalRequest });
  Object.defineProperty(globalThis, "Response", { value: originalResponse });
  if (previousHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousHome;
  await fs.rm(home, { recursive: true, force: true });
});

beforeEach(() => {
  east.calls.length = 0;
  west.calls.length = 0;
  old.calls.length = 0;
});

const through = (gateway: string) => `/api/relay/gateways/${gateway}`;
function send(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), origin: trustedOrigin, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
const files = (name: string, text = skillText(name)) => { const form = new FormData(); form.append("files", new File([text], "SKILL.md")); return form; };
const sendForm = (method: string, pathname: string, form: FormData) => fetch(`${base}${pathname}`, { method, headers: { origin: trustedOrigin }, body: form });
const json = async (response: Response) => response.json() as Promise<{ id: string; versions: Array<{ id: string }>; skillMd?: string } & Record<string, unknown>>;

function multipartOf(total: number): Buffer {
  const open = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="skill.zip"\r\nContent-Type: application/zip\r\n\r\n`);
  const close = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return Buffer.concat([open, Buffer.alloc(Math.max(0, total - open.length - close.length), 0x61), close]);
}
const uploadBytes = (method: string, pathname: string, bytes: Buffer | string, headers: Record<string, string> = {}) =>
  fetch(`${base}${pathname}`, { method, headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, origin: trustedOrigin, ...headers }, body: typeof bytes === "string" ? bytes : new Uint8Array(bytes) });

function rawRequest(lines: string, body: Buffer | string, destroyAfterMs: number): Promise<{ status: number }> {
  return new Promise((resolve) => {
    const socket = net.connect(Number(new URL(base).port), "127.0.0.1", () => {
      socket.write(`${lines}\r\n\r\n`);
      socket.write(body);
      setTimeout(() => socket.destroy(), destroyAfterMs);
    });
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString("latin1"); });
    socket.on("error", () => undefined);
    socket.on("close", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0) }));
  });
}

describe("nested agent skills through the alias, to the actual skill handlers", () => {
  it("reads, marks as system, checks, and makes a default of nested agent skills, with the exact IDs", async () => {
    const detail = await send("GET", `${through("east")}/api/skill-ids/${wire(nested)}`);
    expect(detail.status).toBe(200);
    expect(await json(detail)).toMatchObject({ id: nested, name: "east-nested", locked: true, kind: "agent", agentId: "hr@east" });
    expect((await send("PUT", `${through("east")}/api/skill-ids/${wire(nested)}/system`, { system: true })).status).toBe(200);
    expect(await east.store.systemAgentSkills()).toContain(nested);
    const check = await send("GET", `${through("east")}/api/skill-ids/${wire(second)}/default`);
    expect(await json(check)).toEqual({ outsidePaths: [] });
    const made = await send("POST", `${through("east")}/api/skill-ids/${wire(second)}/default`);
    expect(made.status).toBe(200);
    expect(await json(made)).toEqual({ id: "default:second-skill", name: "second-skill" });
    // The remote saw the alias path only, with the linked bearer, and no legacy object path.
    expect(east.calls.map((call) => `${call.method} ${call.url} ${call.authorization}`)).toEqual([
      `GET /api/skill-ids/${wire(nested)} Bearer bearer-root`,
      `PUT /api/skill-ids/${wire(nested)}/system Bearer bearer-root`,
      `GET /api/skill-ids/${wire(second)}/default Bearer bearer-root`,
      `POST /api/skill-ids/${wire(second)}/default Bearer bearer-root`,
    ]);
    expect(west.calls).toEqual([]);
  });

  it("keeps equal IDs on two gateways apart and keeps each remote policy", async () => {
    const westDetail = await json(await send("GET", `${through("west")}/api/skill-ids/${wire(nested)}`));
    expect(westDetail).toMatchObject({ id: nested, name: "west-nested" });
    // The account of the west link is not its superadmin, so the remote refuses the administration.
    expect((await send("PUT", `${through("west")}/api/skill-ids/${wire(nested)}/system`, { system: true })).status).toBe(403);
    expect(await west.store.systemAgentSkills()).toEqual([]);
    expect((await send("GET", `${through("west")}/api/skill-ids/${wire(nested)}/default`)).status).toBe(403);
    expect((await send("GET", `${through("west")}/api/admin/skills`)).status).toBe(403);
    expect(east.calls).toEqual([]);
  });

  it("passes a remote refusal of an inactive account without a local role", async () => {
    const response = await send("GET", `${through("banned")}/api/skill-ids/${wire(nested)}`);
    expect(response.status).toBe(401);
    expect(await east.store.systemAgentSkills()).not.toContain("banned");
  });

  it("runs the user skill flow through the alias: create, replace, enable, share, version, restore, delete", async () => {
    const created = await sendForm("POST", `${through("east")}/api/skills`, files("flow-skill"));
    expect(created.status).toBe(201);
    const { id } = await json(created);
    const alias = `${through("east")}/api/skill-ids/${wire(id)}`;
    expect(await json(await send("GET", alias))).toMatchObject({ id, name: "flow-skill", canManage: true });
    expect((await sendForm("PUT", `${alias}/content`, files("flow-skill", skillText("flow-skill") + "\nSecond."))).status).toBe(200);
    expect((await send("PUT", `${alias}/enabled`, { enabled: true })).status).toBe(200);
    expect((await send("PUT", `${alias}/shares`, { shares: [{ kind: "user", id: "alice", mode: "read" }] })).status).toBe(200);
    expect((await east.store.get(id))?.shares).toEqual([{ kind: "user", id: "alice", mode: "read" }]);
    const { versions } = await json(await send("GET", `${alias}/versions`));
    expect(versions).toHaveLength(1);
    expect((await send("POST", `${alias}/versions/${versions[0].id}/restore`)).status).toBe(200);
    expect(await json(await send("GET", alias))).toMatchObject({ skillMd: skillText("flow-skill") });
    expect((await send("DELETE", alias)).status).toBe(200);
    expect(await east.store.get(id)).toBeNull();
  });
});

describe("invalid IDs and routes stop before any upstream request", () => {
  it.each([
    ["no version", "YWJj"],
    ["an unknown version", "v2_YWJj"],
    ["padding", "v1_YQ=="],
    ["a noncanonical form", "v1_YR"],
    ["malformed UTF-8", "v1_" + Buffer.from([0xff, 0xfe]).toString("base64url")],
    ["only the prefix", "v1_"],
    ["a percent escape", "v1_YWJj%2F"],
    ["an encoded slash", "v1_YW%2Fj"],
    ["a double encoding", "v1_YW%252Fj"],
    ["an encoded backslash", "v1_YW%5Cj"],
    ["a dot segment", ".."],
    ["an encoded dot segment", "%2e%2e"],
  ])("refuses %s in the wire ID", async (_name, id) => {
    for (const [method, suffix, body] of [["GET", "", undefined], ["DELETE", "", undefined], ["PUT", "/enabled", { enabled: true }], ["PUT", "/system", { system: true }], ["POST", "/default", undefined]] as Array<[string, string, unknown?]>) {
      const response = await send(method, `${through("east")}/api/skill-ids/${id}${suffix}`, body);
      expect([400, 405]).toContain(response.status);
    }
    expect(east.calls).toEqual([]);
  });

  it("refuses unknown actions, extra segments, other methods, and a missing wire ID", async () => {
    const id = wire(nested);
    for (const [method, url] of [
      ["POST", `/api/skill-ids/${id}`], ["PATCH", `/api/skill-ids/${id}`], ["GET", "/api/skill-ids"], ["GET", "/api/skill-ids/"],
      ["GET", `/api/skill-ids/${id}/other`], ["GET", `/api/skill-ids/${id}/enabled`], ["POST", `/api/skill-ids/${id}/content`],
      ["GET", `/api/skill-ids/${id}/versions/v-1/restore`], ["POST", `/api/skill-ids/${id}/versions/v-1/restore/extra`],
      ["GET", `/api/skill-ids/${id}/import-token`], ["POST", `/api/skill-ids/${id}/import`], ["GET", `/api/skill-ids/${id}/default/extra`],
    ]) {
      const response = await send(method, `${through("east")}${url}`, method === "GET" ? undefined : {});
      expect({ method, url, status: response.status }).toEqual({ method, url, status: 405 });
    }
    expect(east.calls).toEqual([]);
  });

  it("keeps the generic separator guard outside the alias, and the legacy routes unchanged", async () => {
    for (const url of ["/api/skills/a%2Fb", "/api/skills/a%5Cb", "/api/skills/a%25b", "/api/skills/a%2Fb/versions"]) {
      const response = await send("GET", `${through("east")}${url}`);
      expect({ url, status: response.status }).toEqual({ url, status: 400 });
    }
    expect(east.calls).toEqual([]);
    // An encoded colon is not a separator, so the legacy route still carries an opaque ID.
    expect((await send("GET", `${through("east")}/api/skills/${encodeURIComponent("agent:hr:x")}`)).status).toBe(404);
    expect(east.calls).toHaveLength(1);
  });

  it("names no import route, no other gateway, and no path with an encoded ID", async () => {
    for (const id of ["import", "../import", "../../etc/passwd", "west", "agent:hr:../../outside", "recipients", "import-token"]) {
      const response = await send("GET", `${through("east")}/api/skill-ids/${wire(id)}`);
      expect({ id, status: response.status }).toEqual({ id, status: 404 });
    }
    // Each request reached only the east remote, as an alias lookup. Nothing reached west or the import endpoint.
    expect(east.calls.every((call) => call.url.startsWith("/api/skill-ids/"))).toBe(true);
    expect(east.calls).toHaveLength(7);
    expect(west.calls).toEqual([]);
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      expect((await send(method, `${through("east")}/api/skills/import`, method === "GET" ? undefined : {})).status).toBe(405);
    }
    expect(east.calls).toHaveLength(7);
  });

  it("uses the linked bearer and never an import token or a caller credential", async () => {
    const response = await send("GET", `${through("east")}/api/skill-ids/${wire(nested)}`, undefined, { authorization: "Bearer ski_callertoken", cookie: "session=caller" });
    expect(response.status).toBe(200);
    expect(east.calls.map((call) => call.authorization)).toEqual(["Bearer bearer-root"]);
  });
});

describe("alias writes keep the body, Origin, and upload protections", () => {
  const alias = () => `${through("east")}/api/skill-ids/${wire(nested)}`;
  const stateBefore = () => east.store.systemAgentSkills();

  it("refuses an untrusted Origin, an oversize JSON body, and a body on a bodyless write", async () => {
    const before = await stateBefore();
    const foreign = await fetch(`${base}${alias()}/system`, { method: "PUT", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ system: true }) });
    expect(foreign.status).toBe(403);
    const none = await fetch(`${base}${alias()}/system`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ system: true }) });
    expect(none.status).toBe(403);
    const big = await send("PUT", `${alias()}/system`, JSON.stringify({ system: true, pad: "a".repeat(MiB + 10) }));
    expect(big.status).toBe(413);
    expect((await send("DELETE", alias(), { force: true })).status).toBe(400);
    expect((await send("POST", `${alias()}/default`, { force: true })).status).toBe(400);
    expect((await send("PUT", `${alias()}/system`, "not json")).status).toBe(400);
    expect(east.calls).toEqual([]);
    expect(await stateBefore()).toEqual(before);
  });

  it("refuses malformed, mismatched, over-limit, and aborted uploads with no remote call", async () => {
    const id = wire("user-skill-1");
    const url = `${through("east")}/api/skill-ids/${id}/content`;
    expect((await uploadBytes("PUT", url, "no multipart")).status).toBe(400);
    expect((await uploadBytes("PUT", url, `--${BOUNDARY}\r\nnot-a-header\r\n\r\nx\r\n--${BOUNDARY}--\r\n`)).status).toBe(400);
    expect((await uploadBytes("PUT", url, multipartOf(2048), { "content-type": "application/json" })).status).toBe(415);
    expect((await uploadBytes("PUT", url, multipartOf(25 * MiB + 1))).status).toBe(413);
    const declared = await rawRequest([
      `PUT ${url} HTTP/1.1`, "Host: 127.0.0.1", `Origin: ${trustedOrigin}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`, `Content-Length: ${25 * MiB + 1}`,
    ].join("\r\n"), "tiny", 200);
    expect(declared.status).toBe(413);
    const aborted = await rawRequest([
      `PUT ${url} HTTP/1.1`, "Host: 127.0.0.1", `Origin: ${trustedOrigin}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`, "Content-Length: 4096",
    ].join("\r\n"), multipartOf(2048).subarray(0, 1000), 200);
    expect(aborted.status).not.toBe(200);
    expect(east.calls).toEqual([]);
  });

  it("forwards an envelope of exactly 25 MiB to the alias, and no store change follows an invalid file", async () => {
    const response = await uploadBytes("PUT", `${through("east")}/api/skill-ids/${wire("user-skill-1")}/content`, multipartOf(25 * MiB));
    // The remote answers for itself. The relay forwarded the whole envelope, and the remote found no such skill.
    expect([404, 400, 413]).toContain(response.status);
    expect(east.calls).toHaveLength(1);
    expect(east.calls[0]).toMatchObject({ method: "PUT", url: `/api/skill-ids/${wire("user-skill-1")}/content`, bytes: 25 * MiB });
  });
});

describe("a peer that has no alias", () => {
  it("passes the failure and never retries the mutation on a legacy route", async () => {
    const response = await send("PUT", `${through("old")}/api/skill-ids/${wire(nested)}/system`, { system: true });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
    expect(old.calls.map((call) => `${call.method} ${call.url}`)).toEqual([`PUT /api/skill-ids/${wire(nested)}/system`]);
  });

  it("still serves the legacy routes of the old peer for ordinary IDs", async () => {
    const response = await send("GET", `${through("old")}/api/skills/plain-id`);
    expect(response.status).toBe(200);
    expect(old.calls.map((call) => call.url)).toEqual(["/api/skills/plain-id"]);
  });
});

describe("the remote alias checks the raw wire segment (direct sockets to the actual skill router)", () => {
  /** A raw request to the remote. The path reaches the router exactly as written. */
  function direct(method: string, rawPath: string, body?: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port: east.port, method, path: rawPath, headers: { authorization: "Bearer bearer-root", ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }) } }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString() }));
      });
      request.on("error", reject);
      request.end(body);
    });
  }
  const good = wire(nested);
  // The same canonical wire ID with one escaped character: the prefix, the first payload character, a middle one, and the last one.
  const escape = (index: number) => `${good.slice(0, index)}%${good.charCodeAt(index).toString(16).toUpperCase()}${good.slice(index + 1)}`;
  const escaped = [
    ["the version prefix", `%76%31_${good.slice(3)}`],
    ["one prefix character", escape(0)],
    ["the underscore of the prefix", escape(2)],
    ["the first payload character", escape(3)],
    ["a middle payload character", escape(Math.floor(good.length / 2))],
    ["the last payload character", escape(good.length - 1)],
    ["a lower-case escape", `${good.slice(0, 3)}%${good.charCodeAt(3).toString(16).toLowerCase()}${good.slice(4)}`],
    ["a double escape", `%2576%31_${good.slice(3)}`],
    ["an escaped slash", `${good}%2Fextra`],
    ["an escaped percent", `${good}%25`],
    ["an escaped space", `${good}%20`],
  ];
  const actions: Array<[string, string, string?]> = [["GET", ""], ["DELETE", ""], ["PUT", "/enabled", "{\"enabled\":true}"], ["PUT", "/system", "{\"system\":false}"], ["PUT", "/shares", "{\"shares\":[]}"], ["GET", "/default"], ["POST", "/default"], ["GET", "/versions"], ["PUT", "/owner", "{\"ownerId\":\"alice\"}"], ["PUT", "/admin", "{\"disabledByAdmin\":true}"]];

  it.each(escaped)("answers 400 for %s, whatever the action, and changes no stored state", async (_name, segment) => {
    const before = JSON.stringify({ system: await east.store.systemAgentSkills(), list: await east.store.list(), defaults: (await east.store.defaults()).map((skill) => skill.id) });
    for (const [method, suffix, body] of actions) {
      const response = await direct(method, `/api/skill-ids/${segment}${suffix}`, body);
      expect({ segment, method, suffix, status: response.status }).toEqual({ segment, method, suffix, status: 400 });
      expect(JSON.parse(response.text)).toEqual({ error: "invalid_skill_id" });
    }
    expect(JSON.stringify({ system: await east.store.systemAgentSkills(), list: await east.store.list(), defaults: (await east.store.defaults()).map((skill) => skill.id) })).toBe(before);
    // The nested skill is still there and still reads through its canonical wire ID.
    expect((await direct("GET", `/api/skill-ids/${good}`)).status).toBe(200);
  });

  it("serves the canonical segment and keeps the legacy :id route unchanged", async () => {
    const alias = await direct("GET", `/api/skill-ids/${good}`);
    expect(alias.status).toBe(200);
    expect(JSON.parse(alias.text)).toMatchObject({ id: nested });
    // The legacy route still decodes its :id once, as before this change.
    const legacy = await direct("GET", `/api/skills/${encodeURIComponent(nested)}`);
    expect(legacy.status).toBe(200);
    expect(JSON.parse(legacy.text)).toMatchObject({ id: nested });
    expect((await direct("GET", "/api/skills/agent%3Ahr%3Amissing")).status).toBe(404);
  });

  it("keeps the relay refusal in front of the same forms", async () => {
    east.calls.length = 0;
    for (const [, segment] of escaped) expect([400, 405]).toContain((await send("GET", `${through("east")}/api/skill-ids/${segment}`)).status);
    expect(east.calls).toEqual([]);
  });
});
