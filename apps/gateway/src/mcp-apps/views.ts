import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import type { GatewayConfig } from "@yoplai/shared";
import { isSafeSessionId } from "../history/sessions.js";
import { readMcpAppRecord } from "./capture.js";
import { logInfo, logWarn } from "../logging.js";
import { accessLogger } from "../server/access-log.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";

type SessionScope = { agentId: string; sessionId: string; ownerUserId?: string | null };
type Ticket = SessionScope & { appsOrigin: string; chatOrigin: string; html: string; policy: string; expiresAt: number };
const tickets = new Map<string, Ticket>();
const pendingViews = new Set<SessionScope & { revoked: boolean }>();
let listener: ReturnType<typeof serve> | undefined;
let listening = false;
const DEFAULT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'self'; object-src 'none'";

export function appsAvailable(): boolean {
  return listening;
}

export function revokeMcpAppSession(scope: SessionScope): void {
  for (const pending of pendingViews) {
    if (pending.agentId === scope.agentId && pending.sessionId === scope.sessionId && (pending.ownerUserId ?? null) === (scope.ownerUserId ?? null)) pending.revoked = true;
  }
  for (const [id, ticket] of tickets) {
    if (ticket.agentId === scope.agentId && ticket.sessionId === scope.sessionId && (ticket.ownerUserId ?? null) === (scope.ownerUserId ?? null)) tickets.delete(id);
  }
}

export function startAppsListener(config: GatewayConfig, host: string): () => void {
  listening = false;
  const app = new Hono();
  app.use("*", accessLogger());
  for (const kind of ["sandbox", "content"] as const) {
    app.get(`/${kind}/:ticket`, (c) => {
      const ticket = tickets.get(c.req.param("ticket"));
      if (!ticket || ticket.expiresAt <= Date.now() || new URL(c.req.url).host !== new URL(ticket.appsOrigin).host) return c.notFound();
      c.header("Cache-Control", "no-store");
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Content-Type", "text/html; charset=utf-8");
      if (kind === "content") {
        c.header("Content-Security-Policy", `${ticket.policy}; frame-ancestors ${ticket.chatOrigin} ${ticket.appsOrigin}`);
        c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
        return c.body(ticket.html);
      }
      c.header("Content-Security-Policy", `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors ${ticket.chatOrigin}`);
      return c.body(bootstrapPage(ticket, c.req.param("ticket")));
    });
  }
  const server = serve({
    fetch: (request) => request.method === "GET" ? app.fetch(request) : new Response("Not Found", { status: 404 }),
    hostname: host, port: config.apps?.port ?? 4001,
  });
  listener = server;
  server.once("listening", () => { if (listener === server) listening = true; });
  server.on("error", () => {
    if (listener === server) listening = false;
    logWarn("MCP Apps listener unavailable", { outcome: "unavailable" });
  });
  return () => {
    if (listener === server) { listening = false; listener = undefined; }
    tickets.clear();
    server.close();
  };
}

function bootstrapPage(ticket: Ticket, id: string): string {
  const chatOrigin = JSON.stringify(ticket.chatOrigin).replaceAll("<", "\\u003c");
  const contentUrl = JSON.stringify(`${ticket.appsOrigin}/content/${id}`).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>MCP App sandbox</title><style>html,body,iframe{width:100%;height:100%;border:0;margin:0;display:block}body{overflow:hidden}</style></head><body><script>
(() => {
  'use strict';
  const chatOrigin = ${chatOrigin};
  const contentUrl = ${contentUrl};
  const appsOrigin = new URL(contentUrl).origin;
  if (parent === window || location.origin === chatOrigin) return;
  let inner;
  addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return;
    const sandboxMessage = typeof message.method === 'string' && message.method.startsWith('ui/notifications/sandbox-');
    if (event.source === parent && event.origin === chatOrigin) {
      if (message.method === 'ui/notifications/sandbox-resource-ready') {
        if (inner) return;
        inner = document.createElement('iframe');
        inner.title = 'MCP App content';
        inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
        inner.src = contentUrl;
        document.body.append(inner);
      } else if (inner && !sandboxMessage) {
        inner.contentWindow.postMessage(message, appsOrigin);
      }
    } else if (inner && event.source === inner.contentWindow && event.origin === appsOrigin && !sandboxMessage) {
      parent.postMessage(message, chatOrigin);
    }
  });
  parent.postMessage({jsonrpc:'2.0', method:'ui/notifications/sandbox-proxy-ready', params:{}}, chatOrigin);
})();
</script></body></html>`;
}

function appsOrigin(config: GatewayConfig, chatOrigin: string): string | undefined {
  const chat = new URL(chatOrigin);
  const loopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  const candidate = config.apps?.origin ?? (loopback(chat.hostname) ? `http://yoplai-apps.localhost:${config.apps?.port ?? 4001}` : undefined);
  if (!candidate || !/^https?:\/\/[^/?#]+$/i.test(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.hostname === chat.hostname) return undefined;
    if (url.protocol !== "https:" && !loopback(url.hostname) && !url.hostname.endsWith(".localhost")) return undefined;
    return url.origin;
  } catch { return undefined; }
}

type Csp = { connectDomains: string[]; resourceDomains: string[]; frameDomains: string[]; baseUriDomains: string[] };

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function viewPolicy(meta: unknown): { csp: Csp; policy: string; prefersBorder: boolean } {
  const ui = object(object(meta).ui);
  const declared = object(ui.csp);
  const csp: Csp = { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] };
  for (const key of Object.keys(csp) as Array<keyof Csp>) {
    const values = declared[key];
    if (!Array.isArray(values)) continue;
    for (const value of values) {
      let approved: string | undefined;
      try {
        // Scheme sources for document-created resources (for example, tldraw imports its code from blob: URLs).
        if (key === "resourceDomains" && (value === "blob:" || value === "data:")) approved = value;
        else if (typeof value === "string" && /^[a-z]+:\/\/[^/?#]+$/.test(value) && !/[\s*'";\\]/.test(value)) {
          const url = new URL(value);
          const validProtocol = ["https:", "wss:"].includes(url.protocol) || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname) && /:[0-9]+$/.test(value));
          if (validProtocol && !url.username && !url.password && url.hostname) approved = value;
        }
      } catch { /* Invalid declared origins are discarded. */ }
      if (approved) {
        if (!csp[key].includes(approved)) csp[key].push(approved);
      } else logWarn("MCP Apps invalid CSP origin", { directive: key, outcome: "dropped" });
    }
  }
  let policy = DEFAULT_CSP;
  if (Object.values(csp).some((values) => values.length)) {
    const resources = csp.resourceDomains.length ? ` ${csp.resourceDomains.join(" ")}` : "";
    policy = `default-src 'none'; script-src 'self' 'unsafe-inline'${resources}; style-src 'self' 'unsafe-inline'${resources}; img-src 'self' data:${resources}; media-src 'self' data:${resources}`;
    if (resources) policy += `; font-src 'self'${resources}`;
    policy += `; connect-src ${csp.connectDomains.join(" ") || "'none'"}; frame-src ${csp.frameDomains.join(" ") || "'none'"}; base-uri ${csp.baseUriDomains.join(" ") || "'self'"}; object-src 'none'`;
  }
  return { csp, policy, prefersBorder: ui.prefersBorder === true };
}

async function readJson(request: Request, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (Number(request.headers.get("content-length")) > maxBytes) throw new RangeError("request_too_large");
  const reader = request.body?.getReader();
  if (!reader) return null;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new RangeError("request_too_large");
      }
      chunks.push(value);
    }
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
  signal?.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function mcpError(error: unknown): { reason: string; authorizeUrl?: string } {
  const shaped = object(error);
  const reasons = ["unknown_agent", "unknown_server", "unknown_tool", "not_app_visible", "not_connected", "needs_reconnect", "timeout", "aborted", "upstream"];
  if (shaped.name === "McpAppsError" && typeof shaped.reason === "string" && reasons.includes(shaped.reason)) {
    return { reason: shaped.reason, ...(typeof shaped.authorizeUrl === "string" ? { authorizeUrl: shaped.authorizeUrl } : {}) };
  }
  return { reason: "upstream" };
}

async function deadline<T>(requestSignal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const stopped = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  const abort = (reason: "timeout" | "aborted") => controller.abort(Object.assign(new Error("MCP Apps request failed"), { name: "McpAppsError", reason }));
  const onAbort = () => abort("aborted");
  const timer = setTimeout(() => abort("timeout"), 30_000);
  requestSignal.addEventListener("abort", onAbort, { once: true });
  if (requestSignal.aborted) onAbort();
  try {
    return await Promise.race([stopped, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    requestSignal.removeEventListener("abort", onAbort);
  }
}

export function createMcpAppRoutes(deps: {
  getConfig: () => GatewayConfig;
  getRuntime: () => ExtensionRuntime;
  getUserId: (c: Context) => Promise<string | undefined>;
  resolveHistoryFile: (params: { userId?: string; agentId: string; sessionId: string }) => Promise<string | null>;
}): Hono {
  const app = new Hono();
  app.post("/agents/:agentId/sessions/:sessionId/mcp-apps/:toolCallId/:operation", async (c) => {
    const startedAt = Date.now();
    const agentId = c.req.param("agentId"), sessionId = c.req.param("sessionId"), toolCallId = c.req.param("toolCallId");
    const operation = c.req.param("operation");
    let pending: (SessionScope & { revoked: boolean }) | undefined;
    const audit: Record<string, unknown> = { viewer: null, agent: agentId, session: sessionId, toolCall: toolCallId, server: null, method: operation, tool: null, resource: null, outcome: "not_found" };
    try {
      const userId = await deps.getUserId(c);
      audit.viewer = userId ?? null;
      if (operation === "view") {
        pending = { agentId, sessionId, ownerUserId: userId, revoked: false };
        pendingViews.add(pending);
      }
      if (!isSafeSessionId(sessionId) || !await deps.resolveHistoryFile({ userId, agentId, sessionId })) return c.json({ error: "not_found" }, 404);
      const record = await readMcpAppRecord({ agentId, sessionId, ownerUserId: userId }, toolCallId);
      if (!record) return c.json({ error: "not_found" }, 404);
      Object.assign(audit, { server: record.server, tool: record.tool, resource: record.resourceUri });
      const mcpApps = deps.getRuntime().getLoadedExtensions().find((extension) => extension.mcpApps)?.mcpApps;
      if (operation === "log") {
        let body: unknown;
        try { body = await deadline(c.req.raw.signal, (signal) => readJson(c.req.raw, 4096, signal)); }
        catch (error) { audit.outcome = "invalid_log"; return c.json({ error: "invalid_log" }, error instanceof RangeError ? 413 : 400); }
        const event = object(body);
        if (typeof event.level !== "string" || !["debug", "info", "notice", "warning", "warn", "error", "critical", "alert", "emergency"].includes(event.level) || typeof event.message !== "string" || event.message.length > 500) {
          audit.outcome = "invalid_log";
          return c.json({ error: "invalid_log" }, 400);
        }
        Object.assign(audit, { outcome: "ok", appLevel: event.level, message: event.message.replace(/\p{Cc}/gu, " ") });
        return c.json({ ok: true });
      }
      if (operation === "rpc") {
        let id: string | number | null = null;
        const response = (code: number, message: string, outcome: string) => {
          audit.outcome = outcome;
          return c.json({ jsonrpc: "2.0", id, error: { code, message } });
        };
        try {
          return await deadline(c.req.raw.signal, async (signal) => {
            const body = await readJson(c.req.raw, 1024 * 1024, signal);
            const request = object(body);
            if (typeof request.id === "string" || typeof request.id === "number" || request.id === null) id = request.id;
            if (Array.isArray(body) || request.jsonrpc !== "2.0" || !("id" in request) || (request.id !== null && typeof request.id !== "string" && typeof request.id !== "number") || typeof request.method !== "string") return response(-32600, "Invalid Request", "invalid_request");
            audit.method = request.method;
            if (!["tools/call", "resources/read"].includes(request.method)) return response(-32601, "Method not found", "method_not_found");
            const params = object(request.params);
            if (request.method === "tools/call" && (typeof params.name !== "string" || !params.name || (params.arguments !== undefined && (params.arguments === null || typeof params.arguments !== "object" || Array.isArray(params.arguments))))) return response(-32602, "Invalid params", "invalid_params");
            if (request.method === "resources/read" && (typeof params.uri !== "string" || !params.uri)) return response(-32602, "Invalid params", "invalid_params");
            if (!mcpApps) throw Object.assign(new Error("MCP Apps unavailable"), { name: "McpAppsError", reason: "not_connected" });
            signal.throwIfAborted();
            const context = { agentId, ...(userId ? { userId } : {}), signal };
            Object.assign(audit, request.method === "tools/call" ? { tool: params.name, resource: null } : { tool: null, resource: params.uri });
            const result = request.method === "tools/call"
              ? await mcpApps.callTool(context, record.server, params.name as string, object(params.arguments))
              : await mcpApps.readResource(context, record.server, params.uri as string);
            audit.outcome = "ok";
            return c.json({ jsonrpc: "2.0", id, result });
          });
        } catch (error) {
          if (error instanceof RangeError) { audit.outcome = "request_too_large"; return c.json({ error: "request_too_large" }, 413); }
          if (error instanceof SyntaxError) return response(-32700, "Parse error", "parse_error");
          const data = mcpError(error);
          audit.outcome = data.reason;
          return c.json({ jsonrpc: "2.0", id, error: { code: -32000, message: "MCP Apps request failed", data } });
        }
      }
      if (operation !== "view") return c.notFound();
      const unavailable = (reason: string) => { audit.outcome = reason; return c.json({ available: false, reason }); };
      const config = deps.getConfig();
      const chatOrigin = c.req.header("Origin");
      const { getTrustedOrigins, getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
      if (!chatOrigin || !getTrustedOrigins(config).includes(chatOrigin)) { audit.outcome = "untrusted_origin"; return c.json({ error: "untrusted_origin" }, 403); }
      const cookiePolicy = getMultiUserRuntime()?.auth.options?.advanced;
      if (cookiePolicy?.crossSubDomainCookies?.enabled || cookiePolicy?.defaultCookieAttributes?.domain || Object.values(cookiePolicy?.cookies ?? {}).some((cookie) => cookie.attributes?.domain)) return unavailable("unsafe_cookie_domain");
      const origin = appsOrigin(config, chatOrigin);
      if (!origin || !appsAvailable()) return unavailable("apps_unavailable");
      if (!mcpApps) return unavailable("not_connected");
      let contents;
      try {
        ({ contents } = await deadline(c.req.raw.signal, (signal) => mcpApps.readResource({ agentId, ...(userId ? { userId } : {}), signal }, record.server, record.resourceUri)));
      } catch (error) { return unavailable(mcpError(error).reason); }
      const content = contents?.[0];
      if (!Array.isArray(contents) || contents.length !== 1 || content?.mimeType !== "text/html;profile=mcp-app") return unavailable("invalid_resource");
      const maxHtmlBytes = 5 * 1024 * 1024;
      let html = typeof content.text === "string" ? content.text : undefined;
      if (html === undefined && typeof content.blob === "string" && content.blob.length <= Math.ceil(maxHtmlBytes / 3) * 4 && content.blob.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(content.blob)) {
        const bytes = Buffer.from(content.blob, "base64");
        if (bytes.byteLength <= maxHtmlBytes) html = bytes.toString("utf8");
      }
      if (html === undefined || Buffer.byteLength(html) > maxHtmlBytes) return unavailable("invalid_resource");
      const { csp, policy, prefersBorder } = viewPolicy(content._meta);
      if (pending?.revoked) return unavailable("session_deleted");
      if (c.req.raw.signal.aborted) return unavailable("aborted");
      for (const [id, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(id);
      if (tickets.size >= 512) { const oldest = tickets.keys().next().value; if (oldest) tickets.delete(oldest); }
      const id = randomBytes(32).toString("hex");
      tickets.set(id, { agentId, sessionId, ownerUserId: userId, chatOrigin, appsOrigin: origin, html, policy, expiresAt: Date.now() + 3600_000 });
      audit.outcome = "ok";
      logInfo("MCP Apps CSP", { viewer: userId ?? null, agent: agentId, session: sessionId, toolCall: toolCallId, server: record.server, csp, policy });
      return c.json({ available: true, sandboxUrl: `${origin}/sandbox/${id}`, appsOrigin: origin, server: record.server, toolName: record.tool, args: record.args, result: record.result, csp, prefersBorder });
    } finally {
      if (pending) pendingViews.delete(pending);
      logInfo("MCP Apps operation", { ...audit, duration: Date.now() - startedAt });
    }
  });
  return app;
}
