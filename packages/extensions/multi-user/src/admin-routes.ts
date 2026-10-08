import type { SettingsAuditEntry } from "@yoplai/shared";
import type { Context, Hono } from "hono";
import { z } from "zod";
import {
  getRequestAuthContext,
  hasSuperadminRole,
  requireAdmin,
  requireSuperadmin,
} from "./middleware.js";
import { getMultiUserRuntime } from "./runtime-state.js";
import { logImpersonationEvent, startImpersonation } from "./impersonation.js";
import { isDuplicateTeamNameError, isTeamNotFoundError } from "./teams.js";
import { isForkNotFoundError, isPoolAgentNotFoundError } from "./forks.js";
import { isAllUsersTeamError } from "./membership.js";

const UpdateAdminUserBodySchema = z
  .object({
    approved: z.boolean().optional(),
    role: z.enum(["superadmin", "admin", "user"]).optional(),
  })
  .refine((data) => data.approved !== undefined || data.role !== undefined, {
    message: "approved or role is required",
  });

const SetAgentAssignmentsBodySchema = z.object({
  userIds: z.array(z.string()),
});

const SetTeamMembersBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("list"), userIds: z.array(z.string().min(1)) }),
]);

const SetForkTeamsBodySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }),
  z.object({ mode: z.literal("list"), teamIds: z.array(z.string().min(1)) }),
]);

const StartImpersonationBodySchema = z.object({
  targetUserId: z.string().min(1),
});

const optionalNullableString = z.string().trim().nullable().optional();

const CreateTeamBodySchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  description: optionalNullableString,
  color: optionalNullableString,
  icon: optionalNullableString,
  private: z.boolean().optional(),
});

const UpdateTeamBodySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: optionalNullableString,
    color: optionalNullableString,
    icon: optionalNullableString,
    private: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.name !== undefined ||
      data.description !== undefined ||
      data.color !== undefined ||
      data.icon !== undefined ||
      data.private !== undefined,
    { message: "at least one field is required" }
  );

function getRuntimeOrThrow() {
  const runtime = getMultiUserRuntime();
  if (!runtime) {
    throw new Error("multi-user runtime not initialized");
  }
  return runtime;
}

function recordAdminChange(
  c: Context,
  target: Pick<SettingsAuditEntry, "action" | "targetType" | "targetId" | "agentId">,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): void {
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
  if (!changes.length) return;
  const auth = getRequestAuthContext(c);
  getRuntimeOrThrow().audit?.record({
    ...target,
    actorUserId: auth?.user.id,
    actorEmail: auth?.user.email,
    impersonatorUserId: auth?.impersonator?.id,
    scope: target.targetType === "user" ? undefined : "team",
    changes,
  });
}

/**
 * Admins are scoped to the teams they belong to; superadmins manage every
 * team. Returns false when the caller may not manage `teamId`.
 */
function canManageTeam(c: Context, teamId: string): boolean {
  const authContext = getRequestAuthContext(c);
  if (!authContext) return false;
  if (hasSuperadminRole(authContext)) return true;
  return getRuntimeOrThrow().membership.isMember(teamId, authContext.user.id);
}

export function registerMultiUserAdminRoutes(app: Hono): void {
  app.get("/admin/users", requireAdmin(), async (c) => {
    const { auth } = getRuntimeOrThrow();
    const result = await auth.api.listUsers({
      headers: c.req.raw.headers,
      query: {},
    });
    return c.json(result);
  });

  app.post("/admin/impersonate/start", requireSuperadmin(), async (c) => {
    const parsed = StartImpersonationBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const authContext = getRequestAuthContext(c);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);
    if (parsed.data.targetUserId === authContext.user.id) {
      return c.json({ error: "cannot_impersonate_self" }, 400);
    }

    const { auth } = getRuntimeOrThrow();
    const target = await auth.api.getUser({
      headers: c.req.raw.headers,
      query: { id: parsed.data.targetUserId },
    });
    if (!target) {
      return c.json({ error: "User not found" }, 404);
    }

    startImpersonation(authContext.session.id, parsed.data.targetUserId);
    logImpersonationEvent({
      action: "start",
      adminId: authContext.user.id,
      targetId: parsed.data.targetUserId,
    });
    return c.body(null, 204);
  });

  app.patch("/admin/users/:id", requireAdmin(), async (c) => {
    const parsed = UpdateAdminUserBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    // Role changes are superadmin-only. Admins may still approve/reject
    // users but cannot change any role.
    if (parsed.data.role !== undefined) {
      const authContext = getRequestAuthContext(c);
      if (!authContext || !hasSuperadminRole(authContext)) {
        return c.json({ error: "forbidden" }, 403);
      }
    }

    const userId = c.req.param("id");
    const { auth, db } = getRuntimeOrThrow();
    const existing = await auth.api.getUser({
      headers: c.req.raw.headers,
      query: { id: userId },
    });

    if (!existing) {
      return c.json({ error: "User not found" }, 404);
    }

    const before = { approved: existing.approved, role: existing.role };
    if (parsed.data.role !== undefined) {
      await auth.api.setRole({
        headers: c.req.raw.headers,
        body: {
          userId,
          role: parsed.data.role,
        },
      });
    }

    if (parsed.data.approved !== undefined) {
      db.prepare("UPDATE user SET approved = ? WHERE id = ?").run(
        parsed.data.approved ? 1 : 0,
        userId
      );
    }

    const updated = await auth.api.getUser({
      headers: c.req.raw.headers,
      query: { id: userId },
    });
    recordAdminChange(c, { action: "admin.user_update", targetType: "user", targetId: userId }, before, {
      approved: updated?.approved, role: updated?.role,
    });
    return c.json({ user: updated });
  });

  app.get("/admin/agents/assignments", requireSuperadmin(), (c) => {
    const { assignments } = getRuntimeOrThrow();
    return c.json({ assignments: assignments.getAllAssignments() });
  });

  // Fork/team provenance — lets the pool catalog decide whether to show
  // "Assign to team" (no fork yet) vs a reassign flow (fork exists).
  app.get("/admin/forks", requireAdmin(), (c) => {
    const { forks } = getRuntimeOrThrow();
    return c.json({ forks: forks.listForks() });
  });

  app.put("/admin/forks/:poolId/teams", requireAdmin(), async (c) => {
    const parsed = SetForkTeamsBodySchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const authContext = getRequestAuthContext(c);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);
    const { forks, teams, membership, access } = getRuntimeOrThrow();
    if (parsed.data.mode === "list" && parsed.data.teamIds.some((teamId) => !teams.getTeam(teamId))) {
      return c.json({ error: "Team not found" }, 404);
    }
    const poolId = c.req.param("poolId");
    const existing = forks.getForkByPool(poolId);
    let assignment = parsed.data;
    if (!hasSuperadminRole(authContext)) {
      // Admins only (un)assign their own teams; links to other teams are kept.
      if (assignment.mode === "all" || existing?.assignment.mode === "all") return c.json({ error: "forbidden" }, 403);
      if (existing && !access.canUserChatAgent(authContext.user.id, existing.forkAgentId)) return c.json({ error: "forbidden" }, 403);
      const ownTeams = new Set(membership.listTeamsForUser(authContext.user.id));
      if (assignment.teamIds.some((teamId) => !ownTeams.has(teamId))) return c.json({ error: "forbidden" }, 403);
      const otherTeams = existing?.assignment.mode === "list" ? existing.assignment.teamIds.filter((teamId) => !ownTeams.has(teamId)) : [];
      assignment = { mode: "list", teamIds: [...new Set([...otherTeams, ...assignment.teamIds])] };
    }
    try {
      const before = existing ? { assignment: existing.assignment } : {};
      const fork = forks.setTeams(poolId, assignment, authContext.user.id);
      recordAdminChange(c, { action: "admin.fork_teams", targetType: "fork", targetId: poolId, agentId: fork.forkAgentId }, before, { assignment: fork.assignment });
      return c.json({ fork });
    } catch (error) {
      if (isPoolAgentNotFoundError(error) || isForkNotFoundError(error)) return c.json({ error: (error as Error).message }, 404);
      throw error;
    }
  });

  app.delete("/admin/teams/:teamId/agents/:poolId", requireAdmin(), (c) => {
    if (!canManageTeam(c, c.req.param("teamId"))) return c.json({ error: "forbidden" }, 403);
    const { forks } = getRuntimeOrThrow();
    try {
      const poolId = c.req.param("poolId");
      const before = forks.getForkByPool(poolId)?.assignment;
      const fork = forks.removeTeam(poolId, c.req.param("teamId"));
      recordAdminChange(c, { action: "admin.team_agent_remove", targetType: "fork", targetId: poolId, agentId: fork.forkAgentId }, { assignment: before }, { assignment: fork.assignment });
      return c.json({ fork });
    } catch (error) {
      if (isForkNotFoundError(error)) return c.json({ error: (error as Error).message }, 404);
      if (error instanceof Error && /All-teams/.test(error.message)) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.post("/admin/teams", requireSuperadmin(), async (c) => {
    const parsed = CreateTeamBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const authContext = getRequestAuthContext(c);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);

    const { teams } = getRuntimeOrThrow();
    try {
      const team = teams.createTeam({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        color: parsed.data.color ?? null,
        icon: parsed.data.icon ?? null,
        private: parsed.data.private,
        createdBy: authContext.user.id,
      });
      recordAdminChange(c, { action: "admin.team_create", targetType: "team", targetId: team.id }, {}, { name: team.name, description: team.description, color: team.color, icon: team.icon, private: team.private });
      return c.json({ team }, 201);
    } catch (error) {
      if (isDuplicateTeamNameError(error)) {
        return c.json({ error: (error as Error).message }, 409);
      }
      throw error;
    }
  });

  app.patch("/admin/teams/:id", requireAdmin(), async (c) => {
    if (!canManageTeam(c, c.req.param("id"))) return c.json({ error: "forbidden" }, 403);
    const parsed = UpdateTeamBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const { teams } = getRuntimeOrThrow();
    try {
      const existing = teams.getTeam(c.req.param("id"));
      const before = existing ? { name: existing.name, description: existing.description, color: existing.color, icon: existing.icon, private: existing.private } : {};
      const team = teams.updateTeam(c.req.param("id"), parsed.data);
      recordAdminChange(c, { action: "admin.team_update", targetType: "team", targetId: team.id }, before, { name: team.name, description: team.description, color: team.color, icon: team.icon, private: team.private });
      return c.json({ team });
    } catch (error) {
      if (isTeamNotFoundError(error)) {
        return c.json({ error: (error as Error).message }, 404);
      }
      if (isDuplicateTeamNameError(error)) {
        return c.json({ error: (error as Error).message }, 409);
      }
      throw error;
    }
  });

  app.get("/admin/teams/:id/delete-preview", requireSuperadmin(), (c) => {
    const { teams, membership } = getRuntimeOrThrow();
    const teamId = c.req.param("id");
    if (!teams.getTeam(teamId)) {
      return c.json({ error: "Team not found" }, 404);
    }
    return c.json({ teamlessUsers: membership.usersOnlyInTeam(teamId) });
  });

  app.delete("/admin/teams/:id", requireSuperadmin(), (c) => {
    const { teams, notifyAgentListChanged } = getRuntimeOrThrow();
    try {
      const teamId = c.req.param("id");
      const existing = teams.getTeam(teamId);
      const result = teams.deleteTeam(teamId);
      recordAdminChange(c, { action: "admin.team_delete", targetType: "team", targetId: teamId }, existing ? { name: existing.name, description: existing.description, color: existing.color, icon: existing.icon, private: existing.private } : {}, {});
      notifyAgentListChanged?.();
      return c.json(result);
    } catch (error) {
      if (isTeamNotFoundError(error)) {
        return c.json({ error: (error as Error).message }, 404);
      }
      throw error;
    }
  });

  app.put("/admin/teams/:teamId/members", requireAdmin(), async (c) => {
    if (!canManageTeam(c, c.req.param("teamId"))) return c.json({ error: "forbidden" }, 403);
    const parsed = SetTeamMembersBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const authContext = getRequestAuthContext(c);
    if (!authContext) return c.json({ error: "unauthorized" }, 401);

    const teamId = c.req.param("teamId");
    const { teams, membership, db, notifyAgentListChanged } = getRuntimeOrThrow();
    if (!teams.getTeam(teamId)) {
      return c.json({ error: "Team not found" }, 404);
    }

    const userIds = parsed.data.mode === "list" ? [...new Set(parsed.data.userIds)] : [];
    if (userIds.length) {
      const rows = db.prepare(`SELECT id FROM user WHERE id IN (${userIds.map(() => "?").join(",")})`).all(...userIds) as Array<{ id: string }>;
      if (rows.length !== userIds.length) return c.json({ error: "User not found" }, 404);
    }
    const before = { allUsers: teams.getTeam(teamId)?.allUsers ?? false, userIds: membership.listSavedMemberProfilesForTeam(teamId).map((member) => member.id).sort() };
    membership.setMembers(teamId, parsed.data.mode === "all" ? { mode: "all" } : { mode: "list", userIds }, authContext.user.id);
    notifyAgentListChanged?.();
    const allUsers = teams.getTeam(teamId)?.allUsers ?? false;
    recordAdminChange(c, { action: "admin.team_members", targetType: "team", targetId: teamId }, before, { allUsers, userIds: membership.listSavedMemberProfilesForTeam(teamId).map((member) => member.id).sort() });
    return c.json({
      teamId,
      allUsers,
      members: membership.listMemberProfilesForTeam(teamId),
      // The latent roster from before the team switched to All users, so the
      // UI can restore it if the admin unchecks All users.
      ...(allUsers ? { savedMembers: membership.listSavedMemberProfilesForTeam(teamId) } : {}),
    });
  });

  app.delete("/admin/teams/:teamId/members/:userId", requireAdmin(), (c) => {
    if (!canManageTeam(c, c.req.param("teamId"))) return c.json({ error: "forbidden" }, 403);
    const teamId = c.req.param("teamId");
    const userId = c.req.param("userId");
    const { teams, membership, notifyAgentListChanged } = getRuntimeOrThrow();
    if (!teams.getTeam(teamId)) {
      return c.json({ error: "Team not found" }, 404);
    }

    const before = membership.listUsersForTeam(teamId).sort();
    try { membership.removeMember(teamId, userId); } catch (error) {
      if (isAllUsersTeamError(error)) return c.json({ error: (error as Error).message }, 409);
      throw error;
    }
    recordAdminChange(c, { action: "admin.team_member_remove", targetType: "team", targetId: teamId }, { userIds: before }, { userIds: membership.listUsersForTeam(teamId).sort() });
    notifyAgentListChanged?.();
    return c.json({
      teamId,
      allUsers: teams.getTeam(teamId)?.allUsers ?? false,
      members: membership.listMemberProfilesForTeam(teamId),
    });
  });

  app.put("/admin/agents/:agentId/assignments", requireSuperadmin(), async (c) => {
    const parsed = SetAgentAssignmentsBodySchema.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const agentId = c.req.param("agentId");
    const { assignments, db, getAgent } = getRuntimeOrThrow();
    if (!getAgent(agentId)) {
      return c.json({ error: "Agent not found" }, 404);
    }
    const authContext = getRequestAuthContext(c);
    if (!authContext) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const userIds = [...new Set(parsed.data.userIds)];
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(", ");
      const existingUserIds = new Set(
        (
          db
            .prepare(`SELECT id FROM user WHERE id IN (${placeholders})`)
            .all(...userIds) as Array<{ id: string }>
        ).map((row) => row.id)
      );
      const invalidUserIds = userIds.filter(
        (userId) => !existingUserIds.has(userId)
      );

      if (invalidUserIds.length > 0) {
        return c.json(
          {
            error: "Unknown user ids",
            userIds: invalidUserIds,
          },
          400
        );
      }
    }

    const before = assignments.getAssignmentsForAgent(agentId).sort();
    try {
      assignments.setAssignmentsForAgent(agentId, userIds, authContext.user.id);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("FOREIGN KEY constraint failed")
      ) {
        return c.json({ error: "Invalid assignment user ids" }, 400);
      }
      throw error;
    }

    recordAdminChange(c, { action: "admin.agent_assignments", targetType: "assignment", targetId: agentId, agentId }, { userIds: before }, { userIds: assignments.getAssignmentsForAgent(agentId).sort() });
    return c.json({
      agentId,
      userIds: assignments.getAssignmentsForAgent(agentId),
    });
  });
}
