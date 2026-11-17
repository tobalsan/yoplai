import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { MultiUserRuntime } from "../../../../packages/extensions/multi-user/src/runtime-state.js";
import { writeTestAgent, writeTestV3Config } from "../test-utils/v3-config.js";

// The real gateway server, the real multi-user authentication middleware, the real agent gate, the real core OAuth
// routes, the real provider registration, the real service, the real token exchange, and the real encrypted store run
// over real Node sockets. Only the account lookup is a stand-in: a header names the session, and no header is a request
// with no cookie. The provider is a synthetic loopback server with synthetic credentials. No real provider is contacted.

const SESSION_HEADER = "x-test-session";
const CALLBACK = "/api/oauth/fixture/callback";
const START = (agent: string, scope: string) => `/api/oauth/fixture/authorize?agent=${agent}&scope=${scope}`;

describe("core OAuth callback past the outer authentication gate (real socket)", () => {
  let tmpDir: string;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let base: string;
  let peer: Server;
  let peerBase: string;
  let clearRuntime: (() => void) | undefined;
  let getStore: typeof import("../oauth/store.js").getOAuthConnectionStore;
  const previous = { yoplai: process.env.YOPLAI_HOME, home: process.env.HOME, profile: process.env.USERPROFILE };
  const issued = new Map<string, URL>();
  const peerSeen: Array<{ cookie?: string; authorization?: string }> = [];
  let exchanges = 0;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-core-oauth-"));
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    await writeTestAgent(path.join(tmpDir, "pool"), { id: "allowed-agent" });
    await writeTestAgent(path.join(tmpDir, "pool"), { id: "other-agent" });
    const writeConfig = (redirectBaseUrl: string) => writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [{ id: "allowed-agent", name: "Allowed Agent" }, { id: "other-agent", name: "Other Agent" }],
      extraConfig: { pool: ["allowed-agent", "other-agent"].map((id) => path.join(tmpDir, "pool", "agents", id)), oauth: { redirectBaseUrl, encryptionKey: "synthetic-encryption-key-for-tests", providers: { fixture: { clientId: "synthetic-client", clientSecret: "synthetic-secret" }, second: { clientId: "synthetic-client", clientSecret: "synthetic-secret" } } } },
      extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "x".repeat(32) } },
    });
    await writeConfig("http://127.0.0.1:1");
    vi.resetModules();
    vi.doMock("../extensions/registry.js", async () => {
      const actual = await vi.importActual<typeof import("../extensions/registry.js")>("../extensions/registry.js");
      return {
        ...actual,
        getLoadedExtensions: () => [{ id: "multiUser" }],
        isMultiUserLoaded: () => true,
        isExtensionLoaded: (extensionId: string) => extensionId === "multiUser",
        getExtensionRuntime: () => ({ isEnabled: (extensionId: string) => extensionId === "multiUser", getRouteMatchers: () => [] }),
      };
    });

    // The synthetic provider: an authorize endpoint that redirects back with a one-use code, and a token endpoint
    // that checks the verifier, the client, the secret, and the redirect URI exactly.
    const { Hono } = await import("hono");
    const { serve } = await import("@hono/node-server");
    const provider = new Hono();
    provider.get("/authorize", (c) => {
      const url = new URL(c.req.url);
      const code = `code-${issued.size}`;
      issued.set(code, url);
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      return c.redirect(back.toString());
    });
    provider.post("/token", async (c) => {
      exchanges++;
      peerSeen.push({ cookie: c.req.header("cookie"), authorization: c.req.header("authorization") });
      const form = new URLSearchParams(await c.req.text());
      const original = issued.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!original || createHash("sha256").update(verifier).digest("base64url") !== original.searchParams.get("code_challenge")) return c.json({ error: "invalid_grant" }, 400);
      if (form.get("client_id") !== "synthetic-client" || form.get("client_secret") !== "synthetic-secret" || form.get("redirect_uri") !== original.searchParams.get("redirect_uri") || original.searchParams.get("code_challenge_method") !== "S256") return c.json({ error: "invalid_client" }, 400);
      return c.json({ access_token: "synthetic-access", token_type: "Bearer", scope: "read" });
    });
    peer = serve({ fetch: provider.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
    await new Promise<void>((resolve) => (peer.listening ? resolve() : peer.once("listening", resolve)));
    peerBase = `http://127.0.0.1:${(peer.address() as AddressInfo).port}`;

    // Real registration of two synthetic providers. The second one proves that a state is bound to its own provider.
    const { resetOAuthProviders } = await import("@yoplai/shared");
    resetOAuthProviders();
    const { registerExtensionOAuthProviders } = await import("../extensions/runtime.js");
    registerExtensionOAuthProviders([{ id: "synthetic-extension", oauthProviders: ["fixture", "second"].map((id) => ({ id, displayName: id, authorizeUrl: `${peerBase}/authorize`, tokenUrl: `${peerBase}/token`, defaultScopes: ["read"] })) }] as never);

    const dbMod = await import("../../../../packages/extensions/multi-user/src/db.js");
    const { createForkStore } = await import("../../../../packages/extensions/multi-user/src/forks.js");
    const { createMembershipStore } = await import("../../../../packages/extensions/multi-user/src/membership.js");
    const { createAccessResolver } = await import("../../../../packages/extensions/multi-user/src/access.js");
    const { createPoolCatalogResolver } = await import("../../../../packages/extensions/multi-user/src/catalog.js");
    const { createOnboardingStore } = await import("../../../../packages/extensions/multi-user/src/onboarding.js");
    const { createConnectPromptStore } = await import("../../../../packages/extensions/multi-user/src/connect-prompt.js");
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT, approved INTEGER DEFAULT 1, banned INTEGER DEFAULT 0, role TEXT DEFAULT 'user')");
    for (const [id, role] of [["alice", "user"], ["mallory", "user"], ["root", "superadmin"]]) db.prepare("INSERT INTO user (id, name, email, role) VALUES (?, ?, ?, ?)").run(id, id, `${id}@example.test`, role);
    dbMod.ensureTeamsTable(db);
    dbMod.ensureTeamMembersTable(db);
    dbMod.ensureAgentForksTable(db);
    dbMod.ensureUserOnboardingTable(db);
    dbMod.ensureUserAgentConnectPromptTable(db);
    db.prepare("INSERT INTO teams (id, name, createdBy) VALUES ('team-red', 'Red', 'root')").run();
    const poolAgents = new Map(["allowed-agent", "other-agent"].map((id) => [id, { id, workspaceDir: path.join(tmpDir, "pool", "agents", id) }]));
    const forks = createForkStore({ db, getForksDir: () => path.join(tmpDir, "forks"), getPoolAgent: (id) => poolAgents.get(id) ?? null });
    const membership = createMembershipStore(db);
    forks.setTeams("allowed-agent", { mode: "list", teamIds: ["team-red"] }, "root");
    forks.setTeams("other-agent", { mode: "list", teamIds: ["team-red"] }, "root");
    membership.setMembers("team-red", { mode: "list", userIds: ["alice"] }, "root");
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    const access = createAccessResolver({ membership, forks });
    setMultiUserRuntime({
      db, forks, membership, access,
      catalog: createPoolCatalogResolver({ forks, access, isAgentRunnable: () => true, getTeamName: () => null }),
      onboarding: createOnboardingStore(db),
      connectPrompt: createConnectPromptStore(db),
      getPoolAgentIds: () => [...poolAgents.keys()],
      auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get(SESSION_HEADER);
        return id ? { user: { id, role: (db.prepare("SELECT role FROM user WHERE id = ?").get(id) as { role?: string } | undefined)?.role ?? "user", approved: true }, session: { id: `session-${id}`, userId: id } } : null;
      } } },
    } as unknown as MultiUserRuntime);
    clearRuntime = () => { setMultiUserRuntime(null); db.close(); };

    const serverMod = await import("./index.js");
    server = serverMod.startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The config names the redirect base of this socket, the synthetic credentials, and a synthetic encryption key.
    await writeConfig(base);
    const { clearConfigCacheForTests } = await import("../config/index.js");
    clearConfigCacheForTests();
    ({ getOAuthConnectionStore: getStore } = await import("../oauth/store.js"));
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (peer) await new Promise<void>((resolve) => peer.close(() => resolve()));
    clearRuntime?.();
    const { resetOAuthProviders } = await import("@yoplai/shared");
    resetOAuthProviders();
    const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
    restore("YOPLAI_HOME", previous.yoplai); restore("HOME", previous.home); restore("USERPROFILE", previous.profile);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => { exchanges = 0; peerSeen.length = 0; });

  const as = (id: string) => ({ [SESSION_HEADER]: id });
  /** A raw request, so the path reaches the server exactly as written. */
  function raw(method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
    return new Promise((resolve, reject) => {
      const url = new URL(base);
      const req = httpRequest({ host: url.hostname, port: url.port, method, path: p, headers }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); });
      req.on("error", reject);
      req.end();
    });
  }
  /** Starts a flow as a signed-in user and follows the provider redirect once. Returns the callback address. */
  async function start(user: string, agent: string, scope: string, provider = "fixture"): Promise<URL> {
    const response = await fetch(`${base}${START(agent, scope).replace("/fixture/", `/${provider}/`)}`, { headers: { ...as(user), accept: "application/json" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as { kind: string; provider: string; authorizationUrl: string };
    expect(body).toMatchObject({ kind: "oauth_authorization", provider });
    const redirected = await fetch(body.authorizationUrl, { redirect: "manual" });
    return new URL(redirected.headers.get("location")!);
  }
  const callback = (url: URL, headers: Record<string, string> = {}) => fetch(`${base}${url.pathname}${url.search}`, { headers, redirect: "manual" });
  const personal = (user: string, agent = "allowed-agent") => getStore().get(agent, "fixture", { type: "personal", userId: user });
  const team = (agent = "allowed-agent") => getStore().get(agent, "fixture", { type: "team" });

  it("completes a personal start with no cookie and saves the grant for the user who started it", async () => {
    const url = await start("alice", "allowed-agent", "personal");
    const response = await callback(url);
    expect(response.status).toBe(200);
    expect(exchanges).toBe(1);
    expect(personal("alice")?.accessToken).toBe("synthetic-access");
    expect(personal("mallory")).toBeUndefined();
    expect(team()).toBeUndefined();
    // The provider peer receives no gateway cookie and no gateway authorization.
    expect(peerSeen).toEqual([{ cookie: undefined, authorization: undefined }]);
  });

  it("refuses a replay with no second exchange", async () => {
    const url = await start("alice", "allowed-agent", "personal");
    expect((await callback(url)).status).toBe(200);
    expect((await callback(url)).status).toBe(400);
    expect(exchanges).toBe(1);
  });

  it("refuses a missing state, a missing code, and a false state", async () => {
    for (const query of ["", "?code=x", "?state=never-issued", "?code=x&state=never-issued"]) {
      expect({ query, status: (await fetch(`${base}${CALLBACK}${query}`)).status }).toEqual({ query, status: 400 });
    }
    expect(exchanges).toBe(0);
  });

  it("binds the state to its provider, and a different registered provider leaves the state usable", async () => {
    const url = await start("alice", "allowed-agent", "personal");
    const other = new URL(url);
    other.pathname = other.pathname.replace("/fixture/", "/second/");
    expect((await callback(other)).status).toBe(400);
    expect(exchanges).toBe(0);
    expect((await callback(url)).status).toBe(200);
  });

  it("takes no authority from the callback request: a forged owner, scope, agent, and session change nothing", async () => {
    const url = await start("alice", "allowed-agent", "personal");
    const forged = new URL(url);
    for (const [key, value] of [["scope", "team"], ["userId", "mallory"], ["owner", "mallory"], ["agent", "other-agent"]]) forged.searchParams.set(key, value);
    expect((await callback(forged, as("mallory"))).status).toBe(200);
    expect(personal("alice")?.accessToken).toBe("synthetic-access");
    expect(personal("mallory")).toBeUndefined();
    expect(personal("mallory", "other-agent")).toBeUndefined();
    expect(team()).toBeUndefined();
    expect(team("other-agent")).toBeUndefined();
  });

  it("rejects a code of another flow by PKCE, consumes the failed state, and keeps the other flow usable", async () => {
    const first = await start("alice", "allowed-agent", "personal");
    const second = await start("alice", "allowed-agent", "personal");
    const mixed = new URL(first);
    mixed.searchParams.set("code", second.searchParams.get("code")!);
    expect((await callback(mixed)).status).toBe(400);
    expect((await callback(first)).status).toBe(400);
    expect((await callback(second)).status).toBe(200);
  });

  it("refuses a provider cancellation and its replay with no exchange", async () => {
    const url = await start("alice", "allowed-agent", "personal");
    url.searchParams.delete("code");
    url.searchParams.set("error", "access_denied");
    expect((await callback(url)).status).toBe(400);
    expect((await callback(url)).status).toBe(400);
    expect(exchanges).toBe(0);
  });

  it("refuses a state older than ten minutes", async () => {
    const url = await start("alice", "allowed-agent", "personal");
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
    try {
      expect((await callback(url)).status).toBe(400);
    } finally {
      spy.mockRestore();
    }
    expect(exchanges).toBe(0);
  });

  it("keeps the start policy: an agent that the user cannot use, a team start without management, no scope, and an unknown provider", async () => {
    const accept = { accept: "application/json" };
    expect((await fetch(`${base}${START("allowed-agent", "personal")}`, { headers: accept })).status).toBe(401);
    expect((await fetch(`${base}${START("allowed-agent", "personal")}`, { headers: { ...as("mallory"), ...accept } })).status).toBe(403);
    expect((await fetch(`${base}${START("allowed-agent", "team")}`, { headers: { ...as("alice"), ...accept } })).status).toBe(403);
    expect((await fetch(`${base}/api/oauth/fixture/authorize?agent=allowed-agent`, { headers: { ...as("alice"), ...accept } })).status).toBe(400);
    expect((await fetch(`${base}/api/oauth/unknown/authorize?agent=allowed-agent&scope=personal`, { headers: as("alice") })).status).toBe(404);
  });

  it("completes a team flow that a superadmin started, with no cookie, as a team grant", async () => {
    const url = await start("root", "allowed-agent", "team");
    expect((await callback(url)).status).toBe(200);
    expect(team()?.accessToken).toBe("synthetic-access");
    expect(personal("root")).toBeUndefined();
  });

  it("keeps the exception exact: other methods, suffixes, trailing slashes, case, encodings, and unknown providers need credentials", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect({ method, status: (await raw(method, `${CALLBACK}?state=x&code=y`)).status }).toEqual({ method, status: 401 });
    }
    for (const p of [`${CALLBACK}/`, `${CALLBACK}/x`, `${CALLBACK}.json`, "/api/oauth/Fixture/callback", "/api/oauth/fixture%2Fextra/callback", "/api/oauth/fixture%2e/callback", "/api/oauth/unknown/callback", "/api/oauth//callback", "/api/oauth/fixture/callback%2F"]) {
      expect({ p, status: (await raw("GET", `${p}?state=x&code=y`)).status }).toEqual({ p, status: 401 });
    }
    expect(exchanges).toBe(0);
  });

  it("refuses an encoded alias of the callback path or provider, with valid state and code, and makes no exchange", async () => {
    const url = await start("alice", "allowed-agent", "personal");
    const query = url.search;
    const aliases = [
      `/api/oauth/%66ixture/callback`, `/api/oauth/fix%74ure/callback`, `/api/oauth/%46ixture/callback`, `/api/oauth/%66%69%78%74%75%72%65/callback`,
      `/api/oauth/fixture/%63allback`, `/api/oauth/fixture/call%62ack`, `/api/oauth/fixture/%43allback`, `/api/oauth/fixture/%63%61%6c%6c%62%61%63%6b`,
      `/api/%6Fauth/fixture/callback`, `/%61pi/oauth/fixture/callback`, `/api/oauth%2Ffixture/callback`, `/api/oauth/fixture/callback%2F`,
      // Dot segments, double slashes, and backslashes. The adapter normalizes some of them before Hono sees the request.
      `/api/oauth/fixture/%2e/callback`, `/api/oauth/fixture/%2E/callback`, `/api/oauth/fixture/%2e%2e/fixture/callback`, `/api/oauth/fixture/%2E%2E/fixture/callback`,
      `/api/oauth/fixture/%2e%2E/fixture/callback`, `/api/oauth/fixture/%2e./fixture/callback`, `/api/oauth/fixture/./callback`, `/api/oauth/fixture/../fixture/callback`,
      `/api/oauth/fixture/x/%2e%2e/callback`, `/api/oauth//fixture/callback`, `/api//oauth/fixture/callback`,
      `/api/oauth/fixture\\callback`, `/api\\oauth/fixture/callback`, `/api/oauth/fixture/callback\\`,
    ];
    for (const alias of aliases) {
      const response = await raw("GET", `${alias}${query}`);
      expect({ alias, status: response.status }).toEqual({ alias, status: 401 });
    }
    // A leading double slash is outside the `/api/*` mount. It reaches no gateway route, so it is 404 and not an exception.
    expect((await raw("GET", `//api/oauth/fixture/callback${query}`)).status).toBe(404);
    expect(exchanges).toBe(0);
    // No state was consumed: the exact, unencoded request still completes.
    expect((await callback(url)).status).toBe(200);
    expect(exchanges).toBe(1);
  });

  it("refuses an encoded alias of the MCP callback path with no credentials, and keeps the exact path through the gate", async () => {
    for (const alias of ["/api/mcp/oauth/%63allback", "/api/mcp/oauth/call%62ack", "/api/mcp/oauth/%43allback", "/api/mcp/%6Fauth/callback", "/api/%6Dcp/oauth/callback", "/%61pi/mcp/oauth/callback", "/api/mcp/oauth/%2e/callback", "/api/mcp/oauth/%2E/callback", "/api/mcp/oauth/%2e%2e/oauth/callback", "/api/mcp/oauth/%2e%2E/oauth/callback", "/api/mcp/oauth/./callback", "/api/mcp//oauth/callback", "/api/mcp/oauth\\callback"]) {
      expect({ alias, status: (await raw("GET", `${alias}?state=x&code=y`)).status }).toEqual({ alias, status: 401 });
    }
    expect((await raw("GET", "/api/mcp/oauth/callback?state=x&code=y")).status).toBe(404);
  });

  it("keeps the other protected routes behind credentials", async () => {
    for (const [method, p] of [["GET", "/api/oauth/fixture/authorize?agent=allowed-agent&scope=personal"], ["GET", "/api/oauth/fixture/status?agent=allowed-agent"], ["POST", "/api/oauth/fixture/disconnect?agent=allowed-agent&scope=personal"], ["GET", "/api/agents"], ["GET", "/api/mcp/oauth/status?agent=allowed-agent"]]) {
      expect({ method, p, status: (await raw(method, p)).status }).toEqual({ method, p, status: 401 });
    }
  });

  it("keeps the CORS preflight answer of the callback", async () => {
    const response = await fetch(`${base}${CALLBACK}`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" } });
    expect(response.status).toBe(204);
  });

  it("keeps the MCP callback exception and the client metadata exception as they were", async () => {
    // The MCP callback has no handler in this graph, so a pass through the gate shows as 404 and never as 401.
    expect((await raw("GET", "/api/mcp/oauth/callback?state=x&code=y")).status).toBe(404);
    expect((await raw("GET", "/api/mcp/oauth/client-metadata.json")).status).toBe(404);
    expect((await raw("POST", "/api/mcp/oauth/callback")).status).toBe(401);
  });
});
