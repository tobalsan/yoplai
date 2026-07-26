import { serve } from "@hono/node-server";
import path from "node:path";
import { Hono } from "hono";
import { logError } from "../logging.js";
import { cors } from "hono/cors";
import { readEnv, resolveBindHost } from "@yoplai/shared";
import type { GatewayBindMode, GatewayConfig } from "@yoplai/shared";
import { api } from "./api.core.js";
import { internalTools } from "./internal-tools.js";
import {
  cleanupOrphanContainers,
  ensureAgentImage,
  ensureNetwork,
} from "../agents/container.js";
import { loadConfig } from "../config/index.js";
import { agentEventBus } from "../agents/index.js";
import { getExtensionRuntime } from "../extensions/registry.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { WsBroker, type WsBrokerAuthAdapter } from "./ws-broker.js";
import { accessLogger } from "./access-log.js";

type RequestAuthContext =
  import("@yoplai/extension-multi-user").RequestAuthContext;

const app = new Hono();
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

app.use("*", cors());
app.use("*", accessLogger());
app.route("/internal", internalTools);
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
    if (!matcher.matches(path)) continue;
    if (isExtensionEnabled(config, matcher.extension, runtime)) break;
    if (matcher.allowWhenDisabled && runtime.isEnabled(matcher.extension)) break;
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

app.all("/api/*", async (c) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname.startsWith("/api/")
    ? url.pathname.slice(4)
    : url.pathname === "/api"
      ? "/"
      : url.pathname;
  url.pathname = pathname || "/";
  const request = new Request(url, c.req.raw);

  if (currentExtensionRuntime().isEnabled("multiUser")) {
    const { forwardAuthContextToRequest, getRequestAuthContext } =
      await loadMultiUserMiddlewareModule();
    forwardAuthContextToRequest(request, getRequestAuthContext(c));
  }

  return api.fetch(request);
});

app.all("/hooks/*", async (c) => {
  if (!currentExtensionRuntime().isEnabled("webhooks")) {
    return c.json({ error: "extension_disabled", extension: "webhooks" }, 404);
  }
  return api.fetch(c.req.raw);
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
  const shutdown = async () => {
    console.log("[gateway] Graceful shutdown initiated");
    try {
      cleanupOrphanContainers();
    } catch (error) {
      logError("[gateway] Container cleanup failed", error);
    }
    server.close();
    process.exit(0);
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
  const nodeBin = path.dirname(process.execPath);
  if (nodeBin && !process.env.PATH?.split(path.delimiter).includes(nodeBin)) {
    process.env.PATH = `${nodeBin}${path.delimiter}${process.env.PATH ?? ""}`;
  }

  console.log(`Starting gateway server on ${resolvedHost}:${resolvedPort}`);
  process.env.YOPLAI_GATEWAY_PORT = String(resolvedPort);

  const server = serve({
    fetch: app.fetch,
    port: resolvedPort,
    hostname: resolvedHost,
  });

  const wsAuthAdapter: WsBrokerAuthAdapter = {
    isMultiUserEnabled: () => currentExtensionRuntime().isEnabled("multiUser"),
    validateWebSocketRequest: async (request) => {
      const { validateWebSocketRequest } = await loadMultiUserMiddlewareModule();
      return validateWebSocketRequest(request);
    },
    canAccessAgent,
    getExtensionRuntime: currentExtensionRuntime,
  };
  new WsBroker().attach(server as import("http").Server, wsAuthAdapter);

  setupGracefulShutdown(server);

  return server;
}

export { app };
