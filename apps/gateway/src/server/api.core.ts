import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { resolveDefaultProjectManager, resolveHomeDir } from "@yoplai/shared";
import { eligibleMainAgents } from "@yoplai/shared/main-agent";
import { readMcpServerSources } from "../capabilities/catalog.js";
import { aggregateMcpCandidates, readMcpIconCache, readSharedMcpServerSources, readTopExtensions, sanitizeTopExtensions, writeTopExtensions } from "../extensions/top-extensions.js";
import {
  getActiveAgents,
  getAgent,
  isAgentActive,
  loadConfig,
  resolveAgentEnv,
  resolveWorkspaceDir,
} from "../config/index.js";
import { reloadAfterExtensionWrite as reloadAfterConfigWrite } from "../extensions/reload.js";
import {
  getExtensionRuntime,
  isExtensionLoaded,
  getHomeExtension,
  getLoadedExtensions,
} from "../extensions/registry.js";
import {
  buildExtensionCatalog,
  resolveExtensionDefinition,
} from "../extensions/catalog.js";
import {
  updateAgentExtensionConfig,
  type ExtensionConfigPatch,
} from "../extensions/agent-config-writer.js";
import {
  runAgent,
  getAllSessionsForAgent,
  getAgentStatuses,
  getSessionHistory,
  getFullSessionHistory,
  getSessionCurrentTurn,
  isStreaming,
} from "../agents/index.js";
import type { FullHistoryMessage, SimpleHistoryMessage, HistoryViewMode } from "@yoplai/shared";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import {
  clearSessionEntry,
  getSessionEntry,
  getSessionThinkLevel,
} from "../sessions/index.js";
import {
  saveUploadedFile,
  resolveUploadMimeType,
  getAllowedMimeTypes,
  MAX_UPLOAD_SIZE_BYTES,
  UploadTooLargeError,
  UploadTypeError,
} from "../media/upload.js";
import {
  getMediaFileMetadata,
  resolveMediaFilePath,
} from "../media/metadata.js";
import { normalizeRunRequest } from "./run-request.js";
import { historyPage, activeContextUsage } from "../history/page.js";
import { compactAgentSession } from "../agents/compact.js";
import {
  isSafeSessionId,
  parseSessionFileName,
  sessionIdIsInteractive,
  readSessionFile,
} from "../history/sessions.js";
import { matchSession } from "../history/session-search.js";
import { CONFIG_DIR } from "../config/index.js";
import { CredentialStore } from "../credentials/store.js";
import { createConnectionRoutes } from "../credentials/routes.js";
import { extensionSecretFields, getPersonalExtensionTokens, isValidPersonalValue, resolveExtensionTokenConfig, savePersonalExtensionTokens, type PersonalExtensionValues } from "../credentials/extension-tokens.js";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import {
  appendSessionMeta,
  invalidateResolvedHistoryFile,
} from "../history/store.js";
import { resolveSessionDataFile } from "../sessions/files.js";
import { createOAuthRoutes } from "../oauth/routes.js";
import { createMainAgentRoutes } from "../main-agent/routes.js";
import { createChatProjectRoutes } from "../chat-projects/routes.js";
import { createSkillRoutes } from "../skills/routes.js";
import { getSkillContext, resolveSkillActor } from "../skills/context.js";
import { ImportTokenStore } from "../skills/import-tokens.js";
import { listSkillRecipients, skillOwnerName } from "../skills/http-auth.js";
import { ChatProjectStore, isSafeChatProjectId } from "../chat-projects/store.js";
import { getOAuthService } from "../oauth/service.js";
import { readToolLabels } from "../maintenance/tool-labels.js";
import { loadSuggestions } from "../suggestions/loader.js";
import { listAgentDashboards } from "../canvas/list.js";
import { getDashboardRegistry } from "../canvas/store.js";
import { createDashboardResourceRoutes } from "../canvas/routes.js";
import { resolveDashboardHttpActor, listDashboardRecipients, dashboardOwnerName } from "../canvas/http-auth.js";
import { getAuditActor, listSettingsChanges, recordSettingsChange } from "../audit/store.js";
import { diffSettings } from "../audit/diff.js";

const api = new Hono();
// Hono fetch creates a fresh context. Carry only the outer host’s authenticated
// identity through its in-process bindings, never through caller-supplied headers.
api.use("*", async (c: Context, next) => {
  const authContext = (c.env as {
    multiUserAuthContext?: import("@yoplai/extension-multi-user").RequestAuthContext | null;
  } | undefined)?.multiUserAuthContext;
  if (authContext) c.set("multiUserAuthContext", authContext);
  await next();
});
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MultiUserApiDeps = {
  getForwardedAuthContext: typeof import("@yoplai/extension-multi-user").getForwardedAuthContext;
  getAgentFilter: typeof import("@yoplai/extension-multi-user").getAgentFilter;
  hasAgentAccess: typeof import("@yoplai/extension-multi-user").hasAgentAccess;
  canManageAgent: typeof import("@yoplai/extension-multi-user").canManageAgent;
};

let multiUserApiDepsPromise: Promise<MultiUserApiDeps> | null = null;

function loadMultiUserApiDeps(): Promise<MultiUserApiDeps> {
  multiUserApiDepsPromise ??= import("@yoplai/extension-multi-user").then(
    (module) => ({
      getForwardedAuthContext: module.getForwardedAuthContext,
      getAgentFilter: module.getAgentFilter,
      hasAgentAccess: module.hasAgentAccess,
      canManageAgent: module.canManageAgent,
    })
  );
  return multiUserApiDepsPromise;
}

async function getRequestAuthContext(c: Context) {
  if (!isExtensionLoaded("multiUser")) return null;
  const { getForwardedAuthContext } = await loadMultiUserApiDeps();
  return getForwardedAuthContext(c.req.raw.headers);
}

/**
 * True iff the caller may access `agentId`. In single-user mode (or when the
 * multi-user extension is not loaded) there is no access boundary, so allow.
 * In multi-user mode this delegates to the access resolver, which applies
 * caller bypasses and resolves chat access from fork visibility and team
 * membership.
 */
async function callerHasAgentAccess(
  c: Context,
  agentId: string
): Promise<boolean> {
  if (!isExtensionLoaded("multiUser")) return true;
  const { hasAgentAccess } = await loadMultiUserApiDeps();
  const authContext = await getRequestAuthContext(c);
  if (!authContext) return false;
  return hasAgentAccess(authContext, agentId);
}

async function getRequestUserId(c: Context): Promise<string | undefined> {
  return (await getRequestAuthContext(c))?.session.userId;
}

// Per-user first-run onboarding flag (auth.db). Multi-user only: single-user
// mode has no user identity, so the tour is reported unsupported.
async function resolveOnboardingStore(c: Context) {
  const userId = await getRequestUserId(c);
  if (!userId) return null;
  const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  const store = getMultiUserRuntime()?.onboarding;
  return store ? { userId, store } : null;
}

api.get("/me/onboarding", async (c) => {
  const ctx = await resolveOnboardingStore(c);
  if (!ctx) return c.json({ supported: false, status: null, at: null });
  return c.json({ supported: true, ...ctx.store.get(ctx.userId) });
});

api.put("/me/onboarding", async (c) => {
  const ctx = await resolveOnboardingStore(c);
  if (!ctx) return c.json({ error: "onboarding unavailable" }, 404);
  const body = await c.req.json().catch(() => null);
  const status = (body as { status?: unknown } | null)?.status;
  if (status !== "done" && status !== "skipped") {
    return c.json({ error: "status must be 'done' or 'skipped'" }, 400);
  }
  return c.json({ supported: true, ...ctx.store.set(ctx.userId, status) });
});

api.delete("/me/onboarding", async (c) => {
  const ctx = await resolveOnboardingStore(c);
  if (!ctx) return c.json({ error: "onboarding unavailable" }, 404);
  return c.json({ supported: true, ...ctx.store.clear(ctx.userId) });
});

// Per-user, per-agent "Connect your tools" prompt seen flag (auth.db). Multi-user only.
async function resolveConnectPromptStore(c: Context) {
  const userId = await getRequestUserId(c);
  if (!userId) return null;
  const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  const store = getMultiUserRuntime()?.connectPrompt;
  return store ? { userId, store } : null;
}

api.get("/me/connect-prompt/:agentId", async (c) => {
  const ctx = await resolveConnectPromptStore(c);
  if (!ctx) return c.json({ supported: false, seen: true, at: null });
  return c.json({ supported: true, ...ctx.store.get(ctx.userId, c.req.param("agentId")) });
});

api.put("/me/connect-prompt/:agentId", async (c) => {
  const ctx = await resolveConnectPromptStore(c);
  if (!ctx) return c.json({ supported: false, seen: true, at: null });
  return c.json({ supported: true, ...ctx.store.markSeen(ctx.userId, c.req.param("agentId")) });
});

api.delete("/me/connect-prompt/:agentId", async (c) => {
  const ctx = await resolveConnectPromptStore(c);
  if (!ctx) return c.json({ supported: false, seen: true, at: null });
  return c.json({ supported: true, ...ctx.store.clear(ctx.userId, c.req.param("agentId")) });
});

const STAFF_ROLES = ["admin", "superadmin"];

function hasAdminRole(role: unknown): boolean {
  if (Array.isArray(role))
    return role.some((r) => typeof r === "string" && STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

async function isSuperadminRequest(c: Context): Promise<boolean> {
  if (!isExtensionLoaded("multiUser")) return true;
  const role = (await getRequestAuthContext(c))?.user.role;
  return Array.isArray(role) ? role.includes("superadmin") : role === "superadmin";
}

api.get("/top-extensions", (c) => c.json(readTopExtensions()));

async function listTopExtensionCandidates() {
  const config = loadConfig();
  const sampleAgent = config.agents[0] ?? config.pool?.[0] ?? ({ id: "_", name: "_" } as AgentConfig);
  const catalog = await buildExtensionCatalog(config, sampleAgent, { configurable: false });
  const extensions = catalog.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    description: entry.description,
    ...(entry.iconDataUri ? { iconDataUri: entry.iconDataUri } : {}),
  }));
  const mcp = aggregateMcpCandidates([...(await readMcpServerSources(config.agents)), ...readSharedMcpServerSources(config.agents)], readMcpIconCache());
  return { extensions, mcp };
}

api.get("/admin/top-extensions", async (c) => {
  if (!(await isSuperadminRequest(c))) return c.json({ error: "forbidden" }, 403);
  return c.json({ ...readTopExtensions(), candidates: await listTopExtensionCandidates() });
});

api.put("/admin/top-extensions", async (c) => {
  if (!(await isSuperadminRequest(c))) return c.json({ error: "forbidden" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray((body as { extensions?: unknown }).extensions) || !Array.isArray((body as { mcp?: unknown }).mcp)) {
    return c.json({ error: "extensions and mcp must be arrays" }, 400);
  }
  const { extensions: candidates } = await listTopExtensionCandidates();
  const before = readTopExtensions();
  const next = sanitizeTopExtensions({ ...body, system: "system" in body ? body.system : before.system }, new Set(candidates.map((entry) => entry.id)));
  if (isExtensionLoaded("multiUser")) {
    next.extensions = next.extensions.filter((id) => !next.system.extensions.includes(id));
    next.mcp = next.mcp.filter((url) => !next.system.mcp.includes(url));
  }
  writeTopExtensions(next);
  recordSettingsChange({ ...await getAuditActor(c), action: "top_extensions.update", targetType: "top-extensions",
    changes: diffSettings(before, next, []),
  });
  return c.json(next);
});

async function canViewAgentPrivateMeta(c: Context): Promise<boolean> {
  if (!isExtensionLoaded("multiUser")) return true;
  const authContext = await getRequestAuthContext(c);
  return hasAdminRole(authContext?.user.role);
}

async function canConfigureAgentExtensions(
  c: Context,
  agentId: string
): Promise<boolean> {
  if (!isExtensionLoaded("multiUser")) return true;
  const authContext = await getRequestAuthContext(c);
  if (!authContext) return false;
  const { hasAgentAccess } = await loadMultiUserApiDeps();
  return hasAgentAccess(authContext, agentId);
}

/**
 * Whole-team credentials and OAuth require management of the owning agent.
 */
async function canConfigureTeamExtensions(c: Context, agentId: string): Promise<boolean> {
  if (!isExtensionLoaded("multiUser")) return true;
  const { canManageAgent } = await loadMultiUserApiDeps();
  return canManageAgent(await getRequestAuthContext(c), agentId);
}

/**
 * Whether the requester (personal) or the team connection for the provider
 * grants every scope this extension needs. Extensions sharing one provider
 * account (e.g. Gmail + Drive on Google) are not "connected" until their own
 * scopes are granted.
 */
function hasOAuthConnection(
  agentId: string,
  oauth: { provider: string; scopes: string[]; personalScopes?: string[] },
  userId?: string
): boolean {
  try {
    const connection = getOAuthService().getConnection(agentId, oauth.provider, userId);
    if (!connection) return false;
    const required = connection.scope === "personal" ? oauth.personalScopes ?? oauth.scopes : oauth.scopes;
    return required.every((scope) => connection.scopes?.includes(scope));
  } catch {
    return false;
  }
}

async function requesterExtensionCatalog(c: Context, config: GatewayConfig, agent: AgentConfig, configurable = true) {
  const auth = await getRequestAuthContext(c);
  const canConfigureTeam = await canConfigureTeamExtensions(c, agent.id);
  const catalog = await buildExtensionCatalog(config, agent, { configurable, ...(auth ? { requesterUserId: auth.user.id } : {}) });
  const withOAuth = catalog.map((entry) => entry.oauth
    ? { ...entry, canConfigureTeam, oauthConnected: hasOAuthConnection(agent.id, entry.oauth, auth?.user.id) }
    : entry);
  if (!auth) return withOAuth;
  return withOAuth.map((entry) => {
    const fields = extensionSecretFields(entry);
    const personal = getPersonalExtensionTokens(new CredentialStore(), agent.id, auth.user.id, entry.id);
    // OAuth extensions without credential fields still keep personal settings (e.g. Drive allowWrite).
    if (!fields.length) return entry.oauth ? { ...entry, personalConfigValues: personal ?? {} } : entry;
    const personalConfigValues = Object.fromEntries(Object.entries(personal ?? {}).filter(([field]) => !fields.includes(field)));
    return { ...entry, canConfigureTeam, personalSecretFields: fields.filter((field) => !!personal?.[field]), personalConfigValues };
  });
}

function findExtensionCatalogAgent(
  config: GatewayConfig,
  agentId: string
): { agent: AgentConfig; configurable: boolean } | undefined {
  const directAgent = config.agents.find(
    (candidate) => candidate.id === agentId
  );
  if (directAgent) return { agent: directAgent, configurable: true };

  const poolAgent = config.pool?.find((candidate) => candidate.id === agentId);
  if (!poolAgent) return undefined;
  const agentWithoutTemplateExtensions = { ...poolAgent };
  delete (agentWithoutTemplateExtensions as { extensions?: unknown })
    .extensions;
  return { agent: agentWithoutTemplateExtensions, configurable: false };
}

function findWritableExtensionAgent(
  config: GatewayConfig,
  agentId: string
): AgentConfig | undefined {
  return config.agents.find((candidate) => candidate.id === agentId);
}

async function getVisibleAgents(c: Context) {
  const agents = getActiveAgents();
  if (!isExtensionLoaded("multiUser")) {
    return agents;
  }

  const authContext = await getRequestAuthContext(c);
  if (!authContext) return agents;

  const { getAgentFilter } = await loadMultiUserApiDeps();
  return getAgentFilter(authContext.user.id, authContext.user.role)(agents);
}

async function getEligibleMainAgents(c: Context) {
  const agents = await getVisibleAgents(c);
  if (!isExtensionLoaded("multiUser") || !loadConfig().forkedAgents) return eligibleMainAgents(agents);
  const auth = await getRequestAuthContext(c);
  const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
  const runtime = getMultiUserRuntime();
  if (!auth || !runtime) return [];
  const role = auth.user.role;
  const actions = runtime.catalog.resolvePoolActions(runtime.getPoolAgentIds(), {
    id: auth.session.userId,
    isStaff: hasAdminRole(role),
    isSuperadmin: Array.isArray(role) ? role.includes("superadmin") : role === "superadmin",
  });
  return eligibleMainAgents(agents, actions);
}

function contentDispositionFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, "_");
}

// OAuth connect framework (authorize + callback + status/disconnect).
api.route("/", createMainAgentRoutes({ dataDir: CONFIG_DIR, getUserId: getRequestUserId, getEligibleAgents: getEligibleMainAgents }));
api.route("/", createConnectionRoutes({ canAccessAgent: callerHasAgentAccess, getUserId: getRequestUserId }));
api.route("/", createChatProjectRoutes({ getUserId: getRequestUserId, getAgentIds: () => loadConfig().agents.map((agent) => agent.id) }));
api.route("/", createSkillRoutes({
  getContext: getSkillContext,
  tokens: new ImportTokenStore(CONFIG_DIR),
  getActor: async (c) => resolveSkillActor((c.get("multiUserAuthContext") as import("@yoplai/extension-multi-user").RequestAuthContext | undefined)?.user.id),
  getAgents: async (c) => (await getVisibleAgents(c)).filter((agent) => !agent.sdk || agent.sdk === "pi").map((agent) => ({ id: agent.id, name: agent.name, directory: path.join(resolveWorkspaceDir(agent.workspace), "skills") })),
  getOwnerName: skillOwnerName,
  getRecipients: listSkillRecipients,
  publicBaseUrl: () => {
    const config = loadConfig();
    return config.server?.baseUrl ?? config.web?.baseUrl ?? `http://localhost:${config.gateway?.port ?? 4000}`;
  },
  audit: async (c, action, targetId, changes) => recordSettingsChange({ ...await getAuditActor(c), action, targetType: "skill", targetId, changes }),
}));
api.route("/", createOAuthRoutes(
  undefined,
  callerHasAgentAccess,
  getRequestUserId,
  canConfigureTeamExtensions
));

api.get("/theme.css", async (c) => {
  const themePath = path.join(resolveHomeDir(), "theme.css");
  try {
    const css = await fs.readFile(themePath, "utf8");
    c.header("Content-Type", "text/css");
    c.header("Cache-Control", "no-cache");
    return c.body(css);
  } catch {
    return c.body(null, 204);
  }
});

const BRANDING_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function brandingMimeType(file: string): string {
  return BRANDING_MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function serveBrandingFile(c: Context, configured: string | undefined) {
  if (!configured) return c.json({ error: "Not found" }, 404);
  const homeDir = resolveHomeDir();
  const filePath = path.resolve(homeDir, configured);
  const relative = path.relative(homeDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return c.json({ error: "Invalid path" }, 400);
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return c.json({ error: "Not found" }, 404);
    const stream = createReadStream(filePath);
    c.header("Content-Type", brandingMimeType(filePath));
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream);
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
}

api.get("/branding/logo", (c) => serveBrandingFile(c, loadConfig().branding?.logo));

api.get("/branding/icon", (c) => serveBrandingFile(c, loadConfig().branding?.icon));

api.get("/manifest.webmanifest", (c) => {
  const branding = loadConfig().branding;
  const name = branding?.name ?? "Yoplai";
  c.header("Content-Type", "application/manifest+json");
  c.header("Cache-Control", "no-cache");
  return c.body(
    JSON.stringify({
      name,
      short_name: name,
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0a0a0a",
      theme_color: "#0a0a0a",
      icons: branding?.icon
        ? [
            {
              src: "/api/branding/icon",
              sizes: "any",
              type: brandingMimeType(branding.icon),
              purpose: "any",
            },
          ]
        : [],
    })
  );
});

api.get("/tool-labels", async (c) => c.json(await readToolLabels()));

api.get("/audit/settings", async (c) => {
  if (isExtensionLoaded("multiUser") && !hasAdminRole((await getRequestAuthContext(c))?.user.role)) {
    return c.json({ error: "forbidden" }, 403);
  }
  const query = c.req.query();
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || [query.since, query.until].some((value) => value !== undefined && !Number.isFinite(Date.parse(value)))) {
    return c.json({ error: "Invalid audit filters" }, 400);
  }
  try {
    return c.json(listSettingsChanges({
      agentId: query.agentId, actorUserId: query.actorUserId, action: query.action,
      since: query.since ? new Date(query.since).toISOString() : undefined,
      until: query.until ? new Date(query.until).toISOString() : undefined,
      limit: Math.min(limit, 500), cursor: query.cursor,
    }));
  } catch (error) {
    if (error instanceof Error && error.message === "Invalid audit cursor") return c.json({ error: error.message }, 400);
    return c.json({ error: "Unable to read settings audit" }, 500);
  }
});

api.get("/capabilities", async (c) => {
  const extensions = Object.fromEntries(
    getLoadedExtensions()
      .filter(
        (extension) =>
          extension.id !== "taskLifecycle" &&
          extension.id !== "capabilityDiscovery"
      )
      .map((extension) => [extension.id, true])
  );
  const isMultiUserEnabled = isExtensionLoaded("multiUser");
  const authContext = isMultiUserEnabled
    ? await getRequestAuthContext(c)
    : null;
  const agents = await getVisibleAgents(c);
  const config = loadConfig();
  const branding = config.branding;
  const home = getHomeExtension();
  const multiUserConfig = config.extensions?.multiUser;

  return c.json({
    version: 2,
    extensions,
    agents: agents.map((agent) => agent.id),
    multiUser: isMultiUserEnabled,
    ...(isMultiUserEnabled
      ? {
          authMethods: {
            google: Boolean(multiUserConfig?.oauth?.google),
            emailAndPassword: multiUserConfig?.emailAndPassword?.enabled === true,
          },
        }
      : {}),
    forkedAgents: config.forkedAgents ?? false,
    agentFab: config.agentFab ?? false,
    enableCronMonitoring: config.enableCronMonitoring ?? false,
    ...(home ? { home } : {}),
    ...(isMultiUserEnabled && authContext
      ? {
          user: {
            id: authContext.user.id,
            name: authContext.user.name ?? null,
            email: authContext.user.email ?? null,
            role: authContext.user.role ?? null,
          },
        }
      : {}),
    ...(branding
      ? {
          branding: {
            name: branding.name,
            logo: branding.logo ? "/api/branding/logo" : undefined,
            icon: branding.icon ? "/api/branding/icon" : undefined,
          },
        }
      : {}),
  });
});

/** Resolve avatar for API response: relative paths become /api/agents/:id/avatar */
function resolveAvatarForApi(
  avatar: string | undefined,
  agentId: string,
  routeBase: "agents" | "pool" = "agents"
): string | undefined {
  if (!avatar) return undefined;
  if (/^\p{Emoji}/u.test(avatar) && avatar.length <= 4) return avatar;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  return `/api/${routeBase}/${agentId}/avatar`;
}

async function resolveExistingSessionHistoryFile(params: {
  userId?: string;
  agentId: string;
  sessionId: string;
}): Promise<string | null> {
  const dir = getUserHistoryDir(params.userId, CONFIG_DIR);
  const filePath = await resolveSessionDataFile({
    dir,
    agentId: params.agentId,
    sessionId: params.sessionId,
    createIfMissing: false,
  });
  return filePath ?? null;
}

// GET /api/agents - list all agents (respects single-agent mode)
api.get("/agents", async (c) => {
  const agents = await getVisibleAgents(c);
  const includePrivateMeta = await canViewAgentPrivateMeta(c);
  const configDefaultId = resolveDefaultProjectManager(loadConfig());
  const visibleDefaultId = agents.some((agent) => agent.id === configDefaultId)
    ? configDefaultId
    : (agents[0]?.id ?? null);
  return c.json(
    agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      role: a.role,
      avatar: resolveAvatarForApi(a.avatar, a.id),
      ...(includePrivateMeta ? { model: a.model } : {}),
      sdk: a.sdk ?? "pi",
      ...(includePrivateMeta && a.workspace
        ? { workspace: resolveWorkspaceDir(a.workspace) }
        : {}),
      authMode: a.auth?.mode,
      queueMode: a.queueMode ?? "queue",
      isDefaultProjectManager: a.id === visibleDefaultId,
    }))
  );
});

// GET /api/pool - list all pool agents (no per-user filtering)
api.get("/pool", async (c) => {
  const config = loadConfig();
  if (!config.forkedAgents) {
    return c.json({ error: "Pool is not configured" }, 404);
  }
  const agents = config.pool ?? [];
  const includePrivateMeta = await canViewAgentPrivateMeta(c);
  return c.json(
    agents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      role: a.role,
      avatar: resolveAvatarForApi(a.avatar, a.id, "pool"),
      ...(includePrivateMeta ? { model: a.model } : {}),
      sdk: a.sdk ?? "pi",
      ...(includePrivateMeta && a.workspace
        ? { workspace: resolveWorkspaceDir(a.workspace) }
        : {}),
      authMode: a.auth?.mode,
      queueMode: a.queueMode ?? "queue",
    }))
  );
});

// GET /api/agents/status - get all agent streaming statuses
api.get("/agents/status", async (c) => {
  const agents = await getVisibleAgents(c);
  const statuses = getAgentStatuses(agents.map((agent) => agent.id));
  return c.json({ statuses });
});

// Shared sidebar scope: filename ownership, visible agents, interactive sessions and archive state.
async function listSidebarSessions(c: Context, includeArchived = false) {
  const userId = await getRequestUserId(c);
  const historyDir = getUserHistoryDir(userId, CONFIG_DIR);
  const agents = await getVisibleAgents(c);
  const agentIds = agents.map((agent) => agent.id);
  let entries: Array<{ dir: string; file: string }> = [];
  try {
    entries = (await fs.readdir(historyDir)).map((file) => ({
      dir: historyDir,
      file,
    }));
  } catch {
    entries = [];
  }
  const items = await Promise.all(
    entries.map(async ({ dir, file }) => {
      const parsed = parseSessionFileName(file, agentIds);
      if (!parsed || !sessionIdIsInteractive(parsed.sessionId)) return null;
      const agent = agents.find((item) => item.id === parsed.agentId);
      const session = await readSessionFile({
        filePath: path.join(dir, file),
        ...parsed,
        userId,
      });
      if (!session || (!includeArchived && session.summary.archived !== null)) return null;
      const avatar = resolveAvatarForApi(agent?.avatar, parsed.agentId);
      return {
        ...session,
        summary: { ...session.summary, ...(avatar ? { avatar } : {}) },
      };
    })
  );

  return items.filter((item): item is NonNullable<typeof item> => item !== null);
}

// GET /api/agents/sessions - list past lead-agent sessions
api.get("/agents/sessions", async (c) => {
  const sessions = await listSidebarSessions(c, c.req.query("includeArchived") === "1");
  return c.json({ items: sessions.map((session) => session.summary).sort((a, b) => b.lastActivity - a.lastActivity) });
});

// GET /api/agents/sessions/search - search the caller's sidebar history without an index.
api.get("/agents/sessions/search", async (c) => {
  const query = c.req.query("q") ?? "";
  if (!query.trim()) return c.json({ items: [] });
  const sessions = await listSidebarSessions(c);
  const items = sessions.flatMap(({ summary, messages }) => {
    const match = matchSession(summary.title || summary.firstUserMessage || summary.sessionId, messages, query);
    return match ? [{ ...summary, ...match }] : [];
  });
  items.sort((a, b) => Number(b.match === "title") - Number(a.match === "title") || b.lastActivity - a.lastActivity);
  return c.json({ items: items.slice(0, 50) });
});

// DELETE /api/agents/:agentId/sessions/:sessionId - delete a session history file
api.delete("/agents/:agentId/sessions/:sessionId", async (c) => {
  const agentId = c.req.param("agentId");
  const sessionId = c.req.param("sessionId");
  if (!isSafeSessionId(sessionId)) {
    return c.json({ error: "Invalid session id" }, 400);
  }
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }
  const userId = await getRequestUserId(c);
  const filePath = await resolveExistingSessionHistoryFile({
    userId,
    agentId,
    sessionId,
  });
  if (!filePath) return c.json({ error: "Session not found" }, 404);
  await fs.unlink(filePath);
  invalidateResolvedHistoryFile(agentId, sessionId, userId);
  const main = await getSessionEntry(agentId, "main", userId);
  if (main?.sessionId === sessionId) {
    await clearSessionEntry(agentId, "main", userId);
  }
  return c.json({ ok: true });
});

// PATCH /api/agents/:agentId/sessions/:sessionId - update session metadata
api.patch("/agents/:agentId/sessions/:sessionId", async (c) => {
  const agentId = c.req.param("agentId");
  const sessionId = c.req.param("sessionId");
  if (!isSafeSessionId(sessionId)) {
    return c.json({ error: "Invalid session id" }, 400);
  }
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }
  const userId = await getRequestUserId(c);
  const filePath = await resolveExistingSessionHistoryFile({
    userId,
    agentId,
    sessionId,
  });
  if (!filePath) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid session metadata" }, 400);
  }
  if (body.pinned !== undefined && typeof body.pinned !== "boolean") {
    return c.json({ error: "Pinned must be a boolean" }, 400);
  }
  if (body.archived !== undefined && typeof body.archived !== "boolean") {
    return c.json({ error: "Archived must be a boolean" }, 400);
  }
  if (body.archived === true) {
    const main = await getSessionEntry(agentId, "main", userId);
    if (main?.sessionId === sessionId) {
      return c.json({ error: "Main session cannot be archived" }, 400);
    }
  }
  if (body.projectId !== undefined && body.projectId !== null) {
    if (typeof body.projectId !== "string" || !isSafeChatProjectId(body.projectId)) {
      return c.json({ error: "Invalid project id" }, 400);
    }
    if (!await new ChatProjectStore(CONFIG_DIR, userId).get(body.projectId)) {
      return c.json({ error: "Project not found" }, 404);
    }
  }
  const updates: { title?: string; pinned?: number | null; archived?: number | null; projectId?: string | null } = {};
  if (body.title !== undefined) {
    updates.title = typeof body.title === "string" ? body.title.trim() : "";
    await appendSessionMeta(agentId, sessionId, "title", updates.title, userId);
  }
  if (typeof body.pinned === "boolean") {
    updates.pinned = body.pinned ? Date.now() : null;
    await appendSessionMeta(agentId, sessionId, "pinned", updates.pinned, userId);
  }
  if (typeof body.archived === "boolean") {
    updates.archived = body.archived ? Date.now() : null;
    await appendSessionMeta(agentId, sessionId, "archived", updates.archived, userId);
  }
  if (body.projectId !== undefined) {
    updates.projectId = body.projectId;
    await appendSessionMeta(agentId, sessionId, "project", updates.projectId, userId);
  }
  invalidateResolvedHistoryFile(agentId, sessionId, userId);
  return c.json({ ok: true, ...updates });
});

// GET /api/agents/:id - get single agent
api.get("/agents/:id", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }
  const includePrivateMeta = await canViewAgentPrivateMeta(c);
  return c.json({
    id: agent.id,
    name: agent.name,
    description: agent.description,
    role: agent.role,
    avatar: resolveAvatarForApi(agent.avatar, agent.id),
    ...(includePrivateMeta ? { model: agent.model } : {}),
    sdk: agent.sdk ?? "pi",
    ...(includePrivateMeta && agent.workspace
      ? { workspace: resolveWorkspaceDir(agent.workspace) }
      : {}),
    authMode: agent.auth?.mode,
    queueMode: agent.queueMode ?? "queue",
  });
});

// The outer /api/agents/:id/* middleware applies requireAgentAccess before this route.
api.get("/agents/:id/dashboards", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }
  const config = loadConfig();
  if (config.canvas?.enabled === false) return c.json([]);
  const registry = getDashboardRegistry(path.join(CONFIG_DIR, "canvas", "registry.json"));
  const auth = await getRequestAuthContext(c);
  const actor = await resolveDashboardHttpActor(auth, agentId);
  return c.json(await listAgentDashboards(agent, registry, config, { actor, ownerName: dashboardOwnerName }));
});

// GET /api/agents/:id/suggestions - workspace-authored starting prompts.
api.get("/agents/:id/suggestions", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }
  return c.json(
    await loadSuggestions(
      resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace)
    )
  );
});

// GET /api/agents/:id/extensions - extension catalog for one agent.
// Lists every available extension (built-in static registry + runtime scan of
// $YOPLAI_HOME/extensions) with its per-agent enabled state, config JSON-schema,
// required secrets, and config-surface tier. Read-only.
api.get("/agents/:id/extensions", async (c) => {
  const agentId = c.req.param("id");
  // In multi-user mode, staff and same-team members may configure a fork.
  // Others get 403 without leaking whether the agent exists.
  if (!(await canConfigureAgentExtensions(c, agentId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const config = loadConfig();
  const resolved = findExtensionCatalogAgent(config, agentId);
  if (!resolved) {
    return c.json({ error: "Agent not found" }, 404);
  }
  const extensions = await requesterExtensionCatalog(c, config, resolved.agent, resolved.configurable);
  return c.json({ agentId, extensions });
});

// PATCH /api/agents/:id/extensions/:extensionId - write extension config.
// updates an agent's per-extension config in agent.yaml. Flips enabled and/or
// merges config fields; secret values are written as $env:NAME sentinels in
// agent.yaml with the concrete value stored in the agent's .env (never
// plaintext in yaml). After a successful write the config cache is invalidated
// so the change takes effect on the agent's next run.
api.patch("/agents/:id/extensions/:extensionId", async (c) => {
  const agentId = c.req.param("id");
  // Server-side guard (not just UI hiding): only staff and same-team members
  // can edit an agent's extension config.
  if (!(await canConfigureAgentExtensions(c, agentId))) {
    return c.json({ error: "forbidden" }, 403);
  }

  const extensionId = c.req.param("extensionId");
  const config = loadConfig();
  const agent = findWritableExtensionAgent(config, agentId);
  if (!agent) {
    return c.json({ error: "Agent not found" }, 404);
  }

  // Factory extensions are internal/non-user-facing: they're hidden from the
  // catalog entirely, so must also be rejected here rather than silently
  // reconfigured through a direct API call.
  const targetExtension = await resolveExtensionDefinition(config, extensionId);
  if (targetExtension?.factory === true) {
    return c.json(
      { error: "Factory extensions cannot be configured from the UI" },
      403
    );
  }

  const catalog = await buildExtensionCatalog(config, agent);
  const targetEntry = catalog.find((entry) => entry.id === extensionId);
  if (targetEntry?.managedAtRoot) {
    return c.json(
      {
        error: `${extensionId} is configured at the agent.yaml root; edit agent.yaml to change it`,
      },
      409
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const {
    enabled,
    config: configPatch,
    secrets,
    credentialScope,
    userId,
  } = body as {
    enabled?: unknown;
    config?: unknown;
    secrets?: unknown;
    credentialScope?: unknown;
    userId?: unknown;
  };

  if (userId !== undefined || (credentialScope !== undefined && credentialScope !== "personal" && credentialScope !== "team")) {
    return c.json({ error: "Invalid credential scope; requester identity is server-derived" }, 400);
  }
  const auth = await getRequestAuthContext(c);
  const personalScope = credentialScope === "personal";
  if (personalScope && !auth) return c.json({ error: "Personal credentials require login" }, 401);

  const patch: ExtensionConfigPatch = {};
  if (enabled !== undefined) {
    if (typeof enabled !== "boolean") {
      return c.json({ error: "`enabled` must be a boolean" }, 400);
    }
    patch.enabled = enabled;
  }
  if (configPatch !== undefined) {
    if (
      typeof configPatch !== "object" ||
      configPatch === null ||
      Array.isArray(configPatch)
    ) {
      return c.json({ error: "`config` must be an object" }, 400);
    }
    patch.config = configPatch as Record<string, unknown>;
  }
  if (secrets !== undefined) {
    if (
      typeof secrets !== "object" ||
      secrets === null ||
      Array.isArray(secrets) ||
      Object.values(secrets).some((value) => typeof value !== "string")
    ) {
      return c.json(
        { error: "`secrets` must be an object of string values" },
        400
      );
    }
    patch.secrets = secrets as Record<string, string>;
  }

  const secretFields = targetExtension ? extensionSecretFields(targetExtension) : targetEntry?.requiredSecrets ?? [];
  // Public chat access does not grant control of team credentials or OAuth.
  if (!personalScope && (secretFields.length > 0 || targetEntry?.oauth) && !(await canConfigureTeamExtensions(c, agentId))) {
    return c.json({ error: "team_requires_admin" }, 403);
  }
  if (Object.keys(patch.config ?? {}).some((field) => secretFields.includes(field))) {
    return c.json({ error: "Credential fields must be submitted as secrets" }, 400);
  }
  if (personalScope) {
    if (!auth) return c.json({ error: "Personal credentials require login" }, 401);
    if (!targetExtension || (enabled !== undefined && enabled !== true)) {
      return c.json({ error: "Personal scope accepts only configuration fields" }, 400);
    }
    const values = { ...(patch.config ?? {}), ...patch.secrets };
    if (Object.entries(values).some(([field, value]) => !isValidPersonalValue(targetExtension, field, value))) {
      return c.json({ error: "Invalid personal credential fields" }, 400);
    }
    let before: PersonalExtensionValues;
    let after: PersonalExtensionValues;
    try {
      const store = new CredentialStore();
      before = getPersonalExtensionTokens(store, agentId, auth.user.id, extensionId) ?? {};
      // The form sends every setting override, so ones reset to the team value are dropped.
      savePersonalExtensionTokens(targetExtension, agent, config, auth.user.id, values as PersonalExtensionValues, store, true);
      after = getPersonalExtensionTokens(store, agentId, auth.user.id, extensionId) ?? {};
    } catch (error) {
      if (error instanceof Error && "fields" in error) {
        return c.json({ error: "Extension configuration is invalid", fields: (error as Error & { fields: string[] }).fields }, 422);
      }
      return c.json({ error: "Unable to store personal credentials; check oauth.encryptionKey" }, 400);
    }
    const changes = diffSettings(before, after, secretFields);
    const recordPersonalChange = async () => recordSettingsChange({
      ...await getAuditActor(c), action: "extension.personal_update", agentId,
      targetType: "extension", targetId: extensionId, scope: "personal", changes,
    });
    // Personal credentials alone make the extension usable for this agent.
    if (targetEntry && !targetEntry.enabled) {
      try {
        await updateAgentExtensionConfig(resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace), extensionId, { enabled: true });
      } catch (error) {
        return c.json({ error: (error as Error).message || "Failed to enable extension" }, 400);
      }
      changes.push({ field: "enabled", before: false, after: true });
      await recordPersonalChange();
      const extensions = await reloadAfterExtensionWrite(c, agentId);
      return c.json({ agentId, extensionId, extensions });
    }
    await recordPersonalChange();
    const extensions = await requesterExtensionCatalog(c, config, agent);
    return c.json({ agentId, extensionId, extensions });
  }

  const workspaceDir = resolveWorkspaceDir(
    agent.workspaceDir ?? agent.workspace
  );
  const env = resolveAgentEnv(agent, config);
  const rootExtensionConfig = config.extensions?.[extensionId];
  const auditSecrets = [...secretFields, ...Object.keys(patch.secrets ?? {})];
  const before: Record<string, unknown> = {
    ...(typeof rootExtensionConfig === "object" && rootExtensionConfig !== null ? rootExtensionConfig : {}),
    ...agent.extensions?.[extensionId], enabled: targetEntry?.enabled ?? false,
  };
  for (const [field, value] of Object.entries(before)) {
    if (auditSecrets.includes(field) && typeof value === "string" && value.startsWith("$env:")) before[field] = env[value.slice(5)];
  }
  const after: Record<string, unknown> = { ...before, ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...patch.config, ...patch.secrets };
  for (const [field, value] of Object.entries(after)) {
    if (auditSecrets.includes(field) && typeof value === "string" && value.startsWith("$env:")) after[field] = env[value.slice(5)];
  }
  try {
    await updateAgentExtensionConfig(workspaceDir, extensionId, patch, (nextConfig, pendingEnv) => {
      const nextExtensions = nextConfig.extensions as AgentConfig["extensions"];
      const prospectiveAgent = { ...agent, extensions: nextExtensions };
      const enabled = (nextExtensions as Record<string, { enabled?: boolean }> | undefined)?.[extensionId]?.enabled !== false;
      if (!enabled || !targetExtension?.validateAgentConfig) return;
      const prospectiveEnv = {
        ...resolveAgentEnv(agent, config),
        ...pendingEnv,
      };
      const scoped = resolveExtensionTokenConfig(targetExtension, prospectiveAgent, config, undefined, undefined, prospectiveEnv);
      const result = targetExtension.validateAgentConfig(scoped.agent, scoped.config, prospectiveEnv);
      if (!result.valid) {
        const error = new Error("Extension configuration is invalid") as Error & { fields: string[] };
        error.fields = result.errors;
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof Error && "fields" in error) {
      return c.json(
        { error: "Extension configuration is invalid", fields: error.fields },
        422
      );
    }
    return c.json(
      { error: (error as Error).message || "Failed to update extension" },
      400
    );
  }

  recordSettingsChange({ ...await getAuditActor(c), action: "extension.update", agentId,
    targetType: "extension", targetId: extensionId, scope: "team",
    changes: diffSettings(before, after, auditSecrets),
  });
  const extensions = await reloadAfterExtensionWrite(c, agentId);
  return c.json({ agentId, extensionId, extensions });
});

// DELETE /api/agents/:id/extensions/:extensionId/credentials - unset the
// whole-team credentials (secret fields) of an extension. Non-secret settings
// and the enabled flag stay; personal credentials are removed through
// DELETE /api/agents/:id/connections/extension/:extensionId.
api.delete("/agents/:id/extensions/:extensionId/credentials", async (c) => {
  const agentId = c.req.param("id");
  if (!(await canConfigureAgentExtensions(c, agentId)) || !(await canConfigureTeamExtensions(c, agentId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  const extensionId = c.req.param("extensionId");
  const config = loadConfig();
  const agent = findWritableExtensionAgent(config, agentId);
  if (!agent) return c.json({ error: "Agent not found" }, 404);
  const entry = (await buildExtensionCatalog(config, agent)).find((item) => item.id === extensionId);
  if (entry?.managedAtRoot) {
    return c.json({ error: `${extensionId} is configured at the agent.yaml root; edit agent.yaml to change it` }, 409);
  }
  const targetExtension = await resolveExtensionDefinition(config, extensionId);
  const secretFields = targetExtension ? extensionSecretFields(targetExtension) : entry?.requiredSecrets ?? [];
  if (!entry || secretFields.length === 0) return c.json({ error: "Extension has no credentials" }, 404);

  const existing = agent.extensions?.[extensionId] as Record<string, unknown> | undefined;
  const removed = secretFields.filter((field) => existing?.[field] !== undefined);

  try {
    await updateAgentExtensionConfig(resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace), extensionId, {
      removeSecrets: secretFields,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message || "Failed to remove credentials" }, 400);
  }
  recordSettingsChange({ ...await getAuditActor(c), action: "extension.credentials_remove", agentId,
    targetType: "extension", targetId: extensionId, scope: "team",
    changes: removed.map((field) => ({ field, secret: "removed" })),
  });
  const extensions = await reloadAfterExtensionWrite(c, agentId);
  return c.json({ agentId, extensionId, extensions });
});

/** Reload config after an agent.yaml write and return the requester's catalog for the agent. */
async function reloadAfterExtensionWrite(c: Context, agentId: string) {
  const reloaded = await reloadAfterConfigWrite();

  const updatedAgent = findWritableExtensionAgent(reloaded, agentId);
  return updatedAgent
    ? await requesterExtensionCatalog(c, reloaded, updatedAgent)
    : [];
}

// GET /api/agents/:id/avatar - serve avatar image from workspace
api.get("/agents/:id/avatar", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId) || !agent.avatar || !agent.workspace) {
    return c.json({ error: "Not found" }, 404);
  }
  const wsDir = resolveWorkspaceDir(agent.workspace);
  const filePath = path.resolve(wsDir, agent.avatar);
  // Prevent path traversal outside workspace
  if (!filePath.startsWith(wsDir)) {
    return c.json({ error: "Invalid path" }, 400);
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return c.json({ error: "Not found" }, 404);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";
    const stream = createReadStream(filePath);
    c.header("Content-Type", contentType);
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream);
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// GET /api/pool/:id/avatar - serve avatar image from workspace for a pool agent
api.get("/pool/:id/avatar", async (c) => {
  const agentId = c.req.param("id");
  const agent = (loadConfig().pool ?? []).find((a) => a.id === agentId);
  if (!agent || !agent.avatar || !agent.workspace) {
    return c.json({ error: "Not found" }, 404);
  }
  const wsDir = resolveWorkspaceDir(agent.workspace);
  const filePath = path.resolve(wsDir, agent.avatar);
  // Prevent path traversal outside workspace
  if (!filePath.startsWith(wsDir)) {
    return c.json({ error: "Invalid path" }, 400);
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return c.json({ error: "Not found" }, 404);
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
    };
    const contentType = mimeMap[ext] ?? "application/octet-stream";
    const stream = createReadStream(filePath);
    c.header("Content-Type", contentType);
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(Readable.toWeb(stream) as unknown as ReadableStream);
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// GET /api/agents/:id/status - get agent status
api.get("/agents/:id/status", (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const sessions = getAllSessionsForAgent(agent.id);
  const streaming = sessions.some((s) => s.isStreaming);
  const lastActivity = Math.max(0, ...sessions.map((s) => s.lastActivity));

  return c.json({
    id: agent.id,
    name: agent.name,
    isStreaming: streaming,
    lastActivity: lastActivity || undefined,
  });
});

// POST /api/agents/:id/messages - send message to agent
api.post("/agents/:id/messages", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }

  try {
    const body = await c.req.json();
    const authContext = await getRequestAuthContext(c);
    const normalized = await normalizeRunRequest({
      agent,
      input: { agentId, ...body },
      authContext,
      extensionRuntime: getExtensionRuntime(),
      source: "web",
    });

    if (normalized.type === "validation_error") {
      return c.json({ error: normalized.message }, 400);
    }
    if (normalized.type === "immediate") {
      return c.json(normalized.result);
    }

    const result = await runAgent(normalized.params);
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

// POST /api/agents/:id/compact - summarize and compact a session in place
api.post("/agents/:id/compact", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const sessionKey =
      typeof body.sessionKey === "string" && body.sessionKey.trim()
        ? body.sessionKey
        : "main";
    const authContext = await getRequestAuthContext(c);
    const userId = authContext?.session.userId;
    const sessionId =
      typeof body.sessionId === "string" && body.sessionId.trim()
        ? body.sessionId.trim()
        : undefined;
    if (sessionId && !isSafeSessionId(sessionId)) {
      return c.json({ error: "Invalid session id" }, 400);
    }
    const entry = sessionId
      ? { sessionId }
      : await getSessionEntry(agentId, sessionKey, userId);
    if (!entry) {
      return c.json({ error: "Session not found" }, 404);
    }

    const result = await compactAgentSession({
      agentId,
      sessionKey,
      sessionId: entry.sessionId,
      userId,
      extensionRuntime: getExtensionRuntime(),
      context: authContext?.user.name
        ? { kind: "web", name: authContext.user.name }
        : undefined,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500
    );
  }
});

// GET /api/agents/:id/history - get session history
// Query params: sessionId OR sessionKey (default "main"), view ("simple" | "full", default "simple")
api.get("/agents/:id/history", async (c) => {
  const agentId = c.req.param("id");
  const agent = getAgent(agentId);
  if (!agent || !isAgentActive(agentId)) {
    return c.json({ error: "Agent not found" }, 404);
  }

  const sessionKey = c.req.query("sessionKey") ?? "main";
  const explicitSessionId = c.req.query("sessionId");
  if (explicitSessionId && !isSafeSessionId(explicitSessionId)) {
    return c.json({ error: "Invalid session id" }, 400);
  }
  const view = (c.req.query("view") ?? "simple") as HistoryViewMode;
  const userId = await getRequestUserId(c);
  const entry = explicitSessionId
    ? null
    : await getSessionEntry(agentId, sessionKey, userId);
  const sessionId = explicitSessionId ?? entry?.sessionId;

  if (!sessionId) {
    return c.json({ messages: [], view });
  }

  const messages =
    view === "full"
      ? await getFullSessionHistory(agentId, sessionId, userId)
      : await getSessionHistory(agentId, sessionId, userId);

  const limitQuery = c.req.query("limit");
  const limit = limitQuery ? Number(limitQuery) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)) {
    return c.json({ error: "History limit must be between 1 and 200" }, 400);
  }
  let page;
  try {
    page = limit === undefined ? { messages, historyOffset: 0 } : historyPage<SimpleHistoryMessage | FullHistoryMessage>(messages, limit, c.req.query("before"));
  } catch {
    return c.json({ error: "Invalid history cursor" }, 400);
  }
  const fullMessages = view === "full" ? messages : await getFullSessionHistory(agentId, sessionId, userId);

  // Only include thinkingLevel for OAuth agents
  const thinkingLevel =
    agent.auth?.mode === "oauth"
      ? await getSessionThinkLevel(agentId, sessionKey, userId)
      : undefined;

  const streaming = isStreaming(agentId, sessionId);
  const turn = streaming ? getSessionCurrentTurn(agentId, sessionId) : null;
  const activeTurn = turn
    ? {
        // Once the user message is persisted to canonical history, omit it
        // from the active-turn snapshot so clients don't render it twice.
        userText: turn.userFlushed ? null : turn.userText,
        userTimestamp: turn.userTimestamp,
        startedAt: turn.startTimestamp,
        thinking: turn.thinkingText,
        text: turn.assistantText,
        toolCalls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          parentToolCallId: tc.parentToolCallId,
          name: tc.name,
          arguments: tc.args,
          status: tc.status,
        })),
        toolResults: turn.toolResults,
      }
    : null;

  return c.json({
    ...page,
    activeContextUsage: activeContextUsage(fullMessages as FullHistoryMessage[]),
    sessionId,
    view,
    thinkingLevel,
    isStreaming: streaming,
    activeTurn,
  });
});

// POST /api/media/upload - upload a file (multipart/form-data)
api.post("/media/upload", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return c.json({ error: "No file provided" }, 400);
    }

    // An upload may be bound to a target agent so the resulting media inherits
    // that agent's access boundary (both here and on later download). A caller
    // who cannot chat the agent must not be able to stage an attachment for it.
    const agentIdField = formData.get("agentId");
    const agentId =
      typeof agentIdField === "string" && agentIdField.length > 0
        ? agentIdField
        : undefined;
    const sessionIdField = formData.get("sessionId");
    const sessionId =
      typeof sessionIdField === "string" && sessionIdField.length > 0
        ? sessionIdField
        : undefined;
    if (agentId && !(await callerHasAgentAccess(c, agentId))) {
      return c.json({ error: "forbidden" }, 403);
    }

    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return c.json(
        {
          error: `File exceeds the 25MB upload limit`,
          maxSize: MAX_UPLOAD_SIZE_BYTES,
        },
        413
      );
    }

    let mimeType: string;
    try {
      mimeType = resolveUploadMimeType(file.type, file.name);
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : "Unsupported file",
          allowedTypes: getAllowedMimeTypes(),
        },
        400
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const result = await saveUploadedFile(arrayBuffer, mimeType, file.name, {
      agentId,
      sessionId,
    });

    return c.json(result);
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return c.json(
        {
          error: "File exceeds the 25MB upload limit",
          maxSize: MAX_UPLOAD_SIZE_BYTES,
        },
        413
      );
    }
    if (err instanceof UploadTypeError) {
      return c.json(
        { error: err.message, allowedTypes: getAllowedMimeTypes() },
        400
      );
    }

    const message = err instanceof Error ? err.message : "Upload failed";
    return c.json({ error: message }, 500);
  }
});

// GET /api/media/download/:id - download a registered media file
api.get("/media/download/:id", async (c) => {
  const fileId = c.req.param("id");
  if (!UUID_RE.test(fileId)) {
    return c.json({ error: "File not found" }, 404);
  }

  const metadata = await getMediaFileMetadata(fileId);
  if (!metadata) {
    return c.json({ error: "File not found" }, 404);
  }
  if (metadata.userId && metadata.userId !== await getRequestUserId(c)) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Media tied to an agent session inherits that agent's access boundary: a
  // caller who cannot chat the agent must not be able to pull its attachments
  // by guessing/reusing a file id. Files with no agent binding (e.g. inbound
  // uploads not yet attached to a run) stay open as before.
  if (metadata.agentId && !(await callerHasAgentAccess(c, metadata.agentId))) {
    return c.json({ error: "forbidden" }, 403);
  }

  try {
    const realFilePath = await resolveMediaFilePath(metadata);
    const stat = await fs.stat(realFilePath);

    c.header("Content-Type", metadata.mimeType);
    c.header("Content-Length", String(stat.size));
    c.header(
      "Content-Disposition",
      `attachment; filename="${contentDispositionFilename(metadata.filename)}"`
    );
    return c.body(
      Readable.toWeb(
        createReadStream(realFilePath)
      ) as unknown as ReadableStream
    );
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
});

// GET /api/media/allowed-types - list allowed file types
api.get("/media/allowed-types", (c) => {
  return c.json({ types: getAllowedMimeTypes() });
});

export { api };

api.route("/dashboards", createDashboardResourceRoutes({
  getConfig: loadConfig, getAgent,
  registry: getDashboardRegistry(path.join(CONFIG_DIR, "canvas", "registry.json")),
  async authenticate(request) {
    if (!loadConfig().extensions?.multiUser?.enabled) return {};
    const { validateWebSocketRequest } = await import("@yoplai/extension-multi-user");
    return validateWebSocketRequest(request);
  },
  async hasAgentAccess(auth, agentId) {
    return (await resolveDashboardHttpActor(auth, agentId)).hasAgentAccess === true;
  },
  resolveActor: resolveDashboardHttpActor,
  listRecipients: listDashboardRecipients,
  getOwnerName: dashboardOwnerName,
}));
