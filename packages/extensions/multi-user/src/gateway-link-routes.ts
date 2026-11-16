import { isIP } from "node:net";
import type { Context, Hono } from "hono";
import type { ZodType } from "zod";
import {
  GatewayLinkConsentActionSchema,
  GatewayLinkRequestInputSchema,
  GatewayLinkRevokeInputSchema,
  GatewayLinkTokenInputSchema,
} from "@yoplai/shared";
import { hasDuplicateTopLevelKey, isReservedPrefix } from "./gateway-link-codec.js";
import type { GatewayLinkResult, GatewayLinkService } from "./gateway-link.js";
import { getImpersonation } from "./impersonation.js";
import { getBearerToken, getRequestAuthContext, isVerifiedBearerRequest } from "./middleware.js";
import { getMultiUserRuntime } from "./runtime-state.js";

const BODY_LIMIT_BYTES = 4096;
/** Peers whose `X-Forwarded-For` the rate limits read. The proxy of a deployment runs on the same host. */
const TRUSTED_PROXY_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

type Bindings = { peerAddress?: string; incoming?: { socket?: { remoteAddress?: string } } } | undefined;

function reply(c: Context, status: number, body: unknown): Response {
  c.header("Cache-Control", "no-store");
  return c.json(body as never, status as never);
}

function failure(c: Context, status: number, error: string): Response {
  return reply(c, status, { error });
}

function unwrap<T>(c: Context, result: GatewayLinkResult<T>, success = 200): Response {
  return result.ok ? reply(c, success, result.value) : failure(c, result.status, result.error);
}

/** The key for the rate limits: the socket peer, or the last `X-Forwarded-For` entry when a trusted proxy sent the request. */
function sourceOf(c: Context): string {
  const env = c.env as Bindings;
  const peer = env?.peerAddress ?? env?.incoming?.socket?.remoteAddress ?? "unknown";
  if (!TRUSTED_PROXY_ADDRESSES.has(peer)) return peer;
  const entries = (c.req.header("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim());
  const last = entries[entries.length - 1];
  return last && isIP(last) ? last : peer;
}

async function readBoundedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

/** A JSON body with a size limit, one value for each key, and a strict schema. */
async function readJson<T>(c: Context, schema: ZodType<T>): Promise<Parsed<T>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) return { ok: false, response: failure(c, 415, "json_required") };
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > BODY_LIMIT_BYTES) return { ok: false, response: failure(c, 413, "body_too_large") };
  const text = await readBoundedText(c.req.raw, BODY_LIMIT_BYTES);
  if (text === null) return { ok: false, response: failure(c, 413, "body_too_large") };
  if (hasDuplicateTopLevelKey(text)) return { ok: false, response: failure(c, 400, "invalid_body") };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: failure(c, 400, "invalid_body") };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, response: failure(c, 400, "invalid_body") };
}

/** A route that reads or writes as a native client takes no `Origin`. A browser always sends one on a cross-site request. */
function rejectOrigin(c: Context): Response | null {
  return c.req.header("origin") === undefined ? null : failure(c, 403, "origin_not_allowed");
}

function isAllowedOrigin(c: Context, service: GatewayLinkService): boolean {
  const origin = c.req.header("origin");
  return origin !== undefined && service.getAllowedOrigins().includes(origin);
}

/** A read from the web page may carry an `Origin`, but only the configured web origin. */
function checkReadOrigin(c: Context, service: GatewayLinkService): Response | null {
  return c.req.header("origin") === undefined || isAllowedOrigin(c, service) ? null : failure(c, 403, "origin_not_allowed");
}

/** A write from the web page needs the exact configured web origin. An absent or `null` Origin fails. */
function checkWriteOrigin(c: Context, service: GatewayLinkService): Response | null {
  return isAllowedOrigin(c, service) ? null : failure(c, 403, "origin_not_allowed");
}

type CookieSession = { userId: string; sessionId: string };

/**
 * The signed-in browser session, read from the cookie only. A bearer, a forwarded context, and an impersonation never
 * count. This handler runs after the outer gate has skipped `/api/auth/*`, so it checks the session itself.
 */
async function readCookieSession(c: Context): Promise<{ ok: true; session: CookieSession } | { ok: false; response: Response }> {
  const runtime = getMultiUserRuntime();
  if (!runtime) return { ok: false, response: failure(c, 503, "unavailable") };
  if (getBearerToken(c.req.raw.headers)) return { ok: false, response: failure(c, 401, "cookie_session_required") };
  const session = await runtime.auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return { ok: false, response: failure(c, 401, "login_required") };
  const sessionId = String(session.session.id);
  if ((session.session as { impersonatedBy?: unknown }).impersonatedBy || getImpersonation(sessionId)) {
    return { ok: false, response: failure(c, 403, "impersonation_not_allowed") };
  }
  return { ok: true, session: { userId: String(session.user.id), sessionId } };
}

function readyService(c: Context): { service: GatewayLinkService } | { response: Response } {
  const service = getMultiUserRuntime()?.gatewayLinks;
  if (!service?.isReady()) return { response: failure(c, 503, "unavailable") };
  return { service };
}

const BASE = "/auth/gateway-link";

export function registerGatewayLinkRoutes(app: Hono): void {
  // Generic key routes of the key plugin must not create or change a managed key. They run before the auth wildcard.
  app.use("/auth/api-key/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const action = c.req.path.replace(/\/+$/, "").split("/").pop()?.toLowerCase();
    if (action !== "create" && action !== "update") return next();
    let body: unknown;
    try {
      body = await c.req.raw.clone().json();
    } catch {
      return next();
    }
    const fields = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (action === "create" && isReservedPrefix(fields.prefix)) return failure(c, 403, "reserved_prefix");
    if (action === "update" && typeof fields.keyId === "string") {
      const service = getMultiUserRuntime()?.gatewayLinks;
      if (service ? service.isManagedKeyId(fields.keyId) : false) return failure(c, 403, "managed_key");
    }
    return next();
  });

  // The local gateway starts a request. A native request has no Origin, and a browser origin is always refused.
  app.post(`${BASE}/requests`, async (c) => {
    const ready = readyService(c);
    if ("response" in ready) return ready.response;
    const blocked = rejectOrigin(c);
    if (blocked) return blocked;
    const body = await readJson(c, GatewayLinkRequestInputSchema);
    if (!body.ok) return body.response;
    return unwrap(c, ready.service.createRequest(body.value, sourceOf(c)), 201);
  });

  // The consent page reads the safe details of a request. The answer holds no state, code, verifier, or callback URL.
  app.get(`${BASE}/requests/:id`, async (c) => {
    const ready = readyService(c);
    if ("response" in ready) return ready.response;
    const blocked = checkReadOrigin(c, ready.service);
    if (blocked) return blocked;
    const session = await readCookieSession(c);
    if (!session.ok) return session.response;
    return unwrap(c, ready.service.describeRequest(c.req.param("id"), session.session));
  });

  for (const action of ["approve", "deny"] as const) {
    app.post(`${BASE}/${action}`, async (c) => {
      const ready = readyService(c);
      if ("response" in ready) return ready.response;
      const blocked = checkWriteOrigin(c, ready.service);
      if (blocked) return blocked;
      const session = await readCookieSession(c);
      if (!session.ok) return session.response;
      const body = await readJson(c, GatewayLinkConsentActionSchema);
      if (!body.ok) return body.response;
      const result =
        action === "approve"
          ? ready.service.approve(body.value.requestId, body.value.nonce, session.session)
          : ready.service.deny(body.value.requestId, body.value.nonce, session.session);
      return unwrap(c, result);
    });
  }

  // The local gateway exchanges the code. Native only, with the verifier and the exact callback URI.
  app.post(`${BASE}/token`, async (c) => {
    const ready = readyService(c);
    if ("response" in ready) return ready.response;
    const blocked = rejectOrigin(c);
    if (blocked) return blocked;
    const body = await readJson(c, GatewayLinkTokenInputSchema);
    if (!body.ok) return body.response;
    return unwrap(c, await ready.service.exchange(body.value, sourceOf(c)));
  });

  app.get(`${BASE}/links`, async (c) => {
    const ready = readyService(c);
    if ("response" in ready) return ready.response;
    const blocked = checkReadOrigin(c, ready.service);
    if (blocked) return blocked;
    const session = await readCookieSession(c);
    if (!session.ok) return session.response;
    return reply(c, 200, { links: ready.service.listLinks(session.session.userId) });
  });

  // An owner revokes with a cookie session. A link revokes itself with its own verified key and nothing else.
  app.post(`${BASE}/revoke`, async (c) => {
    const ready = readyService(c);
    if ("response" in ready) return ready.response;
    const body = await readJson(c, GatewayLinkRevokeInputSchema);
    if (!body.ok) return body.response;
    if (getBearerToken(c.req.raw.headers)) {
      if (c.req.header("origin") !== undefined || c.req.header("cookie") !== undefined) return failure(c, 403, "bearer_only");
      const context = isVerifiedBearerRequest(c) ? getRequestAuthContext(c) : null;
      const keyId = context?.session.id.startsWith("apikey:") ? context.session.id.slice("apikey:".length) : null;
      if (!keyId) return failure(c, 401, "unauthorized");
      const result = ready.service.revokeByKey(keyId, body.value.linkId);
      return unwrap(c, result);
    }
    const blocked = checkWriteOrigin(c, ready.service);
    if (blocked) return blocked;
    const session = await readCookieSession(c);
    if (!session.ok) return session.response;
    if (!body.value.linkId) return failure(c, 400, "invalid_body");
    return unwrap(c, ready.service.revokeOwnedLink(session.session.userId, body.value.linkId));
  });
}
