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
import { createAccessResolver, type AccessResolver } from "./access.js";

let db: Database.Database;
let forks: ForkStore;
let membership: MembershipStore;
let resolver: AccessResolver;
let poolDir: string;
let forksDir: string;
const tempDirs: string[] = [];

function writePoolAgent(id: string): PoolAgentRef {
  const dir = path.join(poolDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent.yaml"),
    `id: ${id}\nname: ${id}\n`
  );
  return { id, workspaceDir: dir };
}

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-access-"));
  tempDirs.push(home);
  poolDir = path.join(home, "pool");
  forksDir = path.join(home, "agents");
  fs.mkdirSync(poolDir, { recursive: true });

  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
  const insertUser = db.prepare("INSERT INTO user (id) VALUES (?)");
  for (const u of ["admin-1", "alice", "bob", "carol", "loner"]) {
    insertUser.run(u);
  }
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
  for (const id of ["scribe", "sage", "scout", "orphan"]) {
    poolAgents.set(id, writePoolAgent(id));
  }

  forks = createForkStore({
    db,
    getForksDir: () => forksDir,
    getPoolAgent: (poolId) => poolAgents.get(poolId) ?? null,
  });
  membership = createMembershipStore(db);
  resolver = createAccessResolver({ membership, forks });

  // team-red owns scribe; team-blue owns sage; team-green owns scout.
  forks.setTeams("scribe", { mode: "list", teamIds: ["team-red"] }, "admin-1");
  forks.setTeams("sage", { mode: "list", teamIds: ["team-blue"] }, "admin-1");
  forks.setTeams("scout", { mode: "list", teamIds: ["team-green"] }, "admin-1");
  // orphan is forked but left teamless (unassigned).
  forks.setTeams("orphan", { mode: "list", teamIds: [] }, "admin-1");

  // alice ∈ {red, blue}; bob ∈ {green}; carol ∈ {}; loner ∈ {} (teamless).
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

describe("canUserChatAgent", () => {
  it("allows a user who shares the fork's team", () => {
    expect(resolver.canUserChatAgent("alice", forkId("scribe"))).toBe(true);
    expect(resolver.canUserChatAgent("alice", forkId("sage"))).toBe(true);
    expect(resolver.canUserChatAgent("bob", forkId("scout"))).toBe(true);
  });

  it("denies a user who shares no team with the fork", () => {
    // alice is in red+blue but not green → cannot chat scout.
    expect(resolver.canUserChatAgent("alice", forkId("scout"))).toBe(false);
    // bob is only in green → cannot chat scribe/sage.
    expect(resolver.canUserChatAgent("bob", forkId("scribe"))).toBe(false);
    expect(resolver.canUserChatAgent("bob", forkId("sage"))).toBe(false);
  });

  it("denies a teamless user access to everything", () => {
    expect(resolver.canUserChatAgent("loner", forkId("scribe"))).toBe(false);
    expect(resolver.canUserChatAgent("loner", forkId("sage"))).toBe(false);
    expect(resolver.canUserChatAgent("loner", forkId("scout"))).toBe(false);
  });

  it("denies everyone a teamless fork", () => {
    expect(resolver.canUserChatAgent("alice", forkId("orphan"))).toBe(false);
    expect(resolver.canUserChatAgent("bob", forkId("orphan"))).toBe(false);
  });

  it("denies an unknown agent id", () => {
    expect(resolver.canUserChatAgent("alice", "does-not-exist")).toBe(
      false
    );
  });
});

describe("getVisibleChatAgents", () => {
  it("returns the union of chattable forks across a user's teams", () => {
    // alice ∈ red (scribe) + blue (sage) → both, sorted.
    expect(resolver.getVisibleChatAgents("alice")).toEqual([
      forkId("sage"),
      forkId("scribe"),
    ]);
  });

  it("returns only the forks of the single team a user belongs to", () => {
    expect(resolver.getVisibleChatAgents("bob")).toEqual([forkId("scout")]);
  });

  it("returns an empty set for a teamless user", () => {
    expect(resolver.getVisibleChatAgents("loner")).toEqual([]);
    expect(resolver.getVisibleChatAgents("carol")).toEqual([]);
  });

  it("never includes a teamless fork", () => {
    const visible = resolver.getVisibleChatAgents("alice");
    expect(visible).not.toContain(forkId("orphan"));
  });
});
