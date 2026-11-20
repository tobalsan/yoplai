import { ownsExtensionCatalogPath } from "./extension-catalog-policy.js";
import { createInstructionWriter } from "../desktop/agent-instructions.js";
import { createAgentRoutes } from "../desktop/agent-create.js";
import { createModelAccess } from "../desktop/model-access.js";
import { desktopSetupGuard } from "../desktop/guard.js";
import { createDesktopSetupRoutes } from "../desktop/setup.js";
import { serve } from "@hono/node-server";
import path from "node:path";
import { Hono } from "hono";
import { startAppsListener } from "../mcp-apps/views.js";
import { startUiListener } from "./ui-listener.js";
import { logError } from "../logging.js";
import { cors } from "hono/cors";
import { readEnv, resolveBindHost, resolveHomeDir } from "@yoplai/shared";
import type { GatewayBindMode, GatewayConfig } from "@yoplai/shared";
import { api, dashboardSessionExists } from "./api.core.js";
import { internalTools } from "./internal-tools.js";
import { startConfiguredInternalSocket } from "./internal-socket.js";
import {
  cleanupOrphanContainers,
  ensureAgentImage,
  ensureNetwork,
} from "../agents/container.js";
import { loadConfig } from "../config/index.js";
import { agentEventBus } from "../agents/index.js";
import { getCurrentInnerApi, getExtensionRuntime } from "../extensions/registry.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { WsBroker, type WsBrokerAuthAdapter } from "./ws-broker.js";
import { accessLogger } from "./access-log.js";
import { allowedCorsOrigins } from "./origins.js";
import { relayConfigurationHttp, relayHttp } from "../relay/http.js";
import { GATEWAY_LIST_PATH } from "../relay/configuration.js";
import { relayDeviceApi } from "../relay/device-routes.js";
import { dashboardViewHttp, ownsDashboardViewPath } from "../relay/dashboard-views.js";
import { relayLinkApi } from "../relay/link-routes.js";
import { ownsLinkPath } from "@yoplai/shared/secret-paths";
import { startDeviceLinks } from "../relay/device-links.js";
import { configureRelay, setGatewayListener } from "../relay/state.js";
import { SKILL_IMPORT_TOKEN_PREFIX } from "../skills/import-tokens.js";
import { getAgent, CONFIG_DIR } from "../config/index.js";
import { createDashboardAssetRoutes, createDashboardRoutes } from "../canvas/routes.js";
import { getDashboardRegistry } from "../canvas/store.js";
import { resolveDashboardHttpActor, listDashboardRecipients, dashboardOwnerName, authenticateDashboardRequest } from "../canvas/http-auth.js";
import { createExtensionPageRoutes } from "../extensions/page-routes.js";

type RequestAuthContext =
  import("@yoplai/extension-multi-user").RequestAuthContext;

const app = new Hono();
// Refuse this namespace before CORS or authentication can answer a normalized alias.
app.use("*", async (c, next) => {
  if (!currentExtensionRuntime().isEnabled("multiUser")) return next();
  const { rejectBetterAuthAdminRoute } = await loadMultiUserMiddlewareModule();
  return rejectBetterAuthAdminRoute(new URL(c.req.url).pathname, true) ?? next();
});
app.use("/api/*", async (c, next) => {
  const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
  if (bearer?.startsWith(SKILL_IMPORT_TOKEN_PREFIX) && !(c.req.method === "POST" && c.req.path === "/api/skills/import")) return c.json({ error: "unauthorized" }, 401);
  await next();
});
let activeExtensionRuntime: ExtensionRuntime | undefined;

function currentExtensionRuntime(): ExtensionRuntime {
  return activeExtensionRuntime ?? getExtensionRuntime();
}

type MultiUserMiddlewareModule = typeof import("@yoplai/extension-multi-user");

let multiUserMiddlewareModulePromise: Promise<MultiUserMiddlewareModule> | null =
  null;

function loadMultiUserMiddlewareModule(): Promise<MultiUserMiddlewareModule> {
  multiUserMiddlewareModulePromise ??= import("@yoplai/extension-multi-user");
  return multiUserMiddlewareModulePromise;
}

function isExtensionEnabled(
  config: GatewayConfig,
  extensionId: string,
  runtime: ExtensionRuntime
): boolean {
  return runtime.isEnabled(extensionId, config);
}

const globalCors = cors({
  // Reflect only known origins. `credentials: true` is incompatible with a
  // wildcard, and the web client calls the API with `credentials: "include"`.
  origin: (origin) => (allowedCorsOrigins().includes(origin) ? origin : null),
  credentials: true,
});
// The dashboard viewer and the browser link routes answer CORS themselves: a narrower grant than the global list.
app.use("*", (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname === "/api/agents" && c.req.method === "POST") return next();
  return ownsDashboardViewPath(pathname) || ownsLinkPath(pathname) || pathname === "/api/desktop-setup" || pathname === "/api/model-access" || pathname.startsWith("/api/model-access/") ? next() : globalCors(c, next);
});
app.use("*", accessLogger());
app.route("/internal", internalTools);
app.route("/x", createExtensionPageRoutes({
  getRuntime: currentExtensionRuntime,
  getConfig: loadConfig,
  async authenticate(request) {
    if (!currentExtensionRuntime().isEnabled("multiUser")) return {};
    return authenticateDashboardRequest(request);
  },
}));
app.route("/d-assets", createDashboardAssetRoutes(loadConfig));
app.route(
  "/d",
  createDashboardRoutes({
    getConfig: loadConfig,
    getAgent,
    resolveActor: resolveDashboardHttpActor,
    listRecipients: listDashboardRecipients,
    getOwnerName: dashboardOwnerName,
    sessionExists: dashboardSessionExists,
    registry: getDashboardRegistry(
      path.join(CONFIG_DIR, "canvas", "registry.json")
    ),
    async authenticate(request) {
      if (!currentExtensionRuntime().isEnabled("multiUser")) return {};
      return authenticateDashboardRequest(request);
    },
    async hasAgentAccess(auth, agentId) {
      if (!currentExtensionRuntime().isEnabled("multiUser")) return true;
      const { hasAgentAccess } = await loadMultiUserMiddlewareModule();
      return hasAgentAccess(auth as RequestAuthContext, agentId);
    },
  })
);
// The viewer namespace answers before the extension gate and the generic relay.
// The mount matches every path, because the ownership test also claims mixed-case and encoded spellings.
app.use("*", dashboardViewHttp());
// The link namespace answers before the extension gate. It owns every spelling of its path and refuses what no route owns.
app.use("*", relayLinkApi());
const setupGuard = desktopSetupGuard(
  () => currentExtensionRuntime().isEnabled("multiUser"),
  () => loadConfig().ui?.port ?? 3000
);
app.use("/api/desktop-setup/*", setupGuard);
app.route("/api/desktop-setup", createDesktopSetupRoutes(CONFIG_DIR));
app.use("/api/model-access/*", setupGuard);
const modelAccess = createModelAccess(CONFIG_DIR);
app.route("/api/model-access", modelAccess.routes);
app.on("POST", "/api/agents", setupGuard);
app.route("/api/agents", createAgentRoutes(CONFIG_DIR, modelAccess.listModels, createInstructionWriter(modelAccess.getAuth)));
const configurationRelay = relayConfigurationHttp();
app.use("/api/*", (c, next) => {
  // Local multi-user mode keeps the relay off. Only the gateway list answers there, with an explicit refusal.
  if (currentExtensionRuntime().isEnabled("multiUser") && c.req.path !== GATEWAY_LIST_PATH) return next();
  return configurationRelay(c, next);
});
app.use("/api/*", async (c, next) => {
  let config: GatewayConfig;
  try {
    config = loadConfig();
  } catch {
    await next();
    return;
  }

  const path = c.req.path;
  const runtime = currentExtensionRuntime();
  for (const matcher of runtime.getRouteMatchers()) {
    // These core routes are also available without multi-user.
    if (matcher.extension === "multiUser" && (path === "/api/me/main-agent" || path === "/api/admin/top-extensions" || path === "/api/admin/model-quota" || ownsExtensionCatalogPath(path))) continue;
    if (!matcher.matches(path)) continue;
    if (isExtensionEnabled(config, matcher.extension, runtime)) break;
    if (matcher.allowWhenDisabled && runtime.isEnabled(matcher.extension))
      break;
    return c.json(
      {
        error: "extension_disabled",
        extension: matcher.extension,
      },
      404
    );
  }

  await next();
});
app.use("/api/*", async (c, next) => {
  if (!currentExtensionRuntime().isEnabled("multiUser")) {
    await next();
    return;
  }

  const { createAuthMiddleware } = await loadMultiUserMiddlewareModule();
  return createAuthMiddleware()(c, next);
});
app.use("/api/*", async (c, next) => {
  if (!currentExtensionRuntime().isEnabled("multiUser")) {
    await next();
    return;
  }

  const { getRequestAuthContext, hasActiveImpersonation } =
    await loadMultiUserMiddlewareModule();
  const pathname = new URL(c.req.url).pathname;
  const allowed =
    pathname === "/api/admin/impersonate/end" ||
    pathname === "/api/auth/signout" ||
    pathname === "/api/auth/sign-out" ||
    pathname === "/api/impersonation/status";
  if (
    hasActiveImpersonation(getRequestAuthContext(c)) &&
    c.req.method !== "GET" &&
    !allowed
  ) {
    return c.json({ error: "read_only_impersonation" }, 403);
  }

  await next();
});

// External MCP server and OAuth routes carry the agent in a query parameter; the shared catalog is host-wide (superadmin checked by the extension).
app.use("/api/mcp/*", async (c, next) => {
  if (!currentExtensionRuntime().isEnabled("multiUser") || c.req.path === "/api/mcp/oauth/callback" || c.req.path.startsWith("/api/mcp/catalog") || (c.req.method === "GET" && c.req.path === "/api/mcp/oauth/client-metadata.json")) {
    await next();
    return;
  }
  const agentId = c.req.query("agent");
  if (!agentId) return c.json({ error: "missing_agent" }, 400);
  const { getRequestAuthContext, hasAgentAccess } = await loadMultiUserMiddlewareModule();
  if (!(await hasAgentAccess(getRequestAuthContext(c), agentId))) {
    return c.json({ error: "forbidden" }, 403);
  }
  await next();
});

// Aggregate agent endpoints (`/api/agents/status`, `/api/agents/sessions`)
// are shaped like `/api/agents/:id` but are not addressed to a single agent —
// they already filter their payload per-user via `getVisibleAgents`. Gating
// them with a per-agent access check would treat the literal segment
// ("status"/"sessions") as an agent id and reject every non-staff caller.
const AGGREGATE_AGENT_SEGMENTS = new Set(["status", "sessions"]);

app.use("/api/agents/:id", async (c, next) => {
  if (!currentExtensionRuntime().isEnabled("multiUser")) {
    await next();
    return;
  }

  if (AGGREGATE_AGENT_SEGMENTS.has(c.req.param("id"))) {
    await next();
    return;
  }

  const { requireAgentAccess } = await loadMultiUserMiddlewareModule();
  return requireAgentAccess("id")(c, next);
});
app.use("/api/agents/:id/*", async (c, next) => {
  if (!currentExtensionRuntime().isEnabled("multiUser")) {
    await next();
    return;
  }

  // The `:id/*` pattern also matches the bare aggregate paths (empty trailing
  // segment), so exclude them here too; their own sub-routes (e.g.
  // `/agents/:agentId/sessions/:sessionId`) still gate on the real agent id.
  if (AGGREGATE_AGENT_SEGMENTS.has(c.req.param("id"))) {
    await next();
    return;
  }

  const { requireAgentAccess } = await loadMultiUserMiddlewareModule();
  return requireAgentAccess("id")(c, next);
});
if (readEnv("DEV")) {
  app.get("/api/debug/events", (c) =>
    c.json({ events: agentEventBus.getRecentEvents() })
  );
}

app.use("/api/*", relayDeviceApi());
app.use("/api/*", relayHttp());

app.all("/api/*", async (c) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname.startsWith("/api/")
    ? url.pathname.slice(4)
    : url.pathname === "/api"
      ? "/"
      : url.pathname;
  url.pathname = pathname || "/";
  const init = {
    method: c.req.method,
    headers: c.req.raw.headers,
    body: c.req.raw.body,
    signal: c.req.raw.signal,
    duplex: "half",
  };
  const request = new Request(url, init);

  let authContext: RequestAuthContext | null = null;
  let multiUserBearerVerified = false;
  if (currentExtensionRuntime().isEnabled("multiUser")) {
    const { forwardAuthContextToRequest, getRequestAuthContext, isVerifiedBearerRequest } =
      await loadMultiUserMiddlewareModule();
    authContext = getRequestAuthContext(c);
    // The marker comes from the outer middleware after it verified the bearer. It travels only in the bindings below.
    multiUserBearerVerified = authContext !== null && isVerifiedBearerRequest(c);
    forwardAuthContextToRequest(request, authContext);
  }

  // The socket peer reaches the inner API only through this binding. The remote link routes use it for rate limits.
  const peerAddress = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
  return (getCurrentInnerApi() ?? api).fetch(request, { multiUserAuthContext: authContext, multiUserBearerVerified, peerAddress });
});

app.all("/hooks/*", async (c) => {
  if (!currentExtensionRuntime().isEnabled("webhooks")) {
    return c.json({ error: "extension_disabled", extension: "webhooks" }, 404);
  }
  return (getCurrentInnerApi() ?? api).fetch(c.req.raw);
});

app.get("/health", (c) => c.json({ ok: true }));

async function canAccessAgent(
  authContext: RequestAuthContext | null,
  agentId: string
): Promise<boolean> {
  if (!currentExtensionRuntime().isEnabled("multiUser")) return true;
  if (!authContext) return false;
  const { hasAgentAccess } = await loadMultiUserMiddlewareModule();
  return hasAgentAccess(authContext, agentId);
}

function resolveGatewayBindHost(bind?: GatewayBindMode): string {
  const host = resolveBindHost(bind);
  if (bind === "tailnet" && host === "127.0.0.1") {
    console.warn(
      "[gateway] tailnet bind: no tailnet IP found, falling back to 127.0.0.1"
    );
  }
  return host;
}

function setupGracefulShutdown(server: ReturnType<typeof serve>): void {
  const shutdown = () => {
    console.log("[gateway] Graceful shutdown initiated");
    try {
      cleanupOrphanContainers();
    } catch (error) {
      logError("[gateway] Container cleanup failed", error);
    }
    // Do not force-exit here. The CLI owns extension shutdown and registers its
    // own signal handler after the server starts; exiting from this earlier
    // handler would cut off those awaited stop hooks.
    server.close();
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

export function startServer(
  port?: number,
  host?: string,
  runtime: ExtensionRuntime = getExtensionRuntime()
) {
  activeExtensionRuntime = runtime;
  const config = loadConfig();
  const hasSandboxAgents = config.agents.some(
    (agent) => agent.sandbox?.enabled
  );
  if (hasSandboxAgents) {
    const networkName = config.sandbox?.network?.name ?? "yoplai-agents";
    const internal = config.sandbox?.network?.internal ?? true;
    try {
      ensureNetwork(networkName, internal);
      cleanupOrphanContainers();
      const images = new Set(
        config.agents
          .filter((a) => a.sandbox?.enabled)
          .map((a) => a.sandbox?.image ?? "yoplai-agent:latest")
      );
      for (const image of images) {
        ensureAgentImage(image);
      }
      console.log("Container sandbox: network ready, orphans cleaned");
    } catch (error) {
      logError("Container sandbox setup failed", error);
    }
  }

  const resolvedPort = port ?? config.gateway?.port ?? 4000;
  // host arg > config.gateway.host > resolve from bind > default loopback
  const resolvedHost =
    host ??
    config.gateway?.host ??
    resolveGatewayBindHost(config.gateway?.bind);
  configureRelay(
    resolvedHost,
    () => runtime.isEnabled("multiUser"),
    config.ui?.tailscale?.mode === "serve",
    readEnv("UI_HOST") ?? resolveBindHost(config.ui?.bind)
  );
  const nodeBin = path.dirname(process.execPath);
  if (nodeBin && !process.env.PATH?.split(path.delimiter).includes(nodeBin)) {
    process.env.PATH = `${nodeBin}${path.delimiter}${process.env.PATH ?? ""}`;
  }

  console.log(`Starting gateway server on ${resolvedHost}:${resolvedPort}`);
  // Port 0 (tests) means "any free port". It is not a valid env port, and loadConfig refuses it.
  if (resolvedPort !== 0) process.env.YOPLAI_GATEWAY_PORT = String(resolvedPort);

  const server = serve({
    fetch: app.fetch,
    port: resolvedPort,
    hostname: resolvedHost,
  });
  // The browser link needs the address that the listener really bound. A host name can bind to any of its addresses.
  const recordListener = () => {
    const address = server.address();
    setGatewayListener(address && typeof address === "object" ? { address: address.address, port: address.port } : undefined);
  };
  if (server.listening) recordListener();
  else server.once("listening", recordListener);
  server.once("close", () => setGatewayListener(undefined));

  // The packaged app has no Vite. With a built UI directory, a second loopback listener serves it on the UI port.
  const webDist = readEnv("WEB_DIST");
  // Dev keeps running without Apps views. The packaged app exits, so the desktop shows its error page with Restart.
  const stopApps = startAppsListener(
    config,
    resolvedHost,
    webDist
      ? (error) => {
          logError(`MCP Apps listener failed on port ${config.apps?.port ?? 4001}`, error);
          process.exit(1);
        }
      : undefined
  );
  server.once("close", stopApps);

  if (webDist) {
    const uiPort = config.ui?.port ?? 3000;
    const uiServer = startUiListener({
      webDist,
      host: "127.0.0.1",
      port: uiPort,
      gatewayHost: ["0.0.0.0", "::"].includes(resolvedHost) ? "127.0.0.1" : resolvedHost,
      gatewayPort: resolvedPort,
      onError: (error) => {
        logError(`UI listener failed on 127.0.0.1:${uiPort}`, error);
        process.exit(1);
      },
    });
    console.log(`Serving web UI from ${webDist} on 127.0.0.1:${uiPort}`);
    server.once("close", () => {
      uiServer.close();
      uiServer.closeAllConnections();
    });
  }

  // Loaded by the first upgrade of a multi-user socket, so the sync check below finds it for every socket with a context.
  let loadedMultiUserModule: MultiUserMiddlewareModule | undefined;
  const wsAuthAdapter: WsBrokerAuthAdapter = {
    isMultiUserEnabled: () => currentExtensionRuntime().isEnabled("multiUser"),
    validateWebSocketRequest: async (request) => {
      loadedMultiUserModule = await loadMultiUserMiddlewareModule();
      return loadedMultiUserModule.validateWebSocketRequest(request);
    },
    isAuthContextActive: (authContext) => {
      // A bearer session has the ID `apikey:<key ID>`. A cookie session has no key to revoke.
      if (!authContext.session.id.startsWith("apikey:")) return true;
      if (!loadedMultiUserModule) return false;
      const state = loadedMultiUserModule.getManagedKeyState(authContext.session.id.slice("apikey:".length), authContext.user.id);
      return state === "active" || state === "unmanaged";
    },
    canAccessAgent,
    getExtensionRuntime: currentExtensionRuntime,
  };
  new WsBroker().attach(server as import("http").Server, wsAuthAdapter);
  server.once("close", startDeviceLinks());

  setupGracefulShutdown(server);

  void startConfiguredInternalSocket(config, resolveHomeDir());

  return server;
}

export { app };
