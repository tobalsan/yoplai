import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  DASHBOARD_EMBED_ASSET_VERSION,
  DASHBOARD_EMBED_HEADERS,
  DASHBOARD_EMBED_POLICY_VERSION,
  DASHBOARD_EMBED_VERSION,
  DASHBOARD_ID_RE,
  DASHBOARD_TRANSPORT_QUERY_PREFIX,
  decodeDashboardEmbedMeta,
} from "../canvas/embed-contract.js";
import { parseThemeCookie } from "../canvas/routes.js";
import { allowedCorsOrigins } from "../server/origins.js";
import {
  createDashboardViewGrant,
  recordDashboardView,
  resolveDashboardViewGrant,
  type ResolvedDashboardViewGrant,
} from "./dashboard-view-grants.js";
import { fetchRemoteExact } from "./remote.js";
import { getLinkedGateways, isLoopbackForwardedFor, isRelayEnabled } from "./state.js";
import type { RemoteGateway } from "./store.js";

/**
 * Local viewer for remote dashboards. The browser never holds the linked
 * bearer. A short-lived grant in the path lets a sandboxed frame load one
 * gateway's dashboards, and the remote edit token authorizes every write.
 * See docs/relay-configuration.md for the full contract.
 */
export const DASHBOARD_VIEW_NAMESPACE = "/api/relay/dashboard-views";

export const dashboardViewLimits = {
  htmlBytes: 5 * 1024 * 1024,
  editBytes: 256 * 1024,
  queryBytes: 8 * 1024,
  createBytes: 1024,
  capabilitiesBytes: 64 * 1024,
  deadlineMs: 30_000,
  concurrencyPerGateway: 8,
};

/** Embed asset versions that the local `/d-assets` routes serve for an embed page. */
const SUPPORTED_ASSET_VERSIONS = new Set<string>([DASHBOARD_EMBED_ASSET_VERSION]);

type Route =
  | { kind: "create" }
  | { kind: "current"; grant: string }
  | { kind: "view"; grant: string; id: string }
  | { kind: "edit" | "add"; grant: string; id: string };

const G = "([A-Za-z0-9_-]{43})";
const I = "([A-Za-z0-9_-]{32})";
const ROUTES: Array<[RegExp, (match: RegExpExecArray) => Route]> = [
  [/^\/api\/relay\/dashboard-views$/, () => ({ kind: "create" })],
  [new RegExp(`^/api/relay/dashboard-views/${G}/current$`), (m) => ({ kind: "current", grant: m[1] })],
  [new RegExp(`^/api/relay/dashboard-views/${G}/${I}/$`), (m) => ({ kind: "view", grant: m[1], id: m[2] })],
  [new RegExp(`^/api/relay/dashboard-views/${G}/${I}/(edit|add)$`), (m) => ({ kind: m[3] as "edit" | "add", grant: m[1], id: m[2] })],
];
const METHODS: Record<Route["kind"], string> = { create: "POST", current: "GET", view: "GET", edit: "POST", add: "POST" };

function parseRoute(pathname: string): Route | undefined {
  for (const [pattern, build] of ROUTES) {
    const match = pattern.exec(pathname);
    if (match) return build(match);
  }
  return undefined;
}

/** Claims every spelling of the namespace, so a malformed path never reaches another relay handler. */
export function ownsDashboardViewPath(pathname: string): boolean {
  let value = pathname;
  for (let i = 0; i < 3; i++) {
    if (value.toLowerCase().startsWith(DASHBOARD_VIEW_NAMESPACE)) return true;
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return false;
}

const LOCAL_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function localJson(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...LOCAL_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'self'",
      ...headers,
    },
  });
}

type Fail = (status: number, error: string, extra?: Record<string, unknown>, headers?: Record<string, string>) => Response;

class BodyTooLargeError extends Error {}

/** Counts decoded bytes while it reads. Cancels the stream when the limit, the deadline, or a client abort stops the read. */
async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new BodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    try { reader.releaseLock(); } catch { /* A pending cancel can keep the lock. */ }
  }
  return Buffer.concat(chunks);
}

function discard(body: ReadableStream<Uint8Array> | null | undefined): void {
  void body?.cancel().catch(() => undefined);
}

function declaredLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  return value && /^\d+$/.test(value) ? Number(value) : undefined;
}

const mediaType = (headers: Headers) => headers.get("content-type")?.split(";")[0].trim().toLowerCase();

const active = new Map<string, number>();
function acquire(gateway: string): (() => void) | undefined {
  const count = active.get(gateway) ?? 0;
  if (count >= dashboardViewLimits.concurrencyPerGateway) return undefined;
  active.set(gateway, count + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (active.get(gateway) ?? 1) - 1;
    if (next <= 0) active.delete(gateway);
    else active.set(gateway, next);
  };
}

/**
 * Runs one remote exchange under a deadline that covers the headers and the
 * body, and under the abort signal of the caller. Both abort reasons end here.
 */
async function withDeadline(
  request: Request,
  gateway: RemoteGateway,
  fail: Fail,
  run: (signal: AbortSignal) => Promise<Response>
): Promise<Response> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), dashboardViewLimits.deadlineMs);
  const signal = AbortSignal.any([request.signal, deadline.signal]);
  try {
    return await run(signal);
  } catch (error) {
    // Nobody is waiting for an answer after a disconnect.
    if (request.signal.aborted) return new Response(null, { status: 499 });
    if (deadline.signal.aborted) return fail(504, "remote_timeout", { gateway: gateway.name }, { "Retry-After": "5" });
    if (error instanceof BodyTooLargeError) return fail(502, "remote_response_too_large");
    return fail(502, "gateway_offline", { gateway: gateway.name });
  } finally {
    clearTimeout(timer);
  }
}

function viewerCsp(origin: string, viewerPath: string): string {
  const assets = `${origin}/d-assets/`;
  return [
    "sandbox allow-scripts allow-downloads allow-modals",
    "default-src 'none'",
    `script-src 'unsafe-inline' ${assets}`,
    `style-src 'unsafe-inline' ${assets}`,
    "img-src data: blob:",
    `font-src data: ${assets}`,
    `connect-src ${origin}${viewerPath}/edit ${origin}${viewerPath}/add`,
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'none'",
  ].join("; ");
}

function forwardedQuery(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const [name, value] of params) {
    if (!name.startsWith(DASHBOARD_TRANSPORT_QUERY_PREFIX)) kept.append(name, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : "";
}

/** Names the first part of the embed contract that the remote does not meet. */
function incompatibility(headers: Headers): string | undefined {
  const version = headers.get(DASHBOARD_EMBED_HEADERS.version);
  if (version === null) return "missing_embed_marker";
  if (version !== String(DASHBOARD_EMBED_VERSION)) return "embed_version";
  if (!SUPPORTED_ASSET_VERSIONS.has(headers.get(DASHBOARD_EMBED_HEADERS.assets) ?? "")) return "asset_version";
  if (headers.get(DASHBOARD_EMBED_HEADERS.policy) !== String(DASHBOARD_EMBED_POLICY_VERSION)) return "policy_version";
  return undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

async function readJsonRecord(response: Response, limit: number, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  if (mediaType(response.headers) !== "application/json") {
    discard(response.body);
    return undefined;
  }
  const declared = declaredLength(response.headers);
  if (declared !== undefined && declared > limit) {
    discard(response.body);
    throw new BodyTooLargeError();
  }
  const bytes = await readBounded(response.body, limit, signal);
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A 404 without the embed marker comes from an old remote or from a proxy. The remote capabilities tell which. */
async function classifyUnmarkedNotFound(gateway: RemoteGateway, fail: Fail, signal: AbortSignal): Promise<Response> {
  const response = await fetchRemoteExact(gateway, "/api/capabilities", { method: "GET", headers: { accept: "application/json" }, signal, bearer: true });
  if (response.status === 401) { discard(response.body); return fail(401, "remote_unauthorized"); }
  if (response.status === 403) { discard(response.body); return fail(403, "forbidden"); }
  if (response.status !== 200) { discard(response.body); return fail(502, "invalid_remote_response"); }
  const capabilities = await readJsonRecord(response, dashboardViewLimits.capabilitiesBytes, signal);
  if (!capabilities) return fail(502, "invalid_remote_response");
  return isRecord(capabilities.dashboardEmbed)
    ? fail(404, "not_found")
    : fail(409, "remote_update_required", { reason: "missing_capability" });
}

async function viewDashboard(request: Request, url: URL, grant: string, id: string, resolved: ResolvedDashboardViewGrant): Promise<Response> {
  const { gateway } = resolved;
  const fail: Fail = (status, error, extra = {}, headers = {}) => {
    recordDashboardView(grant, id, { ok: false, error, status });
    return localJson(status, { error, ...extra }, headers);
  };
  const query = forwardedQuery(url.searchParams);
  if (Buffer.byteLength(query) > dashboardViewLimits.queryBytes) return fail(414, "query_too_large");
  const release = acquire(gateway.name);
  if (!release) return fail(429, "too_many_dashboard_view_requests", {}, { "Retry-After": "1" });
  try {
    return await withDeadline(request, gateway, fail, async (signal) => {
      const theme = parseThemeCookie(request.headers.get("cookie"));
      const response = await fetchRemoteExact(gateway, `/d/${id}/embed${query}`, {
        method: "GET",
        headers: { accept: "text/html", ...(theme ? { [DASHBOARD_EMBED_HEADERS.theme]: theme } : {}) },
        signal,
        bearer: true,
      });
      const marked = response.headers.has(DASHBOARD_EMBED_HEADERS.version);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "";
        discard(response.body);
        let login = false;
        try { login = new URL(location, gateway.url).pathname.replace(/\/+$/, "").endsWith("/login"); } catch { /* An unparsable location is not a login page. */ }
        return login ? fail(401, "remote_unauthorized") : fail(502, "invalid_remote_response");
      }
      if (response.status === 401) { discard(response.body); return fail(401, "remote_unauthorized"); }
      if (marked || response.status === 200) {
        const reason = incompatibility(response.headers);
        if (reason) { discard(response.body); return fail(409, "remote_update_required", { reason }); }
      }
      if (response.status === 403) {
        let ownerName: string | undefined;
        try {
          const body = await readJsonRecord(response, 4096, signal);
          if (typeof body?.ownerName === "string" && body.ownerName.length <= 200) ownerName = body.ownerName;
        } catch (error) {
          if (signal.aborted) throw error;
        }
        return fail(403, "forbidden", ownerName ? { ownerName } : {});
      }
      if (response.status === 404) {
        const reason = response.headers.get(DASHBOARD_EMBED_HEADERS.reason);
        discard(response.body);
        if (marked) return reason === "canvas_disabled" ? fail(404, "canvas_disabled") : fail(404, "not_found");
        return classifyUnmarkedNotFound(gateway, fail, signal);
      }
      if (response.status !== 200 || !mediaType(response.headers)?.startsWith("text/html")) {
        discard(response.body);
        return fail(502, "invalid_remote_response", { remoteStatus: response.status });
      }
      const meta = decodeDashboardEmbedMeta(response.headers.get(DASHBOARD_EMBED_HEADERS.meta));
      if (!meta || meta.dashboardId !== id) { discard(response.body); return fail(502, "invalid_remote_response"); }
      const declared = declaredLength(response.headers);
      if (declared !== undefined && declared > dashboardViewLimits.htmlBytes) {
        discard(response.body);
        return fail(502, "remote_response_too_large");
      }
      const html = new TextDecoder().decode(await readBounded(response.body, dashboardViewLimits.htmlBytes, signal));
      recordDashboardView(grant, id, { ok: true, meta });
      return new Response(html, {
        status: 200,
        headers: {
          ...LOCAL_HEADERS,
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": viewerCsp(resolved.origin, `${DASHBOARD_VIEW_NAMESPACE}/${grant}/${id}`),
        },
      });
    });
  } finally {
    release();
  }
}

const EditRequestSchema = z.object({ token: z.string().min(1).max(4096) }).passthrough();
const WRITE_STATUSES = new Set([200, 400, 401, 403, 404, 503]);

async function writeDashboard(request: Request, op: "edit" | "add", id: string, resolved: ResolvedDashboardViewGrant): Promise<Response> {
  const { gateway } = resolved;
  const fail: Fail = (status, error, extra = {}, headers = {}) => localJson(status, { error, ...extra }, headers);
  if (request.headers.get("origin") !== "null") return fail(403, "opaque_origin_required");
  if (mediaType(request.headers) !== "text/plain") return fail(415, "text_plain_required");
  const declared = declaredLength(request.headers);
  if (declared !== undefined && declared > dashboardViewLimits.editBytes) {
    discard(request.body);
    return fail(413, "request_too_large");
  }
  const release = acquire(gateway.name);
  if (!release) {
    discard(request.body);
    return fail(429, "too_many_dashboard_view_requests", {}, { "Retry-After": "1" });
  }
  try {
    return await withDeadline(request, gateway, fail, async (signal) => {
      let bytes: Buffer;
      try {
        bytes = await readBounded(request.body, dashboardViewLimits.editBytes, signal);
      } catch (error) {
        if (error instanceof BodyTooLargeError) return fail(413, "request_too_large");
        throw error;
      }
      let valid = false;
      try { valid = EditRequestSchema.safeParse(JSON.parse(bytes.toString("utf8"))).success; } catch { /* Invalid JSON is refused below. */ }
      if (!valid) return fail(400, "invalid_edit_request");
      const response = await fetchRemoteExact(gateway, `/d/${id}/${op}`, {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", accept: "application/json" },
        body: new Uint8Array(bytes),
        signal,
        bearer: false,
      });
      if (!WRITE_STATUSES.has(response.status)) {
        discard(response.body);
        return fail(502, "invalid_remote_response", { remoteStatus: response.status });
      }
      const result = await readJsonRecord(response, dashboardViewLimits.editBytes, signal);
      if (!result || typeof result.ok !== "boolean") return fail(502, "invalid_remote_response");
      return localJson(response.status, result);
    });
  } finally {
    release();
  }
}

const CreateViewSchema = z.object({ gateway: z.string(), dashboardId: z.string() }).strict();

async function createView(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || !allowedCorsOrigins().includes(origin)) return localJson(403, { error: "untrusted_origin" });
  if (request.headers.get("sec-fetch-site") !== "same-origin") return localJson(403, { error: "same_origin_required" });
  if (mediaType(request.headers) !== "application/json") return localJson(415, { error: "json_required" });
  let body: Buffer;
  try {
    body = await readBounded(request.body, dashboardViewLimits.createBytes, request.signal);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return localJson(413, { error: "request_too_large" });
    return new Response(null, { status: 499 });
  }
  let input: z.infer<typeof CreateViewSchema>;
  try {
    input = CreateViewSchema.parse(JSON.parse(body.toString("utf8")));
  } catch {
    return localJson(400, { error: "invalid_dashboard_view_request" });
  }
  const gateway = getLinkedGateways().find((item) => item.name === input.gateway);
  if (!gateway) return localJson(404, { error: "unknown_gateway" });
  if (!DASHBOARD_ID_RE.test(input.dashboardId)) return localJson(400, { error: "invalid_dashboard_id" });
  const created = createDashboardViewGrant(gateway, origin);
  if (!created) return localJson(429, { error: "too_many_dashboard_views" }, { "Retry-After": "60" });
  return localJson(201, {
    frameUrl: `${DASHBOARD_VIEW_NAMESPACE}/${created.grant}/${input.dashboardId}/`,
    expiresAt: new Date(created.expiresAt).toISOString(),
    gateway: gateway.name,
    dashboardId: input.dashboardId,
  });
}

function currentView(request: Request, resolved: ResolvedDashboardViewGrant): Response {
  const origin = request.headers.get("origin");
  if (request.headers.get("sec-fetch-site") !== "same-origin" || (origin !== null && origin !== resolved.origin)) {
    return localJson(403, { error: "same_origin_required" });
  }
  return localJson(200, { expiresAt: new Date(resolved.expiresAt).toISOString(), view: resolved.view ?? null });
}

async function dispatch(request: Request, url: URL, route: Route): Promise<Response> {
  if (request.method !== METHODS[route.kind]) return localJson(405, { error: "method_not_allowed" }, { Allow: METHODS[route.kind] });
  if (!isRelayEnabled() || !isLoopbackForwardedFor(request.headers.get("x-forwarded-for"))) return localJson(403, { error: "relay_unavailable" });
  if (route.kind === "create") return createView(request);
  const resolved = resolveDashboardViewGrant(route.grant);
  if (!resolved) return localJson(410, { error: "dashboard_view_expired" });
  if (route.kind === "current") return currentView(request, resolved);
  if (route.kind === "view") {
    const destination = request.headers.get("sec-fetch-dest");
    if (destination !== "iframe" && destination !== "document") return localJson(403, { error: "navigation_required" });
    return viewDashboard(request, url, route.grant, route.id, resolved);
  }
  return writeDashboard(request, route.kind, route.id, resolved);
}

/**
 * Claims the exact viewer namespace before the extension gate and the generic
 * relay. A malformed path in the namespace gets a local refusal, not a fallthrough.
 * The global CORS middleware skips this namespace, so only an accepted
 * opaque-origin write gets the one CORS answer that its page may read. That
 * answer carries no credentials.
 */
export function dashboardViewHttp(): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (!ownsDashboardViewPath(url.pathname)) return next();
    const request = c.req.raw;
    const route = parseRoute(url.pathname);
    if (!route) return localJson(404, { error: "invalid_dashboard_view_route" });
    const response = await dispatch(request, url, route);
    if ((route.kind === "edit" || route.kind === "add") && request.headers.get("origin") === "null") {
      response.headers.set("Access-Control-Allow-Origin", "null");
      response.headers.set("Vary", "Origin");
    }
    return response;
  };
}
