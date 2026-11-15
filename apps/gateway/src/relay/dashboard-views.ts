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
  type DashboardEmbedMeta,
} from "../canvas/embed-contract.js";
import { allowedCorsOrigins } from "../server/origins.js";
import { DASHBOARD_VIEW_NAMESPACE, ownsDashboardViewPath } from "./dashboard-view-paths.js";
import { shellCsp, shellHtml } from "./dashboard-view-shell.js";
import {
  claimDashboardViewBytes,
  claimDashboardViewShell,
  hasDashboardViewRoom,
  resolveDashboardViewSnapshot,
  storeDashboardViewSnapshot,
  type ResolvedSnapshot,
} from "./dashboard-view-snapshots.js";
import { fetchRemoteExact } from "./remote.js";
import { getLinkedGateways, isLoopbackForwardedFor, isRelayEnabled } from "./state.js";
import type { RemoteGateway } from "./store.js";

/**
 * Local viewer for remote dashboards. The browser never holds the linked
 * bearer. The trusted UI prepares one snapshot of one dashboard: a single
 * checked remote read whose bytes and metadata never change. A trusted shell
 * delivers the bytes once to one sandboxed frame, and the remote edit token
 * authorizes every write. See docs/relay-configuration.md for the full contract.
 */
export { DASHBOARD_VIEW_NAMESPACE, ownsDashboardViewPath };

export const dashboardViewLimits = {
  htmlBytes: 5 * 1024 * 1024,
  editBytes: 256 * 1024,
  queryBytes: 8 * 1024,
  /** The prepare body holds the gateway, the dashboard ID, and a query of up to `queryBytes`. */
  createBytes: 12 * 1024,
  /** Time to read the small body of a prepare or read request. */
  createDeadlineMs: 5_000,
  /** Prepare and read requests that can wait for a body at the same time. This is not the stored snapshot cap. */
  createPending: 16,
  capabilitiesBytes: 64 * 1024,
  deadlineMs: 30_000,
  concurrencyPerGateway: 8,
};

/** Embed asset versions that the local `/d-assets` routes serve for an embed page. */
const SUPPORTED_ASSET_VERSIONS = new Set<string>([DASHBOARD_EMBED_ASSET_VERSION]);

type Route =
  | { kind: "prepare" }
  | { kind: "read" }
  | { kind: "shell" | "frame" | "edit" | "add"; handle: string };

const H = "([A-Za-z0-9_-]{43})";
const ROUTES: Array<[RegExp, (match: RegExpExecArray) => Route]> = [
  [/^\/api\/relay\/dashboard-views$/, () => ({ kind: "prepare" })],
  [/^\/api\/relay\/dashboard-views\/read$/, () => ({ kind: "read" })],
  [new RegExp(`^/api/relay/dashboard-views/${H}/(shell|frame|edit|add)$`), (m) => ({ kind: m[2] as "shell" | "frame" | "edit" | "add", handle: m[1] })],
];
const METHODS: Record<Route["kind"], string> = { prepare: "POST", read: "POST", shell: "GET", frame: "GET", edit: "POST", add: "POST" };

function parseRoute(pathname: string): Route | undefined {
  for (const [pattern, build] of ROUTES) {
    const match = pattern.exec(pathname);
    if (match) return build(match);
  }
  return undefined;
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
async function withDeadline<T>(
  request: Request,
  gateway: RemoteGateway,
  fail: Fail,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T | Response> {
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

/** The versions that a remote reports, as the text of a header or of a capability field. */
type EmbedVersions = { version: string | null; assets: string | null; policy: string | null };

/** Names the first part of the embed contract that the remote does not meet. */
function incompatibility({ version, assets, policy }: EmbedVersions): string | undefined {
  if (version === null) return "missing_embed_marker";
  if (version !== String(DASHBOARD_EMBED_VERSION)) return "embed_version";
  if (!SUPPORTED_ASSET_VERSIONS.has(assets ?? "")) return "asset_version";
  if (policy !== String(DASHBOARD_EMBED_POLICY_VERSION)) return "policy_version";
  return undefined;
}

const headerVersions = (headers: Headers): EmbedVersions => ({
  version: headers.get(DASHBOARD_EMBED_HEADERS.version),
  assets: headers.get(DASHBOARD_EMBED_HEADERS.assets),
  policy: headers.get(DASHBOARD_EMBED_HEADERS.policy),
});

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

/** The `dashboardEmbed` field of `GET /api/capabilities`. A newer remote can add fields. */
const EmbedCapabilitySchema = z.object({ version: z.number(), assetVersion: z.string(), policyVersion: z.number(), enabled: z.boolean() });

/**
 * A 404 without the embed marker comes from an old remote or from a proxy. The
 * remote capabilities tell which: no capability (old remote), a malformed
 * capability, an unsupported version, a disabled Canvas, or a missing dashboard.
 */
async function classifyUnmarkedNotFound(gateway: RemoteGateway, fail: Fail, signal: AbortSignal): Promise<Response> {
  const response = await fetchRemoteExact(gateway, "/api/capabilities", { method: "GET", headers: { accept: "application/json" }, signal, bearer: true });
  if (response.status === 401) { discard(response.body); return fail(401, "remote_unauthorized"); }
  if (response.status === 403) { discard(response.body); return fail(403, "forbidden"); }
  if (response.status !== 200) { discard(response.body); return fail(502, "invalid_remote_response"); }
  const capabilities = await readJsonRecord(response, dashboardViewLimits.capabilitiesBytes, signal);
  if (!capabilities) return fail(502, "invalid_remote_response");
  if (capabilities.dashboardEmbed === undefined) return fail(409, "remote_update_required", { reason: "missing_capability" });
  const embed = EmbedCapabilitySchema.safeParse(capabilities.dashboardEmbed);
  if (!embed.success) return fail(502, "invalid_remote_response");
  const { version, assetVersion, policyVersion, enabled } = embed.data;
  const reason = incompatibility({ version: String(version), assets: assetVersion, policy: String(policyVersion) });
  if (reason) return fail(409, "remote_update_required", { reason });
  return enabled ? fail(404, "not_found") : fail(404, "canvas_disabled");
}

type CheckedRemotePage = { meta: DashboardEmbedMeta; bytes: Buffer };

/**
 * One bounded remote read of `GET /d/:id/embed`. It returns the checked
 * metadata and the counted bytes, or the typed local error for the result.
 */
async function readRemoteDashboard(
  gateway: RemoteGateway,
  id: string,
  query: string,
  theme: "light" | "dark" | null,
  fail: Fail,
  signal: AbortSignal
): Promise<CheckedRemotePage | Response> {
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
  // A forbidden answer comes before the version check, like an unauthorized one. It is never an update prompt.
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
  if (marked || response.status === 200) {
    const reason = incompatibility(headerVersions(response.headers));
    if (reason) { discard(response.body); return fail(409, "remote_update_required", { reason }); }
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
  // Keep the counted bytes as they are. A text decode would replace each invalid byte with three bytes.
  return { meta, bytes: await readBounded(response.body, dashboardViewLimits.htmlBytes, signal) };
}

const EditRequestSchema = z.object({ token: z.string().min(1).max(4096) }).passthrough();
const WRITE_STATUSES = new Set([200, 400, 401, 403, 404, 503]);

/** The write route holds no dashboard ID. The snapshot names the one dashboard that its frame shows. */
async function writeDashboard(request: Request, op: "edit" | "add", resolved: ResolvedSnapshot): Promise<Response> {
  const { gateway, dashboardId: id } = resolved;
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

const PrepareSchema = z.object({
  gateway: z.string(),
  dashboardId: z.string(),
  query: z.string().optional(),
  theme: z.enum(["light", "dark"]).optional(),
}).strict();
const ReadSchema = z.object({ handle: z.string() }).strict();

let pendingBodies = 0;

/** Reads the small JSON body of a prepare or read request under a size limit, a deadline, and a cap on parallel reads. */
async function readSmallBody(request: Request): Promise<Buffer | Response> {
  const declared = declaredLength(request.headers);
  if (declared !== undefined && declared > dashboardViewLimits.createBytes) {
    discard(request.body);
    return localJson(413, { error: "request_too_large" });
  }
  if (pendingBodies >= dashboardViewLimits.createPending) {
    discard(request.body);
    return localJson(429, { error: "too_many_dashboard_view_requests" }, { "Retry-After": "1" });
  }
  pendingBodies += 1;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), dashboardViewLimits.createDeadlineMs);
  try {
    return await readBounded(request.body, dashboardViewLimits.createBytes, AbortSignal.any([request.signal, deadline.signal]));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return localJson(413, { error: "request_too_large" });
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return localJson(408, { error: "request_timeout" });
  } finally {
    clearTimeout(timer);
    pendingBodies -= 1;
  }
}

/** The checks that every strict same-origin JSON request from the trusted UI must pass. Returns the issuer origin or the refusal. */
function trustedUiRequest(request: Request): string | Response {
  const origin = request.headers.get("origin");
  if (!origin || !allowedCorsOrigins().includes(origin)) return localJson(403, { error: "untrusted_origin" });
  if (request.headers.get("sec-fetch-site") !== "same-origin") return localJson(403, { error: "same_origin_required" });
  if (mediaType(request.headers) !== "application/json") return localJson(415, { error: "json_required" });
  return origin;
}

const expired = () => localJson(410, { state: "expired", error: "dashboard_view_expired", status: 410 });

/**
 * Makes one snapshot: one checked remote read, stored as bytes plus metadata.
 * A remote failure is a typed error of this request, and no snapshot exists.
 */
async function prepareView(request: Request): Promise<Response> {
  const origin = trustedUiRequest(request);
  if (typeof origin !== "string") return origin;
  const body = await readSmallBody(request);
  if (!Buffer.isBuffer(body)) return body;
  let input: z.infer<typeof PrepareSchema>;
  try {
    input = PrepareSchema.parse(JSON.parse(body.toString("utf8")));
  } catch {
    return localJson(400, { error: "invalid_dashboard_view_request" });
  }
  const gateway = getLinkedGateways().find((item) => item.name === input.gateway);
  if (!gateway) return localJson(404, { error: "unknown_gateway" });
  if (!DASHBOARD_ID_RE.test(input.dashboardId)) return localJson(400, { error: "invalid_dashboard_id" });
  const fail: Fail = (status, error, extra = {}, headers = {}) => localJson(status, { error, ...extra }, headers);
  const query = forwardedQuery(new URLSearchParams(input.query ?? ""));
  if (Buffer.byteLength(query) > dashboardViewLimits.queryBytes) return fail(414, "query_too_large");
  if (!hasDashboardViewRoom()) return fail(429, "too_many_dashboard_views", {}, { "Retry-After": "60" });
  const release = acquire(gateway.name);
  if (!release) return fail(429, "too_many_dashboard_view_requests", {}, { "Retry-After": "1" });
  const theme = input.theme ?? null;
  let page: CheckedRemotePage | Response;
  try {
    page = await withDeadline(request, gateway, fail, (signal) => readRemoteDashboard(gateway, input.dashboardId, query, theme, fail, signal));
  } finally {
    release();
  }
  if (!("meta" in page)) return page;
  const stored = storeDashboardViewSnapshot(gateway, origin, { dashboardId: input.dashboardId, query, theme, meta: page.meta, bytes: page.bytes });
  if (stored === "count") return fail(429, "too_many_dashboard_views", {}, { "Retry-After": "60" });
  if (stored === "bytes") return fail(429, "dashboard_view_storage_full", {}, { "Retry-After": "60" });
  return localJson(201, {
    handle: stored.handle,
    instance: stored.instance,
    shellUrl: `${DASHBOARD_VIEW_NAMESPACE}/${stored.handle}/shell`,
    expiresAt: new Date(stored.expiresAt).toISOString(),
    gateway: gateway.name,
    dashboardId: input.dashboardId,
  });
}

/**
 * Gives the trusted host the checked metadata of one snapshot. The handle is
 * in the JSON body, never in a URL. Only the issuer origin can read it.
 */
async function readView(request: Request): Promise<Response> {
  const origin = trustedUiRequest(request);
  if (typeof origin !== "string") return origin;
  const body = await readSmallBody(request);
  if (!Buffer.isBuffer(body)) return body;
  let handle: string;
  try {
    handle = ReadSchema.parse(JSON.parse(body.toString("utf8"))).handle;
  } catch {
    return localJson(400, { error: "invalid_dashboard_view_request" });
  }
  const resolved = /^[A-Za-z0-9_-]{43}$/.test(handle) ? resolveDashboardViewSnapshot(handle) : undefined;
  if (!resolved) return expired();
  if (resolved.origin !== origin) return localJson(403, { error: "untrusted_origin" });
  return localJson(200, {
    expiresAt: new Date(resolved.expiresAt).toISOString(),
    state: resolved.state,
    gateway: resolved.gateway.name,
    dashboardId: resolved.dashboardId,
    meta: resolved.meta,
  });
}

/** The trusted shell loads once, as a frame of the trusted UI page. */
function deliverShell(request: Request, handle: string, resolved: ResolvedSnapshot): Response {
  if (request.headers.get("sec-fetch-dest") !== "iframe") return localJson(403, { error: "navigation_required" });
  if (request.headers.get("sec-fetch-site") !== "same-origin") return localJson(403, { error: "same_origin_required" });
  if (!claimDashboardViewShell(handle)) return localJson(409, { error: "dashboard_view_shell_delivered" });
  const framePath = `${DASHBOARD_VIEW_NAMESPACE}/${handle}/frame`;
  return new Response(shellHtml(framePath, resolved.instance), {
    status: 200,
    headers: {
      ...LOCAL_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": shellCsp(resolved.origin, framePath),
    },
  });
}

/**
 * Delivers the stored bytes to one frame, once. A top-level request, a second
 * frame, and a later request get a refusal and never another document.
 */
function deliverFrame(request: Request, handle: string, resolved: ResolvedSnapshot): Response {
  if (request.headers.get("sec-fetch-dest") !== "iframe") return localJson(403, { error: "navigation_required" });
  const bytes = claimDashboardViewBytes(handle);
  if (!bytes) return localJson(409, { error: "dashboard_view_delivered" });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...LOCAL_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": viewerCsp(resolved.origin, `${DASHBOARD_VIEW_NAMESPACE}/${handle}`),
    },
  });
}

async function dispatch(request: Request, route: Route): Promise<Response> {
  if (request.method !== METHODS[route.kind]) return localJson(405, { error: "method_not_allowed" }, { Allow: METHODS[route.kind] });
  if (!isRelayEnabled() || !isLoopbackForwardedFor(request.headers.get("x-forwarded-for"))) return localJson(403, { error: "relay_unavailable" });
  if (route.kind === "prepare") return prepareView(request);
  if (route.kind === "read") return readView(request);
  const resolved = resolveDashboardViewSnapshot(route.handle);
  if (!resolved) return expired();
  if (route.kind === "shell") return deliverShell(request, route.handle, resolved);
  if (route.kind === "frame") return deliverFrame(request, route.handle, resolved);
  if (resolved.state !== "delivered") return localJson(409, { error: "dashboard_view_not_delivered" });
  return writeDashboard(request, route.kind, resolved);
}

/**
 * Claims the exact viewer namespace before the extension gate and the generic
 * relay. Mount it on every path (`*`): it calls `next()` for each path that
 * the ownership test does not claim, so every spelling of the namespace gets
 * the local refusal and no other request changes. A malformed path in the namespace gets a local refusal, not a fallthrough.
 * A query string is an identity variation, so it gets the same refusal.
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
    if (!route || request.url.includes("?")) return localJson(404, { error: "invalid_dashboard_view_route" });
    const response = await dispatch(request, route);
    if ((route.kind === "edit" || route.kind === "add") && request.headers.get("origin") === "null") {
      response.headers.set("Access-Control-Allow-Origin", "null");
      response.headers.set("Vary", "Origin");
    }
    return response;
  };
}
