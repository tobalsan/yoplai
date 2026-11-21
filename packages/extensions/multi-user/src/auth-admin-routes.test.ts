import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayConfigSchema, type ExtensionContext } from "@yoplai/shared";
import { getAuthDbPath, multiUserExtension } from "./index.js";
import { createAuthMiddleware } from "./middleware.js";

describe("Better Auth admin HTTP namespace", () => {
  const origin = "http://127.0.0.1:4999";
  let dataDir: string;
  let app: Hono;

  const request = (path: string, init?: RequestInit) => app.request(`${origin}${path}`, init);
  const post = (path: string, body: object, cookie = "") => request(path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const credentials = (name: string) => ({ email: `${name}@example.test`, password: "fixture-password-123" });

  async function signIn(name: string) {
    const response = await post("/api/auth/sign-in/email", credentials(name));
    expect(response.status).toBe(200);
    // Use only the session token so get-session reads current database state.
    const cookie = response.headers.getSetCookie().find((value) => value.includes(".session_token="))?.split(";")[0];
    if (!cookie) throw new Error("Missing sign-in cookie");
    return cookie;
  }

  async function createAccount(name: string, role: string) {
    const signup = await post("/api/auth/sign-up/email", { name, ...credentials(name) });
    expect(signup.status).toBe(200);
    const { user: { id } } = await signup.json() as { user: { id: string } };
    const db = new Database(getAuthDbPath(dataDir));
    try {
      db.prepare("UPDATE user SET approved = 1, role = ? WHERE id = ?").run(role, id);
    } finally {
      db.close();
    }

    const cookie = await signIn(name);
    const me = await request("/api/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { id, role, approved: true } });
    return { id, cookie, name, role };
  }

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-auth-admin-"));
    const config = GatewayConfigSchema.parse({
      agents: [],
      server: { baseUrl: origin },
      gateway: { port: 4999 },
      ui: { port: 4999 },
      extensions: {
        multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "auth-admin-synthetic-test-secret-123" },
      },
    });
    const context: ExtensionContext = {
      getConfig: () => config, getDataDir: () => dataDir, getAgent: () => undefined, getAgents: () => [],
      reloadConfig() {}, isAgentActive: () => true, isAgentStreaming: () => false, resolveWorkspaceDir: () => dataDir,
      runAgent: async () => ({ payloads: [], meta: { durationMs: 0, sessionId: "unused" } }), getSubagentTemplates: () => [],
      resolveSessionId: async () => undefined, getSessionEntry: async () => undefined, clearSessionEntry: async () => undefined,
      restoreSessionUpdatedAt() {}, deleteSession() {}, hasSession: async () => false, resetSession: async () => {},
      ensureSession: async () => { throw new Error("unused"); }, invalidateHistoryCache: async () => {}, getSessionHistory: async () => [],
      registerDeliverySink: () => () => {}, getDeliverySink: () => undefined, registerUserNotifier: () => () => {}, getUserNotifiers: () => new Map(),
      subscribe: () => () => {}, emit() {}, logger: { info() {}, warn() {}, error() {} },
    };
    await multiUserExtension.start(context);
    app = new Hono();
    app.use("/api/*", createAuthMiddleware());
    const api = new Hono();
    multiUserExtension.registerRoutes!(api);
    app.route("/api", api);
  });

  afterEach(async () => {
    await multiUserExtension.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("returns a JSON 404 for the admin namespace", async () => {
    const response = await request("/api/auth/admin/policy-check");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it.each([
    ["DELETE", "/api/auth/admin/"],
    ["OPTIONS", "/api/auth/admin/policy-check"],
    ["POST", "/api/auth//admin/policy-check/"],
    ["POST", "/api/auth/ADMIN/policy-check"],
    ["POST", "/api/auth/%61dmin%2Fpolicy-check"],
  ])("blocks %s %s", async (method, path) => {
    const response = await request(path, { method });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")?.split(";")[0]).toBe("application/json");
    expect(await response.json()).toEqual({ error: "not_found" });
  });

  it("denies both staff roles while preserving Yoplai administration and ordinary authentication", async () => {
    const owner = await createAccount("operator", "superadmin");
    const staff = await createAccount("staff", "admin");
    const member = await createAccount("member", "user");
    const otherOwner = await createAccount("other-operator", "superadmin");

    const sessionFor = async (cookie: string) => {
      const response = await request("/api/auth/get-session", { headers: { cookie } });
      expect(response.status).toBe(200);
      return await response.json() as { session: { id: string }; user: { id: string; role: string; banned: boolean } };
    };
    const existingSessions = await Promise.all([member, otherOwner].map(async (target) => ({
      target,
      sessionId: (await sessionFor(target.cookie)).session.id,
    })));

    for (const { cookie, role } of [staff, owner]) {
      for (const endpoint of [
        "ban-user", "remove-user", "set-user-password", "impersonate-user", "update-user",
        "list-user-sessions", "revoke-user-session", "revoke-user-sessions",
      ]) {
        const response = await post(`/api/auth/admin/${endpoint}`, {}, cookie);
        expect(response.status, `${role} ${endpoint}`).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
    }

    const users = await request("/api/admin/users", { headers: { cookie: staff.cookie } });
    expect(users.status).toBe(200);
    expect(await users.json()).toMatchObject({ total: 4 });
    expect((await request("/api/teams", { headers: { cookie: staff.cookie } })).status).toBe(200);
    for (const { target, sessionId } of existingSessions) {
      const identity = { id: target.id, role: target.role, banned: false };
      expect(await sessionFor(target.cookie)).toMatchObject({ user: identity, session: { id: sessionId } });
      expect(await sessionFor(await signIn(target.name))).toMatchObject({ user: identity });
    }

    const keys = await request("/api/auth/api-key/list", { headers: { cookie: staff.cookie } });
    expect(keys.status).toBe(200);
    expect(await keys.json()).toMatchObject({ apiKeys: [] });

    const impersonate = { targetUserId: member.id };
    expect((await post("/api/admin/impersonate/start", impersonate, staff.cookie)).status).toBe(403);
    expect((await post("/api/admin/impersonate/start", impersonate, owner.cookie)).status).toBe(204);
    const status = await request("/api/impersonation/status", { headers: { cookie: owner.cookie } });
    expect(await status.json()).toMatchObject({ active: true, target: { id: member.id } });
    expect((await post("/api/admin/impersonate/end", {}, owner.cookie)).status).toBe(204);
  });
});
