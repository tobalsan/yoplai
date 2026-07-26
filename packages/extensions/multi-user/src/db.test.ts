import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSIGNMENTS_TO_TEAMS_MIGRATION,
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
