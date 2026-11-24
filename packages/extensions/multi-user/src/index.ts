import {
  MultiUserConfigSchema,
  registerSurfaceLinkService,
  resolveWebBaseUrl,
  type AgentConfig,
  type Extension,
  type ExtensionContext,
} from "@yoplai/shared";
import type { Hono } from "hono";
import { ensureManagedKeyPrefixIndex, initializeMultiUserDatabase } from "./db.js";
import { createMultiUserAuth, getTrustedOrigins } from "./auth.js";
import { createGatewayLinkService } from "./gateway-link.js";
import { registerMultiUserRoutes } from "./routes.js";
import { createAgentAssignmentStore } from "./assignments.js";
import { createTeamStore } from "./teams.js";
import { createMembershipStore } from "./membership.js";
import { createOnboardingStore } from "./onboarding.js";
import { createConnectPromptStore } from "./connect-prompt.js";
import { createForkStore } from "./forks.js";
import { createAccessResolver } from "./access.js";
import {
  canUserUseAgent,
  getMultiUserRuntime,
  setMultiUserRuntime,
} from "./runtime-state.js";
import { createSurfaceLinkService } from "./surface-links.js";
import { registerSurfaceLinkRoutes } from "./surface-link-routes.js";

let unregisterSurfaceLinks: (() => void) | undefined;
let activeContext: ExtensionContext | undefined;

export { canUserUseAgent, getMultiUserRuntime, isGatewayLinkReady } from "./runtime-state.js";
export type { ManagedKeyState } from "./gateway-link.js";

/**
 * The state of an API key for a socket that must stop when its key stops. `unmanaged` is a key that the link service
 * does not own. A managed key is `active`, `inactive` (expired, replaced, revoked, or blocked), or `missing`.
 */
export function getManagedKeyState(keyId: string, ownerId: string): import("./gateway-link.js").ManagedKeyState {
  return getMultiUserRuntime()?.gatewayLinks?.getManagedKeyState(keyId, ownerId) ?? "unmanaged";
}
export type { MultiUserRuntime } from "./runtime-state.js";

function hasSuperadminRole(role: string | string[] | null | undefined): boolean {
  if (Array.isArray(role)) return role.includes("superadmin");
  return role === "superadmin";
}

export function getAgentFilter(
  userId: string,
  role: string | string[] | null | undefined
): <T extends Pick<AgentConfig, "id">>(agents: T[]) => T[] {
  return (agents) => {
    const activeRuntime = getMultiUserRuntime();
    // Superadmins and single-user (no runtime) see everything.
    if (!activeRuntime || hasSuperadminRole(role)) {
      return agents;
    }
    return agents.filter((agent) => canUserUseAgent(userId, agent.id));
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
  canManageAgent,
  requireAdmin,
  requireSuperadmin,
  requireAgentAccess,
  requireNotImpersonating,
  validateWebSocketRequest,
  recheckWebSocketSession,
  isVerifiedBearerRequest,
} from "./middleware.js";
export type { RequestAuthContext } from "./middleware.js";
export {
  getUserDataDir,
  getUserHistoryDir,
  getUserSessionsPath,
} from "./isolation.js";
export type { OnboardingState, OnboardingStatus } from "./onboarding.js";
export type { ConnectPromptState, ConnectPromptStore } from "./connect-prompt.js";
export { initializeMultiUserDatabase, getAuthDbPath } from "./db.js";
export { createMultiUserAuth, getTrustedOrigins } from "./auth.js";
export type { MultiUserAuth } from "./auth.js";
export { rejectBetterAuthAdminRoute } from "./routes.js";
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
export { getEligibleAccount } from "./users.js";
export type { EligibleAccount } from "./users.js";
export { createMembershipStore } from "./membership.js";
export type { MembershipStore, TeamMember } from "./membership.js";
export { createAccessResolver } from "./access.js";
export type { AccessResolver } from "./access.js";
export {
  createForkStore,
  ForkNotFoundError,
  AgentNotFoundError,
  isForkNotFoundError,
  isAgentNotFoundError,
} from "./forks.js";
export type { ForkStore, AgentFork } from "./forks.js";

export const multiUserExtension: Extension = {
  id: "multiUser",
  displayName: "Multi-User Auth",
  factory: true,
  description:
    "OAuth authentication, sessions, and per-user agent access control",
  dependencies: [],
  configSchema: MultiUserConfigSchema,
  routePrefixes: [
    "/api/auth",
    "/api/me",
    "/api/admin",
    "/api/teams",
    "/api/impersonation",
    "/api/surface-links",
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
    registerSurfaceLinkRoutes(app, () => activeContext?.getConfig().branding);
  },
  async start(ctx: ExtensionContext) {
    const config = ctx.getConfig().extensions?.multiUser;
    if (!config?.enabled) {
      throw new Error("multiUser config missing or disabled");
    }

    const db = initializeMultiUserDatabase(ctx.getDataDir());
    const auth = await createMultiUserAuth(ctx.getConfig(), config, db);
    activeContext = ctx;
    unregisterSurfaceLinks = registerSurfaceLinkService(createSurfaceLinkService(db, resolveWebBaseUrl(ctx.getConfig())));
    const assignments = createAgentAssignmentStore(db);
    const membership = createMembershipStore(db);
    const forks = createForkStore({ db, agentExists: (id) => Boolean(ctx.getAgent(id)) });
    // teams needs a fork lookup so deleteTeam can name soon-to-be-teamless
    // forks; forks has no dependency on teams, so construct it first.
    const teams = createTeamStore(db, membership, () => forks);
    const access = createAccessResolver({ membership, forks });
    // Recovery resolves every unfinished key issuance before the remote advertises link support or accepts a managed key.
    ensureManagedKeyPrefixIndex(db);
    const gatewayLinks = createGatewayLinkService({
      db,
      auth: auth.api,
      secret: config.sessionSecret,
      getAllowedOrigins: () => getTrustedOrigins(ctx.getConfig()),
      logger: ctx.logger,
    });
    gatewayLinks.recover();
    setMultiUserRuntime({
      auth,
      db,
      gatewayLinks,
      assignments,
      teams,
      membership,
      forks,
      onboarding: createOnboardingStore(db),
      connectPrompt: createConnectPromptStore(db),
      access,
      getAgent: ctx.getAgent,
      getAgentOwner: ctx.getAgentOwner,
      notifyAgentListChanged: ctx.notifyAgentListChanged,
      audit: ctx.audit,
      logger: ctx.logger,
    });
  },
  async stop() {
    unregisterSurfaceLinks?.();
    unregisterSurfaceLinks = undefined;
    activeContext = undefined;
    getMultiUserRuntime()?.db.close();
    setMultiUserRuntime(null);
  },
  capabilities() {
    return getMultiUserRuntime() ? ["multi-user"] : [];
  },
};

export { createSurfaceLinkService } from "./surface-links.js";
