import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { relayHttp } from "./http.js";
import { fetchRemote, isSafeRemotePath, remoteHttpUrl } from "./remote.js";
import type { RemoteGateway } from "./store.js";

const fixture = vi.hoisted(() => ({
  gateways: [
    { name: "east", url: "https://east.test", token: "fake-east-bearer" },
    { name: "west", url: "https://west.test", token: "fake-west-bearer" },
  ] as RemoteGateway[],
  localIds: new Set(["local", "same@east"]),
}));
vi.mock("../config/index.js", () => ({
  getAgent: (id: string) => fixture.localIds.has(id) ? { id } : undefined,
  loadConfig: () => ({ gateway: { port: 4700 }, ui: { port: 3700 }, web: { baseUrl: "http://localhost:3701" } }),
}));
vi.mock("./state.js", async (original) => ({ ...await original<typeof import("./state.js")>(), getLinkedGateways: () => fixture.gateways }));

const origin = "http://localhost:3700";
const prefix = (name = "east") => `/api/relay/gateways/${name}`;
const startInput = { gateway: "east", agentId: "agent@east", kind: "core", provider: "google", scope: "personal", scopes: ["email"] };
const json = (body: unknown, extra: HeadersInit = {}): RequestInit => ({ method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

let localCalls: string[];
let app: Hono;
let remote: ReturnType<typeof vi.fn<typeof fetch>>;
let records: Array<{ url: URL; init: RequestInit; body: string; headers: Headers }>;
let answer: (url: URL, init: RequestInit) => Response;

beforeEach(() => {
  localCalls = [];
  records = [];
  fixture.localIds = new Set(["local", "same@east"]);
  answer = () => Response.json({ agentId: "agent", id: "object@east" });
  remote = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? await new Response(init.body).text() : "";
    records.push({ url, init, body, headers: new Headers(init.headers) });
    return answer(url, init);
  });
  vi.stubGlobal("fetch", remote);
  app = new Hono();
  app.use("/api/*", relayHttp());
  app.all("*", (c) => {
    localCalls.push(`${c.req.method} ${c.req.path}`);
    return c.json({ local: true });
  });
});
afterEach(() => vi.unstubAllGlobals());

const mutations: Array<[string, string, unknown?]> = [
  ["PATCH", "/api/agents/agent@east/extensions/ext", { config: { text: "agent@east" }, credentialScope: "personal" }],
  ["DELETE", "/api/agents/agent@east/extensions/ext/credentials"],
  ["DELETE", "/api/agents/agent@east/connections/oauth/google"],
  ["PATCH", "/api/agents/agent@east/webhooks/hook", { enabled: true }],
  ["POST", "/api/oauth/google/disconnect?agent=agent@east&scope=personal"],
  ["POST", "/api/mcp/servers/remove?agent=agent@east&server=server@west"],
  ["POST", "/api/mcp/servers/config?agent=agent@east&server=server", { config: { url: "https://mcp.test" } }],
  ["POST", "/api/mcp/servers/shared?agent=agent@east&server=server", { enabled: true }],
  ["POST", "/api/mcp/servers/label?agent=agent@east&server=server", { displayName: "agent@east" }],
  ["POST", "/api/mcp/servers/icon/refresh?agent=agent@east&server=server"],
  ["POST", "/api/mcp/oauth/disconnect?agent=agent@east&server=server&scope=team"],
  ["PATCH", "/api/schedules/agent@east/job", { name: "agent@east" }],
  ["DELETE", "/api/schedules/agent@east/job"],
  ["POST", "/api/schedules/agent@east/job/run"],
  ["POST", "/api/schedules", { agentId: "agent@east", name: "agent@east", payload: { agentId: "agent@east" } }],
  ["PUT", `${prefix()}/api/dashboards/object@east/pin`],
  ["DELETE", `${prefix()}/api/dashboards/object@east/pin`],
  ["PATCH", `${prefix()}/api/dashboards/object@east/sharing`, { shares: [{ kind: "user", id: "user@east", mode: "read" }] }],
  ["POST", `${prefix()}/api/dashboards/object@east/claim`, {}],
  ["DELETE", `${prefix()}/api/dashboards/object@east`],
  ["PUT", `${prefix()}/api/admin/forks/pool@east/teams`, { teamIds: ["team@east"] }],
  ["PATCH", `${prefix()}/api/admin/forks/pool@east/visibility`, { public: false }],
  ["DELETE", `${prefix()}/api/admin/teams/team@east/agents/pool@east`],
];

describe("configuration transport", () => {
  it.each(mutations)("forwards %s %s without a local mutation", async (method, path, body) => {
    const response = await app.request(path, { ...json(body ?? {}), method });
    expect(response.status).toBe(200);
    expect(localCalls).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0].init.method).toBe(method);
    expect(records[0].url.origin).toBe("https://east.test");
    expect(records[0].url.searchParams.get("agent")).not.toBe("agent@east");
    if (body !== undefined) {
      const expected = path === "/api/schedules" ? { ...body as object, agentId: "agent" } : body;
      expect(JSON.parse(records[0].body)).toEqual(expected);
    }
  });

  it.each([
    "/api/agents/agent@east/extensions", "/api/agents/agent%40east/connections",
    "/api/oauth/google/status?agent=agent%40east&scope=personal", "/api/mcp/servers?agent=agent%40east&live=0",
    "/api/mcp/servers/config?agent=agent@east&server=agent@east", "/api/mcp/servers/personal-status?agent=agent@east&url=https%3A%2F%2Fmcp.test",
    "/api/mcp/oauth/status?agent=agent@east&scope=team", "/api/schedules?agent=agent%40east",
    "/api/schedules/agent%40east/job/runs", "/api/schedules/agent@east/job/runs/run/trace",
  ])("rewrites the agent in %s", async (path) => {
    expect((await app.request(path)).status).toBe(200);
    const { url } = records[0];
    if (url.searchParams.has("agent")) expect(url.searchParams.get("agent")).toBe("agent");
    else expect(url.pathname.split("/")[3]).toBe("agent");
    expect(url.searchParams.get("server")).toBe(path.includes("server=agent") ? "agent@east" : null);
    expect(localCalls).toEqual([]);
  });

  it.each(["/api/agents", "/api/mcp/catalog", "/api/schedule-alerts", "/api/dashboards", "/api/dashboards/recipients", "/api/pool", "/api/pool/pool/avatar", "/api/pool-actions", "/api/teams", "/api/admin/forks", "/api/top-extensions", "/api/capabilities"])("reads %s from the selected gateway", async (path) => {
    for (const name of ["east", "west"]) {
      expect((await app.request(`${prefix(name)}${path}`)).status).toBe(200);
      expect(records.at(-1)?.url.origin).toBe(`https://${name}.test`);
      expect(records.at(-1)?.url.pathname).toBe(path);
    }
    expect(localCalls).toEqual([]);
  });

  it("refuses an explicit gateway when the relay has no links", async () => {
    const saved = fixture.gateways;
    fixture.gateways = [];
    try {
      expect((await app.request(`${prefix()}/api/dashboards/object`, { method: "DELETE" })).status).toBe(403);
      expect((await app.request("/api/relay/oauth/start", json(startInput))).status).toBe(403);
      expect(records).toEqual([]);
      expect(localCalls).toEqual([]);
    } finally {
      fixture.gateways = saved;
    }
  });

  it("suffixes the selected agent catalog", async () => {
    answer = () => Response.json([{ id: "agent", avatar: "/api/agents/agent/avatar" }]);
    expect(await (await app.request(`${prefix()}/api/agents`)).json()).toEqual([{ id: "agent@east", avatar: "/api/agents/agent%40east/avatar", gateway: "east" }]);
    expect(localCalls).toEqual([]);
  });

  it("keeps equal object IDs separate across gateways", async () => {
    for (const name of ["east", "west"]) {
      const response = await app.request(`${prefix(name)}/api/dashboards/same/pin`, { method: "PUT" });
      expect(response.status).toBe(200);
      expect(records.at(-1)?.url.href).toBe(`https://${name}.test/api/dashboards/same/pin`);
      expect(records.at(-1)?.headers.get("authorization")).toBe(`Bearer fake-${name}-bearer`);
    }
    expect(localCalls).toEqual([]);
  });

  it("keeps exact local agent precedence", async () => {
    for (const path of ["/api/agents/same@east/extensions", "/api/mcp/servers?agent=same@east", "/api/schedules/same@east/job"]) {
      expect((await app.request(path, { method: path.includes("schedules/") ? "DELETE" : "GET" })).status).toBe(200);
    }
    expect(localCalls).toHaveLength(3);
    expect(records).toEqual([]);
    expect((await app.request(`${prefix()}/api/mcp/servers?agent=same@east`)).status).toBe(400);
    expect(records).toEqual([]);
  });

  it("accepts a raw agent ID with an explicit gateway", async () => {
    fixture.localIds.add("agent");
    for (const name of ["east", "west"]) {
      const response = await app.request(`${prefix(name)}/api/schedules/agent/job`, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(records.at(-1)?.url.href).toBe(`https://${name}.test/api/schedules/agent/job`);
    }
    expect(localCalls).toEqual([]);
  });

  it.each([
    ["DELETE", `${prefix("missing")}/api/dashboards/object`, undefined, 404],
    ["DELETE", "/api/schedules/agent@missing/job", undefined, 404],
    ["POST", "/api/schedules", { agentId: "agent@missing" }, 404],
    ["DELETE", `${prefix()}/api/schedules/agent@west/job`, undefined, 400],
    ["POST", `${prefix()}/api/auth/sign-out`, {}, 405],
    ["GET", `${prefix()}/api/internal/tools`, undefined, 405],
    ["GET", `${prefix()}/api/admin/users`, undefined, 405],
    ["PUT", `${prefix()}/api/admin/top-extensions`, {}, 405],
    ["POST", `${prefix()}/api/mcp/catalog`, {}, 405],
    ["PUT", "/api/mcp/servers?agent=agent@east", {}, 405],
    ["GET", "/api/mcp/servers?agent=agent@east&agent=local", undefined, 400],
    ["GET", `${prefix()}/api/mcp/servers`, undefined, 400],
    ["GET", "/api/oauth/google/authorize?agent=agent@east&scope=team", undefined, 405],
    ["GET", "/api/mcp/oauth/authorize?agent=agent@east&scope=team&server=one", undefined, 405],
  ])("refuses %s %s without local use", async (method, path, body, status) => {
    const response = await app.request(path, { ...(body ? json(body) : {}), method });
    expect(response.status).toBe(status);
    expect(records).toEqual([]);
    expect(localCalls).toEqual([]);
  });

  it.each(["http://evil.test", "http://localhost.evil.test:3700"])("refuses an untrusted origin: %s", async (badOrigin) => {
    expect((await app.request(`${prefix()}/api/dashboards/object`, { method: "DELETE", headers: { origin: badOrigin } })).status).toBe(403);
    expect((await app.request("/api/schedules/agent@east/job", { method: "DELETE", headers: { origin: badOrigin } })).status).toBe(403);
    expect(records).toEqual([]);
    expect(localCalls).toEqual([]);
  });

  it("refuses a proxy request from outside loopback", async () => {
    expect((await app.request(`${prefix()}/api/teams`, { headers: { "x-forwarded-for": "127.0.0.1, 192.0.2.1" } })).status).toBe(403);
    expect(records).toEqual([]);
  });

  it("strips caller identity and preserves remote permission errors", async () => {
    answer = () => Response.json({ error: "team_requires_admin" }, { status: 403, headers: { "set-cookie": "secret=one" } });
    const response = await app.request(`${prefix()}/api/admin/forks/pool/visibility`, {
      method: "PATCH", headers: { origin, authorization: "Bearer page-token", cookie: "page=one", host: "evil.test", "x-yoplai-auth-context": "admin", "x-yoplai-user-id": "admin", "x-forwarded-host": "evil.test", forwarded: "for=evil.test", referer: `${origin}/agents`, "content-type": "application/json" }, body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "team_requires_admin" });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(records[0].headers.get("authorization")).toBe("Bearer fake-east-bearer");
    for (const name of ["cookie", "origin", "host", "referer", "x-yoplai-auth-context", "x-yoplai-user-id", "x-forwarded-host", "forwarded"]) expect(records[0].headers.has(name)).toBe(false);
  });

  it("returns the remote requester, not the local requester", async () => {
    answer = (url) => Response.json({ multiUser: true, user: { id: `${url.hostname}-owner`, role: "user", name: "Remote owner", email: "owner@test.invalid" }, forkedAgents: true, extensions: { mcp: true } });
    const response = await app.request(`${prefix()}/api/capabilities`, { headers: { "x-yoplai-auth-context": "local-superadmin" } });
    expect((await response.json()).user).toEqual({ id: "east.test-owner", role: "user", name: "Remote owner", email: "owner@test.invalid" });
    expect(records[0].headers.has("x-yoplai-auth-context")).toBe(false);
  });

  it("suffixes dashboard agent IDs, but keeps dashboard IDs", async () => {
    answer = () => Response.json({ owned: [{ agentId: "agent", id: "same" }], shared: [], dashboard: { agentId: "agent", id: "same" } });
    const response = await app.request(`${prefix()}/api/dashboards`);
    expect(await response.json()).toEqual({ owned: [{ agentId: "agent@east", id: "same" }], shared: [], dashboard: { agentId: "agent@east", id: "same" } });
  });

  it("preserves streams and empty responses", async () => {
    answer = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("trace data")); controller.close(); } }), { headers: { "content-type": "text/plain" }, status: 206 });
    const response = await app.request("/api/schedules/agent@east/job/runs/run/trace");
    expect(response.status).toBe(206);
    expect(await response.text()).toBe("trace data");
    answer = () => new Response(null, { status: 204 });
    const empty = await app.request(`${prefix()}/api/dashboards/object`, { method: "DELETE" });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it("reports an offline gateway without a local mutation", async () => {
    remote.mockRejectedValueOnce(new Error("offline"));
    const response = await app.request("/api/schedules/agent@east/job", { method: "DELETE" });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_offline", gateway: "east" });
    expect(localCalls).toEqual([]);
  });

  it.each(["https://provider.test/auth", "https://east.test/api/auth/login", "//evil.test/api/teams", "javascript:alert(1)"])("does not follow an API redirect to %s", async (location) => {
    answer = () => new Response(null, { status: 302, headers: { location } });
    const response = await app.request(`${prefix()}/api/teams`);
    expect(response.status).toBe(502);
    expect(records).toHaveLength(1);
    expect(records[0].init.redirect).toBe("manual");
  });

  it.each(["https://east.test/api/dashboards", "/api/dashboards", "dashboards"])("keeps the API redirect %s on the same linked gateway", async (location) => {
    answer = () => new Response(null, { status: 307, headers: { location } });
    const response = await app.request(`${prefix()}/api/teams`);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${prefix()}/api/dashboards`);
    expect(records).toHaveLength(1);
  });
});

describe("configuration path boundaries", () => {
  it.each(["//evil.test/api/teams", "/api/../teams", "/api/%2e%2e/teams", "/api/%252e%252e/teams", "/api/agents/a%2Fb/extensions", "/api/agents/a%5Cb/extensions", "/api/agents/a%252fb/extensions", "/api/agents/a%00b/extensions", "/api/agents/%ZZ/extensions", "/api/teams#x", "/api\\teams"])("refuses %s before fetch", async (path) => {
    expect(isSafeRemotePath(path)).toBe(false);
    await expect(fetchRemote(fixture.gateways[0], path)).rejects.toThrow();
    expect(records).toEqual([]);
  });

  it.each(["a%2fb", "a%5cb", "%252e%252e", "%ZZ", "a%00b"])("refuses an unsafe route ID: %s", async (id) => {
    const response = await app.request(`${prefix()}/api/agents/${id}/extensions`);
    expect(response.status).toBe(400);
    expect(records).toEqual([]);
    expect(localCalls).toEqual([]);
  });

  it("keeps raw and encoded IDs on the configured origin", () => {
    expect(remoteHttpUrl(fixture.gateways[0], "/api/agents/a%40b/extensions?agent=a%40b")).toBe("https://east.test/api/agents/a%40b/extensions?agent=a%40b");
  });
});

describe("remote OAuth start", () => {
  beforeEach(() => { answer = () => new Response(null, { status: 302, headers: { location: "https://provider.test/authorize?state=fake-state" } }); });

  it.each(["personal", "team"])("starts core OAuth with explicit %s scope", async (scope) => {
    const response = await app.request("/api/relay/oauth/start", json({ ...startInput, scope }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ authorizationUrl: "https://provider.test/authorize?state=fake-state" });
    expect(records).toHaveLength(1);
    expect(records[0].url.href).toBe(`https://east.test/api/oauth/google/authorize?agent=agent&scope=${scope}&scopes=email`);
    expect(records[0].headers.get("authorization")).toBe("Bearer fake-east-bearer");
    expect(records[0].init.redirect).toBe("manual");
    expect(localCalls).toEqual([]);
  });

  it("starts MCP OAuth once without a remote return path", async () => {
    const response = await app.request("/api/relay/oauth/start", json({ gateway: "west", agentId: "agent@west", kind: "mcp", server: "server@east", scope: "team" }));
    expect(response.status).toBe(200);
    expect(records[0].url.href).toBe("https://west.test/api/mcp/oauth/authorize?agent=agent&scope=team&server=server%40east");
    expect(records).toHaveLength(1);
  });

  it.each([undefined, "null", "http://localhost:3999", "http://evil.test"])("refuses an absent or untrusted Origin: %s", async (badOrigin) => {
    const init = json(startInput);
    const headers = new Headers(init.headers);
    if (badOrigin === undefined) headers.delete("origin"); else headers.set("origin", badOrigin);
    expect((await app.request("/api/relay/oauth/start", { ...init, headers })).status).toBe(403);
    expect(records).toEqual([]);
  });

  it("uses the configured trusted UI origin", async () => {
    expect((await app.request("/api/relay/oauth/start", json(startInput, { origin: "http://localhost:3701" }))).status).toBe(200);
  });

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"])("refuses %s", async (contentType) => {
    expect((await app.request("/api/relay/oauth/start", json(startInput, { "content-type": contentType }))).status).toBe(415);
    expect(records).toEqual([]);
  });

  it.each([
    { ...startInput, scope: undefined }, { ...startInput, scope: "all" }, { ...startInput, kind: "other" },
    { ...startInput, provider: "unknown" }, { ...startInput, agentId: "agent@west" },
    { ...startInput, returnTo: "/agents" }, { ...startInput, userId: "admin" }, { ...startInput, scopes: [42] },
    { ...startInput, agentId: "same@east" },
  ])("refuses an invalid start: %j", async (input) => {
    expect((await app.request("/api/relay/oauth/start", json(input))).status).toBe(400);
    expect(records).toEqual([]);
    expect(localCalls).toEqual([]);
  });

  it("refuses an unknown gateway", async () => {
    expect((await app.request("/api/relay/oauth/start", json({ ...startInput, gateway: "missing" }))).status).toBe(404);
    expect(records).toEqual([]);
  });

  it.each(["GET", "PUT", "DELETE"])("refuses the %s method", async (method) => {
    expect((await app.request("/api/relay/oauth/start", { method, headers: { origin } })).status).toBe(405);
    expect(records).toEqual([]);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "file:///tmp/file", "https://user:pass@provider.test/auth", "/api/auth/login", "https://east.test/login", "https://provider.test/auth?code=private-code", "https://provider.test/auth?client_secret=secret", "https://provider.test/auth?token=fake-east-bearer", "https://provider.test/a\\b"])("refuses the unsafe provider URL: %s", async (location) => {
    answer = () => new Response(null, { status: 302, headers: { location } });
    const response = await app.request("/api/relay/oauth/start", json(startInput));
    expect(response.status).toBe(502);
    expect(records).toHaveLength(1);
    expect(records[0].url.origin).toBe("https://east.test");
    expect(await response.text()).not.toContain("fake-east-bearer");
  });

  it.each([200, 400, 401, 403, 404, 307, 500])("reports remote status %s without provider fetch", async (status) => {
    answer = () => new Response("<html>login or error</html>", { status, headers: { "content-type": "text/html" } });
    const response = await app.request("/api/relay/oauth/start", json(startInput));
    expect(response.status).toBe([401, 403, 404].includes(status) ? status : 502);
    expect(records).toHaveLength(1);
    expect(await response.text()).not.toContain("<html>");
  });

  it("returns an offline error", async () => {
    remote.mockRejectedValueOnce(new Error("offline"));
    const response = await app.request("/api/relay/oauth/start", json(startInput));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "gateway_offline" });
  });

  it("uses the authorization URL from MCP add without a second grant", async () => {
    answer = () => Response.json({ server: { name: "server" }, authorizationUrl: "https://provider.test/auth?state=add-state" }, { status: 201 });
    const response = await app.request("/api/mcp/servers?agent=agent@east", json({ url: "https://mcp.test", credentialScope: "personal", returnTo: "/agents/agent@east/edit" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ server: { name: "server" }, authorizationUrl: "https://provider.test/auth?state=add-state" });
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0].body)).toEqual({ url: "https://mcp.test", credentialScope: "personal" });
    expect(records[0].url.pathname).toBe("/api/mcp/servers");
    expect(localCalls).toEqual([]);
  });

  it("returns MCP add without OAuth when no grant starts", async () => {
    answer = () => Response.json({ server: { name: "server" } });
    const response = await app.request(`${prefix()}/api/mcp/servers?agent=agent`, json({ url: "https://mcp.test", credentialScope: "team" }));
    expect(await response.json()).toEqual({ server: { name: "server" } });
    expect(records).toHaveLength(1);
  });

  it("reports an invalid MCP add response after the remote mutation", async () => {
    answer = () => new Response("not JSON", { headers: { "content-type": "text/plain" } });
    const response = await app.request(`${prefix()}/api/mcp/servers?agent=agent`, json({ url: "https://mcp.test", credentialScope: "team" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid_mcp_add_response" });
    expect(records).toHaveLength(1);
  });

  it("reports malformed JSON after MCP add", async () => {
    answer = () => new Response("not JSON", { headers: { "content-type": "application/json" } });
    const response = await app.request(`${prefix()}/api/mcp/servers?agent=agent`, json({ url: "https://mcp.test", credentialScope: "team" }));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "invalid_remote_response", gateway: "east" });
    expect(records).toHaveLength(1);
  });

  it("refuses MCP add without the browser start boundary", async () => {
    expect((await app.request("/api/mcp/servers?agent=agent@east", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://mcp.test", credentialScope: "team" }) })).status).toBe(403);
    expect(records).toEqual([]);
  });

  it("refuses an unsafe MCP add authorization URL", async () => {
    answer = () => Response.json({ server: { name: "server" }, authorizationUrl: "javascript:alert(1)" });
    const response = await app.request(`${prefix()}/api/mcp/servers?agent=agent`, json({ url: "https://mcp.test", credentialScope: "team" }));
    expect(response.status).toBe(502);
    expect(records).toHaveLength(1);
  });
});
