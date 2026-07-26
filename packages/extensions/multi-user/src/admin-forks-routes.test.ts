import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import {
  ensureAgentForksTable,
  ensureTeamsTable,
  ensureTeamMembersTable,
} from "./db.js";
import { createTeamStore } from "./teams.js";
import { createMembershipStore } from "./membership.js";
import { createForkStore } from "./forks.js";

const getMultiUserRuntime = vi.fn();

vi.mock("./index.js", async () => {
  const actual =
    await vi.importActual<typeof import("./index.js")>("./index.js");
  return { ...actual, getMultiUserRuntime };
});

// Mirror the sibling admin-routes test's top-level mocks. Mocking the gateway
// config + registry modules forces Vitest to hoist/apply all mocks (including
// ./index.js) before the first request, avoiding a first-test warmup race where
// the auth middleware's getMultiUserRuntime binding is briefly the un-mocked
// original (which returns the null module singleton -> spurious 401).
const getLoadedExtensions = vi.fn(() => [{ id: "multiUser" }]);

vi.mock(
  "../../../../apps/gateway/src/config/index.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../apps/gateway/src/config/index.js")
      >();
    return {
      ...actual,
      isAgentActive: () => true,
      loadConfig: () => ({ agents: [] }),
    };
  }
);

vi.mock("../../../../apps/gateway/src/extensions/registry.js", () => ({
  getLoadedExtensions,
  getHomeExtension: () => undefined,
  getExtensionRuntime: () => ({
    getCapabilities: () => ({
      extensions: {},
      capabilities: {},
      multiUser: true,
      home: undefined,
    }),
  }),
  isMultiUserLoaded: () => true,
  isExtensionLoaded: (id: string) =>
    getLoadedExtensions().some(
      (extension: { id?: string }) => extension.id === id
    ),
}));

type Role = "superadmin" | "admin" | "user";

function createSession(role: Role) {
  return {
    user: {
      id: `${role}-1`,
      email: `${role}@example.com`,
      name: role,
      role,
      approved: true,
    },
    session: { id: `${role}-session`, userId: `${role}-1` },
  };
}

let db: Database.Database;
let homeDir: string;
let poolDir: string;
let teamId: string;
let getSession: ReturnType<typeof vi.fn>;

function buildRuntime() {
  const membership = createMembershipStore(db);
  const teams = createTeamStore(db, membership);
  const forks = createForkStore({
    db,
    getForksDir: () => path.join(homeDir, "agents"),
    getPoolAgent: (poolId) =>
      poolId === "scribe" ? { id: "scribe", workspaceDir: poolDir } : null,
  });
  return {
    auth: { api: { getSession } },
    db,
    teams,
    membership,
    forks,
  };
}

async function makeApp(role: Role = "admin") {
  getSession = vi.fn(async () => createSession(role));
  getMultiUserRuntime.mockReturnValue(buildRuntime());
  const { registerMultiUserRoutes } = await import("./routes.js");
  const { createAuthMiddleware } = await import("./middleware.js");
  const app = new Hono();
  app.use("*", createAuthMiddleware());
  registerMultiUserRoutes(app);
  return app;
}

function req(path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { cookie: "session=1", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Prime the mocked module graph once before any test. The first import of
  // ./routes.js + ./middleware.js after a fresh module registry can resolve
  // ./index.js to its un-mocked binding (runtime singleton = null -> 401);
  // doing it here rather than in the first real test keeps every asserted
  // request stable.
  await import("./routes.js");
  await import("./middleware.js");
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-fork-routes-"));
  poolDir = path.join(homeDir, "pool", "scribe");
  fs.mkdirSync(poolDir, { recursive: true });
  fs.writeFileSync(
    path.join(poolDir, "agent.yaml"),
    "id: scribe\nname: scribe\n"
  );

  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
  for (const id of ["admin-1", "superadmin-1", "user-1"]) {
    db.prepare("INSERT INTO user (id) VALUES (?)").run(id);
  }
  ensureTeamsTable(db);
  ensureTeamMembersTable(db);
  ensureAgentForksTable(db);
  teamId = "team-a";
  db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(
    teamId,
    "Team A",
    "admin-1"
  );
  db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(
    "team-b",
    "Team B",
    "admin-1"
  );
});

afterEach(() => {
  db.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("admin fork/assignment routes", () => {
  it("assigns a pool agent to a team (forks + link)", async () => {
    const app = await makeApp("admin");
    const res = await app.request(
      req("/admin/forks/assign", { poolId: "scribe", teamId })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { fork: { forkAgentId: string; teamId: string } };
    expect(body.fork.forkAgentId).toBe("scribe");
    expect(body.fork.teamId).toBe(teamId);
    expect(fs.existsSync(path.join(homeDir, "agents", "scribe"))).toBe(true);
  });

  it("is guarded to admins/superadmins", async () => {
    const app = await makeApp("user");
    const res = await app.request(
      req("/admin/forks/assign", { poolId: "scribe", teamId })
    );
    expect(res.status).toBe(403);
  });

  it("reassign moves the fork to another team without duplicating", async () => {
    const app = await makeApp("admin");
    await app.request(req("/admin/forks/assign", { poolId: "scribe", teamId }));
    const res = await app.request(
      req("/admin/forks/scribe/reassign", { teamId: "team-b" })
    );
    expect(res.status).toBe(200);
    const listRes = await app.request(
      new Request("http://localhost/admin/forks", {
        headers: { cookie: "session=1" },
      })
    );
    const list = (await listRes.json()) as { forks: unknown[] };
    expect(list.forks).toHaveLength(1);
  });

  it("unassign clears the team link", async () => {
    const app = await makeApp("admin");
    await app.request(req("/admin/forks/assign", { poolId: "scribe", teamId }));
    const res = await app.request(req("/admin/forks/scribe/unassign"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fork: { teamId: string | null } };
    expect(body.fork.teamId).toBeNull();
  });

  it("returns 404 assigning an unknown pool id", async () => {
    const app = await makeApp("admin");
    const res = await app.request(
      req("/admin/forks/assign", { poolId: "ghost", teamId })
    );
    expect(res.status).toBe(404);
  });

  it("lists a team's agents via GET /teams/:id/agents", async () => {
    const app = await makeApp("admin");
    await app.request(req("/admin/forks/assign", { poolId: "scribe", teamId }));
    const res = await app.request(
      new Request(`http://localhost/teams/${teamId}/agents`, {
        headers: { cookie: "session=1" },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { forks: Array<{ forkAgentId: string }> };
    expect(body.forks.map((f) => f.forkAgentId)).toEqual(["scribe"]);
  });
});
