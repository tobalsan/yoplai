import { OAuthAuthorizationStartSchema } from "@yoplai/shared";
import { getAgent } from "../config/index.js";
import { allowedCorsOrigins } from "../server/origins.js";
import { isTrustedRequest, resolveRemoteAgent } from "./state.js";
import { fetchRemote, isSafeRemotePath, remoteHttpUrl } from "./remote.js";
import type { RemoteGateway } from "./store.js";

type Rule = { methods: string[]; path: RegExp; agent?: "path" | "query" | "body" };
const rules: Rule[] = [
  { methods: ["GET"], path: /^\/api\/agents\/[^/]+(?:\/(?:extensions|connections|webhooks|dashboards|avatar))?$/, agent: "path" },
  { methods: ["PATCH"], path: /^\/api\/agents\/[^/]+\/(?:extensions|webhooks)\/[^/]+$/, agent: "path" },
  { methods: ["DELETE"], path: /^\/api\/agents\/[^/]+\/(?:extensions\/[^/]+\/credentials|connections\/[^/]+\/[^/]+)$/, agent: "path" },
  { methods: ["GET"], path: /^\/api\/oauth\/[^/]+\/status$/, agent: "query" },
  { methods: ["POST"], path: /^\/api\/oauth\/[^/]+\/disconnect$/, agent: "query" },
  { methods: ["GET", "POST"], path: /^\/api\/mcp\/servers(?:\/config)?$/, agent: "query" },
  { methods: ["GET"], path: /^\/api\/mcp\/servers\/personal-status$/, agent: "query" },
  { methods: ["POST"], path: /^\/api\/mcp\/servers\/(?:remove|shared|label|icon\/refresh)$/, agent: "query" },
  { methods: ["GET"], path: /^\/api\/mcp\/oauth\/status$/, agent: "query" },
  { methods: ["POST"], path: /^\/api\/mcp\/oauth\/disconnect$/, agent: "query" },
  { methods: ["GET"], path: /^\/api\/schedules$/, agent: "query" },
  { methods: ["POST"], path: /^\/api\/schedules$/, agent: "body" },
  { methods: ["PATCH", "DELETE"], path: /^\/api\/schedules\/[^/]+\/[^/]+$/, agent: "path" },
  { methods: ["POST"], path: /^\/api\/schedules\/[^/]+\/[^/]+\/run$/, agent: "path" },
  { methods: ["GET"], path: /^\/api\/schedules\/[^/]+\/[^/]+\/runs(?:\/[^/]+\/trace)?$/, agent: "path" },
  { methods: ["GET"], path: /^\/api\/(?:agents|mcp\/catalog|schedule-alerts|dashboards(?:\/recipients)?|pool(?:\/[^/]+\/avatar)?|pool-actions|teams|admin\/forks|top-extensions|capabilities)$/ },
  { methods: ["PUT", "DELETE"], path: /^\/api\/dashboards\/[^/]+\/pin$/ },
  { methods: ["PATCH"], path: /^\/api\/dashboards\/[^/]+\/sharing$/ },
  { methods: ["POST"], path: /^\/api\/dashboards\/[^/]+\/claim$/ },
  { methods: ["DELETE"], path: /^\/api\/dashboards\/[^/]+$/ },
  { methods: ["PUT"], path: /^\/api\/admin\/forks\/[^/]+\/teams$/ },
  { methods: ["PATCH"], path: /^\/api\/admin\/forks\/[^/]+\/visibility$/ },
  { methods: ["DELETE"], path: /^\/api\/admin\/teams\/[^/]+\/agents\/[^/]+$/ },
];

export type ConfigurationForward = (request: Request, gateway: RemoteGateway, path: string, agentDetail?: boolean) => Promise<Response>;
const fail = (error: string, status = 400) => Response.json({ error }, { status });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Provider state stays remote. The local server never fetches this URL. */
export function safeAuthorizationUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\s\p{Cc}\\]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || ["code", "access_token", "refresh_token", "client_secret", "authorization"].some((key) => url.searchParams.has(key))) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function browserStartError(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin || !allowedCorsOrigins().includes(origin)) return fail("untrusted_origin", 403);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return fail("json_required", 415);
}

async function jsonBody(request: Pick<Request, "body" | "signal">): Promise<Record<string, unknown> | Response> {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Cancel the owned stream without waiting for its source to finish cancellation.
  const cancel = () => { void reader?.cancel().catch(() => undefined); };
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    request.signal.throwIfAborted();
    while (reader) {
      const { done, value } = await reader.read();
      request.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        cancel();
        return fail("configuration_body_too_large", 413);
      }
      if (value.byteLength) chunks.push(value);
    }
  } catch {
    cancel();
    return fail("configuration_body_read_failed");
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
    return isRecord(value) ? value : fail("invalid_configuration_body");
  } catch {
    return fail("invalid_configuration_body");
  }
}

function withJson(request: Request, body: Record<string, unknown>): Request {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal });
}

function selectedAgent(value: string, gateway: RemoteGateway, gateways: RemoteGateway[]): string | undefined {
  const target = resolveRemoteAgent(value, gateways);
  if (target.gateway) return target.gateway === gateway.name ? target.agentId : undefined;
  // An exact local ID with a relay suffix must not select a remote agent.
  if (getAgent(value) && gateways.some((item) => value.endsWith(`@${item.name}`))) return undefined;
  return value;
}

async function startOAuth(request: Request, gateways: RemoteGateway[]): Promise<Response> {
  if (request.method !== "POST") return fail("method_not_allowed", 405);
  const denied = browserStartError(request);
  if (denied) return denied;
  const input = await jsonBody(request);
  if (input instanceof Response) return input;
  if (Object.keys(input).some((key) => !["gateway", "agentId", "kind", "provider", "server", "scope", "scopes"].includes(key))) return fail("invalid_oauth_start");
  const gateway = gateways.find((item) => item.name === input.gateway);
  if (!gateway) return fail("unknown_gateway", 404);
  if (typeof input.agentId !== "string" || !input.agentId || !["personal", "team"].includes(String(input.scope))) return fail("invalid_oauth_start");
  const agent = selectedAgent(input.agentId, gateway, gateways);
  if (!agent) return fail("invalid_remote_agent");
  const query = new URLSearchParams({ agent, scope: String(input.scope) });
  let path: string;
  if (input.kind === "core" && typeof input.provider === "string" && /^[A-Za-z0-9_-]+$/.test(input.provider)) {
    path = `/api/oauth/${encodeURIComponent(input.provider)}/authorize`;
    if (input.scopes !== undefined) {
      if (!Array.isArray(input.scopes) || input.scopes.some((scope) => typeof scope !== "string")) return fail("invalid_oauth_scopes");
      query.set("scopes", input.scopes.join(","));
    }
  } else if (input.kind === "mcp" && typeof input.server === "string" && input.server.trim()) {
    path = "/api/mcp/oauth/authorize";
    query.set("server", input.server);
  } else return fail("invalid_oauth_target");
  try {
    const core = input.kind === "core";
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    const response = await fetchRemote(gateway, `${path}?${query}`, {
      headers: core ? { accept: "application/json" } : undefined,
      signal,
    });
    if ([401, 403, 404].includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      return fail("remote_oauth_denied", response.status);
    }
    let location: unknown;
    if (core) {
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        return fail("unexpected_oauth_redirect", 502);
      }
      if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
        void response.body?.cancel().catch(() => undefined);
        return fail("remote_oauth_start_failed", 502);
      }
      const result = await jsonBody({ body: response.body, signal });
      const parsed = OAuthAuthorizationStartSchema.safeParse(result);
      if (!parsed.success || parsed.data.provider !== input.provider) return fail("remote_oauth_start_failed", 502);
      location = parsed.data.authorizationUrl;
    } else {
      location = response.headers.get("location");
      void response.body?.cancel().catch(() => undefined);
      if (![302, 303].includes(response.status) || !location) return fail("remote_oauth_start_failed", 502);
    }
    const authorizationUrl = safeAuthorizationUrl(location);
    if (!authorizationUrl || (gateway.token && decodeURIComponent(authorizationUrl).includes(gateway.token))) return fail("unsafe_authorization_url", 502);
    const target = new URL(authorizationUrl);
    if (target.origin === new URL(gateway.url).origin) return fail("unexpected_oauth_redirect", 502);
    return Response.json({ authorizationUrl }, { headers: { "cache-control": "no-store" } });
  } catch {
    return fail("gateway_offline", 502);
  }
}

/**
 * Only this table adds configuration routes to the relay. Object IDs stay unchanged.
 * A returned Request holds the rebuilt body for a local handler.
 */
export async function relayConfiguration(request: Request, gateways: RemoteGateway[], forward: ConfigurationForward): Promise<Response | Request | null> {
  const url = new URL(request.url);
  const prefix = /^\/api\/relay\/gateways\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const isStart = url.pathname === "/api/relay/oauth/start";
  const path = prefix ? prefix[2] ?? "" : url.pathname;
  const rule = rules.find((item) => item.path.test(path) && item.methods.includes(request.method)) ?? rules.find((item) => item.path.test(path));
  const authorize = /^\/api\/(?:oauth\/[^/]+|mcp\/oauth)\/authorize$/.test(path);
  if (!prefix && !isStart && !rule && !authorize) return null;
  if (!isSafeRemotePath(url.pathname)) return fail("invalid_remote_path");
  const trusted = isTrustedRequest(request.headers.get("origin"), request.headers.get("x-forwarded-for"));
  if (prefix || isStart) {
    if (!trusted || gateways.length === 0) return fail("relay_unavailable", 403);
    if (isStart) return startOAuth(request, gateways);
  }
  if (!prefix && gateways.length === 0) return null;
  let gateway = prefix ? gateways.find((item) => item.name === decodeURIComponent(prefix[1])) : undefined;
  if (prefix && !gateway) return fail("unknown_gateway", 404);
  if (prefix && (!rule || !rule.methods.includes(request.method))) return fail("relay_route_not_allowed", 405);
  const agentKind = rule?.agent ?? (authorize ? "query" : undefined);
  let body: Record<string, unknown> | undefined;
  let value: string | undefined;
  if (agentKind === "path") value = decodeURIComponent(path.split("/")[3]);
  if (agentKind === "query") {
    if (url.searchParams.getAll("agent").length > 1) return fail("invalid_remote_agent");
    value = url.searchParams.get("agent") ?? undefined;
  }
  if (agentKind === "body") {
    const input = await jsonBody(request);
    if (input instanceof Response) return input;
    body = input;
    request = withJson(request, body);
    value = typeof body?.agentId === "string" ? body.agentId : undefined;
  }
  let agent: string | undefined;
  if (value) {
    const target = resolveRemoteAgent(value, gateways);
    if (!prefix && !target.gateway) {
      if (getAgent(value) || !value.includes("@")) return body ? request : null;
      return fail("unknown_gateway", 404);
    }
    gateway ??= gateways.find((item) => item.name === target.gateway);
    if (gateway) agent = selectedAgent(value, gateway, gateways);
  }
  if (!gateway) return body ? request : null;
  if (!trusted) return fail("untrusted_origin", 403);
  if (rule && !rule.methods.includes(request.method)) return fail("relay_route_not_allowed", 405);
  if (authorize) return fail("use_oauth_start", 405);
  if (agentKind && !agent) return fail("invalid_remote_agent");
  let remotePath = path;
  if (agentKind === "path") {
    const segments = path.split("/");
    segments[3] = encodeURIComponent(agent!);
    remotePath = segments.join("/");
  }
  if (agentKind === "query") url.searchParams.set("agent", agent!);
  if (agentKind === "body") request = withJson(request, { ...body, agentId: agent });
  const mcpAdd = request.method === "POST" && path === "/api/mcp/servers";
  if (mcpAdd) {
    const denied = browserStartError(request);
    if (denied) return denied;
    const input = await jsonBody(request);
    if (input instanceof Response) return input;
    if (!["personal", "team"].includes(String(input.credentialScope))) return fail("invalid_credential_scope");
    delete input.returnTo;
    request = withJson(request, input);
  }
  const response = await forward(request, gateway, `${remotePath}${url.search}`, request.method === "GET" && /^\/api\/agents\/[^/]+$/.test(path));
  if (mcpAdd && response.ok) {
    let result: unknown;
    try { result = await response.json(); }
    catch { return fail("invalid_mcp_add_response", 502); }
    if (!isRecord(result)) return fail("invalid_mcp_add_response", 502);
    if (result.authorizationUrl !== undefined) {
      const authorizationUrl = safeAuthorizationUrl(result.authorizationUrl);
      if (!authorizationUrl || new URL(authorizationUrl).origin === new URL(gateway.url).origin || (gateway.token && authorizationUrl.includes(gateway.token))) return fail("unsafe_authorization_url", 502);
      result.authorizationUrl = authorizationUrl;
    }
    return Response.json(result, { status: response.status, headers: response.headers });
  }
  return response;
}

export function configurationRedirect(gateway: RemoteGateway, location: string, pathAndQuery: string): string | undefined {
  try {
    const base = new URL(gateway.url);
    const target = new URL(location, remoteHttpUrl(gateway, pathAndQuery));
    if (target.origin !== base.origin || target.username || target.password || !isSafeRemotePath(target.pathname)) return undefined;
    if (!rules.some((rule) => rule.methods.includes("GET") && rule.path.test(target.pathname))) return undefined;
    return `/api/relay/gateways/${encodeURIComponent(gateway.name)}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return undefined;
  }
}
