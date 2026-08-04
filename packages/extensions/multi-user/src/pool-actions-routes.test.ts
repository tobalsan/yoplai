import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
import { createAccessResolver } from "./access.js";
import { createPoolCatalogResolver } from "./catalog.js";
import type { PoolCatalogEntry } from "./catalog.js";

const getMultiUserRuntime = vi.fn();

vi.mock("./runtime-state.js", () => ({
  getMultiUserRuntime,
}));

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

function createSession(userId: string, role: Role) {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: userId,
      role,
      approved: true,
    },
    session: { id: `${userId}-session`, userId },
  };
}

// The full pool the /pool-actions route resolves over.
const POOL_IDS = ["scribe", "sage", "scout", "orphan", "fresh"];

let db: Database.Database;
let homeDir: string;
let poolDir: string;
let getSession: ReturnType<typeof vi.fn>;

function writePoolAgent(id: string): { id: string; workspaceDir: string } {
  const dir = path.join(poolDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), `id: ${id}\nname: ${id}\n`);
  return { id, workspaceDir: dir };
}

function buildRuntime() {
  const membership = createMembershipStore(db);
  const teams = createTeamStore(db, membership);
  const poolAgents = new Map(POOL_IDS.map((id) => [id, writePoolAgent(id)]));
  const forks = createForkStore({
    db,
    getForksDir: () => path.join(homeDir, "agents"),
    getPoolAgent: (poolId) => poolAgents.get(poolId) ?? null,
  });
  const access = createAccessResolver({ membership, forks });
  const catalog = createPoolCatalogResolver({
    forks,
    access,
    isAgentRunnable: () => true,
    getTeamName: (teamId) => teams.getTeam(teamId)?.name ?? null,
  });
  return {
    auth: { api: { getSession } },
    db,
    teams,
    membership,
    forks,
    access,
    catalog,
    getPoolAgentIds: () => POOL_IDS,
  };
}

async function makeApp(userId: string, role: Role) {
  getSession = vi.fn(async () => createSession(userId, role));
  getMultiUserRuntime.mockReturnValue(buildRuntime());
  const { registerMultiUserRoutes } = await import("./routes.js");
  const { createAuthMiddleware } = await import("./middleware.js");
  const app = new Hono();
  app.use("*", createAuthMiddleware());
  registerMultiUserRoutes(app);
  return app;
}

function getReq() {
  return new Request("http://localhost/pool-actions", {
    headers: { cookie: "session=1" },
  });
}

async function actionsFor(userId: string, role: Role) {
  const app = await makeApp(userId, role);
  const res = await app.request(getReq());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { actions: PoolCatalogEntry[] };
  const map = new Map(body.actions.map((entry) => [entry.poolId, entry]));
  return { body, map };
}

beforeAll(async () => {
  await import("./routes.js");
  await import("./middleware.js");
});

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-pool-actions-"));
  poolDir = path.join(homeDir, "pool");
  fs.mkdirSync(poolDir, { recursive: true });

  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
  for (const id of ["admin-1", "superadmin-1", "alice", "bob", "loner"]) {
    db.prepare("INSERT INTO user (id) VALUES (?)").run(id);
  }
  ensureTeamsTable(db);
  ensureTeamMembersTable(db);
  ensureAgentForksTable(db);
  for (const [id, name] of [
    ["team-red", "Red"],
    ["team-blue", "Blue"],
    ["team-green", "Green"],
  ] as const) {
    db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(
      id,
      name,
      "admin-1"
    );
  }

  // Seed forks + memberships up front so the runtime built per request sees a
  // consistent world. scribe→red, sage→blue, scout→green; orphan teamless;
  // fresh never forked. alice∈red+blue, bob∈green, loner∈none.
  const membership = createMembershipStore(db);
  const forks = createForkStore({
    db,
    getForksDir: () => path.join(homeDir, "agents"),
    getPoolAgent: (poolId) => writePoolAgent(poolId),
  });
  forks.setTeams("scribe", { mode: "list", teamIds: ["team-red"] }, "admin-1");
  forks.setTeams("sage", { mode: "list", teamIds: ["team-blue"] }, "admin-1");
  forks.setTeams("scout", { mode: "list", teamIds: ["team-green"] }, "admin-1");
  forks.setTeams("orphan", { mode: "list", teamIds: [] }, "admin-1");
  membership.setMembers("team-red", { mode: "list", userIds: ["alice"] }, "admin-1");
  membership.setMembers("team-blue", { mode: "list", userIds: ["alice"] }, "admin-1");
  membership.setMembers("team-green", { mode: "list", userIds: ["bob"] }, "admin-1");
});

afterEach(() => {
  db.close();
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("GET /pool-actions", () => {
  it("returns chat + fork agent id where a member shares the team", async () => {
    const { map } = await actionsFor("alice", "user");
    expect(map.get("scribe")).toMatchObject({
      action: "chat",
      chatAgentId: "scribe",
      forked: true,
    });
    expect(map.get("sage")?.action).toBe("chat");
  });

  it("returns none where a member shares no team, and for teamless forks", async () => {
    const { map } = await actionsFor("alice", "user");
    // scout is green; alice is not → visible but not chattable.
    expect(map.get("scout")).toMatchObject({
      action: "none",
      chatAgentId: null,
      reason: "other_team",
      teamName: "Green",
    });
    // orphan is teamless → none.
    expect(map.get("orphan")).toMatchObject({
      action: "none",
      reason: "unassigned",
      teamName: null,
    });
  });

  it("returns none for every agent to a teamless non-staff user", async () => {
    const { body } = await actionsFor("loner", "user");
    expect(body.actions.every((e) => e.action === "none")).toBe(true);
  });

  it("does not offer assign_to_team to a non-staff user", async () => {
    const { map } = await actionsFor("alice", "user");
    expect(map.get("fresh")?.action).toBe("none");
    expect(map.get("fresh")?.reason).toBe("unassigned");
  });

  it("gives an admin chat for every fork and assign_to_team for unforked", async () => {
    const { map } = await actionsFor("admin-1", "admin");
    for (const id of ["scribe", "sage", "scout", "orphan"]) {
      expect(map.get(id)?.action).toBe("chat");
    }
    expect(map.get("fresh")?.action).toBe("assign_to_team");
  });

  it("gives a superadmin the same staff action states", async () => {
    const { map } = await actionsFor("superadmin-1", "superadmin");
    expect(map.get("orphan")?.action).toBe("chat"); // teamless fork, staff bypass
    expect(map.get("fresh")?.action).toBe("assign_to_team");
  });

  it("preserves pool order and covers the whole pool", async () => {
    const { body } = await actionsFor("alice", "user");
    expect(body.actions.map((e) => e.poolId)).toEqual(POOL_IDS);
  });
});
