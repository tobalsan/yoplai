import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono, type MiddlewareHandler } from "hono";

type EnvSnapshot = {
  configHome?: string;
  home?: string;
  userProfile?: string;
};

type AppDeps = {
  api: {
    fetch: (request: Request) => Response | Promise<Response>;
  };
  createAuthMiddleware: () => MiddlewareHandler;
  getRequestAuthContext: typeof import("./middleware.js").getRequestAuthContext;
  forwardAuthContextToRequest: typeof import("./middleware.js").forwardAuthContextToRequest;
};

const tempDirs: string[] = [];

afterEach(async () => {
  vi.resetModules();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function createApiApp({
  api,
  createAuthMiddleware,
  getRequestAuthContext,
  forwardAuthContextToRequest,
}: AppDeps) {
  const app = new Hono();
  app.use("/api/*", createAuthMiddleware());
  app.all("/api/*", (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname.startsWith("/api/")
      ? url.pathname.slice(4)
      : url.pathname === "/api"
        ? "/"
        : url.pathname;
    url.pathname = pathname || "/";
    const request = new Request(url, c.req.raw);
    forwardAuthContextToRequest(request, getRequestAuthContext(c));
    return api.fetch(request);
  });
  return app;
}

async function createTempHome(): Promise<{
  dir: string;
  previousEnv: EnvSnapshot;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-multi-user-"));
  tempDirs.push(dir);

  const previousEnv: EnvSnapshot = {
    configHome: process.env.YOPLAI_HOME,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };

  process.env.YOPLAI_HOME = dir;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;

  const agentDir = path.join(dir, "agents", "main");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "agent.yaml"),
    "id: main\nname: Main\nmodel:\n  provider: anthropic\n  model: claude\n"
  );

  return { dir, previousEnv };
}

function restoreEnv(previousEnv: EnvSnapshot) {
  if (previousEnv.configHome === undefined) delete process.env.YOPLAI_HOME;
  else process.env.YOPLAI_HOME = previousEnv.configHome;

  if (previousEnv.home === undefined) delete process.env.HOME;
  else process.env.HOME = previousEnv.home;

  if (previousEnv.userProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousEnv.userProfile;
}

describe("multi-user integration", () => {
  it("initializes Better Auth end-to-end and protects API routes", async () => {
    const { dir, previousEnv } = await createTempHome();

    try {
      await fs.writeFile(
        path.join(dir, "yoplai.json"),
        JSON.stringify({
          version: 3,
          agents: ["agents/main"],
          extensions: {
            multiUser: {
              enabled: true,
              oauth: {
                google: {
                  clientId: "client-id",
                  clientSecret: "client-secret",
                },
              },
              allowedDomains: ["example.com"],
              sessionSecret: "x".repeat(32),
            },
          },
        })
      );

      const { clearConfigCacheForTests, loadConfig } =
        await import("../../../../apps/gateway/src/config/index.js");
      clearConfigCacheForTests();

      const config = loadConfig();
      const { api } =
        await import("../../../../apps/gateway/src/server/api.core.js");
      const {
        createAuthMiddleware,
        getRequestAuthContext,
        forwardAuthContextToRequest,
      } = await import("./middleware.js");
      const { getAuthDbPath } = await import("./db.js");
      const { multiUserExtension, getMultiUserRuntime } =
        await import("./index.js");

      expect(
        multiUserExtension.validateConfig(config.extensions?.multiUser)
      ).toEqual({
        valid: true,
        errors: [],
      });

      multiUserExtension.registerRoutes(api as never);
      await multiUserExtension.start({
        getConfig: () => config,
        getDataDir: () => dir,
        reloadConfig: () => undefined,
        getAgent: (agentId) =>
          config.agents.find((agent) => agent.id === agentId),
        getAgents: () => config.agents,
        isAgentActive: () => true,
        isAgentStreaming: () => false,
        resolveWorkspaceDir: () => "/tmp",
        runAgent: async () => ({
          payloads: [],
          meta: { durationMs: 0, sessionId: "session" },
        }),
        getSubagentTemplates: () => [],
        resolveSessionId: async () => undefined,
        getSessionEntry: async () => undefined,
        clearSessionEntry: async () => undefined,
        restoreSessionUpdatedAt: () => undefined,
        deleteSession: () => undefined,
        invalidateHistoryCache: async () => undefined,
        getSessionHistory: async () => [],
        subscribe: () => () => undefined,
        emit: () => undefined,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      });

      const app = createApiApp({
        api,
        createAuthMiddleware,
        getRequestAuthContext,
        forwardAuthContextToRequest,
      });
      const authDbPath = getAuthDbPath(dir);
      const runtime = getMultiUserRuntime();

      expect(runtime).not.toBeNull();

      const authOkResponse = await app.request("/api/auth/ok");
      expect(authOkResponse.status).toBe(200);
      await expect(authOkResponse.json()).resolves.toEqual({ ok: true });

      await expect(fs.access(authDbPath)).resolves.toBeUndefined();

      const tables = runtime?.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).toContain("agent_assignments");
      const teamColumns = runtime?.db.prepare("PRAGMA table_info(teams)").all() as Array<{ name: string; dflt_value: string | null }>;
      expect(teamColumns).toContainEqual(expect.objectContaining({ name: "allUsers", dflt_value: "0" }));

      const meResponse = await app.request("/api/me");
      expect(meResponse.status).toBe(401);
      await expect(meResponse.json()).resolves.toEqual({
        error: "unauthorized",
      });

      const agentsResponse = await app.request("/api/agents");
      expect(agentsResponse.status).toBe(401);
      await expect(agentsResponse.json()).resolves.toEqual({
        error: "unauthorized",
      });

      await multiUserExtension.stop();
    } finally {
      restoreEnv(previousEnv);
    }
  });

  it("authenticates /api/* via bearer tokens and revokes them through the audited wrapper", async () => {
    const { dir, previousEnv } = await createTempHome();

    try {
      await fs.writeFile(
        path.join(dir, "yoplai.json"),
        JSON.stringify({
          version: 3,
          agents: ["agents/main"],
          extensions: {
            multiUser: {
              enabled: true,
              oauth: {
                google: {
                  clientId: "client-id",
                  clientSecret: "client-secret",
                },
              },
              allowedDomains: ["example.com"],
              sessionSecret: "x".repeat(32),
            },
          },
        })
      );

      const { clearConfigCacheForTests, loadConfig } = await import(
        "../../../../apps/gateway/src/config/index.js"
      );
      clearConfigCacheForTests();

      const config = loadConfig();
      const { api } = await import(
        "../../../../apps/gateway/src/server/api.core.js"
      );
      const {
        createAuthMiddleware,
        getRequestAuthContext,
        forwardAuthContextToRequest,
      } = await import("./middleware.js");
      const { multiUserExtension, getMultiUserRuntime } = await import(
        "./index.js"
      );

      const auditLogs: Array<Record<string, unknown>> = [];

      multiUserExtension.registerRoutes(api as never);
      await multiUserExtension.start({
        getConfig: () => config,
        getDataDir: () => dir,
        reloadConfig: () => undefined,
        getAgent: (agentId) =>
          config.agents.find((agent) => agent.id === agentId),
        getAgents: () => config.agents,
        isAgentActive: () => true,
        isAgentStreaming: () => false,
        resolveWorkspaceDir: () => "/tmp",
        runAgent: async () => ({
          payloads: [],
          meta: { durationMs: 0, sessionId: "session" },
        }),
        getSubagentTemplates: () => [],
        resolveSessionId: async () => undefined,
        getSessionEntry: async () => undefined,
        clearSessionEntry: async () => undefined,
        restoreSessionUpdatedAt: () => undefined,
        deleteSession: () => undefined,
        invalidateHistoryCache: async () => undefined,
        getSessionHistory: async () => [],
        subscribe: () => () => undefined,
        emit: () => undefined,
        logger: {
          info: (payload) => {
            if (payload && typeof payload === "object") {
              auditLogs.push(payload as Record<string, unknown>);
            }
          },
          warn: () => undefined,
          error: () => undefined,
        },
      });

      const app = createApiApp({
        api,
        createAuthMiddleware,
        getRequestAuthContext,
        forwardAuthContextToRequest,
      });
      const runtime = getMultiUserRuntime();
      expect(runtime).not.toBeNull();
      if (!runtime) throw new Error("runtime missing");

      // Seed an approved user directly in the auth DB.
      const now = new Date().toISOString();
      runtime.db
        .prepare(
          `INSERT INTO user (id, name, email, emailVerified, image, role, approved, createdAt, updatedAt)
           VALUES (@id, @name, @email, 1, NULL, 'user', 1, @createdAt, @updatedAt)`
        )
        .run({
          id: "user-bearer",
          name: "Bearer Tester",
          email: "bearer@example.com",
          createdAt: now,
          updatedAt: now,
        });

      // Mint a token via the api-key plugin.
      const created = (await runtime.auth.api.createApiKey({
        body: { userId: "user-bearer", name: "ci" },
      })) as Record<string, unknown>;
      const token = created.key as string | undefined;
      const tokenId = created.id as string | undefined;
      expect(token).toBeTruthy();
      expect(tokenId).toBeTruthy();
      if (!token || !tokenId) throw new Error("token mint failed");

      // /api/me with bearer → 200 with the right user.
      const meResponse = await app.request("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(meResponse.status).toBe(200);
      const meBody = (await meResponse.json()) as {
        user: { id: string; email: string | null };
        assignedAgentIds: string[];
      };
      expect(meBody.user.id).toBe("user-bearer");
      expect(meBody.user.email).toBe("bearer@example.com");

      // /api/agents with the same bearer → 200, list reflects multi-user mode
      // (assignments returns [] for non-admin users → empty list is fine; just
      // assert the request passes auth and returns JSON).
      const agentsResponse = await app.request("/api/agents", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(agentsResponse.status).toBe(200);

      // Without auth, /api/me returns 401.
      const meNoAuth = await app.request("/api/me");
      expect(meNoAuth.status).toBe(401);

      // Verify the keyId exists in the apikey table (matching the CLI lookup pattern).
      const apikeyCols = runtime.db.pragma("table_info(apikey)") as Array<{
        name: string;
      }>;
      const ownerCol = apikeyCols.some((c) => c.name === "userId")
        ? "userId"
        : "referenceId";
      const ownerRow = runtime.db
        .prepare(`SELECT ${ownerCol} as owner FROM apikey WHERE id = ?`)
        .get(tokenId) as { owner?: string } | undefined;
      expect(ownerRow?.owner).toBe("user-bearer");

      // Revoke via the audited wrapper using the same bearer.
      const revokeResponse = await app.request(
        `/api/user/token/${encodeURIComponent(tokenId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      expect(revokeResponse.status).toBe(200);
      await expect(revokeResponse.json()).resolves.toEqual({ ok: true });

      // The audit log line should have been emitted.
      const revokeEvent = auditLogs.find(
        (entry) => entry.event === "user_token.revoked"
      );
      expect(revokeEvent).toMatchObject({
        event: "user_token.revoked",
        userId: "user-bearer",
        tokenId,
      });

      // After revocation the same bearer must be rejected.
      const meAfterRevoke = await app.request("/api/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(meAfterRevoke.status).toBe(401);

      await multiUserExtension.stop();
    } finally {
      restoreEnv(previousEnv);
    }
  });

  it("keeps single-user mode unauthenticated and skips sqlite setup", async () => {
    const { dir, previousEnv } = await createTempHome();

    try {
      await fs.writeFile(
        path.join(dir, "yoplai.json"),
        JSON.stringify({
          version: 3,
          agents: ["agents/main"],
        })
      );

      const { clearConfigCacheForTests, loadConfig } =
        await import("../../../../apps/gateway/src/config/index.js");
      clearConfigCacheForTests();

      const config = loadConfig();
      const { api } =
        await import("../../../../apps/gateway/src/server/api.core.js");
      const {
        createAuthMiddleware,
        getRequestAuthContext,
        forwardAuthContextToRequest,
      } = await import("./middleware.js");
      const { getAuthDbPath } = await import("./db.js");

      const app = createApiApp({
        api,
        createAuthMiddleware,
        getRequestAuthContext,
        forwardAuthContextToRequest,
      });

      const capabilitiesResponse = await app.request("/api/capabilities");
      expect(capabilitiesResponse.status).toBe(200);
      await expect(capabilitiesResponse.json()).resolves.toEqual({
        version: 2,
        extensions: {},
        agents: ["main"],
        multiUser: false,
        agentFab: false,
        forkedAgents: false,
      });

      const agentsResponse = await app.request("/api/agents");
      expect(agentsResponse.status).toBe(200);
      await expect(agentsResponse.json()).resolves.toEqual([
        {
          id: "main",
          name: "Main",
          model: { provider: "anthropic", model: "claude" },
          sdk: "pi",
          workspace: path.join(dir, "agents/main"),
          authMode: undefined,
          queueMode: "queue",
          isDefaultProjectManager: true,
        },
      ]);

      await expect(fs.access(getAuthDbPath(dir))).rejects.toThrow();
      expect(config.extensions?.multiUser).toBeUndefined();
    } finally {
      restoreEnv(previousEnv);
    }
  });

  it("keeps auth modules unloaded in single-user mode", async () => {
    const { dir, previousEnv } = await createTempHome();

    try {
      await fs.writeFile(
        path.join(dir, "yoplai.json"),
        JSON.stringify({
          version: 3,
          agents: ["agents/main"],
        })
      );

      vi.doMock("./auth.js", () => {
        throw new Error("multi-user auth should stay unloaded");
      });
      vi.doMock("./db.js", () => {
        throw new Error("multi-user db should stay unloaded");
      });

      const { clearConfigCacheForTests, loadConfig } =
        await import("../../../../apps/gateway/src/config/index.js");
      clearConfigCacheForTests();

      const { loadExtensions } =
        await import("../../../../apps/gateway/src/extensions/registry.js");
      await loadExtensions(loadConfig());

      const { api } =
        await import("../../../../apps/gateway/src/server/api.core.js");
      await expect(
        import("../../../../apps/gateway/src/server/index.js")
      ).resolves.toHaveProperty("startServer");

      const response = await api.request("/capabilities");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        version: 2,
        extensions: {},
        agents: ["main"],
        multiUser: false,
        agentFab: false,
        forkedAgents: false,
      });
    } finally {
      restoreEnv(previousEnv);
    }
  });
});
