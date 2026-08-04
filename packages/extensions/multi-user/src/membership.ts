import type Database from "better-sqlite3";

export type TeamMember = {
  teamId: string;
  userId: string;
  addedBy: string;
  addedAt: string;
};

export type TeamMemberProfile = { id: string; name: string | null; email: string | null };
export type TeamMembership = { mode: "all" } | { mode: "list"; userIds: string[] };

export class AllUsersTeamError extends Error {
  constructor() { super("Cannot remove a member from an All users team"); this.name = "AllUsersTeamError"; }
}

export function isAllUsersTeamError(error: unknown): boolean {
  return error instanceof Error && error.name === "AllUsersTeamError";
}

/**
 * The membership deep module. Owns the many-to-many user↔team relationship:
 * a user may belong to many teams and a team may hold many users. Membership
 * writes replace the complete explicit set or enable the standing All rule.
 */
export type MembershipStore = {
  setMembers(teamId: string, membership: TeamMembership, addedBy: string): void;
  getMembership(teamId: string): TeamMembership;
  removeMember(teamId: string, userId: string): void;
  isMember(teamId: string, userId: string): boolean;
  /** Team ids the given user belongs to. */
  listTeamsForUser(userId: string): string[];
  /** User ids that belong to the given team. */
  listUsersForTeam(teamId: string): string[];
  /** Members of the team with display info (name/email), for rendering. */
  listMemberProfilesForTeam(teamId: string): TeamMemberProfile[];
  /**
   * Of the given user ids, those whose only remaining team is `teamId` — i.e.
   * the users who would be left teamless if `teamId` were deleted. Used to
   * populate the delete-team confirmation warning.
   */
  usersOnlyInTeam(teamId: string): string[];
};

export function createMembershipStore(db: Database.Database): MembershipStore {
  // ON CONFLICT DO NOTHING keeps add idempotent: a duplicate (teamId, userId)
  // is silently ignored rather than raising a UNIQUE/PK violation.
  const insertStatement = db.prepare(`
    INSERT INTO team_members (teamId, userId, addedBy)
    VALUES (?, ?, ?)
    ON CONFLICT (teamId, userId) DO NOTHING
  `);
  const removeStatement = db.prepare(
    "DELETE FROM team_members WHERE teamId = ? AND userId = ?"
  );
  const allUsersStatement = db.prepare("SELECT allUsers FROM teams WHERE id = ?");
  const setAllUsersStatement = db.prepare("UPDATE teams SET allUsers = ? WHERE id = ?");
  const deleteForTeamStatement = db.prepare("DELETE FROM team_members WHERE teamId = ?");
  const isMemberStatement = db.prepare(
    "SELECT 1 FROM teams t WHERE t.id = ? AND (t.allUsers = 1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.teamId = t.id AND m.userId = ?))"
  );
  const teamsForUserStatement = db.prepare(
    "SELECT t.id AS teamId FROM teams t WHERE t.allUsers = 1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.teamId = t.id AND m.userId = ?) ORDER BY t.id"
  );
  const usersForTeamStatement = db.prepare(
    "SELECT u.id AS userId FROM user u WHERE (SELECT allUsers FROM teams WHERE id = ?) = 1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.teamId = ? AND m.userId = u.id) ORDER BY u.id"
  );
  // Users in `teamId` whose total team count is exactly 1 — they belong to no
  // other team, so deleting this team would leave them teamless.
  const usersOnlyInTeamStatement = db.prepare(`
    SELECT u.id AS userId FROM user u
    WHERE ((SELECT allUsers FROM teams WHERE id = ?) = 1 OR EXISTS (SELECT 1 FROM team_members m WHERE m.teamId = ? AND m.userId = u.id))
      AND (
        SELECT COUNT(*) FROM teams t WHERE t.allUsers = 1 OR EXISTS (SELECT 1 FROM team_members other WHERE other.teamId = t.id AND other.userId = u.id)
      ) = 1
    ORDER BY u.id
  `);
  // Prepared lazily: some test fixtures create a minimal `user` table without
  // name/email columns, and better-sqlite3 validates columns at prepare time.
  let memberProfilesStatement: Database.Statement | undefined;

  return {
    setMembers(teamId, membership, addedBy) {
      db.transaction(() => {
        deleteForTeamStatement.run(teamId);
        setAllUsersStatement.run(membership.mode === "all" ? 1 : 0, teamId);
        if (membership.mode === "list") for (const userId of new Set(membership.userIds)) insertStatement.run(teamId, userId, addedBy);
      })();
    },
    getMembership(teamId) {
      if ((allUsersStatement.get(teamId) as { allUsers: number } | undefined)?.allUsers) return { mode: "all" };
      return { mode: "list", userIds: (usersForTeamStatement.all(teamId, teamId) as Array<{ userId: string }>).map((row) => row.userId) };
    },
    removeMember(teamId, userId) {
      if ((allUsersStatement.get(teamId) as { allUsers: number } | undefined)?.allUsers) throw new AllUsersTeamError();
      removeStatement.run(teamId, userId);
    },
    isMember(teamId, userId) {
      return isMemberStatement.get(teamId, userId) !== undefined;
    },
    listTeamsForUser(userId) {
      return (
        teamsForUserStatement.all(userId) as Array<{ teamId: string }>
      ).map((row) => row.teamId);
    },
    listUsersForTeam(teamId) {
      return (
        usersForTeamStatement.all(teamId, teamId) as Array<{ userId: string }>
      ).map((row) => row.userId);
    },
    usersOnlyInTeam(teamId) {
      return (
        usersOnlyInTeamStatement.all(teamId, teamId) as Array<{ userId: string }>
      ).map((row) => row.userId);
    },
    listMemberProfilesForTeam(teamId) {
      memberProfilesStatement ??= db.prepare(`
        SELECT u.id AS id, u.name AS name, u.email AS email
        FROM user AS u
        WHERE (SELECT allUsers FROM teams WHERE id = ?) = 1
          OR EXISTS (SELECT 1 FROM team_members m WHERE m.teamId = ? AND m.userId = u.id)
        ORDER BY u.id
      `);
      return memberProfilesStatement.all(teamId, teamId) as TeamMemberProfile[];
    },
  };
}
