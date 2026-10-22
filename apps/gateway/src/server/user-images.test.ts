import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayConfigSchema, type GatewayConfig } from "@yoplai/shared";
import { createMultiUserAuth } from "../../../../packages/extensions/multi-user/src/auth.js";
import { initializeMultiUserDatabase } from "../../../../packages/extensions/multi-user/src/db.js";
import { createMembershipStore } from "../../../../packages/extensions/multi-user/src/membership.js";
import { createAuthMiddleware, getRequestAuthContext } from "../../../../packages/extensions/multi-user/src/middleware.js";
import { registerMultiUserRoutes } from "../../../../packages/extensions/multi-user/src/routes.js";
import { setMultiUserRuntime, type MultiUserRuntime } from "../../../../packages/extensions/multi-user/src/runtime-state.js";
import { createTeamStore } from "../../../../packages/extensions/multi-user/src/teams.js";
import { getEligibleAccount } from "../../../../packages/extensions/multi-user/src/users.js";
import { authenticateDashboardRequest, listDashboardRecipients, resolveDashboardHttpActor } from "../canvas/http-auth.js";
import { DashboardPinStore } from "../canvas/pins.js";
import { createDashboardResourceRoutes } from "../canvas/routes.js";
import { DashboardRegistry } from "../canvas/store.js";
import { SkillAccessPolicy } from "../skills/access.js";
import { listSkillRecipients, skillOwnerName } from "../skills/http-auth.js";
import { ImportTokenStore } from "../skills/import-tokens.js";
import { createSkillRoutes } from "../skills/routes.js";
import { SkillStore } from "../skills/store.js";

vi.mock("../config/index.js", async (original) => ({
  ...await original<typeof import("../config/index.js")>(),
  loadConfig: () => ({ extensions: { multiUser: { enabled: true } } }),
}));

let home: string;
let db: ReturnType<typeof initializeMultiUserDatabase>;
let app: Hono;
let cookie: string;
let ownerId: string;
let membership: ReturnType<typeof createMembershipStore>;
let teams: ReturnType<typeof createTeamStore>;
let config: GatewayConfig;
const picture = "https://lh3.googleusercontent.com/alice-current";

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "user-images-"));
  db = initializeMultiUserDatabase(home);
  config = GatewayConfigSchema.parse({ version: 2, agents: [], gateway: { port: 4999 }, extensions: { multiUser: { enabled: true, emailAndPassword: { enabled: true }, sessionSecret: "isolated-profile-images-test-secret" } } });
  const multiUser = config.extensions?.multiUser;
  if (!multiUser?.enabled) throw new Error("Expected multi-user fixture");
  const auth = await createMultiUserAuth(config, multiUser, db);
  const signup = await auth.handler(new Request("http://127.0.0.1:4999/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:4999" }, body: JSON.stringify({ email: "owner@example.test", name: "Owner", password: "isolated-profile-images-password" }) }));
  expect(signup.status).toBe(200);
  cookie = signup.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  ownerId = (await signup.json()).user.id;
  const insert = db.prepare("INSERT INTO user (id, name, email, emailVerified, image, createdAt, updatedAt, approved, role, banned) VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?)");
  insert.run("alice", "Alice", "alice@example.test", picture, 1, "user", 0);
  insert.run("bob", "Bob", "bob@example.test", null, 1, "user", 0);
  insert.run("pending", "Pending", "pending@example.test", picture, 0, "user", 0);
  insert.run("banned", "Banned", "banned@example.test", picture, 1, "user", 1);
  membership = createMembershipStore(db);
  teams = createTeamStore(db, membership);
  setMultiUserRuntime({ auth, db, teams, membership } as unknown as MultiUserRuntime);
  app = new Hono();
  app.use("*", createAuthMiddleware());
  registerMultiUserRoutes(app);
});

afterEach(async () => {
  setMultiUserRuntime(null);
  db.close();
  await fs.rm(home, { recursive: true, force: true });
});

const request = (url: string) => app.request(`http://127.0.0.1:4999${url}`, { headers: { Cookie: cookie } });

it("team member responses carry stored pictures and null for members without pictures", async () => {
  const team = teams.createTeam({ name: "Content", createdBy: ownerId });
  membership.setMembers(team.id, { mode: "list", userIds: ["alice", "bob"] }, ownerId);
  const response = await request(`/teams/${team.id}/members`);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ members: [
    { id: "alice", name: "Alice", email: "alice@example.test", image: picture },
    { id: "bob", name: "Bob", email: "bob@example.test", image: null },
  ] });
});

it("All users responses retain pictures in both the live roster and saved explicit roster", async () => {
  const team = teams.createTeam({ name: "Everyone", createdBy: ownerId });
  membership.setMembers(team.id, { mode: "list", userIds: ["alice", "bob"] }, ownerId);
  membership.setMembers(team.id, { mode: "all" }, ownerId);
  const response = await request(`/teams/${team.id}/members`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.members).toHaveLength(5);
  expect(body).toMatchObject({ allUsers: true, members: expect.arrayContaining([
    { id: "alice", name: "Alice", email: "alice@example.test", image: picture },
    { id: "bob", name: "Bob", email: "bob@example.test", image: null },
  ]), savedMembers: [
    { id: "alice", name: "Alice", email: "alice@example.test", image: picture },
    { id: "bob", name: "Bob", email: "bob@example.test", image: null },
  ] });
});

it("teamless-user responses carry pictures without excluding pending profiles", async () => {
  const team = teams.createTeam({ name: "Assigned", createdBy: ownerId });
  membership.setMembers(team.id, { mode: "list", userIds: [ownerId, "banned"] }, ownerId);
  const response = await request("/admin/users/no-team");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ users: [
    { id: "alice", name: "Alice", email: "alice@example.test", image: picture, approved: true, role: "user" },
    { id: "bob", name: "Bob", email: "bob@example.test", image: null, approved: true, role: "user" },
    { id: "pending", name: "Pending", email: "pending@example.test", image: picture, approved: false, role: "user" },
  ] });
});

it("dashboard recipient responses carry pictures and preserve account eligibility", async () => {
  const routes = createDashboardResourceRoutes({
    getConfig: () => config, getAgent: () => undefined,
    registry: new DashboardRegistry(path.join(home, "canvas", "registry.json")),
    pins: new DashboardPinStore(path.join(home, "canvas", "pins.json")), authenticate: authenticateDashboardRequest,
    resolveActor: resolveDashboardHttpActor, listRecipients: listDashboardRecipients,
    hasAgentAccess: async () => false,
  });
  const response = await routes.request("/recipients", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ users: [
    { id: "alice", name: "Alice", email: "alice@example.test", image: picture },
    { id: "bob", name: "Bob", email: "bob@example.test", image: null },
    { id: ownerId, name: "Owner", email: "owner@example.test", image: null },
  ] });
});

it("skill recipient responses carry pictures and preserve account eligibility", async () => {
  const store = new SkillStore(home);
  const policy = new SkillAccessPolicy({ multiUser: true, getEligibleAccount: (id) => getEligibleAccount(db, id) });
  app.route("/", createSkillRoutes({
    getContext: async () => ({ store, policy, multiUser: true }), tokens: new ImportTokenStore(home),
    getActor: async (c) => {
      const auth = getRequestAuthContext(c);
      const account = auth && getEligibleAccount(db, auth.user.id);
      return account ? { userId: account.id, role: account.role } : undefined;
    },
    getAgents: async () => [], getOwnerName: skillOwnerName, getRecipients: listSkillRecipients,
    publicBaseUrl: () => "http://127.0.0.1:4999",
  }));
  const response = await request("/skills/recipients");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ users: [
    { id: "alice", name: "Alice", email: "alice@example.test", image: picture },
    { id: "bob", name: "Bob", email: "bob@example.test", image: null },
    { id: ownerId, name: "Owner", email: "owner@example.test", image: null },
  ] });
});

it("admin user responses preserve Better Auth pictures and profiles without pictures", async () => {
  const response = await request("/admin/users");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.total).toBe(5);
  expect(body.users).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "alice", name: "Alice", email: "alice@example.test", image: picture }),
    expect.objectContaining({ id: "bob", name: "Bob", email: "bob@example.test", image: null }),
  ]));
});
