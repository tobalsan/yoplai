import { OAuthAuthorizationStartSchema } from "@yoplai/shared";
import { decodeSkillId } from "@yoplai/shared/skill-id-wire";
import { getAgent } from "../config/index.js";
import { allowedCorsOrigins } from "../server/origins.js";
import { isRelayEnabled, isTrustedRequest, resolveRemoteAgent } from "./state.js";
import { fetchRemote, isSafeRemotePath, remoteHttpUrl } from "./remote.js";
import type { RemoteGateway } from "./store.js";

/**
 * `multipart` marks a skill upload. The relay counts the whole envelope against `SKILL_UPLOAD_LIMIT` before it parses or
 * forwards it. `bodyless` marks a write that must carry no body.
 * `json` marks a global write whose JSON body the relay reads within the 1 MiB bound before it forwards. */
type Rule = { methods: string[]; path: RegExp; agent?: "path" | "query" | "body"; json?: boolean; multipart?: boolean; bodyless?: boolean };
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
  { methods: ["GET"], path: /^\/api\/(?:agents|mcp\/catalog|schedule-alerts|dashboards(?:\/recipients)?|pool(?:\/[^/]+\/avatar)?|pool-actions|teams|admin\/forks|top-extensions|admin\/top-extensions|capabilities)$/ },
  // Global extension and MCP catalog administration. The remote checks its own superadmin policy.
  { methods: ["PUT"], path: /^\/api\/admin\/top-extensions$/, json: true },
  { methods: ["POST"], path: /^\/api\/mcp\/catalog$/, json: true },
  { methods: ["POST"], path: /^\/api\/mcp\/catalog\/update$/, json: true },
  { methods: ["POST"], path: /^\/api\/mcp\/catalog\/(?:remove|icon\/refresh)$/ },
  // Skills. Skill IDs are opaque and belong to one gateway. `/api/skills/import` is not here: its bearer is an import
  // token, never the linked bearer. Each method and path is exact, and the remote keeps its role and owner policy.
  { methods: ["GET"], path: /^\/api\/skills$/ },
  { methods: ["POST"], path: /^\/api\/skills$/, multipart: true },
  { methods: ["GET"], path: /^\/api\/skills\/recipients$/ },
  { methods: ["GET"], path: /^\/api\/skills\/import-token$/ },
  { methods: ["POST"], path: /^\/api\/skills\/import-token$/, bodyless: true },
  { methods: ["DELETE"], path: /^\/api\/skills\/import-token\/[^/]+$/, bodyless: true },
  { methods: ["GET"], path: /^\/api\/skills\/(?!import$)[^/]+$/ },
  { methods: ["DELETE"], path: /^\/api\/skills\/(?!import$)[^/]+$/, bodyless: true },
  { methods: ["PUT"], path: /^\/api\/skills\/[^/]+\/content$/, multipart: true },
  { methods: ["PUT"], path: /^\/api\/skills\/[^/]+\/(?:enabled|shares|system|owner|admin)$/, json: true },
  { methods: ["GET"], path: /^\/api\/admin\/skills$/ },
  { methods: ["GET"], path: /^\/api\/skills\/[^/]+\/(?:default|versions)$/ },
  { methods: ["POST"], path: /^\/api\/skills\/[^/]+\/default$/, bodyless: true },
  { methods: ["POST"], path: /^\/api\/skills\/[^/]+\/versions\/[^/]+\/restore$/, bodyless: true },
  // Skill object alias for IDs that the generic path guard cannot carry, such as a nested agent skill. `W` is one canonical
  // wire ID segment (`v1_` and base64url). The relay validates it before it forwards, and the remote decodes it once.
  // The alias covers object operations only. Collections, import tokens, import, and version IDs keep their routes above.
  { methods: ["GET"], path: /^\/api\/skill-ids\/[^/]+$/ },
  { methods: ["DELETE"], path: /^\/api\/skill-ids\/[^/]+$/, bodyless: true },
  { methods: ["PUT"], path: /^\/api\/skill-ids\/[^/]+\/content$/, multipart: true },
  { methods: ["PUT"], path: /^\/api\/skill-ids\/[^/]+\/(?:enabled|shares|system|owner|admin)$/, json: true },
  { methods: ["GET"], path: /^\/api\/skill-ids\/[^/]+\/(?:default|versions)$/ },
  { methods: ["POST"], path: /^\/api\/skill-ids\/[^/]+\/default$/, bodyless: true },
  { methods: ["POST"], path: /^\/api\/skill-ids\/[^/]+\/versions\/[^/]+\/restore$/, bodyless: true },
  // Slack pairing management. Both identifiers stay opaque and unchanged. The remote authenticates the linked bearer and
  // owns the pairings of that account. Token redemption and credential connection routes are not here.
  { methods: ["GET"], path: /^\/api\/slack\/pairings$/ },
  { methods: ["DELETE"], path: /^\/api\/slack\/pairings\/[^/]+\/[^/]+$/, bodyless: true },
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
/**
 * The Node adapter of Hono replaces the global Response class when the server starts.
 * Then a Response from `Response.json()` is not an `instanceof` the global class.
 * Check the class tag, which both kinds of Response share.
 */
export const isResponse = (value: unknown): value is Response => Object.prototype.toString.call(value) === "[object Response]";
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

function originError(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (!origin || !allowedCorsOrigins().includes(origin)) return fail("untrusted_origin", 403);
}

function browserStartError(request: Request): Response | undefined {
  const denied = originError(request);
  if (denied) return denied;
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

/** The whole multipart envelope of a skill upload, boundary and headers included, may hold at most this many bytes. */
export const SKILL_UPLOAD_LIMIT = 25 * 1024 * 1024;
const MULTIPART_TYPE = /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]{1,70})"|([0-9A-Za-z'()+_,\-./:=?]{1,70}))$/i;

/**
 * Reads the whole upload before any forward. It counts bytes while it reads, so an oversized or chunked body stops at the
 * limit. A bad length, a body that is not multipart, a read that fails, and an abort all end before the remote sees a byte.
 * The returned request keeps the original content type, so the boundary of the header and the body stay equal.
 */
async function skillUpload(request: Request): Promise<Request | Response> {
  const type = request.headers.get("content-type") ?? "";
  const match = MULTIPART_TYPE.exec(type.trim());
  if (!match) return fail("multipart_required", 415);
  const boundary = match[1] ?? match[2];
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^\d+$/.test(declared)) return fail("invalid_content_length");
  if (declared !== null && Number(declared) > SKILL_UPLOAD_LIMIT) return fail("skill_upload_too_large", 413);
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
      if (size > SKILL_UPLOAD_LIMIT) {
        cancel();
        return fail("skill_upload_too_large", 413);
      }
      if (value.byteLength) chunks.push(value);
    }
  } catch {
    cancel();
    return fail("skill_upload_read_failed");
  } finally {
    request.signal.removeEventListener("abort", cancel);
    reader?.releaseLock();
  }
  if (declared !== null && Number(declared) !== size) return fail("invalid_content_length");
  const bytes = Buffer.concat(chunks);
  // A multipart body opens with its first delimiter and closes with the final delimiter.
  const opening = Buffer.from(`--${boundary}`);
  const closing = Buffer.from(`--${boundary}--`);
  const tail = bytes.subarray(Math.max(0, bytes.length - closing.length - 4)).toString("latin1").replace(/[\r\n\t ]+$/, "");
  if (!bytes.subarray(0, opening.length).equals(opening) || !tail.endsWith(closing.toString("latin1"))) return fail("invalid_multipart");
  // Parse the whole bounded envelope before any forward. A part with a malformed header or a broken inner structure
  // stops here. The parse only validates. The forwarded body is still the original bytes with the original boundary.
  const parsed = await new Response(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length), { headers: { "content-type": type.trim() } }).formData().then(() => true, () => false);
  if (!parsed) return fail("invalid_multipart");
  const headers = new Headers(request.headers);
  // The new body has a known length. The old framing headers must not reach the remote request.
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  return new Request(request.url, { method: request.method, headers, body: new Uint8Array(bytes), signal: request.signal });
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
  if (isResponse(input)) return input;
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
      if (core && response.status === 404 && response.headers.get("content-type")?.split(";")[0].trim() === "application/json") {
        const result = await jsonBody({ body: response.body, signal });
        if (!isResponse(result) && result.error === "unknown_provider") return fail("unknown_remote_provider", 404);
      } else {
        void response.body?.cancel().catch(() => undefined);
      }
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

export const GATEWAY_LIST_PATH = "/api/relay/gateways";

/**
 * The configured gateway names, for the gateway choice of global pages. It lists every link,
 * also a link with no visible agent or a gateway that is offline. It never returns a URL, a token,
 * or any other field of the store. A disabled relay is an explicit refusal, not an empty list.
 */
function gatewayList(request: Request, gateways: RemoteGateway[]): Response {
  if (request.method !== "GET") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET", "cache-control": "no-store" } });
  if (!isTrustedRequest(request.headers.get("origin"), request.headers.get("x-forwarded-for"))) return fail("untrusted_origin", 403);
  if (!isRelayEnabled()) return fail("relay_unavailable", 403);
  return Response.json({ gateways: gateways.map((gateway) => ({ name: gateway.name })) }, { headers: { "cache-control": "no-store" } });
}

/**
 * Only this table adds configuration routes to the relay. Object IDs stay unchanged.
 * A returned Request holds the rebuilt body for a local handler.
 */
export async function relayConfiguration(request: Request, gateways: RemoteGateway[], forward: ConfigurationForward): Promise<Response | Request | null> {
  const url = new URL(request.url);
  if (url.pathname === GATEWAY_LIST_PATH) return gatewayList(request, gateways);
  const prefix = /^\/api\/relay\/gateways\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const isStart = url.pathname === "/api/relay/oauth/start";
  const path = prefix ? prefix[2] ?? "" : url.pathname;
  const rule = rules.find((item) => item.path.test(path) && item.methods.includes(request.method)) ?? rules.find((item) => item.path.test(path));
  const authorize = /^\/api\/(?:oauth\/[^/]+|mcp\/oauth)\/authorize$/.test(path);
  if (!prefix && !isStart && !rule && !authorize) return null;
  // A request for the named gateway and the OAuth start need a safe path now. An unprefixed request stays local unless it
  // resolves to a remote agent below, and the same check then runs before any forward.
  const unsafePath = !isSafeRemotePath(url.pathname);
  if (unsafePath && (prefix || isStart || authorize)) return fail("invalid_remote_path");
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
    if (isResponse(input)) return input;
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
  if (unsafePath) return fail("invalid_remote_path");
  if (!trusted) return fail("untrusted_origin", 403);
  if (rule && !rule.methods.includes(request.method)) return fail("relay_route_not_allowed", 405);
  if (authorize) return fail("use_oauth_start", 405);
  if (agentKind && !agent) return fail("invalid_remote_agent");
  // A malformed or noncanonical wire ID stops here, before any body is read and before any upstream request.
  const wireId = /^\/api\/skill-ids\/([^/]+)/.exec(path)?.[1];
  if (wireId !== undefined && decodeSkillId(wireId) === undefined) return fail("invalid_skill_id");
  let remotePath = path;
  if (agentKind === "path") {
    const segments = path.split("/");
    segments[3] = encodeURIComponent(agent!);
    remotePath = segments.join("/");
  }
  if (agentKind === "query") url.searchParams.set("agent", agent!);
  if (agentKind === "body") request = withJson(request, { ...body, agentId: agent });
  if (rule?.json) {
    // Same strict start checks as the MCP add: a trusted Origin and a JSON body inside the 1 MiB bound.
    const denied = browserStartError(request);
    if (denied) return denied;
    const input = await jsonBody(request);
    if (isResponse(input)) return input;
    request = withJson(request, input);
  }
  if (rule?.multipart) {
    const denied = originError(request);
    if (denied) return denied;
    const upload = await skillUpload(request);
    if (isResponse(upload)) return upload;
    request = upload;
  }
  if (rule?.bodyless && (request.headers.has("transfer-encoding") || (request.headers.get("content-length") ?? "0") !== "0")) return fail("body_not_allowed");
  const mcpAdd = request.method === "POST" && path === "/api/mcp/servers";
  if (mcpAdd) {
    const denied = browserStartError(request);
    if (denied) return denied;
    const input = await jsonBody(request);
    if (isResponse(input)) return input;
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
  // A new import token is a secret of the account on the remote. It never lands in a cache.
  if (request.method === "POST" && path === "/api/skills/import-token") {
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
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
