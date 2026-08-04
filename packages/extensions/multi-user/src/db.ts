import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export const AUTH_DB_FILENAME = "auth.db";

export function getAuthDbPath(dataDir: string): string {
  return path.join(dataDir, AUTH_DB_FILENAME);
}

export function ensureAgentAssignmentsTable(
  db: Database.Database
): void {
  const createTableSql = `
    CREATE TABLE agent_assignments (
      userId TEXT NOT NULL,
      agentId TEXT NOT NULL,
      assignedBy TEXT,
      assignedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (userId, agentId),
      FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (assignedBy) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_assignments_agent_id
      ON agent_assignments (agentId);
  `;
  const tableExists = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_assignments'"
    )
    .get();

  if (!tableExists) {
    db.exec(createTableSql);
    return;
  }

  const foreignKeys = db
    .prepare("PRAGMA foreign_key_list(agent_assignments)")
    .all() as Array<{ table: string; from: string }>;
  const hasExpectedForeignKeys =
    foreignKeys.some((row) => row.table === "user" && row.from === "userId") &&
    foreignKeys.some(
      (row) => row.table === "user" && row.from === "assignedBy"
    );

  if (!hasExpectedForeignKeys) {
    const hasUserTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user'"
      )
      .get();

    db.exec("DROP TABLE IF EXISTS agent_assignments_next");
    db.exec(createTableSql.replace("agent_assignments", "agent_assignments_next"));

    if (hasUserTable) {
      db.exec(`
        INSERT INTO agent_assignments_next (userId, agentId, assignedBy, assignedAt)
        SELECT assignments.userId, assignments.agentId, assignments.assignedBy, assignments.assignedAt
        FROM agent_assignments AS assignments
        INNER JOIN user AS assigned_user ON assigned_user.id = assignments.userId
        INNER JOIN user AS assigning_user ON assigning_user.id = assignments.assignedBy;
      `);
    }

    db.exec(`
      DROP TABLE agent_assignments;
      ALTER TABLE agent_assignments_next RENAME TO agent_assignments;
      CREATE INDEX IF NOT EXISTS idx_agent_assignments_agent_id
        ON agent_assignments (agentId);
    `);
  } else {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agent_assignments_agent_id
        ON agent_assignments (agentId);
    `);
  }
}

export function ensureTeamsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT,
      icon TEXT,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (createdBy) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_name_unique
      ON teams (name COLLATE NOCASE);
  `);
}

export function ensureTeamMembersTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_members (
      teamId TEXT NOT NULL,
      userId TEXT NOT NULL,
      addedBy TEXT NOT NULL,
      addedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (teamId, userId),
      FOREIGN KEY (teamId) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE,
      FOREIGN KEY (addedBy) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_team_members_user_id
      ON team_members (userId);
  `);
}

export function ensureAgentForksTable(db: Database.Database): void {
  // One row per forked pool agent. The uniqueness constraints encode the
  // domain invariants directly:
  //   - sourcePoolId UNIQUE  -> a pool definition is forked at most once.
  //   - forkAgentId  UNIQUE  -> a fork is a single, distinct agent id.
  //   - teamId nullable      -> unassign clears the link (teamless/inert)
  //                             without deleting the fork row or its folder.
  // The teamId FK uses ON DELETE SET NULL so deleting a team leaves its forks
  // teamless (inert) rather than cascading them away; deleteTeam surfaces that
  // soon-to-be-teamless set in its warning. `createdBy`/`createdAt` record who
  // first forked and when; `assignedBy`/`assignedAt` record the most recent
  // team (re)assignment provenance and are null while teamless.
  const linksTableExisted = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_fork_teams'")
      .get()
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_forks (
      sourcePoolId TEXT NOT NULL UNIQUE,
      forkAgentId TEXT NOT NULL UNIQUE,
      teamId TEXT,
      allTeams INTEGER NOT NULL DEFAULT 0,
      createdBy TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assignedBy TEXT,
      assignedAt TEXT,
      FOREIGN KEY (teamId) REFERENCES teams(id) ON DELETE SET NULL,
      FOREIGN KEY (createdBy) REFERENCES user(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_forks_team_id
      ON agent_forks (teamId);
  `);
  const columns = db.prepare("PRAGMA table_info(agent_forks)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "allTeams")) {
    db.exec("ALTER TABLE agent_forks ADD COLUMN allTeams INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_fork_teams (
      forkAgentId TEXT NOT NULL,
      teamId TEXT NOT NULL,
      assignedBy TEXT,
      assignedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (forkAgentId, teamId),
      FOREIGN KEY (forkAgentId) REFERENCES agent_forks(forkAgentId) ON DELETE CASCADE,
      FOREIGN KEY (teamId) REFERENCES teams(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_agent_fork_teams_team_id ON agent_fork_teams(teamId);
  `);

  ensureMigrationsTable(db);
  const alreadyBackfilled = db
    .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
    .get(FORK_TEAMS_BACKFILL_MIGRATION);
  if (!alreadyBackfilled && !linksTableExisted) {
    db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO agent_fork_teams (forkAgentId, teamId, assignedBy, assignedAt)
        SELECT forkAgentId, teamId, assignedBy, assignedAt
        FROM agent_forks
        WHERE teamId IS NOT NULL;
      `);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
        FORK_TEAMS_BACKFILL_MIGRATION
      );
    })();
  } else if (!alreadyBackfilled) {
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
      FORK_TEAMS_BACKFILL_MIGRATION
    );
  }
}

/** Records one-shot data migrations so bootstrap never re-runs them. */
export function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** Identifier of the assignments → teams one-shot migration. */
export const ASSIGNMENTS_TO_TEAMS_MIGRATION = "assignments_to_teams";
/** One-shot backfill from the retired agent_forks.teamId column. */
export const FORK_TEAMS_BACKFILL_MIGRATION = "fork_teams_backfill";

/**
 * One-shot migration converting the legacy `agent_assignments` allowlist into
 * the team model so chat access keeps working on installs that predate teams.
 *
 * For each distinct assigned agent it creates one migration team, adds every
 * user who was assigned that agent as a member, and writes an `agent_forks`
 * link row pointing that agent at the team. The original `agentId` is kept as
 * both `sourcePoolId` and `forkAgentId` so the pre-existing (already
 * discovered/runnable) agent still matches the resolver's fork lookup by id.
 *
 * The result preserves access exactly: user U could chat agent A iff a
 * `(U, A)` assignment existed; afterward U is a member of A's team and A's
 * fork links to that team, so `canUserChatAgent(U, A)` holds iff it did before.
 *
 * Idempotent: guarded by a `schema_migrations` marker so re-running bootstrap
 * converts the rows exactly once. `agent_assignments` rows are left in place
 * (untouched) but are no longer read as an access source post-migration.
 */
export function migrateAssignmentsToTeams(db: Database.Database): boolean {
  ensureMigrationsTable(db);

  const alreadyRun = db
    .prepare("SELECT 1 FROM schema_migrations WHERE name = ?")
    .get(ASSIGNMENTS_TO_TEAMS_MIGRATION);
  if (alreadyRun) return false;

  const assignments = db
    .prepare(
      "SELECT userId, agentId, assignedBy FROM agent_assignments ORDER BY agentId, userId"
    )
    .all() as Array<{ userId: string; agentId: string; assignedBy: string }>;

  // Nothing to convert (fresh install, or already-empty allowlist): mark the
  // migration done and skip preparing the insert statements. This also avoids
  // touching the `user` table before better-auth has created it at bootstrap.
  if (assignments.length === 0) {
    db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(
      ASSIGNMENTS_TO_TEAMS_MIGRATION
    );
    return false;
  }

  const insertTeam = db.prepare(
    "INSERT INTO teams (id, name, description, createdBy) VALUES (?, ?, ?, ?)"
  );
  const insertMember = db.prepare(
    "INSERT INTO team_members (teamId, userId, addedBy) VALUES (?, ?, ?) ON CONFLICT (teamId, userId) DO NOTHING"
  );
  const insertFork = db.prepare(
    "INSERT INTO agent_forks (sourcePoolId, forkAgentId, teamId, createdBy, assignedBy, assignedAt) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)"
  );
  const insertForkTeam = db.prepare(
    "INSERT OR IGNORE INTO agent_fork_teams (forkAgentId, teamId, assignedBy, assignedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
  );
  const markDone = db.prepare(
    "INSERT INTO schema_migrations (name) VALUES (?)"
  );

  const run = db.transaction(() => {
    // Group the flat assignment rows by agent so each agent yields one team.
    const byAgent = new Map<
      string,
      { users: Set<string>; assignedBy: string }
    >();
    for (const row of assignments) {
      const entry = byAgent.get(row.agentId);
      if (entry) {
        entry.users.add(row.userId);
      } else {
        byAgent.set(row.agentId, {
          users: new Set([row.userId]),
          assignedBy: row.assignedBy,
        });
      }
    }

    for (const [agentId, { users, assignedBy }] of byAgent) {
      const teamId = randomUUID();
      insertTeam.run(
        teamId,
        `Migrated: ${agentId}`,
        `Auto-created from legacy assignments for agent ${agentId}`,
        assignedBy
      );
      for (const userId of users) {
        insertMember.run(teamId, userId, assignedBy);
      }
      insertFork.run(agentId, agentId, teamId, assignedBy, assignedBy);
      insertForkTeam.run(agentId, teamId, assignedBy);
    }

    markDone.run(ASSIGNMENTS_TO_TEAMS_MIGRATION);
  });

  run();
  return true;
}

export function initializeMultiUserDatabase(
  dataDirOrPath: string
): Database.Database {
  const dbPath = path.extname(dataDirOrPath)
    ? dataDirOrPath
    : getAuthDbPath(dataDirOrPath);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  ensureAgentAssignmentsTable(db);
  ensureTeamsTable(db);
  ensureTeamMembersTable(db);
  ensureAgentForksTable(db);
  ensureMigrationsTable(db);
  // Convert legacy allowlist rows into the team model once, at bootstrap, so
  // pre-teams installs keep working after the resolver stops reading the
  // allowlist. Safe no-op on fresh installs (no assignment rows).
  migrateAssignmentsToTeams(db);
  ensureAgentForksTable(db);
  return db;
}
