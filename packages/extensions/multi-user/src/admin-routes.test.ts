import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { ensureTeamMembersTable, ensureTeamsTable } from "./db.js";
import { createTeamStore } from "./teams.js";
import { createMembershipStore } from "./membership.js";

function createInMemoryTeamStore(extraUserIds: string[] = []) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT)");
  for (const id of ["admin-1", "superadmin-1", ...extraUserIds]) {
    db.prepare("INSERT OR IGNORE INTO user (id) VALUES (?)").run(id);
  }
  ensureTeamsTable(db);
  ensureTeamMembersTable(db);
  const membership = createMembershipStore(db);
  const teams = createTeamStore(db, membership);
  return { teams, membership };
}

const getMultiUserRuntime = vi.fn();
const getAgent = vi.fn();
const getActiveAgents = vi.fn();
const getLoadedExtensions = vi.fn();

vi.mock("./runtime-state.js", () => ({
  getMultiUserRuntime,
}));

vi.mock("./index.js", async () => {
  const actual =
    await vi.importActual<typeof import("./index.js")>("./index.js");
  return {
    ...actual,
    getAgentFilter:
      (userId: string, role: string | string[] | null | undefined) =>
      <T extends { id: string }>(agents: T[]) => {
        const runtime = getMultiUserRuntime();
        if (!runtime) return agents;
        if (Array.isArray(role) ? role.includes("admin") : role === "admin") {
          return agents;
        }
        const allowed = new Set(
          runtime.assignments.getAssignmentsForUser(userId)
        );
        return agents.filter((agent) => allowed.has(agent.id));
      },
  };
});

vi.mock(
  "../../../../apps/gateway/src/config/index.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../../apps/gateway/src/config/index.js")
      >();
    return {
      ...actual,
      getAgent,
      getActiveAgents,
      isAgentActive: () => true,
      loadConfig: () => ({ agents: [], forkedAgents: true }),
      resolveWorkspaceDir: (workspace: string) => workspace,
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
  isMultiUserLoaded: () =>
    getLoadedExtensions().some(
      (extension: { id?: string }) => extension.id === "multiUser"
    ),
  isExtensionLoaded: (id: string) =>
    getLoadedExtensions().some(
      (extension: { id?: string }) => extension.id === id
    ),
}));

type MockSession = {
  user: {
    id: string;
    email?: string;
    name?: string;
    role?: string;
    approved?: boolean;
  };
  session: {
    id: string;
    userId: string;
  };
};

function createSession(
  role: "superadmin" | "admin" | "user",
  approved = true
): MockSession {
  return {
    user: {
      id: `${role}-1`,
      email: `${role}@example.com`,
      name: role,
      role,
      approved,
    },
    session: {
      id: `${role}-session`,
      userId: `${role}-1`,
    },
  };
}

function createAssignmentStore() {
  const byAgent = new Map<string, string[]>();
  return {
    store: {
      getAssignmentsForUser(userId: string) {
        return [...byAgent.entries()]
          .filter(([, userIds]) => userIds.includes(userId))
          .map(([agentId]) => agentId)
          .sort();
      },
      getAssignmentsForAgent(agentId: string) {
        return [...(byAgent.get(agentId) ?? [])].sort();
      },
      getAllAssignments() {
        return [...byAgent.entries()]
          .flatMap(([agentId, userIds]) =>
            [...userIds].sort().map((userId) => ({
              userId,
              agentId,
              assignedBy: "admin-1",
              assignedAt: "2026-04-04 18:00:00",
            }))
          )
          .sort((a, b) =>
            a.agentId === b.agentId
              ? a.userId.localeCompare(b.userId)
              : a.agentId.localeCompare(b.agentId)
          );
      },
      setAssignmentsForAgent(agentId: string, userIds: string[]) {
        byAgent.set(agentId, [...new Set(userIds)]);
      },
      removeAssignment(userId: string, agentId: string) {
        byAgent.set(
          agentId,
          (byAgent.get(agentId) ?? []).filter((value) => value !== userId)
        );
      },
    },
    seed(agentId: string, userIds: string[]) {
      byAgent.set(agentId, [...userIds]);
    },
  };
}

function createDbMock(users: Map<string, Record<string, unknown>>) {
  const approvedByUserId = new Map<string, number>();
  return {
    approvedByUserId,
    db: {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn((userId: string) => {
          if (sql.includes("SELECT 1 FROM user WHERE id = ?")) {
            return users.has(userId) ? { 1: 1 } : undefined;
          }
          return undefined;
        }),
        all: vi.fn((...userIds: string[]) => {
          if (sql.includes("SELECT id FROM user WHERE id IN")) {
            return userIds
              .filter((userId) => users.has(userId))
              .map((userId) => ({ id: userId }));
          }
          return [];
        }),
        run: vi.fn((approved: number, userId: string) => {
          if (sql.includes("UPDATE user SET approved")) {
            approvedByUserId.set(userId, approved);
            const user = users.get(userId);
            if (user) user.approved = approved === 1;
          }
          return { changes: 1 };
        }),
      })),
    },
  };
}

function createRuntime(options?: {
  session?: MockSession;
  users?: Array<Record<string, unknown>>;
}) {
  const assignmentStore = createAssignmentStore();
  const users = new Map(
    (
      options?.users ?? [
        {
          id: "admin-1",
          name: "Admin",
          email: "admin@example.com",
          role: "admin",
          approved: true,
        },
        {
          id: "user-1",
          name: "User One",
          email: "user1@example.com",
          role: "user",
          approved: false,
        },
        {
          id: "user-2",
          name: "User Two",
          email: "user2@example.com",
          role: "user",
          approved: true,
        },
      ]
    ).map((user) => [String(user.id), { ...user }])
  );
  const { approvedByUserId, db } = createDbMock(users);
  const listUsers = vi.fn(async () => ({
    users: [...users.values()],
    total: users.size,
  }));
  const getUser = vi.fn(async ({ query }: { query: { id: string } }) =>
    users.get(query.id)
  );
  const setRole = vi.fn(
    async ({ body }: { body: { userId: string; role: string } }) => {
      const user = users.get(body.userId);
      if (user) user.role = body.role;
      return { user };
    }
  );
  const getSession = vi.fn(
    async () => options?.session ?? createSession("admin")
  );

  const { teams, membership } = createInMemoryTeamStore([...users.keys()]);

  const runtime = {
    auth: {
      api: {
        getSession,
        listUsers,
        getUser,
        setRole,
      },
    },
    db,
    assignments: assignmentStore.store,
    teams,
    membership,
    getAgent,
  };

  return {
    runtime,
    users,
    approvedByUserId,
    listUsers,
    getUser,
    setRole,
    getSession,
    assignmentStore,
    teams,
    membership,
  };
}

function createAdminApp() {
  return new Hono();
}

async function importAdminRoutes() {
  return import("./routes.js");
}

async function importAuthMiddleware() {
  return import("./middleware.js");
}

function makeAuthRequest(path: string) {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: "session=1" },
  });
}

function encodeAuthHeader(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  getAgent.mockImplementation((agentId: string) =>
    [
      { id: "agent-a", name: "Agent A", model: { model: "m", provider: "p" } },
      { id: "agent-b", name: "Agent B", model: { model: "m", provider: "p" } },
    ].find((agent) => agent.id === agentId)
  );
  getActiveAgents.mockReturnValue([
    {
      id: "agent-a",
      name: "Agent A",
      model: { provider: "anthropic", model: "claude" },
      workspace: "/tmp/a",
    },
    {
      id: "agent-b",
      name: "Agent B",
      model: { provider: "anthropic", model: "claude" },
      workspace: "/tmp/b",
    },
  ]);
  getLoadedExtensions.mockReturnValue([{ id: "multiUser" }]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("multi-user admin routes", () => {
  it("admin can list users", async () => {
    const runtime = createRuntime();
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(makeAuthRequest("/admin/users"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: expect.arrayContaining([
        expect.objectContaining({ id: "admin-1", role: "admin" }),
        expect.objectContaining({ id: "user-1", approved: false }),
      ]),
      total: 3,
    });
    expect(runtime.listUsers).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      query: {},
    });
  });

  it("superadmin can start impersonation for another user", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const runtime = createRuntime({ session: createSession("superadmin") });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const { getImpersonation, endImpersonation } =
      await import("./impersonation.js");
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/impersonate/start", {
        method: "POST",
        headers: {
          cookie: "session=1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ targetUserId: "user-1" }),
      })
    );

    expect(response.status).toBe(204);
    expect(getImpersonation("superadmin-session")?.targetUserId).toBe("user-1");
    endImpersonation("superadmin-session");
  });

  it("rejects self impersonation", async () => {
    const runtime = createRuntime({ session: createSession("superadmin") });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/impersonate/start", {
        method: "POST",
        headers: {
          cookie: "session=1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ targetUserId: "superadmin-1" }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "cannot_impersonate_self",
    });
  });

  it("admin can approve and reject a user", async () => {
    const runtime = createRuntime();
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const approveResponse = await app.request(
      new Request("http://localhost/admin/users/user-1", {
        method: "PATCH",
        headers: {
          cookie: "session=1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ approved: true }),
      })
    );

    expect(approveResponse.status).toBe(200);
    expect(runtime.approvedByUserId.get("user-1")).toBe(1);
    await expect(approveResponse.json()).resolves.toEqual({
      user: expect.objectContaining({ id: "user-1", approved: true }),
    });

    const rejectResponse = await app.request(
      new Request("http://localhost/admin/users/user-1", {
        method: "PATCH",
        headers: {
          cookie: "session=1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ approved: false }),
      })
    );

    expect(rejectResponse.status).toBe(200);
    expect(runtime.approvedByUserId.get("user-1")).toBe(0);
  });

  async function patchRole(
    session: MockSession,
    targetId: string,
    role: string
  ) {
    const runtime = createRuntime({ session });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request(`http://localhost/admin/users/${targetId}`, {
        method: "PATCH",
        headers: {
          cookie: "session=1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ role }),
      })
    );
    return { runtime, response };
  }

  it("superadmin can promote user->admin", async () => {
    const { runtime, response } = await patchRole(
      createSession("superadmin"),
      "user-1",
      "admin"
    );
    expect(response.status).toBe(200);
    expect(runtime.setRole).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { userId: "user-1", role: "admin" },
    });
    await expect(response.json()).resolves.toEqual({
      user: expect.objectContaining({ id: "user-1", role: "admin" }),
    });
  });

  it("superadmin can demote admin->user", async () => {
    const { runtime, response } = await patchRole(
      createSession("superadmin"),
      "admin-1",
      "user"
    );
    expect(response.status).toBe(200);
    expect(runtime.setRole).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { userId: "admin-1", role: "user" },
    });
  });

  it("superadmin can promote user->superadmin", async () => {
    const { runtime, response } = await patchRole(
      createSession("superadmin"),
      "user-1",
      "superadmin"
    );
    expect(response.status).toBe(200);
    expect(runtime.setRole).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { userId: "user-1", role: "superadmin" },
    });
  });

  it("superadmin can demote another superadmin (succession/recovery)", async () => {
    const session = createSession("superadmin");
    const runtime = createRuntime({
      session,
      users: [
        {
          id: "superadmin-1",
          name: "Super",
          email: "superadmin@example.com",
          role: "superadmin",
          approved: true,
        },
        {
          id: "superadmin-2",
          name: "Super Two",
          email: "super2@example.com",
          role: "superadmin",
          approved: true,
        },
      ],
    });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/users/superadmin-2", {
        method: "PATCH",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      })
    );
    expect(response.status).toBe(200);
    expect(runtime.setRole).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { userId: "superadmin-2", role: "admin" },
    });
  });

  it("admin cannot change any role (403) and setRole is not called", async () => {
    const { runtime, response } = await patchRole(
      createSession("admin"),
      "user-1",
      "admin"
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(runtime.setRole).not.toHaveBeenCalled();
  });

  it("admin can still approve users (non-role change)", async () => {
    const runtime = createRuntime({ session: createSession("admin") });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/users/user-1", {
        method: "PATCH",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      })
    );
    expect(response.status).toBe(200);
    expect(runtime.approvedByUserId.get("user-1")).toBe(1);
  });

  it("regular user cannot change any role (403)", async () => {
    const { runtime, response } = await patchRole(
      createSession("user"),
      "user-2",
      "admin"
    );
    expect(response.status).toBe(403);
    expect(runtime.setRole).not.toHaveBeenCalled();
  });

  it("admin can list and set agent assignments", async () => {
    const runtime = createRuntime();
    runtime.assignmentStore.seed("agent-a", ["user-1"]);
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const listResponse = await app.request(
      makeAuthRequest("/admin/agents/assignments")
    );
    expect(listResponse.status).toBe(200);
    await expect(listResponse.json()).resolves.toEqual({
      assignments: [
        {
          userId: "user-1",
          agentId: "agent-a",
          assignedBy: "admin-1",
          assignedAt: "2026-04-04 18:00:00",
        },
      ],
    });

    const setResponse = await app.request(
      new Request("http://localhost/admin/agents/agent-b/assignments", {
        method: "PUT",
        headers: {
          cookie: "session=1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userIds: ["user-1", "user-2", "user-2"] }),
      })
    );

    expect(setResponse.status).toBe(200);
    await expect(setResponse.json()).resolves.toEqual({
      agentId: "agent-b",
      userIds: ["user-1", "user-2"],
    });
  });

  it("rejects unknown user ids when setting agent assignments", async () => {
    const runtime = createRuntime();
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/agents/agent-b/assignments", {
        method: "PUT",
        headers: {
          cookie: "session=1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ userIds: ["user-1", "missing-user"] }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unknown user ids",
      userIds: ["missing-user"],
    });
    expect(
      runtime.assignmentStore.store.getAssignmentsForAgent("agent-b")
    ).toEqual([]);
  });

  it("admin can create, edit, list and delete a team", async () => {
    const runtime = createRuntime();
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const createResponse = await app.request(
      new Request("http://localhost/admin/teams", {
        method: "POST",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ name: "Platform", description: "Core" }),
      })
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      team: {
        id: string;
        name: string;
        color: string;
        icon: string;
        createdBy: string;
      };
    };
    expect(created.team).toMatchObject({
      name: "Platform",
      createdBy: "admin-1",
    });
    // Defaults applied server-side when color/icon omitted.
    expect(created.team.color).toBeTruthy();
    expect(created.team.icon).toBeTruthy();

    const editResponse = await app.request(
      new Request(`http://localhost/admin/teams/${created.team.id}`, {
        method: "PATCH",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ name: "Platform Team", color: "#123456" }),
      })
    );
    expect(editResponse.status).toBe(200);
    await expect(editResponse.json()).resolves.toMatchObject({
      team: { id: created.team.id, name: "Platform Team", color: "#123456" },
    });

    const deleteResponse = await app.request(
      new Request(`http://localhost/admin/teams/${created.team.id}`, {
        method: "DELETE",
        headers: { cookie: "session=1" },
      })
    );
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({
      deleted: true,
      teamlessUsers: [],
      teamlessAgents: [],
    });
  });

  it("rejects a duplicate team name with 409", async () => {
    const runtime = createRuntime();
    getMultiUserRuntime.mockReturnValue(runtime.runtime);
    runtime.teams.createTeam({ name: "Alpha", createdBy: "admin-1" });

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/teams", {
        method: "POST",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ name: "alpha" }),
      })
    );
    expect(response.status).toBe(409);
  });

  it("previews users made teamless by deleting an All-users team", async () => {
    const runtime = createRuntime();
    const allUsersTeam = runtime.teams.createTeam({
      name: "Everyone",
      createdBy: "admin-1",
    });
    const otherTeam = runtime.teams.createTeam({
      name: "Other",
      createdBy: "admin-1",
    });
    runtime.membership.setMembers(allUsersTeam.id, { mode: "all" }, "admin-1");
    runtime.membership.setMembers(otherTeam.id, { mode: "list", userIds: ["user-2"] }, "admin-1");
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      makeAuthRequest(`/admin/teams/${allUsersTeam.id}/delete-preview`)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      teamlessUsers: ["admin-1", "superadmin-1", "user-1"],
    });
  });

  it("returns 404 when editing a missing team", async () => {
    const runtime = createRuntime();
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/teams/missing", {
        method: "PATCH",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      })
    );
    expect(response.status).toBe(404);
  });

  it("any authenticated user can list teams", async () => {
    const runtime = createRuntime({ session: createSession("user") });
    runtime.teams.createTeam({ name: "Visible", createdBy: "admin-1" });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(makeAuthRequest("/teams"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { teams: Array<{ name: string }> };
    expect(body.teams.map((team) => team.name)).toContain("Visible");
  });

  it("non-admin cannot mutate teams (403)", async () => {
    const runtime = createRuntime({ session: createSession("user") });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request("http://localhost/admin/teams", {
        method: "POST",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ name: "Nope" }),
      })
    );
    expect(response.status).toBe(403);
    expect(runtime.teams.listTeams()).toHaveLength(0);
  });

  it("admin sets and removes team members", async () => {
    const runtime = createRuntime();
    const team = runtime.teams.createTeam({
      name: "Platform",
      createdBy: "admin-1",
    });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const addUrl = `http://localhost/admin/teams/${team.id}/members`;
    const setBody = (userIds: string[]) =>
      new Request(addUrl, {
        method: "PUT",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ mode: "list", userIds }),
      });

    const firstAdd = await app.request(setBody(["user-1"]));
    expect(firstAdd.status).toBe(200);
    await expect(firstAdd.json()).resolves.toEqual({
      teamId: team.id,
      allUsers: false,
      members: [{ id: "user-1", name: null, email: null }],
    });

    // Re-adding is idempotent: still one member, still 200.
    const secondAdd = await app.request(setBody(["user-1"]));
    expect(secondAdd.status).toBe(200);
    await expect(secondAdd.json()).resolves.toEqual({
      teamId: team.id,
      allUsers: false,
      members: [{ id: "user-1", name: null, email: null }],
    });

    const removeResponse = await app.request(
      new Request(`http://localhost/admin/teams/${team.id}/members/user-1`, {
        method: "DELETE",
        headers: { cookie: "session=1" },
      })
    );
    expect(removeResponse.status).toBe(200);
    await expect(removeResponse.json()).resolves.toEqual({
      teamId: team.id,
      allUsers: false,
      members: [],
    });
  });

  it("sets All users, returns the full roster, and rejects individual removal", async () => {
    const runtime = createRuntime();
    const team = runtime.teams.createTeam({ name: "Platform", createdBy: "admin-1" });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);
    const url = `http://localhost/admin/teams/${team.id}/members`;

    const set = () => new Request(url, { method: "PUT", headers: { cookie: "session=1", "content-type": "application/json" }, body: JSON.stringify({ mode: "all" }) });
    const first = await app.request(set());
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { allUsers: boolean; members: Array<{ id: string }> };
    const repeated = await app.request(set());
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(firstBody);

    const listed = await app.request(makeAuthRequest(`/teams/${team.id}/members`));
    const body = await listed.json() as { allUsers: boolean; members: Array<{ id: string }> };
    expect(body.allUsers).toBe(true);
    expect(body.members.map((member) => member.id)).toEqual(expect.arrayContaining(["admin-1", "user-1", "user-2"]));
    expect((await app.request(new Request(`${url}/user-1`, { method: "DELETE", headers: { cookie: "session=1" } }))).status).toBe(409);
  });

  it("add-member returns 404 for a missing team or user", async () => {
    const runtime = createRuntime();
    const team = runtime.teams.createTeam({
      name: "Platform",
      createdBy: "admin-1",
    });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const missingTeam = await app.request(
      new Request("http://localhost/admin/teams/nope/members", {
        method: "PUT",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ mode: "list", userIds: ["user-1"] }),
      })
    );
    expect(missingTeam.status).toBe(404);

    const missingUser = await app.request(
      new Request(`http://localhost/admin/teams/${team.id}/members`, {
        method: "PUT",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ mode: "list", userIds: ["ghost"] }),
      })
    );
    expect(missingUser.status).toBe(404);
  });

  it("non-admin cannot add a member (403)", async () => {
    const runtime = createRuntime({ session: createSession("user") });
    const team = runtime.teams.createTeam({
      name: "Platform",
      createdBy: "admin-1",
    });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      new Request(`http://localhost/admin/teams/${team.id}/members`, {
        method: "PUT",
        headers: { cookie: "session=1", "content-type": "application/json" },
        body: JSON.stringify({ mode: "list", userIds: ["user-1"] }),
      })
    );
    expect(response.status).toBe(403);
    expect(runtime.membership.listUsersForTeam(team.id)).toEqual([]);
  });

  it("any authenticated user can list a team's members", async () => {
    const runtime = createRuntime({ session: createSession("user") });
    const team = runtime.teams.createTeam({
      name: "Platform",
      createdBy: "admin-1",
    });
    runtime.membership.setMembers(team.id, { mode: "list", userIds: ["user-1"] }, "admin-1");
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(
      makeAuthRequest(`/teams/${team.id}/members`)
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      teamId: team.id,
      allUsers: false,
      members: [{ id: "user-1", name: null, email: null }],
    });
  });

  it("non-admin gets 403 on admin routes", async () => {
    const runtime = createRuntime({ session: createSession("user") });
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const usersResponse = await app.request(makeAuthRequest("/admin/users"));
    expect(usersResponse.status).toBe(403);

    const assignmentsResponse = await app.request(
      makeAuthRequest("/admin/agents/assignments")
    );
    expect(assignmentsResponse.status).toBe(403);
  });

  it("/api/me returns current user and assignments", async () => {
    const runtime = createRuntime({ session: createSession("user") });
    runtime.assignmentStore.seed("agent-a", ["user-1"]);
    runtime.assignmentStore.seed("agent-b", ["user-1", "user-2"]);
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { registerMultiUserRoutes } = await importAdminRoutes();
    const { createAuthMiddleware } = await importAuthMiddleware();
    const app = createAdminApp();
    app.use("*", createAuthMiddleware());
    registerMultiUserRoutes(app);

    const response = await app.request(makeAuthRequest("/me"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      user: {
        id: "user-1",
        name: "user",
        email: "user@example.com",
        role: "user",
        approved: true,
      },
      assignedAgentIds: ["agent-a", "agent-b"],
    });
  });
});

describe("multi-user api core", () => {
  it("/api/agents filters assignments for non-admin users", async () => {
    const runtime = createRuntime();
    runtime.assignmentStore.seed("agent-b", ["user-1"]);
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { api } =
      await import("../../../../apps/gateway/src/server/api.core.js");
    const response = await api.request(
      new Request("http://localhost/agents", {
        headers: {
          "x-yoplai-auth-context": encodeAuthHeader({
            user: {
              id: "user-1",
              role: "user",
              approved: true,
            },
            session: {
              id: "session-1",
              userId: "user-1",
            },
          }),
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ id: "agent-b" }),
    ]);
  });

  it("/api/agents stays unfiltered for admins", async () => {
    const runtime = createRuntime();
    runtime.assignmentStore.seed("agent-b", ["user-1"]);
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { api } =
      await import("../../../../apps/gateway/src/server/api.core.js");
    const response = await api.request(
      new Request("http://localhost/agents", {
        headers: {
          "x-yoplai-auth-context": encodeAuthHeader({
            user: {
              id: "admin-1",
              role: "admin",
              approved: true,
            },
            session: {
              id: "session-1",
              userId: "admin-1",
            },
          }),
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ id: "agent-a" }),
      expect.objectContaining({ id: "agent-b" }),
    ]);
  });

  it("/api/agents/status filters assignments for non-admin users", async () => {
    const runtime = createRuntime();
    runtime.assignmentStore.seed("agent-b", ["user-1"]);
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { api } =
      await import("../../../../apps/gateway/src/server/api.core.js");
    const response = await api.request(
      new Request("http://localhost/agents/status", {
        headers: {
          "x-yoplai-auth-context": encodeAuthHeader({
            user: {
              id: "user-1",
              role: "user",
              approved: true,
            },
            session: {
              id: "session-1",
              userId: "user-1",
            },
          }),
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      statuses: {
        "agent-b": "idle",
      },
    });
  });

  it("/api/capabilities includes multi-user info", async () => {
    const runtime = createRuntime();
    runtime.assignmentStore.seed("agent-b", ["user-1"]);
    getMultiUserRuntime.mockReturnValue(runtime.runtime);

    const { api } =
      await import("../../../../apps/gateway/src/server/api.core.js");
    const response = await api.request(
      new Request("http://localhost/capabilities", {
        headers: {
          "x-yoplai-auth-context": encodeAuthHeader({
            user: {
              id: "user-1",
              name: "User One",
              email: "user1@example.com",
              role: "user",
              approved: true,
            },
            session: {
              id: "session-1",
              userId: "user-1",
            },
          }),
        },
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: 2,
      extensions: { multiUser: true },
      agents: ["agent-b"],
      multiUser: true,
      agentFab: false,
      forkedAgents: true,
      user: {
        id: "user-1",
        name: "User One",
        email: "user1@example.com",
        role: "user",
      },
    });
  });
});
