import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { relayConfigurationHttp, relayHttp } from "./http.js";
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
vi.mock("../audit/store.js", () => ({ getAuditActor: async () => ({}), recordSettingsChange: vi.fn() }));
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
  app.use("/api/*", relayConfigurationHttp());
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
  beforeEach(() => { answer = (url) => url.pathname.startsWith("/api/oauth/")
    ? Response.json({ kind: "oauth_authorization", provider: "google", authorizationUrl: "https://provider.test/authorize?state=fake-state" })
    : new Response(null, { status: 302, headers: { location: "https://provider.test/authorize?state=fake-state" } }); });

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
    { ...startInput, provider: "../unknown" }, { ...startInput, agentId: "agent@west" },
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
    answer = () => Response.json({ kind: "oauth_authorization", provider: "google", authorizationUrl: location });
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

describe("transport correction regressions", () => {
  it("F1 starts a remote provider without a local registration", async () => {
    const { listOAuthProviders, resetOAuthProviders, registerOAuthProviders } = await import("@yoplai/shared");
    const saved = listOAuthProviders();
    resetOAuthProviders();
    try {
      answer = () => Response.json({ kind: "oauth_authorization", provider: "google", authorizationUrl: "https://provider.test/authorize?state=fake" });
      const response = await app.request("/api/relay/oauth/start", json(startInput));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authorizationUrl: "https://provider.test/authorize?state=fake" });
      expect(records).toHaveLength(1);
    } finally {
      resetOAuthProviders();
      registerOAuthProviders(saved);
    }
  });

  it("F2 refuses an unrelated external login redirect", async () => {
    answer = () => new Response(null, { status: 302, headers: { location: "https://login.example.test/sign-in" } });
    const response = await app.request("/api/relay/oauth/start", json(startInput));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "unexpected_oauth_redirect" });
    expect(records).toHaveLength(1);
    expect(records[0].url.origin).toBe("https://east.test");
  });

  it.each(["agent@east", "local"])("F3 rejects an oversized schedule for %s without a cancellation wait", async (agentId) => {
    const pending = app.request("/api/schedules", json({ agentId, name: "x".repeat(1024 * 1024) }));
    const response = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 300))]);
    expect(response?.status).toBe(413);
    expect(await response?.json()).toEqual({ error: "configuration_body_too_large" });
    expect(records).toEqual([]);
    expect(localCalls).toEqual([]);
  });

  it("F5 preserves a 307 upload method and binary file", async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    const form = new FormData();
    form.set("file", new File([bytes], "fixture.bin"));
    answer = (url) => url.searchParams.has("next")
      ? Response.json({ uploaded: true })
      : new Response(null, { status: 307, headers: { location: "/api/media/upload?next=1" } });
    const response = await app.request("/api/media/upload?agentId=agent@east", { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ uploaded: true });
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.init.method).toBe("POST");
      const sent = record.init.body as FormData;
      expect(sent.get("agentId")).toBe("agent");
      expect(new Uint8Array(await (sent.get("file") as File).arrayBuffer())).toEqual(bytes);
    }
  });

  it("F5 follows a 302 download without a byte change", async () => {
    app = new Hono();
    app.use("/api/*", relayConfigurationHttp());
    app.use("/api/*", relayHttp());
    app.all("*", () => new Response(null, { status: 404 }));
    const bytes = new Uint8Array([0, 255, 128, 13, 10]);
    answer = (url) => url.searchParams.has("next")
      ? new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
      : new Response(null, { status: 302, headers: { location: `${url.pathname}?next=1` } });
    const response = await app.request("/api/media/download/11111111-1111-4111-8111-111111111111");
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(records).toHaveLength(2);
  });

  it("F5 merges a redirected remote agent list", async () => {
    app = new Hono();
    app.use("/api/*", relayConfigurationHttp());
    app.use("/api/*", relayHttp());
    app.all("*", () => Response.json([{ id: "local" }]));
    answer = (url) => url.pathname.endsWith("/")
      ? Response.json([{ id: "agent" }])
      : new Response(null, { status: 302, headers: { location: "/api/agents/" } });
    expect(await (await app.request("/api/agents")).json()).toEqual([
      { id: "local" }, { id: "agent@east", gateway: "east" }, { id: "agent@west", gateway: "west" },
    ]);
    expect(records).toHaveLength(4);
  });
});

describe("configuration body ownership", () => {
  it("keeps a valid local schedule body for the local handler", async () => {
    app = new Hono();
    app.use("/api/*", relayConfigurationHttp());
    app.use("/api/*", relayHttp());
    app.post("/api/schedules", async (c) => c.json({ created: await c.req.json() }, 201));
    const body = { agentId: "local", name: "Local", payload: { message: "x".repeat(400_000) } };
    const response = await app.request("/api/schedules", json(body));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: body });
    expect(records).toEqual([]);
  });

  it.each(["{", "[]", "null"])("refuses malformed schedule JSON: %s", async (body) => {
    const response = await app.request("/api/schedules", { ...json({}), body });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_configuration_body" });
    expect(localCalls).toEqual([]);
    expect(records).toEqual([]);
  });

  it("returns a bounded error when the body read fails", async () => {
    const { relayConfiguration } = await import("./configuration.js");
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private read error")); } });
    const request = new Request("http://localhost/api/schedules", { method: "POST", body, duplex: "half" } as RequestInit);
    const forward = vi.fn();
    const result = await relayConfiguration(request, fixture.gateways, forward);
    expect(result).toBeInstanceOf(Response);
    expect(await (result as Response).json()).toEqual({ error: "configuration_body_read_failed" });
    expect(forward).not.toHaveBeenCalled();
  });

  it("does not wait for a stalled source cancellation", async () => {
    const { relayConfiguration } = await import("./configuration.js");
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); }, cancel,
    });
    const request = new Request("http://localhost/api/schedules", { method: "POST", body, duplex: "half" } as RequestInit);
    const pending = relayConfiguration(request, fixture.gateways, vi.fn());
    const result = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), 300))]);
    expect((result as Response)?.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body?.locked).toBe(false);
  });

  it("ends a pending body read when the caller aborts", async () => {
    const { relayConfiguration } = await import("./configuration.js");
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const request = new Request("http://localhost/api/schedules", { method: "POST", body, signal: controller.signal, duplex: "half" } as RequestInit);
    const pending = relayConfiguration(request, fixture.gateways, vi.fn());
    controller.abort();
    const result = await pending;
    expect((result as Response).status).toBe(400);
    expect(await (result as Response).json()).toEqual({ error: "configuration_body_read_failed" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(request.body?.locked).toBe(false);
  });
});

describe("core start result boundary", () => {
  it.each(["", ".", "..", "a/b", "a\\b", "a%2fb", "a?b", "a#b", "a b"])("refuses the provider path segment %j", async (provider) => {
    expect((await app.request("/api/relay/oauth/start", json({ ...startInput, provider }))).status).toBe(400);
    expect(records).toEqual([]);
  });

  it.each([
    {}, { authorizationUrl: "https://provider.test/auth" },
    { kind: "login", provider: "google", authorizationUrl: "https://login.example.test/sign-in" },
    { kind: "oauth_authorization", provider: "other", authorizationUrl: "https://provider.test/auth" },
  ])("refuses an invalid core start result: %j", async (body) => {
    answer = () => Response.json(body);
    const response = await app.request("/api/relay/oauth/start", json(startInput));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "remote_oauth_start_failed" });
    expect(records).toHaveLength(1);
  });

  it("uses the actual core start, callback, and scoped store", async () => {
    const shared = await import("@yoplai/shared");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { OAuthService } = await import("../oauth/service.js");
    const { OAuthConnectionStore } = await import("../oauth/store.js");
    const { TokenCipher } = await import("../oauth/crypto.js");
    const { createOAuthRoutes } = await import("../oauth/routes.js");
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-core-oauth-"));
    const providerFetch = vi.fn<typeof fetch>(async (input) => Response.json(
      String(input).includes("token") ? { access_token: "fake-personal-token", expires_in: 3600 } : { email: "owner@example.test" }
    ));
    try {
      const service = new OAuthService({
        store: new OAuthConnectionStore(home, new TokenCipher("fake-test-key")), fetchImpl: providerFetch,
        loadConfig: () => shared.GatewayConfigSchema.parse({ version: 2, agents: [], extensions: {}, oauth: { redirectBaseUrl: "https://east.test", providers: { google: { clientId: "fake-id", clientSecret: "fake-secret" } } } }),
      });
      const core = createOAuthRoutes(service,
        async (c) => c.req.header("authorization") === "Bearer fake-east-bearer",
        async (c) => c.req.header("authorization") === "Bearer fake-east-bearer" ? "remote-owner" : undefined,
        async () => false);
      remote.mockImplementation(async (input, init) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://east.test");
        expect(init?.redirect).toBe("manual");
        expect(new Headers(init?.headers).get("accept")).toBe("application/json");
        expect(url.searchParams.has("returnTo")).toBe(false);
        url.pathname = url.pathname.replace(/^\/api/, "");
        return core.fetch(new Request(url, init));
      });
      const response = await app.request("/api/relay/oauth/start", json(startInput));
      expect(response.status).toBe(200);
      const url = new URL((await response.json()).authorizationUrl);
      expect(url.origin).toBe("https://accounts.google.com");
      expect(url.searchParams.get("redirect_uri")).toBe("https://east.test/api/oauth/google/callback");
      expect(providerFetch).not.toHaveBeenCalled();
      expect(remote).toHaveBeenCalledOnce();
      const callbackPath = `/oauth/google/callback?code=fake-code&state=${url.searchParams.get("state")}`;
      expect((await core.request(callbackPath)).status).toBe(200);
      expect(service.getConnection("agent", "google", "remote-owner")?.accessToken).toBe("fake-personal-token");
      const replay = await core.request(callbackPath);
      expect(replay.status).toBe(400);
      expect(await replay.text()).toContain("Invalid or expired OAuth state");
      expect(providerFetch.mock.calls.every(([, init]) => new Headers(init?.headers).get("authorization") !== "Bearer fake-east-bearer")).toBe(true);
      const unknown = await app.request("/api/relay/oauth/start", json({ ...startInput, provider: "remote_unknown" }));
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "unknown_remote_provider" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("media and list redirect refusals", () => {
  const fileId = "11111111-1111-4111-8111-111111111111";
  const cases = ["cross-origin", "wrong-family", "traversal", "encoded-separator", "double-encoding", "userinfo", "fragment", "loop", "missing-location", "hop-limit"];
  for (const family of ["upload", "download", "agent-list"] as const) {
    it.each(cases)(`refuses ${family} redirects: %s`, async (kind) => {
      app = new Hono();
      app.use("/api/*", relayConfigurationHttp());
      app.use("/api/*", relayHttp());
      app.all("*", () => family === "agent-list" ? Response.json([{ id: "local" }]) : new Response(null, { status: 404 }));
      answer = (url) => {
        const location = {
          "cross-origin": `https://foreign.test${url.pathname}`,
          "wrong-family": "/api/capabilities",
          traversal: `${url.pathname}/../${url.pathname.split("/").at(-1)}`,
          "encoded-separator": `${url.pathname}%2fother`,
          "double-encoding": `${url.pathname}%252fother`,
          userinfo: `https://user@${url.hostname}${url.pathname}`,
          fragment: `${url.pathname}#private`,
          loop: url.href,
          "hop-limit": `${url.pathname}?hop=${Number(url.searchParams.get("hop")) + 1}`,
        }[kind];
        return new Response(null, { status: family === "upload" ? 307 : 302, headers: location ? { location } : {} });
      };
      const form = new FormData();
      form.set("file", new File([new Uint8Array([0, 255, 128])], "fixture.bin"));
      const route = family === "upload" ? "/api/media/upload?agentId=agent@east" : family === "download" ? `/api/media/download/${fileId}` : "/api/agents";
      const response = await app.request(route, family === "upload" ? { method: "POST", body: form } : {});
      if (family === "agent-list") {
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([{ id: "local" }]);
      } else {
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({ error: "unsafe_remote_redirect" });
      }
      expect(records).toHaveLength((family === "agent-list" ? 2 : 1) * (kind === "hop-limit" ? 6 : 1));
      for (const record of records) {
        expect(["https://east.test", "https://west.test"]).toContain(record.url.origin);
        expect(record.init.redirect).toBe("manual");
        expect(record.headers.get("authorization")).toBe(`Bearer fake-${record.url.hostname.split(".")[0]}-bearer`);
      }
    });
  }

  it.each([301, 302, 303])("does not replay an upload after status %s", async (status) => {
    answer = () => new Response(null, { status, headers: { location: "/api/media/upload/" } });
    const form = new FormData();
    form.set("file", new File([new Uint8Array([0, 255])], "fixture.bin"));
    const response = await app.request("/api/media/upload?agentId=agent@east", { method: "POST", body: form });
    expect(response.status).toBe(502);
    expect(records).toHaveLength(1);
  });

  it("keeps a redirected list under the gateway base path", async () => {
    const saved = fixture.gateways;
    fixture.gateways = [{ ...saved[0], url: "https://east.test/gateway" }];
    app = new Hono();
    app.use("/api/*", relayConfigurationHttp());
    app.use("/api/*", relayHttp());
    app.all("*", () => Response.json([{ id: "local" }]));
    answer = (url) => url.pathname.endsWith("/") ? Response.json([{ id: "agent" }]) : new Response(null, { status: 302, headers: { location: "/gateway/api/agents/" } });
    try {
      expect(await (await app.request("/api/agents")).json()).toEqual([{ id: "local" }, { id: "agent@east", gateway: "east" }]);
      expect(records.map(({ url }) => url.pathname)).toEqual(["/gateway/api/agents", "/gateway/api/agents/"]);
    } finally {
      fixture.gateways = saved;
    }
  });
});
