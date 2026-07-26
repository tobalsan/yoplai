import type { Context, MiddlewareHandler } from "hono";
import { getMultiUserRuntime } from "./index.js";
import { getImpersonation } from "./impersonation.js";

export const FORWARDED_AUTH_CONTEXT_HEADER = "x-yoplai-auth-context";
// Deprecated: accepted for requests forwarded by older code, never sent.
const LEGACY_FORWARDED_AUTH_CONTEXT_HEADER = "x-aihub-auth-context";

let warnedLegacyAuthContextHeader = false;

export type RequestAuthContext = {
  user: {
    id: string;
    email?: string;
    name?: string;
    image?: string | null;
    role?: string | string[] | null;
    approved?: boolean | null;
  };
  session: {
    id: string;
    userId: string;
    expiresAt?: string;
  };
  impersonator?: {
    id: string;
    email?: string;
  };
};

const REQUEST_AUTH_CONTEXT_KEY = "multiUserAuthContext";

function normalizeAuthContext(session: {
  user: Record<string, unknown>;
  session: Record<string, unknown>;
}): RequestAuthContext {
  return {
    user: {
      id: String(session.user.id),
      email:
        typeof session.user.email === "string" ? session.user.email : undefined,
      name:
        typeof session.user.name === "string" ? session.user.name : undefined,
      image:
        typeof session.user.image === "string" || session.user.image === null
          ? (session.user.image as string | null)
          : undefined,
      role:
        typeof session.user.role === "string" ||
        Array.isArray(session.user.role)
          ? (session.user.role as string | string[])
          : undefined,
      approved:
        typeof session.user.approved === "boolean"
          ? session.user.approved
          : session.user.approved === null
            ? null
            : undefined,
    },
    session: {
      id: String(session.session.id),
      userId: String(session.session.userId),
      expiresAt:
        session.session.expiresAt instanceof Date
          ? session.session.expiresAt.toISOString()
          : typeof session.session.expiresAt === "string"
            ? session.session.expiresAt
            : undefined,
    },
  };
}

const STAFF_ROLES = ["admin", "superadmin"];

/**
 * Staff bypass: both `admin` and `superadmin` are privileged staff and
 * bypass approval / agent-assignment checks.
 */
export function hasAdminRole(authContext: RequestAuthContext): boolean {
  const { role } = authContext.user;
  if (Array.isArray(role)) return role.some((r) => STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

export function hasSuperadminRole(authContext: RequestAuthContext): boolean {
  const { role } = authContext.user;
  if (Array.isArray(role)) return role.includes("superadmin");
  return role === "superadmin";
}

function isApproved(authContext: RequestAuthContext): boolean {
  return authContext.user.approved === true || hasAdminRole(authContext);
}

/**
 * When the cookie-cached session says `approved: false`, check the DB
 * directly so newly-approved users don't have to wait for the cache to
 * expire.  Approved users still benefit from the full cookie cache TTL.
 */
function refreshApprovalFromDb(authContext: RequestAuthContext): void {
  if (isApproved(authContext)) return;

  const runtime = getMultiUserRuntime();
  if (!runtime?.db) return;

  const row = runtime.db
    .prepare("SELECT approved, role FROM user WHERE id = ?")
    .get(authContext.user.id) as
    | { approved: number; role: string | null }
    | undefined;

  if (row?.approved) {
    authContext.user.approved = true;
    if (row.role) authContext.user.role = row.role;
  }
}

function applyActiveImpersonation(authContext: RequestAuthContext): RequestAuthContext {
  if (!hasAdminRole(authContext)) return authContext;
  if (authContext.session.id.startsWith("apikey:")) return authContext;

  const entry = getImpersonation(authContext.session.id);
  if (!entry) return authContext;

  const runtime = getMultiUserRuntime();
  if (!runtime?.db) return authContext;

  const target = runtime.db
    .prepare("SELECT id, email, name, image, approved FROM user WHERE id = ?")
    .get(entry.targetUserId) as
    | {
        id: string;
        email: string | null;
        name: string | null;
        image: string | null;
        approved: number | boolean | null;
      }
    | undefined;
  if (!target) return authContext;

  return {
    user: {
      id: target.id,
      email: target.email ?? undefined,
      name: target.name ?? undefined,
      image: target.image,
      role: "user",
      approved:
        typeof target.approved === "boolean"
          ? target.approved
          : target.approved === 1
            ? true
            : target.approved === 0
              ? false
              : null,
    },
    session: {
      ...authContext.session,
      userId: target.id,
    },
    impersonator: {
      id: authContext.user.id,
      email: authContext.user.email,
    },
  };
}

function encodeAuthContext(authContext: RequestAuthContext): string {
  return Buffer.from(JSON.stringify(authContext), "utf-8").toString(
    "base64url"
  );
}

function decodeAuthContext(value: string): RequestAuthContext | null {
  try {
    return JSON.parse(
      Buffer.from(value, "base64url").toString("utf-8")
    ) as RequestAuthContext;
  } catch {
    return null;
  }
}

export function getRequestAuthContext(c: Context): RequestAuthContext | null {
  const authContext = c.get(REQUEST_AUTH_CONTEXT_KEY);
  return (authContext as RequestAuthContext | null | undefined) ?? null;
}

export function getForwardedAuthContext(
  headers: Headers
): RequestAuthContext | null {
  const encoded = headers.get(FORWARDED_AUTH_CONTEXT_HEADER);
  if (encoded) return decodeAuthContext(encoded);

  const legacyEncoded = headers.get(LEGACY_FORWARDED_AUTH_CONTEXT_HEADER);
  if (!legacyEncoded) return null;
  if (!warnedLegacyAuthContextHeader) {
    warnedLegacyAuthContextHeader = true;
    console.warn(
      `[multi-user] ${LEGACY_FORWARDED_AUTH_CONTEXT_HEADER} is deprecated; forward ${FORWARDED_AUTH_CONTEXT_HEADER} instead.`
    );
  }
  return decodeAuthContext(legacyEncoded);
}

export function forwardAuthContextToRequest(
  request: Request,
  authContext: RequestAuthContext | null
): Request {
  if (authContext) {
    request.headers.set(
      FORWARDED_AUTH_CONTEXT_HEADER,
      encodeAuthContext(authContext)
    );
    request.headers.delete(LEGACY_FORWARDED_AUTH_CONTEXT_HEADER);
  } else {
    request.headers.delete(FORWARDED_AUTH_CONTEXT_HEADER);
    request.headers.delete(LEGACY_FORWARDED_AUTH_CONTEXT_HEADER);
  }
  return request;
}

function shouldSkipAuth(path: string): boolean {
  if (path === "/api/auth" || path.startsWith("/api/auth/")) return true;
  if (path === "/api/capabilities") return true;
  if (path === "/api/branding/logo") return true;
  if (path === "/api/theme.css") return true;
  return false;
}

export function getBearerToken(headers: Headers): string | null {
  const raw = headers.get("authorization") ?? headers.get("Authorization");
  if (!raw) return null;
  const match = /^\s*bearer\s+(.+?)\s*$/i.exec(raw);
  if (!match) return null;
  const token = match[1];
  return token.length > 0 ? token : null;
}

type BearerVerifyResult =
  | { kind: "context"; authContext: RequestAuthContext }
  | { kind: "invalid" }
  | { kind: "forbidden"; authContext: RequestAuthContext };

async function verifyBearer(
  token: string
): Promise<BearerVerifyResult | null> {
  const runtime = getMultiUserRuntime();
  if (!runtime) return null;

  let res: Awaited<ReturnType<typeof runtime.auth.api.verifyApiKey>>;
  try {
    res = await runtime.auth.api.verifyApiKey({ body: { key: token } });
  } catch {
    return { kind: "invalid" };
  }

  if (!res?.valid || !res.key) return { kind: "invalid" };

  const key = res.key as Record<string, unknown>;
  const ownerId =
    typeof key.referenceId === "string" && key.referenceId.length > 0
      ? key.referenceId
      : typeof key.userId === "string" && key.userId.length > 0
        ? (key.userId as string)
        : null;
  if (!ownerId) return { kind: "invalid" };

  if (!runtime.db) return { kind: "invalid" };
  const userRow = runtime.db
    .prepare(
      "SELECT id, email, name, image, role, approved FROM user WHERE id = ?"
    )
    .get(ownerId) as
    | {
        id: string;
        email: string | null;
        name: string | null;
        image: string | null;
        role: string | null;
        approved: number | boolean | null;
      }
    | undefined;
  if (!userRow) return { kind: "invalid" };

  const keyId =
    typeof key.id === "string" && key.id.length > 0 ? key.id : "unknown";

  const authContext = normalizeAuthContext({
    user: {
      id: userRow.id,
      email: userRow.email ?? undefined,
      name: userRow.name ?? undefined,
      image: userRow.image,
      role: userRow.role ?? undefined,
      approved:
        typeof userRow.approved === "boolean"
          ? userRow.approved
          : userRow.approved === 1
            ? true
            : userRow.approved === 0
              ? false
              : userRow.approved,
    },
    session: {
      id: `apikey:${keyId}`,
      userId: userRow.id,
      expiresAt: undefined,
    },
  });

  refreshApprovalFromDb(authContext);
  if (!isApproved(authContext)) {
    return { kind: "forbidden", authContext };
  }
  return { kind: "context", authContext };
}

async function getValidatedAuthContext(
  headers: Headers
): Promise<RequestAuthContext | null> {
  const runtime = getMultiUserRuntime();
  if (!runtime) return null;

  const bearer = getBearerToken(headers);
  if (bearer) {
    const result = await verifyBearer(bearer);
    if (!result) return null;
    if (result.kind === "context") return result.authContext;
    return null;
  }

  const session = await runtime.auth.api.getSession({ headers });
  if (!session) return null;

  const authContext = normalizeAuthContext(session);
  refreshApprovalFromDb(authContext);
  if (!isApproved(authContext)) return null;
  return authContext;
}

export const createAuthMiddleware = (): MiddlewareHandler => {
  return async (c, next) => {
    const runtime = getMultiUserRuntime();
    if (!runtime) {
      await next();
      return;
    }

    const bearer = getBearerToken(c.req.raw.headers);

    if (bearer) {
      const result = await verifyBearer(bearer);
      const skip = shouldSkipAuth(c.req.path);

      if (!result || result.kind === "invalid") {
        if (skip) {
          await next();
          return;
        }
        return c.json({ error: "unauthorized" }, 401);
      }

      if (result.kind === "forbidden") {
        if (skip) {
          await next();
          return;
        }
        return c.json({ error: "forbidden" }, 403);
      }

      c.set(REQUEST_AUTH_CONTEXT_KEY, result.authContext);
      await next();
      return;
    }

    const session = await runtime.auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (shouldSkipAuth(c.req.path)) {
      // Public path — attach session if present but never reject
      if (session) {
        const authContext = normalizeAuthContext(session);
        refreshApprovalFromDb(authContext);
        if (isApproved(authContext)) {
          c.set(REQUEST_AUTH_CONTEXT_KEY, applyActiveImpersonation(authContext));
        }
      }
      await next();
      return;
    }

    if (!session) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const authContext = normalizeAuthContext(session);
    refreshApprovalFromDb(authContext);
    if (!isApproved(authContext)) {
      return c.json({ error: "forbidden" }, 403);
    }

    c.set(REQUEST_AUTH_CONTEXT_KEY, applyActiveImpersonation(authContext));
    await next();
  };
};

export function hasActiveImpersonation(authContext: RequestAuthContext | null): boolean {
  return Boolean(authContext?.impersonator);
}

export const requireNotImpersonating = (): MiddlewareHandler => {
  return async (c, next) => {
    const authContext = getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (hasActiveImpersonation(authContext)) {
      return c.json({ error: "read_only_impersonation", code: "READ_ONLY_IMPERSONATION" }, 403);
    }
    await next();
  };
};

function resolveAuthContext(c: Context): RequestAuthContext | null {
  let authContext = getRequestAuthContext(c);
  if (!authContext) {
    // When running inside the api sub-app, the main app forwards the
    // auth context via header instead of Hono's context store.
    authContext = getForwardedAuthContext(c.req.raw.headers);
    if (authContext) {
      c.set(REQUEST_AUTH_CONTEXT_KEY, authContext);
    }
  }
  return authContext;
}

export const requireAdmin = (): MiddlewareHandler => {
  return async (c, next) => {
    if (!getMultiUserRuntime()) {
      await next();
      return;
    }

    const authContext = resolveAuthContext(c);
    if (!authContext) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!hasAdminRole(authContext)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
};

export const requireSuperadmin = (): MiddlewareHandler => {
  return async (c, next) => {
    if (!getMultiUserRuntime()) {
      await next();
      return;
    }

    const authContext = resolveAuthContext(c);
    if (!authContext) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!hasSuperadminRole(authContext)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  };
};

export async function hasAgentAccess(
  authContext: RequestAuthContext | null,
  agentId: string
): Promise<boolean> {
  if (!authContext) return true;
  if (hasAdminRole(authContext)) return true;

  const runtime = getMultiUserRuntime();
  if (!runtime) return true;

  // Chat access resolves from team membership, not the legacy allowlist: a
  // non-staff user may chat a fork iff they share a team with it.
  return runtime.access.canUserChatAgent(authContext.user.id, agentId);
}

export const requireAgentAccess = (agentIdParam = "id"): MiddlewareHandler => {
  return async (c, next) => {
    if (!getMultiUserRuntime()) {
      await next();
      return;
    }

    const authContext = getRequestAuthContext(c);
    if (!authContext) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const agentId = c.req.param(agentIdParam);
    if (!agentId) {
      return c.json({ error: "forbidden" }, 403);
    }
    if (!(await hasAgentAccess(authContext, agentId))) {
      return c.json({ error: "forbidden" }, 403);
    }

    await next();
  };
};

export async function validateWebSocketRequest(
  request: Request
): Promise<RequestAuthContext | null> {
  const authContext = await getValidatedAuthContext(request.headers);
  return authContext ? applyActiveImpersonation(authContext) : null;
}
