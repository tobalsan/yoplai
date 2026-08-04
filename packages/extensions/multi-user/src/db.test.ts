import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSIGNMENTS_TO_TEAMS_MIGRATION,
  ensureAgentForksTable,
  ensureTeamsTable,
  initializeMultiUserDatabase,
  migrateAssignmentsToTeams,
} from "./db.js";
import { createForkStore } from "./forks.js";
import { createMembershipStore } from "./membership.js";
import { createAccessResolver } from "./access.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("multi-user db", () => {
  it("initializes sqlite db and agent assignments table", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-auth-db-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "auth.db");

    const db = initializeMultiUserDatabase(dbPath);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const foreignKeys = db
      .prepare("PRAGMA foreign_key_list(agent_assignments)")
      .all() as Array<{ table: string; from: string }>;
    const foreignKeysEnabled = db.pragma("foreign_keys", {
      simple: true,
    }) as number;

    db.close();

    expect(fs.existsSync(dbPath)).toBe(true);
    expect(tables.map((table) => table.name)).toContain("agent_assignments");
    expect(tables.map((table) => table.name)).toContain("teams");
    expect(tables.map((table) => table.name)).toContain("team_members");
    expect(tables.map((table) => table.name)).toContain("agent_forks");
    expect(foreignKeysEnabled).toBe(1);
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "user", from: "userId" }),
        expect.objectContaining({ table: "user", from: "assignedBy" }),
      ])
    );
  });

  it("creates a teams table with a unique name index", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-teams-db-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "auth.db");

    const db = initializeMultiUserDatabase(dbPath);
    const columns = db
      .prepare("PRAGMA table_info(teams)")
      .all() as Array<{ name: string; notnull: number }>;
    const indexes = db
      .prepare("PRAGMA index_list(teams)")
      .all() as Array<{ name: string; unique: number }>;

    db.close();

    const columnNames = columns.map((column) => column.name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "id",
        "name",
        "description",
        "color",
        "icon",
        "createdBy",
        "createdAt",
      ])
    );
    expect(indexes.some((index) => index.unique === 1)).toBe(true);
  });

  it("adds All-users off without changing existing membership rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO user (id) VALUES ('admin'), ('member')");
    db.exec(`CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdBy TEXT NOT NULL);
      CREATE TABLE team_members (teamId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT NOT NULL, PRIMARY KEY (teamId, userId));
      INSERT INTO teams (id, name, createdBy) VALUES ('team', 'Team', 'admin');
      INSERT INTO team_members (teamId, userId, addedBy) VALUES ('team', 'member', 'admin');`);

    ensureTeamsTable(db);
    ensureTeamsTable(db);
    expect(db.prepare("SELECT allUsers FROM teams WHERE id = 'team'").get()).toEqual({ allUsers: 0 });
    expect(db.prepare("SELECT teamId, userId FROM team_members").all()).toEqual([{ teamId: "team", userId: "member" }]);
    db.close();
  });

  it("creates a team_members M2M table with team/user foreign keys", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-members-db-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "auth.db");

    const db = initializeMultiUserDatabase(dbPath);
    const columns = db
      .prepare("PRAGMA table_info(team_members)")
      .all() as Array<{ name: string; pk: number }>;
    const foreignKeys = db
      .prepare("PRAGMA foreign_key_list(team_members)")
      .all() as Array<{ table: string; from: string }>;

    db.close();

    const columnNames = columns.map((column) => column.name);
    expect(columnNames).toEqual(
      expect.arrayContaining(["teamId", "userId", "addedBy", "addedAt"])
    );
    // Composite primary key on (teamId, userId) makes the pair unique.
    expect(columns.filter((column) => column.pk > 0).map((c) => c.name)).toEqual(
      expect.arrayContaining(["teamId", "userId"])
    );
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ table: "teams", from: "teamId" }),
        expect.objectContaining({ table: "user", from: "userId" }),
      ])
    );
  });

  it("creates an agent_forks table with fork-once / one-team constraints", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-forks-db-"));
    tempDirs.push(tempDir);
    const dbPath = path.join(tempDir, "auth.db");

    const db = initializeMultiUserDatabase(dbPath);
    const columns = db
      .prepare("PRAGMA table_info(agent_forks)")
      .all() as Array<{ name: string; notnull: number }>;
    const indexes = db
      .prepare("PRAGMA index_list(agent_forks)")
      .all() as Array<{ name: string; unique: number }>;
    const foreignKeys = db
      .prepare("PRAGMA foreign_key_list(agent_forks)")
      .all() as Array<{ table: string; from: string; on_delete: string }>;

    db.close();

    const columnNames = columns.map((column) => column.name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "sourcePoolId",
        "forkAgentId",
        "teamId",
        "createdBy",
        "createdAt",
        "assignedBy",
        "assignedAt",
      ])
    );
    // Both sourcePoolId (fork-once) and forkAgentId (one team per fork) are
    // unique.
    expect(indexes.filter((index) => index.unique === 1).length).toBeGreaterThanOrEqual(
      2
    );
    // Deleting a team leaves its forks teamless rather than cascading them.
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "teams",
          from: "teamId",
          on_delete: "SET NULL",
        }),
      ])
    );
  });
});

describe("fork teams backfill", () => {
  it("does not restore a retired teamId link after an assignment changes and the service restarts", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO user (id) VALUES (?)").run("admin-1");
    ensureTeamsTable(db);
    for (const id of ["team-a", "team-b"]) {
      db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(
        id,
        id,
        "admin-1"
      );
    }
    db.exec(`
      CREATE TABLE agent_forks (
        sourcePoolId TEXT NOT NULL UNIQUE,
        forkAgentId TEXT NOT NULL UNIQUE,
        teamId TEXT,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        assignedBy TEXT,
        assignedAt TEXT
      );
    `);
    db.prepare(
      "INSERT INTO agent_forks (sourcePoolId, forkAgentId, teamId, createdBy, assignedBy) VALUES (?, ?, ?, ?, ?)"
    ).run("scribe", "scribe", "team-a", "admin-1", "admin-1");

    ensureAgentForksTable(db);
    const store = createForkStore({
      db,
      getForksDir: () => "",
      getPoolAgent: () => null,
    });
    store.setTeams("scribe", { mode: "list", teamIds: ["team-b"] }, "admin-1");

    // A later bootstrap must not read the retired column again.
    ensureAgentForksTable(db);
    expect(store.getForkByPool("scribe")?.assignment).toEqual({
      mode: "list",
      teamIds: ["team-b"],
    });
    db.close();
  });

  it("does not backfill a stale retired teamId when upgrading an existing join table", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
    db.prepare("INSERT INTO user (id) VALUES (?)").run("admin-1");
    ensureTeamsTable(db);
    for (const id of ["team-a", "team-b"]) {
      db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(
        id,
        id,
        "admin-1"
      );
    }
    db.exec(`
      CREATE TABLE agent_forks (
        sourcePoolId TEXT NOT NULL UNIQUE,
        forkAgentId TEXT NOT NULL UNIQUE,
        teamId TEXT,
        createdBy TEXT NOT NULL,
        createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        assignedBy TEXT,
        assignedAt TEXT
      );
      CREATE TABLE agent_fork_teams (
        forkAgentId TEXT NOT NULL,
        teamId TEXT NOT NULL,
        assignedBy TEXT,
        assignedAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (forkAgentId, teamId)
      );
    `);
    db.prepare(
      "INSERT INTO agent_forks (sourcePoolId, forkAgentId, teamId, createdBy, assignedBy) VALUES (?, ?, ?, ?, ?)"
    ).run("scribe", "scribe", "team-a", "admin-1", "admin-1");
    db.prepare(
      "INSERT INTO agent_fork_teams (forkAgentId, teamId, assignedBy) VALUES (?, ?, ?)"
    ).run("scribe", "team-b", "admin-1");

    ensureAgentForksTable(db);
    expect(
      db
        .prepare("SELECT teamId FROM agent_fork_teams WHERE forkAgentId = ? ORDER BY teamId")
        .all("scribe")
    ).toEqual([{ teamId: "team-b" }]);
    db.close();
  });
});

function seedAssignments(dbPath: string) {
  // A fresh db has no assignment rows, so the migration marker is already set.
  // Seed users + legacy assignments, then clear the marker so the migration
  // has real rows to convert on the next run.
  const db = initializeMultiUserDatabase(dbPath);
  // better-auth normally owns the `user` table; create a minimal stand-in so
  // the assignment/team/member FKs resolve in this isolated test.
  db.exec("CREATE TABLE IF NOT EXISTS user (id TEXT PRIMARY KEY)");
  const insertUser = db.prepare("INSERT INTO user (id) VALUES (?)");
  for (const u of ["admin-1", "alice", "bob", "carol"]) insertUser.run(u);
  const insertAssignment = db.prepare(
    "INSERT INTO agent_assignments (userId, agentId, assignedBy) VALUES (?, ?, ?)"
  );
  // scribe -> alice, bob ; sage -> alice
  insertAssignment.run("alice", "scribe", "admin-1");
  insertAssignment.run("bob", "scribe", "admin-1");
  insertAssignment.run("alice", "sage", "admin-1");
  db.prepare("DELETE FROM schema_migrations WHERE name = ?").run(
    ASSIGNMENTS_TO_TEAMS_MIGRATION
  );
  return db;
}

describe("assignments → teams migration", () => {
  function makeDbPath(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-migrate-"));
    tempDirs.push(tempDir);
    return path.join(tempDir, "auth.db");
  }

  it("converts each assigned agent into a team + members + fork link", () => {
    const db = seedAssignments(makeDbPath());

    expect(migrateAssignmentsToTeams(db)).toBe(true);

    const teams = db
      .prepare("SELECT name FROM teams ORDER BY name")
      .all() as Array<{ name: string }>;
    expect(teams.map((t) => t.name)).toEqual([
      "Migrated: sage",
      "Migrated: scribe",
    ]);

    const forks = db
      .prepare(
        "SELECT sourcePoolId, forkAgentId, teamId FROM agent_forks ORDER BY forkAgentId"
      )
      .all() as Array<{
      sourcePoolId: string;
      forkAgentId: string;
      teamId: string;
    }>;
    // The original agent id is preserved as both pool id and fork id.
    expect(forks.map((f) => f.forkAgentId)).toEqual(["sage", "scribe"]);
    expect(forks.every((f) => f.teamId !== null)).toBe(true);

    const memberCount = db
      .prepare("SELECT COUNT(*) AS n FROM team_members")
      .get() as { n: number };
    // scribe → alice, bob (2) + sage → alice (1) = 3.
    expect(memberCount.n).toBe(3);

    db.close();
  });

  it("is one-shot: re-running does not duplicate rows", () => {
    const db = seedAssignments(makeDbPath());

    expect(migrateAssignmentsToTeams(db)).toBe(true);
    // Second call is a guarded no-op.
    expect(migrateAssignmentsToTeams(db)).toBe(false);

    const teamCount = db
      .prepare("SELECT COUNT(*) AS n FROM teams")
      .get() as { n: number };
    const forkCount = db
      .prepare("SELECT COUNT(*) AS n FROM agent_forks")
      .get() as { n: number };
    const memberCount = db
      .prepare("SELECT COUNT(*) AS n FROM team_members")
      .get() as { n: number };
    expect(teamCount.n).toBe(2);
    expect(forkCount.n).toBe(2);
    expect(memberCount.n).toBe(3);

    db.close();
  });

  it("post-migration access resolves via teams, not the allowlist", () => {
    const db = seedAssignments(makeDbPath());
    migrateAssignmentsToTeams(db);

    const membership = createMembershipStore(db);
    const forks = createForkStore({
      db,
      getForksDir: () => "/tmp/agents",
      getPoolAgent: () => null,
    });
    const resolver = createAccessResolver({ membership, forks });

    // Access matches the original allowlist exactly.
    expect(resolver.canUserChatAgent("alice", "scribe")).toBe(true);
    expect(resolver.canUserChatAgent("alice", "sage")).toBe(true);
    expect(resolver.canUserChatAgent("bob", "scribe")).toBe(true);
    // bob was never assigned sage.
    expect(resolver.canUserChatAgent("bob", "sage")).toBe(false);
    // carol was assigned nothing → teamless → no access.
    expect(resolver.canUserChatAgent("carol", "scribe")).toBe(false);
    expect(resolver.getVisibleChatAgents("alice").sort()).toEqual([
      "sage",
      "scribe",
    ]);

    db.close();
  });

  it("is a no-op on a fresh install with no assignments", () => {
    const db = initializeMultiUserDatabase(makeDbPath());
    // initialize already ran the migration once (marker set, nothing to do).
    expect(migrateAssignmentsToTeams(db)).toBe(false);
    const teamCount = db
      .prepare("SELECT COUNT(*) AS n FROM teams")
      .get() as { n: number };
    expect(teamCount.n).toBe(0);
    db.close();
  });
});
