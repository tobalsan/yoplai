import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import type { Context } from "hono";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type {
  MultiUserRuntime,
} from "../../../../packages/extensions/multi-user/src/runtime-state.js";
import type { PoolAgentRef } from "../../../../packages/extensions/multi-user/src/forks.js";
import { writeTestAgent, writeTestV3Config } from "../test-utils/v3-config.js";

// Every REST run/read surface addressed to a single agent must reject a user
// without team access and allow one who has it. Authorization runs through the
// real multi-user resolver (`hasAgentAccess`, `requireAgentAccess`,
// `getAgentFilter`) over real team/fork/membership stores on in-memory SQLite;
// only session acquisition (the auth middleware) is replaced by a header.
// The aggregate agent endpoints (`/api/agents/status`, `/api/agents/sessions`)
// are shaped like `/api/agents/:id` but are per-user filtered payloads, not
// single-agent addresses, so the per-agent guard must NOT reject them.

type AuthCtx = {
  user: { id: string; role?: string | string[] | null; approved?: boolean };
  session: { id: string; userId: string };
} | null;

// Minimal shape of the Hono context surface the stand-in session middleware touches.
type MockContext = {
  set: (key: string, value: unknown) => void;
  req: { header: (name: string) => string | undefined };
};

const AUTH_HEADER = "x-test-auth";
const HEADER = "x-yoplai-auth-context";

function decodeAuth(value: string | null): AuthCtx {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function encodeAuth(ctx: AuthCtx): string {
  return Buffer.from(JSON.stringify(ctx), "utf8").toString("base64url");
}

describe("REST per-agent access gating (multi-user)", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;
  let clearRuntime: (() => void) | undefined;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-agent-access-rest-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    for (const id of ["allowed-agent", "blocked-agent", "pool-template"]) {
      await writeTestAgent(path.join(tmpDir, "pool"), { id });
    }
    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [
        { id: "allowed-agent", name: "Allowed Agent" },
        { id: "blocked-agent", name: "Blocked Agent" },
        { id: "pool-template", name: "Pool Template" },
      ],
      // A configured pool turns on forkedAgents (per-user agent visibility).
      extraConfig: { pool: ["allowed-agent", "blocked-agent", "pool-template"].map((id) => path.join(tmpDir, "pool", "agents", id)) },
      extensions: {
        multiUser: {
          enabled: true,
          oauth: {
            google: { clientId: "client-id", clientSecret: "client-secret" },
          },
          sessionSecret: "x".repeat(32),
        },
      },
    });

    vi.resetModules();
    vi.doMock("../extensions/registry.js", async () => {
      const actual = await vi.importActual<
        typeof import("../extensions/registry.js")
      >("../extensions/registry.js");
      return {
        ...actual,
        getLoadedExtensions: () => [{ id: "multiUser" }],
        isMultiUserLoaded: () => true,
        isExtensionLoaded: (extensionId: string) => extensionId === "multiUser",
        getExtensionRuntime: () => ({
          isEnabled: (extensionId: string) => extensionId === "multiUser",
          getRouteMatchers: () => [],
        }),
      };
    });
    vi.doMock("@yoplai/extension-multi-user", async () => {
      const actual = await vi.importActual<
        typeof import("@yoplai/extension-multi-user")
      >("@yoplai/extension-multi-user");
      return {
        ...actual,
        // Session acquisition only: install the header-described session where
        // the cookie-session middleware would. Everything else is real.
        createAuthMiddleware:
          () => async (c: MockContext, next: () => Promise<void>) => {
            const ctx = decodeAuth(c.req.header(AUTH_HEADER) ?? null);
            if (ctx) c.set("multiUserAuthContext", ctx);
            await next();
          },
        validateWebSocketRequest: async (request: Request) => decodeAuth(request.headers.get(AUTH_HEADER)),
      };
    });

    // Real stores + access resolver over in-memory SQLite, installed as the
    // multi-user runtime the real authorization functions consult.
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
    for (const u of ["alice", "mallory", "red-admin", "boss", "root"]) {
      db.prepare("INSERT INTO user (id, name, email, role) VALUES (?, ?, ?, ?)").run(u, u, `${u}@example.test`, u === "root" ? "superadmin" : u.includes("admin") || u === "boss" ? "admin" : "user");
    }
    dbMod.ensureTeamsTable(db);
    dbMod.ensureTeamMembersTable(db);
    dbMod.ensureAgentForksTable(db);
    dbMod.ensureUserOnboardingTable(db);
    dbMod.ensureUserAgentConnectPromptTable(db);
    for (const [id, name] of [["team-red", "Red"], ["team-blue", "Blue"]]) {
      db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(id, name, "root");
    }
    const poolAgents = new Map<string, PoolAgentRef>();
    for (const id of ["allowed-agent", "blocked-agent", "pool-template"]) {
      poolAgents.set(id, { id, workspaceDir: path.join(tmpDir, "pool", "agents", id) });
    }
    const forks = createForkStore({
      db,
      getForksDir: () => path.join(tmpDir, "forks"),
      getPoolAgent: (poolId) => poolAgents.get(poolId) ?? null,
    });
    const membership = createMembershipStore(db);
    // allowed-agent belongs to team-red (alice, red-admin); blocked-agent to
    // team-blue (nobody we authenticate as); pool-template is never forked.
    forks.setTeams("allowed-agent", { mode: "list", teamIds: ["team-red"] }, "root");
    forks.setTeams("blocked-agent", { mode: "list", teamIds: ["team-blue"] }, "root");
    membership.setMembers("team-red", { mode: "list", userIds: ["alice", "red-admin"] }, "root");
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    const access = createAccessResolver({ membership, forks });
    setMultiUserRuntime({
      db,
      forks,
      membership,
      access,
      catalog: createPoolCatalogResolver({ forks, access, isAgentRunnable: () => true, getTeamName: () => null }),
      onboarding: createOnboardingStore(db),
      connectPrompt: createConnectPromptStore(db),
      getPoolAgentIds: () => [...poolAgents.keys()],
    } as unknown as MultiUserRuntime);
    clearRuntime = () => {
      setMultiUserRuntime(null);
      db.close();
    };

    const { clearConfigCacheForTests } = await import("../config/index.js");
    clearConfigCacheForTests();

    const { api } = await import("./api.core.js");
    api.get("/mcp/oauth/identity", (c: Context) => c.json({ auth: c.get("multiUserAuthContext") ?? null }));
    const serverMod = await import("./index.js");
    server = serverMod.startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.once("listening", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    clearRuntime?.();
    vi.doUnmock("@yoplai/extension-multi-user");
    if (prevHomeDir === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = prevHomeDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function authHeader(id: string, role?: string): Record<string, string> {
    return {
      [AUTH_HEADER]: encodeAuth({
        user: { id, role: role ?? "user", approved: true },
        session: { id: `session-${id}`, userId: id },
      }),
    };
  }

  async function get(
    urlPath: string,
    headers: Record<string, string>
  ): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers });
    return res.status;
  }

  async function post(
    urlPath: string,
    headers: Record<string, string>
  ): Promise<number> {
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method: "POST",
      headers,
    });
    return res.status;
  }

  it("carries the authenticated requester into extension contexts and ignores spoofed headers", async () => {
    const spoofed = encodeAuth({ user: { id: "mallory" }, session: { id: "spoof", userId: "mallory" } });
    const response = await fetch(`http://127.0.0.1:${port}/api/mcp/oauth/identity?agent=allowed-agent`, {
      headers: { ...authHeader("alice"), [HEADER]: spoofed },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ auth: { user: { id: "alice" } } });
    const { api } = await import("./api.core.js");
    const directResponse = await api.request("/mcp/oauth/identity", { headers: { [HEADER]: spoofed } });
    expect(await directResponse.json()).toEqual({ auth: null });
  });

  it("guards MCP OAuth agent query routes while allowing callbacks", async () => {
    for (const action of ["status", "authorize", "disconnect"]) {
      expect(await get(`/api/mcp/oauth/${action}?agent=allowed-agent&scope=personal`, authHeader("mallory"))).toBe(403);
      expect(await get(`/api/mcp/oauth/${action}?agent=allowed-agent&scope=personal`, authHeader("alice"))).toBe(404);
    }
    expect(await get("/api/mcp/oauth/status", authHeader("alice"))).toBe(400);
    expect(await get("/api/mcp/oauth/callback", authHeader("mallory"))).toBe(404);
    expect(await get("/api/mcp/catalog", authHeader("alice"))).toBe(404);
  });

  it("guards MCP server list, add, and remove routes by agent access", async () => {
    expect(await get("/api/mcp/servers?agent=allowed-agent", authHeader("mallory"))).toBe(403);
    expect(await get("/api/mcp/servers?agent=allowed-agent", authHeader("alice"))).toBe(404);
    expect(await get("/api/mcp/servers", authHeader("alice"))).toBe(400);

    expect(await post("/api/mcp/servers?agent=allowed-agent", authHeader("mallory"))).toBe(403);
    expect(await post("/api/mcp/servers?agent=allowed-agent", authHeader("alice"))).toBe(404);
    expect(await post("/api/mcp/servers/remove?agent=allowed-agent&server=custom", authHeader("mallory"))).toBe(403);
    expect(await post("/api/mcp/servers/remove?agent=allowed-agent&server=custom", authHeader("alice"))).toBe(404);

    expect(await post("/api/mcp/servers/callback?agent=blocked-agent", authHeader("mallory"))).toBe(403);
  });

  it("rejects reading a single agent without access", async () => {
    expect(
      await get("/api/agents/allowed-agent", authHeader("mallory"))
    ).toBe(403);
  });

  it("allows reading a single agent with access", async () => {
    expect(await get("/api/agents/allowed-agent", authHeader("alice"))).toBe(
      200
    );
  });

  it("scopes admins to their teams; only superadmins cross teams", async () => {
    // admin outside the agent's team: denied (no blanket staff bypass).
    expect(await get("/api/agents/blocked-agent", authHeader("boss", "admin"))).toBe(403);
    expect(await get("/api/agents/allowed-agent", authHeader("boss", "admin"))).toBe(403);
    // admin inside the agent's team: allowed; but not another team's agent.
    expect(await get("/api/agents/allowed-agent", authHeader("red-admin", "admin"))).toBe(200);
    expect(await get("/api/agents/blocked-agent", authHeader("red-admin", "admin"))).toBe(403);
    // superadmin: any agent.
    expect(await get("/api/agents/blocked-agent", authHeader("root", "superadmin"))).toBe(200);
    expect(await get("/api/agents/allowed-agent", authHeader("root", "superadmin"))).toBe(200);
  });

  it("lets admins inspect an unforked pool template but not users", async () => {
    expect(await get("/api/agents/pool-template", authHeader("boss", "admin"))).toBe(200);
    expect(await get("/api/agents/pool-template", authHeader("mallory"))).toBe(403);
  });

  it("filters the aggregate agent list by team membership", async () => {
    const ids = async (user: string, role?: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: authHeader(user, role) });
      expect(res.status).toBe(200);
      return ((await res.json()) as { id: string }[]).map((a) => a.id).sort();
    };
    expect(await ids("alice")).toEqual(["allowed-agent"]);
    expect(await ids("mallory")).toEqual([]);
    expect(await ids("boss", "admin")).toEqual([]);
    expect(await ids("red-admin", "admin")).toEqual(["allowed-agent"]);
    expect(await ids("root", "superadmin")).toEqual(
      expect.arrayContaining(["allowed-agent", "blocked-agent"])
    );
  });

  it("gates agent status sub-route by the resolver", async () => {
    expect(
      await get("/api/agents/allowed-agent/status", authHeader("mallory"))
    ).toBe(403);
    expect(
      await get("/api/agents/allowed-agent/status", authHeader("alice"))
    ).toBe(200);
  });

  it("gates agent history sub-route by the resolver", async () => {
    expect(
      await get("/api/agents/allowed-agent/history", authHeader("mallory"))
    ).toBe(403);
    expect(
      await get("/api/agents/allowed-agent/history", authHeader("alice"))
    ).toBe(200);
  });

  it("keeps a fresh home chat unpersisted until its first user message", async () => {
    const userDir = path.join(tmpDir, ".yoplai", "sessions", "users", "alice");
    const sessionFiles = async () => {
      const files = await fs.readdir(userDir, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const persisted = files.filter((file) => file.endsWith(".jsonl") || path.basename(file) === "sessions.json").sort();
      return Promise.all(persisted.map(async (file) => ({ file, contents: await fs.readFile(path.join(userDir, file), "utf8") })));
    };
    const before = await sessionFiles();
    for (const view of ["simple", "full"]) {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/agents/allowed-agent/history?sessionKey=web-home-without-message&view=${view}`,
        { headers: authHeader("alice") }
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ messages: [], view });
    }
    expect(await sessionFiles()).toEqual(before);
  });

  it("uses current account roles rather than stale superadmin sessions for legacy dashboard access", async () => {
    const { getDashboardRegistry } = await import("../canvas/store.js");
    const { getAgent } = await import("../config/index.js");
    const { dashboardDirectory } = await import("../canvas/dashboard-files.js");
    const blocked = getAgent("blocked-agent")!;
    await fs.mkdir(dashboardDirectory(blocked), { recursive: true });
    await fs.writeFile(path.join(dashboardDirectory(blocked), "legacy.html"), "LEGACY-ROLE-GUARD");
    const registry = getDashboardRegistry(path.join(tmpDir, ".yoplai", "canvas", "registry.json"));
    const legacy = await registry.link("blocked-agent", "legacy.html");
    const response = await fetch(`http://127.0.0.1:${port}/d/${legacy.id}`, { headers: authHeader("mallory", "superadmin") });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("LEGACY-ROLE-GUARD");
    const claim = await fetch(`http://127.0.0.1:${port}/api/dashboards/${legacy.id}/claim`, { method: "POST", headers: authHeader("mallory", "superadmin") });
    expect(claim.status).toBe(404);
  });

  it("gates dashboards and returns an empty list for an accessible agent", async () => {
    expect(
      await get("/api/agents/allowed-agent/dashboards", authHeader("mallory"))
    ).toBe(403);
    const response = await fetch(
      `http://127.0.0.1:${port}/api/agents/allowed-agent/dashboards`,
      { headers: authHeader("alice") }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(
      await get("/api/agents/missing-agent/dashboards", authHeader("root", "superadmin"))
    ).toBe(404);
  });

  it("rejects run dispatch to an agent without access", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/agents/allowed-agent/messages`,
      {
        method: "POST",
        headers: {
          ...authHeader("mallory"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "hi" }),
      }
    );
    expect(res.status).toBe(403);
  });

  it("rejects compact for an agent without access", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/agents/allowed-agent/compact`,
      {
        method: "POST",
        headers: {
          ...authHeader("mallory"),
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }
    );
    expect(res.status).toBe(403);
  });

  it("does not treat aggregate /agents/sessions as a per-agent address", async () => {
    // A non-staff user with no chattable agents must still get their (empty)
    // session list, not a 403 for a phantom agent id "sessions".
    expect(await get("/api/agents/sessions", authHeader("mallory"))).toBe(200);
  });

  it("does not treat aggregate /agents/status as a per-agent address", async () => {
    expect(await get("/api/agents/status", authHeader("mallory"))).toBe(200);
  });

  it("persists the authenticated user's main agent without changing another user's preference", async () => {
    const url = `http://127.0.0.1:${port}/api/me/main-agent`;
    const initial = await fetch(url, { headers: authHeader("alice") });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    const saved = await fetch(url, { method: "PUT", headers: { ...authHeader("alice"), "content-type": "application/json" }, body: JSON.stringify({ mainAgentId: "allowed-agent" }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ mainAgentId: "allowed-agent", accessible: true, pickerDismissedAt: null });
    expect(await (await fetch(url, { headers: authHeader("alice") })).json()).toEqual({ mainAgentId: "allowed-agent", accessible: true, pickerDismissedAt: null });
    expect(await (await fetch(url, { headers: authHeader("mallory") })).json()).toEqual({ mainAgentId: null, accessible: false, pickerDismissedAt: null });
    const other = await fetch(url, { method: "PUT", headers: { ...authHeader("mallory"), "content-type": "application/json" }, body: JSON.stringify({ pickerDismissedAt: "now" }) });
    expect(other.status).toBe(200);
    const dismissed = await other.json();
    expect(dismissed).toEqual({ mainAgentId: null, accessible: false, pickerDismissedAt: expect.any(String) });
    expect(await (await fetch(url, { headers: authHeader("mallory") })).json()).toEqual(dismissed);
    expect(await (await fetch(url, { headers: authHeader("alice") })).json()).toEqual({ mainAgentId: "allowed-agent", accessible: true, pickerDismissedAt: null });
  });

  it("rejects an ineligible main agent without replacing the saved choice", async () => {
    const url = `http://127.0.0.1:${port}/api/me/main-agent`;
    const saved = await fetch(url, { method: "PUT", headers: { ...authHeader("alice"), "content-type": "application/json" }, body: JSON.stringify({ mainAgentId: "allowed-agent" }) });
    expect(saved.status).toBe(200);
    const denied = await fetch(url, { method: "PUT", headers: { ...authHeader("alice"), "content-type": "application/json" }, body: JSON.stringify({ mainAgentId: "blocked-agent" }) });
    expect(denied.status).toBe(403);
    expect(await (await fetch(url, { headers: authHeader("alice") })).json()).toEqual({ mainAgentId: "allowed-agent", accessible: true, pickerDismissedAt: null });
  });

  it("rejects unforked pool templates as main agents even for superadmins", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/me/main-agent`, { method: "PUT", headers: { ...authHeader("root", "superadmin"), "content-type": "application/json" }, body: JSON.stringify({ mainAgentId: "pool-template" }) });
    expect(response.status).toBe(403);
  });

  it("reports a saved main agent inaccessible after team access is revoked", async () => {
    const url = `http://127.0.0.1:${port}/api/me/main-agent`;
    const saved = await fetch(url, { method: "PUT", headers: { ...authHeader("alice"), "content-type": "application/json" }, body: JSON.stringify({ mainAgentId: "allowed-agent" }) });
    expect(saved.status).toBe(200);
    const { getMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    const runtime = getMultiUserRuntime()!;
    runtime.membership.removeMember("team-red", "alice");
    try {
      expect(await (await fetch(url, { headers: authHeader("alice") })).json()).toEqual({ mainAgentId: "allowed-agent", accessible: false, pickerDismissedAt: null });
    } finally {
      runtime.membership.setMembers("team-red", { mode: "list", userIds: ["alice", "red-admin"] }, "root");
    }
  });

  it("stores onboarding status per authenticated user", async () => {
    const url = `http://127.0.0.1:${port}/api/me/onboarding`;
    const json = (h: Record<string, string>) => ({ ...h, "content-type": "application/json" });
    expect(await (await fetch(url, { headers: authHeader("alice") })).json()).toEqual({
      supported: true, status: null, at: null,
    });
    expect((await fetch(url, { headers: {} })).status).toBe(200);
    const bad = await fetch(url, { method: "PUT", headers: json(authHeader("alice")), body: JSON.stringify({ status: "x" }) });
    expect(bad.status).toBe(400);
    const put = await fetch(url, { method: "PUT", headers: json(authHeader("alice")), body: JSON.stringify({ status: "skipped" }) });
    expect(await put.json()).toMatchObject({ status: "skipped" });
    expect(await (await fetch(url, { headers: authHeader("bob") })).json()).toMatchObject({ status: null });
    expect(await (await fetch(url, { headers: authHeader("alice") })).json()).toMatchObject({ status: "skipped" });
    const del = await fetch(url, { method: "DELETE", headers: authHeader("alice") });
    expect(await del.json()).toMatchObject({ status: null });
  });

  it("stores connect-prompt seen state per user and agent", async () => {
    const url = (agent: string) => `http://127.0.0.1:${port}/api/me/connect-prompt/${agent}`;
    const read = async (agent: string, user: string, method = "GET") =>
      (await fetch(url(agent), { method, headers: authHeader(user) })).json();
    expect(await read("allowed-agent", "alice")).toEqual({ supported: true, seen: false, at: null });
    expect(await read("allowed-agent", "alice", "PUT")).toMatchObject({ supported: true, seen: true });
    expect(await read("allowed-agent", "alice")).toMatchObject({ seen: true });
    expect(await read("blocked-agent", "alice")).toMatchObject({ seen: false });
    expect(await read("allowed-agent", "bob")).toMatchObject({ seen: false });
    expect(await read("allowed-agent", "alice", "DELETE")).toEqual({ supported: true, seen: false, at: null });
  });

  it("saves sanitized system flags and returns them from both GET routes", async () => {
    const base = `http://127.0.0.1:${port}/api`;
    const headers = { ...authHeader("root", "superadmin"), "content-type": "application/json" };
    const put = await fetch(`${base}/admin/top-extensions`, {
      method: "PUT", headers,
      body: JSON.stringify({ extensions: [], mcp: [], system: {
        extensions: ["webhooks", "webhooks", "ghost"],
        mcp: ["HTTPS://A.test/mcp/", "https://a.test/mcp?x=1", "npx x"],
      } }),
    });
    expect(put.status).toBe(200);
    const expected = { extensions: [], mcp: [], system: { extensions: ["webhooks"], mcp: ["https://a.test/mcp"] } };
    expect(await put.json()).toEqual(expected);
    expect(await (await fetch(`${base}/top-extensions`, { headers: authHeader("alice") })).json()).toEqual(expected);
    expect(await (await fetch(`${base}/admin/top-extensions`, { headers })).json()).toMatchObject(expected);
    const audit = await (await fetch(`${base}/audit/settings?action=top_extensions.update`, { headers })).json() as { entries: unknown[] };
    expect(audit.entries).toContainEqual(expect.objectContaining({
      actorUserId: "root",
      action: "top_extensions.update",
      changes: [{ field: "system", before: { extensions: [], mcp: [] }, after: { extensions: ["webhooks"], mcp: ["https://a.test/mcp"] } }],
    }));
    await fs.rm(path.join(tmpDir, ".yoplai", "top-extensions.json"));
  });

  it("gates admin top-extensions to superadmin and serves the public list", async () => {
    const base = `http://127.0.0.1:${port}/api`;
    const json = (h: Record<string, string>) => ({ ...h, "content-type": "application/json" });
    expect(await (await fetch(`${base}/top-extensions`, { headers: authHeader("alice") })).json()).toEqual({ extensions: [], mcp: [], system: { extensions: [], mcp: [] } });
    for (const role of ["user", "admin"]) {
      expect((await fetch(`${base}/admin/top-extensions`, { headers: authHeader("u", role) })).status).toBe(403);
      const put = await fetch(`${base}/admin/top-extensions`, { method: "PUT", headers: json(authHeader("u", role)), body: JSON.stringify({ extensions: [], mcp: [] }) });
      expect(put.status).toBe(403);
    }
    const listed = await (await fetch(`${base}/admin/top-extensions`, { headers: authHeader("root", "superadmin") })).json() as { candidates: { extensions: { id: string }[]; mcp: unknown[] } };
    expect(listed.candidates.extensions.length).toBeGreaterThan(0);
    expect(listed.candidates.extensions.some((e) => e.id === "mcp")).toBe(false);
    const known = listed.candidates.extensions[0].id;
    const bad = await fetch(`${base}/admin/top-extensions`, { method: "PUT", headers: json(authHeader("root", "superadmin")), body: "{}" });
    expect(bad.status).toBe(400);
    const put = await fetch(`${base}/admin/top-extensions`, {
      method: "PUT", headers: json(authHeader("root", "superadmin")),
      body: JSON.stringify({ extensions: [known, known, "ghost"], mcp: ["HTTPS://A.test/mcp/", "npx x"] }),
    });
    expect(await put.json()).toEqual({ extensions: [known], mcp: ["https://a.test/mcp"], system: { extensions: [], mcp: [] } });
    expect(await (await fetch(`${base}/top-extensions`, { headers: authHeader("alice") })).json()).toEqual({ extensions: [known], mcp: ["https://a.test/mcp"], system: { extensions: [], mcp: [] } });
  });

  it("reads legacy files without system data as empty system lists", async () => {
    await fs.writeFile(path.join(tmpDir, ".yoplai", "top-extensions.json"), JSON.stringify({ extensions: ["webhooks"], mcp: ["https://a.test/mcp"] }));
    const response = await fetch(`http://127.0.0.1:${port}/api/top-extensions`, { headers: authHeader("alice") });
    expect(await response.json()).toEqual({ extensions: ["webhooks"], mcp: ["https://a.test/mcp"], system: { extensions: [], mcp: [] } });
  });

  it("preserves system flags when an older client only updates Top lists", async () => {
    const base = `http://127.0.0.1:${port}/api`;
    const headers = { ...authHeader("root", "superadmin"), "content-type": "application/json" };
    await fetch(`${base}/admin/top-extensions`, { method: "PUT", headers,
      body: JSON.stringify({ extensions: [], mcp: [], system: { extensions: ["webhooks"], mcp: ["https://a.test/mcp"] } }),
    });
    const put = await fetch(`${base}/admin/top-extensions`, { method: "PUT", headers,
      body: JSON.stringify({ extensions: [], mcp: ["https://other.test/mcp"] }),
    });
    expect(await put.json()).toEqual({ extensions: [], mcp: ["https://other.test/mcp"], system: { extensions: ["webhooks"], mcp: ["https://a.test/mcp"] } });
  });

  it("removes system extensions and normalized MCP URLs from Top in multi-user mode", async () => {
    const base = `http://127.0.0.1:${port}/api`;
    const put = await fetch(`${base}/admin/top-extensions`, {
      method: "PUT", headers: { ...authHeader("root", "superadmin"), "content-type": "application/json" },
      body: JSON.stringify({ extensions: ["webhooks"], mcp: ["HTTPS://A.test/mcp/", "https://other.test/mcp"],
        system: { extensions: ["webhooks"], mcp: ["https://a.test/mcp?x=1"] },
      }),
    });
    expect(await put.json()).toEqual({ extensions: [], mcp: ["https://other.test/mcp"], system: { extensions: ["webhooks"], mcp: ["https://a.test/mcp"] } });
  });
});

describe("agent access without a pool (mixed migrated and plain agents)", () => {
  let tmpDir: string;
  let previousEnv: Pick<NodeJS.ProcessEnv, "YOPLAI_HOME" | "HOME" | "USERPROFILE">;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let baseUrl: string;
  let clearRuntime: (() => void) | undefined;
  const users = new Map<string, { id: string; cookie: string }>();
  const avatar = '<svg xmlns="http://www.w3.org/2000/svg"><text>access-fixture</text></svg>';
  const runAgent = vi.fn<typeof import("../agents/index.js").runAgent>();

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-no-pool-access-"));
    previousEnv = { YOPLAI_HOME: process.env.YOPLAI_HOME, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    await writeTestV3Config(process.env.YOPLAI_HOME, {
      agents: ["plain-agent", "legacy-agent"].map((id) => ({ id, extraYaml: "avatar: avatar.svg" })),
      extensions: { multiUser: {
        enabled: true, autoApprove: false,
        emailAndPassword: { enabled: true }, sessionSecret: "no-pool-test-session-secret-32-characters",
      } },
    });
    for (const id of ["plain-agent", "legacy-agent"]) {
      await fs.writeFile(path.join(process.env.YOPLAI_HOME, "agents", id, "avatar.svg"), avatar);
    }
    vi.resetModules();
    vi.doUnmock("@yoplai/extension-multi-user");
    vi.doMock("../agents/index.js", async () => ({
      ...await vi.importActual<typeof import("../agents/index.js")>("../agents/index.js"),
      runAgent,
    }));
    runAgent.mockImplementation(async (params) => {
      params.onEvent?.({ type: "text", data: "dispatch-ok" });
      params.onEvent?.({ type: "done", meta: { durationMs: 1 } });
      return { payloads: [{ text: "dispatch-ok" }], meta: { durationMs: 1, sessionId: "dispatch-session" } };
    });
    const { clearConfigCacheForTests, loadConfig } = await import("../config/index.js");
    clearConfigCacheForTests();
    const config = loadConfig();
    const dbMod = await import("../../../../packages/extensions/multi-user/src/db.js");
    const { createMultiUserAuth } = await import("@yoplai/extension-multi-user");
    const db = dbMod.initializeMultiUserDatabase(path.join(process.env.YOPLAI_HOME, "auth.db"));
    const multiUser = config.extensions?.multiUser;
    if (!multiUser?.enabled) throw new Error("Missing multi-user fixture config");
    const auth = await createMultiUserAuth(config, multiUser, db);
    for (const name of ["root", "alice", "mallory", "boss", "pending"]) {
      const body = { name, email: `${name}@example.test`, password: "fixture-password-123" };
      const signup = await auth.handler(new Request("http://127.0.0.1:4000/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      expect(signup.status).toBe(200);
      const { user } = await signup.json() as { user: { id: string } };
      if (name !== "pending") {
        db.prepare("UPDATE user SET approved = 1, role = ? WHERE id = ?")
          .run(name === "root" ? "superadmin" : name === "boss" ? "admin" : "user", user.id);
      }
      const signin = await auth.handler(new Request("http://127.0.0.1:4000/api/auth/sign-in/email", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      expect(signin.status).toBe(200);
      users.set(name, { id: user.id, cookie: signin.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") });
    }
    // Exercise the same-id Private fork produced by the real legacy migration.
    db.prepare("INSERT INTO agent_assignments (userId, agentId, assignedBy) VALUES (?, ?, ?)")
      .run(users.get("alice")!.id, "legacy-agent", users.get("root")!.id);
    db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(dbMod.ASSIGNMENTS_TO_TEAMS_MIGRATION);
    dbMod.migrateAssignmentsToTeams(db);
    const { createForkStore } = await import("../../../../packages/extensions/multi-user/src/forks.js");
    const { createMembershipStore } = await import("../../../../packages/extensions/multi-user/src/membership.js");
    const { createAccessResolver } = await import("../../../../packages/extensions/multi-user/src/access.js");
    const forks = createForkStore({ db, getForksDir: () => path.join(process.env.YOPLAI_HOME!, "agents"), getPoolAgent: () => null });
    const membership = createMembershipStore(db);
    const { setMultiUserRuntime } = await import("../../../../packages/extensions/multi-user/src/runtime-state.js");
    setMultiUserRuntime({ auth, db, forks, membership, access: createAccessResolver({ forks, membership }), getPoolAgentIds: () => [] } as unknown as MultiUserRuntime);
    clearRuntime = () => { setMultiUserRuntime(null); db.close(); };
    const { startServer } = await import("./index.js");
    server = startServer(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.listening ? resolve() : server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    clearRuntime?.();
    vi.doUnmock("../agents/index.js");
    vi.doUnmock("../extensions/registry.js");
    for (const key of ["YOPLAI_HOME", "HOME", "USERPROFILE"] as const) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function request(name: string, pathname: string, init?: RequestInit) {
    return fetch(`${baseUrl}/api${pathname}`, { signal: AbortSignal.timeout(3000), ...init, headers: { cookie: users.get(name)!.cookie, "content-type": "application/json" } });
  }

  async function connect(name: string): Promise<WebSocket> {
    const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, { headers: { cookie: users.get(name)!.cookie }, handshakeTimeout: 2000 });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return ws;
  }

  function receive(ws: WebSocket, action: () => void): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const frames: Record<string, unknown>[] = [];
      const timeout = setTimeout(() => { ws.off("message", onMessage); reject(new Error("WebSocket response hung")); }, 2000);
      const onMessage = (raw: import("ws").RawData) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "done" || frame.type === "error" || frame.type === "text" && frame.data === "subscription-ok") {
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve(frames);
        }
      };
      ws.on("message", onMessage);
      action();
    });
  }

  it("lists exactly the agents each user can open in a mixed no-pool instance", async () => {
    for (const [name, expected] of [
      ["alice", ["legacy-agent", "plain-agent"]],
      ["mallory", ["plain-agent"]],
      ["boss", ["plain-agent"]],
      ["root", ["legacy-agent", "plain-agent"]],
    ] as const) {
      const list = await request(name, "/agents");
      expect(list.status).toBe(200);
      expect((await list.json() as { id: string }[]).map((agent) => agent.id).sort()).toEqual(expected);
      for (const agent of ["plain-agent", "legacy-agent"]) {
        expect((await request(name, `/agents/${agent}`)).status).toBe(expected.some((id) => id === agent) ? 200 : 403);
      }
    }
  });

  it("serves real avatars and session reads only for accessible agents", async () => {
    for (const name of ["mallory", "boss", "alice", "root"]) {
      for (const agent of ["plain-agent", "legacy-agent"]) {
        const allowed = agent === "plain-agent" || name === "alice" || name === "root";
        const image = await request(name, `/agents/${agent}/avatar`);
        expect(image.status).toBe(allowed ? 200 : 403);
        if (allowed) {
          expect(image.headers.get("content-type")).toContain("image/svg+xml");
          expect(await image.text()).toBe(avatar);
        }
        for (const route of ["history", "status"]) {
          expect((await request(name, `/agents/${agent}/${route}`)).status).toBe(allowed ? 200 : 403);
        }
      }
    }
  });

  it("dispatches HTTP chat for accessible agents and keeps working after a run failure", async () => {
    for (const [name, agent] of [["mallory", "plain-agent"], ["boss", "plain-agent"], ["alice", "legacy-agent"]]) {
      runAgent.mockClear();
      const response = await request(name, `/agents/${agent}/messages`, {
        method: "POST", body: JSON.stringify({ message: "hello", sessionId: "http-access" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ payloads: [{ text: "dispatch-ok" }], meta: { durationMs: 1, sessionId: "dispatch-session" } });
      expect(runAgent).toHaveBeenCalledTimes(1);
      expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: agent, userId: users.get(name)!.id, message: "hello" }));
    }
    runAgent.mockClear();
    expect((await request("mallory", "/agents/legacy-agent/messages", { method: "POST", body: JSON.stringify({ message: "denied" }) })).status).toBe(403);
    expect(runAgent).not.toHaveBeenCalled();
    runAgent.mockRejectedValueOnce(new Error("fixture run failed"));
    expect((await request("mallory", "/agents/plain-agent/messages", { method: "POST", body: JSON.stringify({ message: "failure", sessionId: "http-failure" }) })).status).toBe(500);
    const retry = await request("mallory", "/agents/plain-agent/messages", { method: "POST", body: JSON.stringify({ message: "retry", sessionId: "http-retry" }) });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ payloads: [{ text: "dispatch-ok" }] });
  });

  it("denies a genuinely pending session through real HTTP auth and WebSocket validation", async () => {
    runAgent.mockClear();
    for (const route of ["/agents", "/agents/plain-agent", "/agents/plain-agent/avatar", "/agents/plain-agent/history"]) {
      const response = await request("pending", route);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    expect((await request("pending", "/agents/plain-agent/messages", { method: "POST", body: JSON.stringify({ message: "pending" }) })).status).toBe(403);
    const ws = new WebSocket(`${baseUrl.replace("http:", "ws:")}/ws`, { headers: { cookie: users.get("pending")!.cookie }, handshakeTimeout: 2000 });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Pending WebSocket validation hung")), 2500);
        ws.once("unexpected-response", (_request, response) => { clearTimeout(timeout); response.resume(); resolve(response.statusCode ?? 0); });
        ws.once("open", () => { clearTimeout(timeout); reject(new Error("Pending user was allowed to connect")); });
        ws.on("error", () => undefined);
      });
      expect(status).toBe(401);
      expect(runAgent).not.toHaveBeenCalled();
    } finally {
      ws.terminate();
    }
  });

  it("dispatches WebSocket chat for users and admins while restricting legacy forks", async () => {
    for (const [name, agent] of [["mallory", "plain-agent"], ["boss", "plain-agent"], ["alice", "legacy-agent"], ["root", "legacy-agent"]]) {
      const ws = await connect(name);
      try {
        runAgent.mockClear();
        const frames = await receive(ws, () => ws.send(JSON.stringify({ type: "send", agentId: agent, message: "ws-hello", sessionId: "ws-access" })));
        expect(frames).toEqual([{ type: "text", data: "dispatch-ok" }, { type: "done", meta: { durationMs: 1 } }]);
        expect(runAgent).toHaveBeenCalledTimes(1);
        expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: agent, userId: users.get(name)!.id, message: "ws-hello" }));
      } finally {
        ws.terminate();
      }
    }
    for (const name of ["mallory", "boss"]) {
      const ws = await connect(name);
      try {
        runAgent.mockClear();
        for (const type of ["send", "subscribe"]) {
          expect(await receive(ws, () => ws.send(JSON.stringify({ type, agentId: "legacy-agent", message: "denied", sessionId: "ws-access" })))).toEqual([{ type: "error", message: "Forbidden" }]);
        }
        expect(runAgent).not.toHaveBeenCalled();
      } finally {
        ws.terminate();
      }
    }
  });

  it("delivers subscribed updates to accessible no-pool agents", async () => {
    const { agentEventBus } = await import("../agents/index.js");
    for (const [name, agent] of [["mallory", "plain-agent"], ["boss", "plain-agent"], ["alice", "legacy-agent"]]) {
      const ws = await connect(name);
      try {
        ws.send(JSON.stringify({ type: "subscribe", agentId: agent, sessionId: "subscription-access" }));
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("WebSocket ping hung")), 2000);
          ws.once("pong", () => { clearTimeout(timeout); resolve(); });
          ws.ping();
        });
        expect(await receive(ws, () => agentEventBus.emitStreamEvent({ type: "text", data: "subscription-ok", agentId: agent, sessionId: "subscription-access" }))).toEqual([{ type: "text", data: "subscription-ok" }]);
      } finally {
        ws.terminate();
      }
    }
  });

  it("keeps the WebSocket usable after an allowed run fails", async () => {
    const ws = await connect("mallory");
    try {
      runAgent.mockRejectedValueOnce(new Error("fixture WS run failed"));
      const send = () => ws.send(JSON.stringify({ type: "send", agentId: "plain-agent", message: "retry", sessionId: "ws-retry" }));
      expect(await receive(ws, send)).toEqual([{ type: "error", message: "fixture WS run failed" }]);
      expect(await receive(ws, send)).toEqual([{ type: "text", data: "dispatch-ok" }, { type: "done", meta: { durationMs: 1 } }]);
    } finally {
      ws.terminate();
    }
  });
});
