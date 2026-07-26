import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureAgentForksTable,
  ensureTeamMembersTable,
  ensureTeamsTable,
} from "./db.js";
import { createForkStore, type ForkStore, type PoolAgentRef } from "./forks.js";
import { createMembershipStore, type MembershipStore } from "./membership.js";
import { createAccessResolver } from "./access.js";
import {
  createPoolCatalogResolver,
  type CatalogUser,
  type PoolCatalogResolver,
} from "./catalog.js";

let db: Database.Database;
let forks: ForkStore;
let membership: MembershipStore;
let catalog: PoolCatalogResolver;
let poolDir: string;
let forksDir: string;
const tempDirs: string[] = [];

function writePoolAgent(id: string): PoolAgentRef {
  const dir = path.join(poolDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "agent.yaml"), `id: ${id}\nname: ${id}\n`);
  return { id, workspaceDir: dir };
}

// The full pool the catalog resolves over (mirrors config order).
const POOL_IDS = ["scribe", "sage", "scout", "orphan", "fresh"];

const staff = (id: string): CatalogUser => ({ id, isStaff: true });
const member = (id: string): CatalogUser => ({ id, isStaff: false });

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-catalog-"));
  tempDirs.push(home);
  poolDir = path.join(home, "pool");
  forksDir = path.join(home, "agents");
  fs.mkdirSync(poolDir, { recursive: true });

  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
  const insertUser = db.prepare("INSERT INTO user (id) VALUES (?)");
  for (const u of ["admin-1", "alice", "bob", "loner"]) insertUser.run(u);
  ensureTeamsTable(db);
  ensureTeamMembersTable(db);
  ensureAgentForksTable(db);
  const insertTeam = db.prepare(
    "INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)"
  );
  insertTeam.run("team-red", "Red", "admin-1");
  insertTeam.run("team-blue", "Blue", "admin-1");
  insertTeam.run("team-green", "Green", "admin-1");

  const poolAgents = new Map<string, PoolAgentRef>();
  for (const id of POOL_IDS) poolAgents.set(id, writePoolAgent(id));

  forks = createForkStore({
    db,
    getForksDir: () => forksDir,
    getPoolAgent: (poolId) => poolAgents.get(poolId) ?? null,
  });
  membership = createMembershipStore(db);
  const access = createAccessResolver({ membership, forks });
  const teamNames = new Map([
    ["team-red", "Red"],
    ["team-blue", "Blue"],
    ["team-green", "Green"],
  ]);
  catalog = createPoolCatalogResolver({
    forks,
    access,
    isAgentRunnable: () => true,
    getTeamName: (teamId) => teamNames.get(teamId) ?? null,
  });

  // scribe → red, sage → blue, scout → green; orphan is forked but teamless;
  // fresh is never forked.
  forks.forkAndAssign("scribe", "team-red", "admin-1");
  forks.forkAndAssign("sage", "team-blue", "admin-1");
  forks.forkAndAssign("scout", "team-green", "admin-1");
  forks.forkAndAssign("orphan", "team-red", "admin-1");
  forks.unassign("orphan");

  // alice ∈ {red, blue}; bob ∈ {green}; loner ∈ {} (teamless).
  membership.addMember("team-red", "alice", "admin-1");
  membership.addMember("team-blue", "alice", "admin-1");
  membership.addMember("team-green", "bob", "admin-1");
});

afterEach(() => {
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

const forkId = (poolId: string) => poolId;

describe("resolvePoolAction — chat", () => {
  it("returns chat with the fork agent id when a member shares the team", () => {
    const entry = catalog.resolvePoolAction("scribe", member("alice"));
    expect(entry).toEqual({
      poolId: "scribe",
      forked: true,
      chatAgentId: forkId("scribe"),
      action: "chat",
      reason: null,
      teamName: null,
    });
    // alice also shares blue → sage chattable.
    expect(catalog.resolvePoolAction("sage", member("alice")).action).toBe(
      "chat"
    );
  });

  it("gives staff a usable chat for any existing fork regardless of team", () => {
    // admin belongs to no team but still chats every forked (team-linked) pool.
    for (const id of ["scribe", "sage", "scout"]) {
      const entry = catalog.resolvePoolAction(id, staff("admin-1"));
      expect(entry.action).toBe("chat");
      expect(entry.chatAgentId).toBe(forkId(id));
    }
  });
});

describe("resolvePoolAction — assign_to_team", () => {
  it("offers assign_to_team to staff when no fork exists yet", () => {
    const entry = catalog.resolvePoolAction("fresh", staff("admin-1"));
    expect(entry).toEqual({
      poolId: "fresh",
      forked: false,
      chatAgentId: null,
      action: "assign_to_team",
      reason: null,
      teamName: null,
    });
  });

  it("does NOT offer assign_to_team to a non-staff user", () => {
    const entry = catalog.resolvePoolAction("fresh", member("alice"));
    expect(entry.action).toBe("none");
    expect(entry.reason).toBe("unassigned");
    expect(entry.teamName).toBeNull();
  });
});

describe("resolvePoolAction — none (visible but not chattable)", () => {
  it("is none when a member shares no team with the fork", () => {
    // alice ∈ red+blue, not green → scout is visible but not chattable.
    const entry = catalog.resolvePoolAction("scout", member("alice"));
    expect(entry).toEqual({
      poolId: "scout",
      forked: true,
      chatAgentId: null,
      action: "none",
      reason: "other_team",
      teamName: "Green",
    });
  });

  it("is none for a teamless fork (member or non-staff)", () => {
    const aliceEntry = catalog.resolvePoolAction("orphan", member("alice"));
    expect(aliceEntry.action).toBe("none");
    expect(aliceEntry.reason).toBe("unassigned");
    expect(aliceEntry.teamName).toBeNull();
    const bobEntry = catalog.resolvePoolAction("orphan", member("bob"));
    expect(bobEntry.action).toBe("none");
    expect(bobEntry.reason).toBe("unassigned");
  });

  it("is none for a teamless user across every fork", () => {
    for (const id of ["scribe", "sage", "scout", "orphan"]) {
      expect(catalog.resolvePoolAction(id, member("loner")).action).toBe(
        "none"
      );
    }
    // Teamless (loner) sees other_team + the fork's team name for a
    // team-linked fork they don't belong to...
    const scribeEntry = catalog.resolvePoolAction("scribe", member("loner"));
    expect(scribeEntry.reason).toBe("other_team");
    expect(scribeEntry.teamName).toBe("Red");
    // ...but unassigned for the teamless fork.
    expect(
      catalog.resolvePoolAction("orphan", member("loner")).reason
    ).toBe("unassigned");
  });

  it("is none for a not-yet-forked pool agent when the user is not staff", () => {
    const entry = catalog.resolvePoolAction("fresh", member("loner"));
    expect(entry.action).toBe("none");
    expect(entry.reason).toBe("unassigned");
  });
});

describe("resolvePoolAction — staff on a teamless fork", () => {
  it("still gives staff chat on a teamless fork", () => {
    // Staff bypass means even a teamless fork is chattable by staff.
    const entry = catalog.resolvePoolAction("orphan", staff("admin-1"));
    expect(entry.action).toBe("chat");
    expect(entry.chatAgentId).toBe(forkId("orphan"));
  });

  it("gives staff assign_to_team on a not-yet-forked pool agent", () => {
    expect(catalog.resolvePoolAction("fresh", staff("admin-1")).action).toBe(
      "assign_to_team"
    );
  });
});

describe("resolvePoolAction — orphaned fork (agent not discoverable)", () => {
  it("is none for a member who would otherwise be able to chat", () => {
    // alice shares team-red with scribe, so she'd normally get chat — but the
    // fork's agent folder is gone, so the config loader can't discover it.
    const access = createAccessResolver({ membership, forks });
    const orphanedCatalog = createPoolCatalogResolver({
      forks,
      access,
      isAgentRunnable: (agentId) => agentId !== forkId("scribe"),
      getTeamName: (teamId) => (teamId === "team-red" ? "Red" : null),
    });
    const entry = orphanedCatalog.resolvePoolAction("scribe", member("alice"));
    expect(entry).toEqual({
      poolId: "scribe",
      forked: true,
      chatAgentId: null,
      action: "none",
      reason: "no_workspace",
      teamName: "Red",
    });
  });

  it("is none for staff too (nobody can chat an undiscoverable agent)", () => {
    const access = createAccessResolver({ membership, forks });
    const orphanedCatalog = createPoolCatalogResolver({
      forks,
      access,
      isAgentRunnable: (agentId) => agentId !== forkId("scribe"),
      getTeamName: (teamId) => (teamId === "team-red" ? "Red" : null),
    });
    const entry = orphanedCatalog.resolvePoolAction("scribe", staff("admin-1"));
    expect(entry).toEqual({
      poolId: "scribe",
      forked: true,
      chatAgentId: null,
      action: "none",
      reason: "no_workspace",
      teamName: "Red",
    });
  });
});

describe("resolvePoolActions — full catalog", () => {
  it("resolves the whole pool in order for a member", () => {
    const entries = catalog.resolvePoolActions(POOL_IDS, member("alice"));
    expect(entries.map((e) => e.poolId)).toEqual(POOL_IDS);
    expect(entries.map((e) => e.action)).toEqual([
      "chat", // scribe (red)
      "chat", // sage (blue)
      "none", // scout (green, not shared)
      "none", // orphan (teamless)
      "none", // fresh (unforked, not staff)
    ]);
  });

  it("resolves the whole pool for staff (chat where forked, assign where not)", () => {
    const entries = catalog.resolvePoolActions(POOL_IDS, staff("admin-1"));
    expect(entries.map((e) => e.action)).toEqual([
      "chat", // scribe
      "chat", // sage
      "chat", // scout
      "chat", // orphan (teamless, but staff bypass)
      "assign_to_team", // fresh (no fork yet)
    ]);
  });

  it("resolves everything to none for a teamless non-staff user", () => {
    const entries = catalog.resolvePoolActions(POOL_IDS, member("loner"));
    expect(entries.every((e) => e.action === "none")).toBe(true);
  });
});
