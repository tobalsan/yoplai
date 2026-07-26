import {
  MultiUserConfigSchema,
  type AgentConfig,
  type Extension,
  type ExtensionContext,
  type ExtensionLogger,
} from "@yoplai/shared";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import { initializeMultiUserDatabase } from "./db.js";
import { createMultiUserAuth } from "./auth.js";
import { registerMultiUserRoutes } from "./routes.js";
import {
  createAgentAssignmentStore,
  type AgentAssignmentStore,
} from "./assignments.js";
import { createTeamStore, type TeamStore } from "./teams.js";
import {
  createMembershipStore,
  type MembershipStore,
} from "./membership.js";
import { createForkStore, type ForkStore } from "./forks.js";
import { createAccessResolver, type AccessResolver } from "./access.js";
import {
  createPoolCatalogResolver,
  type PoolCatalogResolver,
} from "./catalog.js";
import path from "node:path";

export type MultiUserRuntime = {
  auth: Awaited<ReturnType<typeof createMultiUserAuth>>;
  db: Database.Database;
  assignments: AgentAssignmentStore;
  teams: TeamStore;
  membership: MembershipStore;
  forks: ForkStore;
  access: AccessResolver;
  catalog: PoolCatalogResolver;
  /** Current pool agent ids (the catalog card keys), in config order. */
  getPoolAgentIds(): string[];
  getAgent: ExtensionContext["getAgent"];
  logger: ExtensionLogger;
};

let runtime: MultiUserRuntime | null = null;

export function getMultiUserRuntime(): MultiUserRuntime | null {
  return runtime;
}

const STAFF_ROLES = ["admin", "superadmin"];

function hasAdminRole(role: string | string[] | null | undefined): boolean {
  if (Array.isArray(role)) return role.some((r) => STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

export function getAgentFilter(
  userId: string,
  role: string | string[] | null | undefined
): <T extends Pick<AgentConfig, "id">>(agents: T[]) => T[] {
  return (agents) => {
    const activeRuntime = getMultiUserRuntime();
    // Staff bypass and single-user (no runtime) both see everything. Otherwise
    // visibility resolves from team membership via the access resolver — the
    // `agent_assignments` allowlist is no longer consulted.
    if (
      !activeRuntime ||
      hasAdminRole(role) ||
      activeRuntime.getPoolAgentIds().length === 0
    ) {
      return agents;
    }
    const visibleAgentIds = new Set(
      activeRuntime.access.getVisibleChatAgents(userId)
    );
    return agents.filter((agent) => visibleAgentIds.has(agent.id));
  };
}

export {
  FORWARDED_AUTH_CONTEXT_HEADER,
  createAuthMiddleware,
  forwardAuthContextToRequest,
  getForwardedAuthContext,
  getRequestAuthContext,
  hasActiveImpersonation,
  hasAgentAccess,
  requireAdmin,
  requireSuperadmin,
  requireAgentAccess,
  requireNotImpersonating,
  validateWebSocketRequest,
} from "./middleware.js";
export type { RequestAuthContext } from "./middleware.js";
export {
  getUserDataDir,
  getUserHistoryDir,
  getUserSessionsPath,
} from "./isolation.js";
export { initializeMultiUserDatabase, getAuthDbPath } from "./db.js";
export { createMultiUserAuth } from "./auth.js";
export type { MultiUserAuth } from "./auth.js";
export {
  createTeamStore,
  DEFAULT_TEAM_COLOR,
  DEFAULT_TEAM_ICON,
  DuplicateTeamNameError,
  TeamNotFoundError,
} from "./teams.js";
export type {
  Team,
  TeamStore,
  CreateTeamInput,
  UpdateTeamInput,
  DeleteTeamResult,
} from "./teams.js";
export { createMembershipStore } from "./membership.js";
export type { MembershipStore, TeamMember } from "./membership.js";
export { createAccessResolver } from "./access.js";
export type { AccessResolver } from "./access.js";
export { createPoolCatalogResolver } from "./catalog.js";
export type {
  PoolCatalogResolver,
  PoolCatalogEntry,
  PoolCatalogAction,
  CatalogUser,
} from "./catalog.js";
export {
  createForkStore,
  forkIdForPool,
  FORK_EXCLUDES,
  ForkNotFoundError,
  PoolAgentNotFoundError,
  isForkNotFoundError,
  isPoolAgentNotFoundError,
} from "./forks.js";
export type { ForkStore, AgentFork } from "./forks.js";

export const multiUserExtension: Extension = {
  id: "multiUser",
  displayName: "Multi-User Auth",
  factory: true,
  description: "OAuth authentication, sessions, and per-user agent access control",
  dependencies: [],
  configSchema: MultiUserConfigSchema,
  routePrefixes: [
    "/api/auth",
    "/api/me",
    "/api/admin",
    "/api/teams",
    "/api/pool-actions",
    "/api/impersonation",
  ],
  validateConfig(raw) {
    const result = MultiUserConfigSchema.safeParse(raw);
    return result.success
      ? { valid: true, errors: [] }
      : {
          valid: false,
          errors: result.error.issues.map((issue) => issue.message),
        };
  },
  registerRoutes(app: Hono) {
    registerMultiUserRoutes(app);
  },
  async start(ctx: ExtensionContext) {
    const config = ctx.getConfig().extensions?.multiUser;
    if (!config?.enabled) {
      throw new Error("multiUser config missing or disabled");
    }

    const db = initializeMultiUserDatabase(ctx.getDataDir());
    const auth = await createMultiUserAuth(ctx.getConfig(), config, db);
    const assignments = createAgentAssignmentStore(db);
    const membership = createMembershipStore(db);
    // Forks live under $YOPLAI_HOME/agents/<forkId>, alongside functional
    // agents, so the standard gateway `agents` glob discovers a freshly
    // copied fork and makes it runnable without a separate forks glob.
    const agentsDir = path.join(ctx.getDataDir(), "agents");
    const forks = createForkStore({
      db,
      getForksDir: () => agentsDir,
      getPoolAgent: (poolId) => {
        const pool = ctx.getConfig().pool ?? [];
        const match = pool.find((agent) => agent.id === poolId);
        if (!match) return null;
        return {
          id: match.id,
          workspaceDir: match.workspaceDir ?? match.workspace ?? "",
        };
      },
      reloadConfig: () => ctx.reloadConfig(),
    });
    // teams needs a fork lookup so deleteTeam can name soon-to-be-teamless
    // forks; forks has no dependency on teams, so construct it first.
    const teams = createTeamStore(db, membership, () => forks);
    const access = createAccessResolver({ membership, forks });
    const catalog = createPoolCatalogResolver({
      forks,
      access,
      isAgentRunnable: (agentId) => Boolean(ctx.getAgent(agentId)),
      getTeamName: (teamId) => teams.getTeam(teamId)?.name ?? null,
    });
    runtime = {
      auth,
      db,
      assignments,
      teams,
      membership,
      forks,
      access,
      catalog,
      getPoolAgentIds: () =>
        (ctx.getConfig().pool ?? []).map((agent) => agent.id),
      getAgent: ctx.getAgent,
      logger: ctx.logger,
    };
  },
  async stop() {
    runtime?.db.close();
    runtime = null;
  },
  capabilities() {
    return runtime ? ["multi-user"] : [];
  },
};
