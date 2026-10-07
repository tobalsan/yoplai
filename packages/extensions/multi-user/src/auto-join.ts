import type Database from "better-sqlite3";

/** Snapshot public team membership only when a user is created. */
export function autoJoinPublicTeams(
  db: Database.Database,
  userId: string
): void {
  db.prepare(
    `
    INSERT INTO team_members (teamId, userId, addedBy)
    SELECT id, @userId, @userId FROM teams
    WHERE private = 0 AND allUsers = 0
    ON CONFLICT (teamId, userId) DO NOTHING
  `
  ).run({ userId });
}
