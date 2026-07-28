import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { resolveDefaultProjectManager, resolveHomeDir } from "@yoplai/shared";
import {
  getActiveAgents,
  getAgent,
  isAgentActive,
  loadConfig,
  reloadConfig,
  resolveAgentEnv,
  resolveWorkspaceDir,
  setLoadedConfig,
} from "../config/index.js";
import { resolveStartupConfig } from "../config/validate.js";
import {
  getExtensionRuntime,
  isExtensionLoaded,
  getHomeExtension,
  getLoadedExtensions,
  reloadExtensions,
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
import type { HistoryViewMode } from "@yoplai/shared";
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
import { compactAgentSession } from "../agents/compact.js";
import { CONFIG_DIR } from "../config/index.js";
import { getUserHistoryDir } from "@yoplai/extension-multi-user/isolation";
import { invalidateResolvedHistoryFile } from "../history/store.js";
import { resolveSessionDataFile } from "../sessions/files.js";
import { createOAuthRoutes } from "../oauth/routes.js";

const api = new Hono();
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type MultiUserApiDeps = {
  getForwardedAuthContext: typeof import("@yoplai/extension-multi-user").getForwardedAuthContext;
  getAgentFilter: typeof import("@yoplai/extension-multi-user").getAgentFilter;
  hasAgentAccess: typeof import("@yoplai/extension-multi-user").hasAgentAccess;
};

let multiUserApiDepsPromise: Promise<MultiUserApiDeps> | null = null;

function loadMultiUserApiDeps(): Promise<MultiUserApiDeps> {
  multiUserApiDepsPromise ??= import("@yoplai/extension-multi-user").then(
    (module) => ({
      getForwardedAuthContext: module.getForwardedAuthContext,
      getAgentFilter: module.getAgentFilter,
      hasAgentAccess: module.hasAgentAccess,
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
 * In multi-user mode this delegates to the team-access resolver, which applies
 * staff bypass (admin/superadmin) and resolves chat access from team
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

const STAFF_ROLES = ["admin", "superadmin"];

function hasAdminRole(role: unknown): boolean {
  if (Array.isArray(role))
    return role.some((r) => typeof r === "string" && STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

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
  if (hasAdminRole(authContext.user.role)) return true;
  const { hasAgentAccess } = await loadMultiUserApiDeps();
  return hasAgentAccess(authContext, agentId);
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
  if (!isExtensionLoaded("multiUser") || !loadConfig().forkedAgents) {
    return agents;
  }

  const authContext = await getRequestAuthContext(c);
  if (!authContext) return agents;

  const { getAgentFilter } = await loadMultiUserApiDeps();
  return getAgentFilter(authContext.user.id, authContext.user.role)(agents);
}

function contentDispositionFilename(filename: string): string {
  return filename.replace(/["\\\r\n]/g, "_");
}

// OAuth connect framework (authorize + callback + status/disconnect).
api.route("/", createOAuthRoutes(undefined, callerHasAgentAccess));

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

api.get("/branding/logo", async (c) => {
  const logo = loadConfig().branding?.logo;
  if (!logo) return c.json({ error: "Not found" }, 404);
  const homeDir = resolveHomeDir();
  const filePath = path.resolve(homeDir, logo);
  if (!filePath.startsWith(homeDir)) {
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

api.get("/capabilities", async (c) => {
  const extensions = Object.fromEntries(
    getLoadedExtensions().map((extension) => [extension.id, true])
  );
  const isMultiUserEnabled = isExtensionLoaded("multiUser");
  const authContext = isMultiUserEnabled
    ? await getRequestAuthContext(c)
    : null;
  const agents = await getVisibleAgents(c);
  const config = loadConfig();
  const branding = config.branding;
  const home = getHomeExtension();

  return c.json({
    version: 2,
    extensions,
    agents: agents.map((agent) => agent.id),
    multiUser: isMultiUserEnabled,
    forkedAgents: config.forkedAgents ?? false,
    agentFab: config.agentFab ?? false,
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

type SessionSummary = {
  agentId: string;
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  firstUserMessage: string;
  title?: string;
  avatar?: string;
  isMain: boolean;
};

function parseSessionFileName(
  file: string,
  agentIds: string[]
): { agentId: string; sessionId: string; createdAt: number } | null {
  if (!file.endsWith(".jsonl")) return null;
  const base = file.slice(0, -".jsonl".length);
  const timestampMatch = base.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)_(.+)$/
  );
  const name = timestampMatch ? timestampMatch[5] : base;
  const createdAt = timestampMatch
    ? Date.parse(
        `${timestampMatch[1]}:${timestampMatch[2]}:${timestampMatch[3]}.${timestampMatch[4]}`
      )
    : 0;
  const agentId = [...agentIds]
    .sort((a, b) => b.length - a.length)
    .find((id) => name.startsWith(`${id}-`));
  if (!agentId) return null;
  const sessionId = name.slice(agentId.length + 1);
  if (!sessionId) return null;
  return {
    agentId,
    sessionId,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
  };
}

function isSafeSessionId(sessionId: string): boolean {
  const hasControlCharacter = [...sessionId].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  return (
    sessionId.length > 0 &&
    sessionId.length <= 200 &&
    !sessionId.includes("/") &&
    !sessionId.includes("\\") &&
    !/(^|[._:-])\.\.($|[._:-])/.test(sessionId) &&
    !hasControlCharacter
  );
}

function sessionIdIsInteractive(sessionId: string): boolean {
  return (
    isSafeSessionId(sessionId) &&
    !/^(scheduler:|scheduler-|bench-|slack:|slack-|webhook:|webhook-|compact:|compact-|default$)/.test(
      sessionId
    )
  );
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const obj = block as Record<string, unknown>;
      return obj.type === "text" && typeof obj.text === "string"
        ? obj.text
        : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function summarizeSessionFile(params: {
  filePath: string;
  agentId: string;
  sessionId: string;
  createdAt: number;
  userId?: string;
}): Promise<SessionSummary | null> {
  const [raw, stat] = await Promise.all([
    fs.readFile(params.filePath, "utf8"),
    fs.stat(params.filePath),
  ]);
  let firstUserMessage = "";
  let title: string | undefined;
  let messageCount = 0;
  let lastActivity = params.createdAt || stat.birthtimeMs;

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      const timestamp =
        typeof entry.timestamp === "number" ? entry.timestamp : undefined;
      if (entry.type === "meta" && entry.key === "title") {
        title = typeof entry.value === "string" ? entry.value : undefined;
        continue;
      }
      if (entry.type !== "history") continue;
      if (entry.role !== "user" && entry.role !== "assistant") continue;
      const text = textFromContent(entry.content);
      if (!text) continue;
      if (timestamp) lastActivity = Math.max(lastActivity, timestamp);
      messageCount += 1;
      if (entry.role === "user" && !firstUserMessage) firstUserMessage = text;
    } catch {
      // Ignore malformed history lines.
    }
  }

  if (messageCount === 0) return null;
  const main = await getSessionEntry(params.agentId, "main", params.userId);
  return {
    agentId: params.agentId,
    sessionId: params.sessionId,
    createdAt: params.createdAt || stat.birthtimeMs,
    lastActivity,
    messageCount,
    firstUserMessage,
    ...(title ? { title } : {}),
    isMain: main?.sessionId === params.sessionId,
  };
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

// GET /api/agents/sessions - list past lead-agent sessions
api.get("/agents/sessions", async (c) => {
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
      const summary = await summarizeSessionFile({
        filePath: path.join(dir, file),
        ...parsed,
        userId,
      });
      if (!summary) return null;
      const avatar = resolveAvatarForApi(agent?.avatar, parsed.agentId);
      return {
        ...summary,
        ...(avatar ? { avatar } : {}),
      };
    })
  );

  return c.json({
    items: items
      .filter((item): item is SessionSummary => item !== null)
      .sort((a, b) => b.lastActivity - a.lastActivity),
  });
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

// PATCH /api/agents/:agentId/sessions/:sessionId - set session title
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
  const body = await c.req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const line =
    JSON.stringify({
      type: "meta",
      key: "title",
      value: title,
      timestamp: Date.now(),
    }) + "\n";
  await fs.appendFile(filePath, line, "utf-8");
  invalidateResolvedHistoryFile(agentId, sessionId, userId);
  return c.json({ ok: true, title });
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
  const extensions = await buildExtensionCatalog(config, resolved.agent, {
    configurable: resolved.configurable,
  });
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
  } = body as {
    enabled?: unknown;
    config?: unknown;
    secrets?: unknown;
  };

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

  const workspaceDir = resolveWorkspaceDir(
    agent.workspaceDir ?? agent.workspace
  );
  try {
    await updateAgentExtensionConfig(workspaceDir, extensionId, patch, (nextConfig, pendingEnv) => {
      const nextExtensions = nextConfig.extensions as AgentConfig["extensions"];
      const prospectiveAgent = { ...agent, extensions: nextExtensions };
      const enabled = (nextExtensions as Record<string, { enabled?: boolean }> | undefined)?.[extensionId]?.enabled !== false;
      if (!enabled || !targetExtension?.validateAgentConfig) return;
      const result = targetExtension.validateAgentConfig(prospectiveAgent, config, {
        ...resolveAgentEnv(agent, config),
        ...pendingEnv,
      });
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

  // Invalidate the config cache so the next run (and the next catalog read)
  // observes the change rather than the stale in-memory config.
  const rawReloaded = reloadConfig();
  const reloaded = await resolveStartupConfig(rawReloaded);
  setLoadedConfig(reloaded);

  // Bring a newly-enabled extension online without a gateway restart so that
  // /capabilities and tool resolution reflect it immediately (ALG-349). Only
  // adds extensions not already loaded; never re-starts running ones.
  try {
    await reloadExtensions(reloaded);
  } catch (error) {
    console.warn(
      `[extensions] runtime reconcile after enable failed: ${(error as Error).message}`
    );
  }

  const updatedAgent = findWritableExtensionAgent(reloaded, agentId);
  const extensions = updatedAgent
    ? await buildExtensionCatalog(reloaded, updatedAgent)
    : [];
  return c.json({ agentId, extensionId, extensions });
});

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
          name: tc.name,
          arguments: tc.args,
          status: tc.status,
        })),
      }
    : null;

  return c.json({
    messages,
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
