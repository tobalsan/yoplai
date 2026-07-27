import type { Hono } from "hono";
import { getMultiUserRuntime } from "./runtime-state.js";
import { registerMultiUserAdminRoutes } from "./admin-routes.js";
import {
  getForwardedAuthContext,
  getRequestAuthContext,
  hasAdminRole,
} from "./middleware.js";
import { endImpersonation, logImpersonationEvent } from "./impersonation.js";

function refreshApproval(
  user: Record<string, unknown>,
  db: import("better-sqlite3").Database
): void {
  if (user.approved === true) return;
  const row = db
    .prepare("SELECT approved, role FROM user WHERE id = ?")
    .get(String(user.id)) as
    | { approved: number; role: string | null }
    | undefined;
  if (row?.approved) {
    user.approved = true;
    if (row.role) user.role = row.role;
  }
}

function getRuntimeOrThrow() {
  const runtime = getMultiUserRuntime();
  if (!runtime) {
    throw new Error("multi-user runtime not initialized");
  }
  return runtime;
}

export function registerMultiUserRoutes(app: Hono): void {
  app.on(["GET", "POST"], "/auth/*", (c) => {
    const { auth } = getRuntimeOrThrow();
    const url = new URL(c.req.url);
    if (!url.pathname.startsWith("/api/")) {
      url.pathname = `/api${url.pathname}`;
    }
    return auth.handler(new Request(url, c.req.raw));
  });

  app.get("/me", async (c) => {
    const { auth, db, assignments } = getRuntimeOrThrow();

    // Prefer the auth context the parent app already validated (bearer or
    // cookie). Falls back to a direct getSession lookup so this route works
    // when called outside the createAuthMiddleware pipeline.
    const forwarded =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);

    let user: Record<string, unknown> | null = null;
    if (forwarded) {
      user = {
        id: forwarded.user.id,
        name: forwarded.user.name ?? null,
        email: forwarded.user.email ?? null,
        role: forwarded.user.role ?? null,
        approved: forwarded.user.approved ?? null,
      };
    } else {
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session) {
        user = session.user as Record<string, unknown>;
      }
    }

    if (!user) {
      return c.json({ user: null, session: null }, 401);
    }

    const userId = String(user.id);
    refreshApproval(user, db);
    return c.json({
      user: {
        id: userId,
        name: typeof user.name === "string" ? user.name : null,
        email: typeof user.email === "string" ? user.email : null,
        role:
          typeof user.role === "string" || Array.isArray(user.role)
            ? user.role
            : null,
        approved:
          typeof user.approved === "boolean"
            ? user.approved
            : user.approved === null
              ? null
              : null,
      },
      assignedAgentIds: assignments.getAssignmentsForUser(userId),
    });
  });

  // Per-user pool catalog action states. Every card stays visible (visibility
  // is global); this only resolves the single action each card should offer for
  // the current user: chat (fork exists + chattable/staff), assign_to_team
  // (staff, no fork yet), or none (visible-but-inert). Drives AgentCatalog.
  app.get("/pool-actions", (c) => {
    const { catalog, getPoolAgentIds } = getRuntimeOrThrow();
    const authContext =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);
    const actions = catalog.resolvePoolActions(getPoolAgentIds(), {
      id: authContext.user.id,
      isStaff: hasAdminRole(authContext),
    });
    return c.json({ actions });
  });

  app.get("/teams", (c) => {
    const { teams } = getRuntimeOrThrow();
    const authContext =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);
    // Team visibility is global: any authenticated user can list all teams.
    return c.json({ teams: teams.listTeams() });
  });

  app.get("/teams/:teamId/members", (c) => {
    const { teams, membership } = getRuntimeOrThrow();
    const authContext =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);
    // Membership visibility is global: any authenticated user can see which
    // users belong to a team, including member name/email.
    const teamId = c.req.param("teamId");
    if (!teams.getTeam(teamId)) {
      return c.json({ error: "Team not found" }, 404);
    }
    return c.json({
      teamId,
      members: membership.listMemberProfilesForTeam(teamId),
    });
  });

  app.get("/teams/:teamId/agents", (c) => {
    const { teams, forks } = getRuntimeOrThrow();
    const authContext =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);
    // Agent listing per team is global-readable, matching team/member reads.
    const teamId = c.req.param("teamId");
    if (!teams.getTeam(teamId)) {
      return c.json({ error: "Team not found" }, 404);
    }
    return c.json({ teamId, forks: forks.listForksForTeam(teamId) });
  });

  app.get("/impersonation/status", (c) => {
    const authContext =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (!authContext?.impersonator) {
      return c.json({ active: false });
    }
    return c.json({
      active: true,
      admin: authContext.impersonator,
      target: {
        id: authContext.user.id,
        name: authContext.user.name ?? null,
        email: authContext.user.email ?? null,
      },
    });
  });

  app.post("/admin/impersonate/end", (c) => {
    const authContext =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);
    const targetId = authContext.user.id;
    endImpersonation(authContext.session.id);
    if (authContext.impersonator) {
      logImpersonationEvent({
        action: "exit",
        adminId: authContext.impersonator.id,
        targetId,
      });
    }
    return c.body(null, 204);
  });

  app.delete("/user/token/:id", async (c) => {
    const runtime = getRuntimeOrThrow();
    const authContext =
      getRequestAuthContext(c) ?? getForwardedAuthContext(c.req.raw.headers);
    if (!authContext) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const tokenId = c.req.param("id");
    if (!tokenId) {
      return c.json({ error: "bad_request" }, 400);
    }

    const callerId = authContext.user.id;
    const isAdmin = hasAdminRole(authContext);

    // Look up the key to verify it exists and (for non-admins) check ownership.
    // The api-key plugin uses `apikey` as its table name with `referenceId` /
    // `userId` columns depending on plugin config. We probe both columns for
    // safety.
    let ownerId: string | null = null;
    try {
      const row = runtime.db
        .prepare("SELECT userId FROM apikey WHERE id = ?")
        .get(tokenId) as { userId?: string | null } | undefined;
      if (row && typeof row.userId === "string") {
        ownerId = row.userId;
      }
    } catch {
      // Column may not exist on this schema version — fall through.
    }
    if (ownerId === null) {
      try {
        const row = runtime.db
          .prepare("SELECT referenceId FROM apikey WHERE id = ?")
          .get(tokenId) as { referenceId?: string | null } | undefined;
        if (row && typeof row.referenceId === "string") {
          ownerId = row.referenceId;
        }
      } catch {
        // ignore
      }
    }

    if (ownerId === null) {
      return c.json({ error: "not_found" }, 404);
    }

    if (!isAdmin && ownerId !== callerId) {
      return c.json({ error: "forbidden" }, 403);
    }

    // Delete directly from the apikey table. We do this rather than calling
    // `auth.api.deleteApiKey` because the plugin's endpoint requires a
    // Better-Auth session (cookie); when the caller authenticated via bearer,
    // no session exists. We already validated ownership above so this is
    // safe — and the wrapper exists precisely to add the audit-log line that
    // the plugin's endpoint does not emit.
    try {
      const result = runtime.db
        .prepare("DELETE FROM apikey WHERE id = ?")
        .run(tokenId);
      if (result.changes === 0) {
        return c.json({ error: "not_found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.logger.warn({
        event: "user_token.revoke_failed",
        userId: ownerId,
        tokenId,
        actor: callerId,
        error: message,
      });
      return c.json({ error: "delete_failed" }, 500);
    }

    runtime.logger.info({
      event: "user_token.revoked",
      userId: ownerId,
      tokenId,
      actor: callerId,
    });

    return c.json({ ok: true });
  });

  registerMultiUserAdminRoutes(app);
}
