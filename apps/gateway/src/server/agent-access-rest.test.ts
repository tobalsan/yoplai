import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { writeTestV3Config } from "../test-utils/v3-config.js";

// Every REST run/read surface addressed to a single agent must reject a user
// without team access and allow one who has it, with staff bypass preserved.
// The aggregate agent endpoints (`/api/agents/status`, `/api/agents/sessions`)
// are shaped like `/api/agents/:id` but are per-user filtered payloads, not
// single-agent addresses, so the per-agent guard must NOT reject them.

type AuthCtx = {
  user: { id: string; role?: string | string[] | null; approved?: boolean };
  session: { id: string; userId: string };
} | null;

// Minimal shape of the Hono context surface the mocked middleware touches.
type MockContext = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  json: (body: unknown, status?: number) => Response;
  req: {
    header: (name: string) => string | undefined;
    param: (name: string) => string | undefined;
  };
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

function hasStaffRole(role: unknown): boolean {
  const staff = ["admin", "superadmin"];
  if (Array.isArray(role)) return role.some((r) => staff.includes(String(r)));
  return typeof role === "string" && staff.includes(role);
}

// alice may chat `allowed-agent`; nobody is granted `blocked-agent`.
const ACCESS: Record<string, Set<string>> = {
  "allowed-agent": new Set(["alice"]),
  "blocked-agent": new Set<string>(),
};

async function hasAgentAccessImpl(
  authContext: AuthCtx,
  agentId: string
): Promise<boolean> {
  if (!authContext) return false;
  if (hasStaffRole(authContext.user.role)) return true;
  return ACCESS[agentId]?.has(authContext.user.id) ?? false;
}

describe("REST per-agent access gating (multi-user)", () => {
  let tmpDir: string;
  let prevHomeDir: string | undefined;
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let server: ReturnType<typeof import("./index.js").startServer>;
  let port: number;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-agent-access-rest-"));
    prevHomeDir = process.env.YOPLAI_HOME;
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    process.env.YOPLAI_HOME = path.join(tmpDir, ".yoplai");
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;

    await writeTestV3Config(path.join(tmpDir, ".yoplai"), {
      agents: [
        { id: "allowed-agent", name: "Allowed Agent" },
        { id: "blocked-agent", name: "Blocked Agent" },
      ],
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
    vi.doMock("@yoplai/extension-multi-user", () => {
      // `createAuthMiddleware` reads a test header and installs the auth context
      // into Hono's store so `requireAgentAccess`/downstream forwarding can read
      // it, mirroring the real cookie-session flow without Better Auth.
      const KEY = "multiUserAuthContext";
      return {
        FORWARDED_AUTH_CONTEXT_HEADER: HEADER,
        createAuthMiddleware:
          () => async (c: MockContext, next: () => Promise<void>) => {
            const ctx = decodeAuth(c.req.header(AUTH_HEADER) ?? null);
            if (ctx) c.set(KEY, ctx);
            await next();
          },
        getRequestAuthContext: (c: MockContext) => c.get(KEY) ?? null,
        getForwardedAuthContext: (headers: Headers) =>
          decodeAuth(headers.get(HEADER)),
        forwardAuthContextToRequest: (request: Request, ctx: AuthCtx) => {
          if (ctx) request.headers.set(HEADER, encodeAuth(ctx));
          else request.headers.delete(HEADER);
          return request;
        },
        hasActiveImpersonation: (ctx: AuthCtx) =>
          Boolean(ctx && (ctx as { impersonator?: unknown }).impersonator),
        getAgentFilter:
          (userId: string, role: unknown) => (agents: Array<{ id: string }>) => {
            if (hasStaffRole(role)) return agents;
            return agents.filter((a) => ACCESS[a.id]?.has(userId));
          },
        hasAgentAccess: hasAgentAccessImpl,
        requireAgentAccess:
          (param = "id") =>
          async (c: MockContext, next: () => Promise<void>) => {
            const ctx = (c.get(KEY) ?? null) as AuthCtx;
            if (!ctx) return c.json({ error: "unauthorized" }, 401);
            const agentId = c.req.param(param);
            if (!agentId) return c.json({ error: "forbidden" }, 403);
            if (!(await hasAgentAccessImpl(ctx, agentId))) {
              return c.json({ error: "forbidden" }, 403);
            }
            await next();
          },
        validateWebSocketRequest: async () => null,
      };
    });

    const { clearConfigCacheForTests } = await import("../config/index.js");
    clearConfigCacheForTests();

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

  it("allows staff to read any agent regardless of membership", async () => {
    expect(
      await get("/api/agents/blocked-agent", authHeader("boss", "admin"))
    ).toBe(200);
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
});
