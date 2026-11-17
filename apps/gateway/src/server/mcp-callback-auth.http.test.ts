import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import { request as httpRequest } from "node:http";
import type { Context } from "hono";
import type { AddressInfo } from "node:net";
import type { MultiUserRuntime } from "../../../../packages/extensions/multi-user/src/runtime-state.js";
import { writeTestAgent, writeTestV3Config } from "../test-utils/v3-config.js";

// The real gateway server, the real multi-user authentication middleware, and the real agent gate run over a real
// Node socket. Only the Better Auth session lookup is replaced: a header names the session, and no header means no cookie.
// The MCP extension is an external package, so a small stand-in peer owns the callback. The peer keeps the contract that
// the extension keeps: one-use state, authority from the authenticated start, and no owner from the callback request.

const SESSION_HEADER = "x-test-session";
const CALLBACK = "/api/mcp/oauth/callback";

type Pending = { owner: string; agent: string; scope: string; verifier: string };

describe("MCP OAuth callback past the outer authentication gate (real socket)", () => {
  let tmpDir: string;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;
  let clearRuntime: (() => void) | undefined;
  const previous = { yoplai: process.env.YOPLAI_HOME, home: process.env.HOME, profile: process.env.USERPROFILE };
  const pending = new Map<string, Pending>();
  const grants = new Map<string, string>();
  const peerCalls: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-mcp-callback-"));
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    await writeTestAgent(path.join(tmpDir, "pool"), { id: "allowed-agent" });
    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [{ id: "allowed-agent", name: "Allowed Agent" }],
      extraConfig: { pool: [path.join(tmpDir, "pool", "agents", "allowed-agent")] },
      extensions: { multiUser: { enabled: true, oauth: { google: { clientId: "client-id", clientSecret: "client-secret" } }, sessionSecret: "x".repeat(32) } },
    });

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
    for (const id of ["alice", "mallory"]) db.prepare("INSERT INTO user (id, name, email, role) VALUES (?, ?, ?, 'user')").run(id, id, `${id}@example.test`);
    dbMod.ensureTeamsTable(db);
    dbMod.ensureTeamMembersTable(db);
    dbMod.ensureAgentForksTable(db);
    dbMod.ensureUserOnboardingTable(db);
    dbMod.ensureUserAgentConnectPromptTable(db);
    db.prepare("INSERT INTO teams (id, name, createdBy) VALUES ('team-red', 'Red', 'alice')").run();
    const poolAgent = { id: "allowed-agent", workspaceDir: path.join(tmpDir, "pool", "agents", "allowed-agent") };
    const forks = createForkStore({ db, getForksDir: () => path.join(tmpDir, "forks"), getPoolAgent: (id) => (id === poolAgent.id ? poolAgent : null) });
    const membership = createMembershipStore(db);
    forks.setTeams("allowed-agent", { mode: "list", teamIds: ["team-red"] }, "alice");
    membership.setMembers("team-red", { mode: "list", userIds: ["alice"] }, "alice");
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    const access = createAccessResolver({ membership, forks });
    setMultiUserRuntime({
      db, forks, membership, access,
      catalog: createPoolCatalogResolver({ forks, access, isAgentRunnable: () => true, getTeamName: () => null }),
      onboarding: createOnboardingStore(db),
      connectPrompt: createConnectPromptStore(db),
      getPoolAgentIds: () => [poolAgent.id],
      // The session lookup: a header names the session. No header is a request with no cookie.
      auth: { api: { getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get(SESSION_HEADER);
        return id ? { user: { id, role: "user", approved: true }, session: { id: `session-${id}`, userId: id } } : null;
      } } },
    } as unknown as MultiUserRuntime);
    clearRuntime = () => { setMultiUserRuntime(null); db.close(); };

    const { clearConfigCacheForTests } = await import("../config/index.js");
    clearConfigCacheForTests();

    const { api } = await import("./api.core.js");
    const identity = (c: Context) => (c.get("multiUserAuthContext") as { user: { id: string } } | undefined)?.user.id;
    // The stand-in peer. The start is authenticated and agent-gated by the real gateway. It binds all authority to the state.
    api.post("/mcp/oauth/authorize", (c: Context) => {
      peerCalls.push("authorize");
      const owner = identity(c);
      if (!owner) return c.json({ error: "unauthorized" }, 401);
      const state = `state-${++counter}`;
      const verifier = `verifier-${counter}`;
      pending.set(state, { owner, agent: c.req.query("agent") ?? "", scope: c.req.query("scope") ?? "personal", verifier });
      return c.json({ state, verifier });
    });
    api.on(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], "/mcp/oauth/callback", (c: Context) => {
      peerCalls.push(`callback ${c.req.method}`);
      if (c.req.method !== "GET") return c.json({ error: "method" }, 405);
      // Only code, state, and error count. Every other query field and every header is ignored.
      const state = c.req.query("state") ?? "";
      const record = pending.get(state);
      pending.delete(state);
      if (!state || !record) return c.json({ error: "invalid_state" }, 400);
      if (c.req.query("error")) return c.json({ error: "cancelled" }, 400);
      if (c.req.query("code") !== `code-for-${record.verifier}`) return c.json({ error: "pkce_mismatch" }, 400);
      grants.set(`${record.owner}|${record.scope}|${record.agent}`, c.req.query("code")!);
      return c.json({ ok: true });
    });
    api.all("/mcp/oauth/status", (c: Context) => { peerCalls.push("status"); return c.json({ ok: true }); });
    api.all("/mcp/servers", (c: Context) => { peerCalls.push("servers"); return c.json({ ok: true }); });

    const serverMod = await import("./index.js");
    server = serverMod.startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => { if (server.listening) return resolve(); server.once("listening", () => resolve()); });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    clearRuntime?.();
    const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
    restore("YOPLAI_HOME", previous.yoplai); restore("HOME", previous.home); restore("USERPROFILE", previous.profile);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const url = (p: string) => `http://127.0.0.1:${port}${p}`;
  /** A raw HTTP request, so the path reaches the server exactly as written. */
  function raw(method: string, p: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method, path: p, headers }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0 })); });
      req.on("error", reject);
      req.end();
    });
  }
  const as = (id: string) => ({ [SESSION_HEADER]: id });
  async function start(owner: string, scope = "personal"): Promise<{ state: string; verifier: string }> {
    const res = await fetch(url(`/api/mcp/oauth/authorize?agent=allowed-agent&scope=${scope}`), { method: "POST", headers: as(owner) });
    expect(res.status).toBe(200);
    return (await res.json()) as { state: string; verifier: string };
  }

  it("completes a personal start with no cookie, and binds the grant to the user who started it", async () => {
    const { state, verifier } = await start("alice");
    const res = await fetch(url(`${CALLBACK}?code=code-for-${verifier}&state=${state}`));
    expect(res.status).toBe(200);
    expect(grants.get("alice|personal|allowed-agent")).toBe(`code-for-${verifier}`);
  });

  it("takes no authority from the callback request: a forged owner, scope, agent, and header change nothing", async () => {
    const { state, verifier } = await start("alice");
    const forged = `${CALLBACK}?code=code-for-${verifier}&state=${state}&owner=mallory&user=mallory&scope=team&agent=other&server=other`;
    // A session of another user on the callback does not change the owner either.
    const res = await fetch(url(forged), { headers: { ...as("mallory"), "x-yoplai-auth-context": Buffer.from(JSON.stringify({ user: { id: "mallory" } })).toString("base64url") } });
    expect(res.status).toBe(200);
    expect(grants.has("mallory|team|other")).toBe(false);
    expect(grants.has("mallory|personal|allowed-agent")).toBe(false);
    expect(grants.get("alice|personal|allowed-agent")).toBe(`code-for-${verifier}`);
  });

  it("refuses a missing state, a false state, and a replay, with no second grant", async () => {
    const before = grants.size;
    expect((await fetch(url(`${CALLBACK}?code=x`))).status).toBe(400);
    expect((await fetch(url(`${CALLBACK}?code=x&state=never-issued`))).status).toBe(400);
    const { state, verifier } = await start("alice", "team");
    expect((await fetch(url(`${CALLBACK}?code=code-for-${verifier}&state=${state}`))).status).toBe(200);
    expect(grants.size).toBe(before + 1);
    expect((await fetch(url(`${CALLBACK}?code=code-for-${verifier}&state=${state}`))).status).toBe(400);
    expect(grants.size).toBe(before + 1);
  });

  it("refuses a code of another flow, and keeps the second flow usable", async () => {
    const first = await start("alice");
    const second = await start("alice", "team");
    expect((await fetch(url(`${CALLBACK}?code=code-for-${second.verifier}&state=${first.state}`))).status).toBe(400);
    expect((await fetch(url(`${CALLBACK}?code=code-for-${first.verifier}&state=${first.state}`))).status).toBe(400);
    expect((await fetch(url(`${CALLBACK}?code=code-for-${second.verifier}&state=${second.state}`))).status).toBe(200);
  });

  it("refuses a provider cancellation and its replay", async () => {
    const { state, verifier } = await start("alice");
    expect((await fetch(url(`${CALLBACK}?error=access_denied&state=${state}`))).status).toBe(400);
    expect((await fetch(url(`${CALLBACK}?code=code-for-${verifier}&state=${state}`))).status).toBe(400);
  });

  it("keeps the exception exact: other methods, suffixes, and trailing slashes need credentials", async () => {
    peerCalls.length = 0;
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      expect((await raw(method, `${CALLBACK}?state=x&code=y`)).status).toBe(401);
    }
    for (const suffix of ["/", "/extra", ".json", "%2Fextra"]) {
      expect((await raw("GET", `${CALLBACK}${suffix}?state=x&code=y`)).status).toBe(401);
    }
    expect((await raw("GET", "/api/mcp/oauth/Callback?state=x&code=y")).status).toBe(401);
    expect(peerCalls).toEqual([]);
  });

  it("keeps the protected MCP routes behind credentials and the agent gate", async () => {
    peerCalls.length = 0;
    for (const p of ["/api/mcp/oauth/status?agent=allowed-agent&scope=personal", "/api/mcp/servers?agent=allowed-agent", "/api/mcp/oauth/authorize?agent=allowed-agent&scope=personal"]) {
      expect((await raw("GET", p)).status).toBe(401);
      expect((await raw("POST", p)).status).toBe(401);
    }
    expect((await fetch(url("/api/mcp/oauth/authorize?agent=allowed-agent&scope=personal"), { method: "POST", headers: as("mallory") })).status).toBe(403);
    expect(peerCalls).toEqual([]);
  });

  it("keeps the CORS preflight answer of the callback", async () => {
    const res = await fetch(url(CALLBACK), { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" } });
    expect(res.status).toBe(204);
  });
});
