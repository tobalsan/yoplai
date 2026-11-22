import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureAgentForksTable,
  ensureTeamMembersTable,
  ensureTeamsTable,
} from "./db.js";
import { createForkStore, type ForkStore } from "./forks.js";
import { createMembershipStore, type MembershipStore } from "./membership.js";
import { createAccessResolver, type AccessResolver } from "./access.js";

let db: Database.Database;
let forks: ForkStore;
let membership: MembershipStore;
let resolver: AccessResolver;

function addMember(teamId: string, userId: string): void {
  const current = membership.getMembership(teamId);
  if (current.mode !== "list") throw new Error("expected explicit team");
  membership.setMembers(teamId, { mode: "list", userIds: [...current.userIds, userId] }, "admin-1");
}

beforeEach(() => {
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

  forks = createForkStore({ db, agentExists: (id) => ["scribe", "sage", "scout", "orphan"].includes(id) });
  membership = createMembershipStore(db);
  resolver = createAccessResolver({ membership, forks });

  // team-red owns scribe; team-blue owns sage; team-green owns scout.
  forks.setTeams("scribe", { mode: "list", teamIds: ["team-red"] }, "admin-1");
  forks.setTeams("sage", { mode: "list", teamIds: ["team-blue"] }, "admin-1");
  forks.setTeams("scout", { mode: "list", teamIds: ["team-green"] }, "admin-1");
  // orphan is forked but left teamless (unassigned).
  forks.setTeams("orphan", { mode: "list", teamIds: [] }, "admin-1");

  // alice ∈ {red, blue}; bob ∈ {green}; carol ∈ {}; loner ∈ {} (teamless).
  addMember("team-red", "alice");
  addMember("team-blue", "alice");
  addMember("team-green", "bob");
});

afterEach(() => db.close());

describe("canUserChatAgent", () => {
  it("opens Public forks to teamless and foreign-team users while Private remains restricted", () => {
    forks.setPublic("scribe", true, "admin-1");
    forks.setPublic("orphan", true, "admin-1");
    expect(resolver.canUserChatAgent("loner", "scribe")).toBe(true);
    expect(resolver.canUserChatAgent("bob", "scribe")).toBe(true);
    expect(resolver.canUserChatAgent("loner", "orphan")).toBe(true);
    expect(resolver.getVisibleChatAgents("loner")).toEqual(["orphan", "scribe"]);
    forks.setPublic("orphan", false, "admin-1");
    expect(resolver.canUserChatAgent("alice", "orphan")).toBe(false);
    expect(resolver.canUserChatAgent("bob", "sage")).toBe(false);
  });
  it("allows a user who shares the fork's team", () => {
    expect(resolver.canUserChatAgent("alice", "scribe")).toBe(true);
    expect(resolver.canUserChatAgent("alice", "sage")).toBe(true);
    expect(resolver.canUserChatAgent("bob", "scout")).toBe(true);
  });

  it("denies a user who shares no team with the fork", () => {
    // alice is in red+blue but not green → cannot chat scout.
    expect(resolver.canUserChatAgent("alice", "scout")).toBe(false);
    // bob is only in green → cannot chat scribe/sage.
    expect(resolver.canUserChatAgent("bob", "scribe")).toBe(false);
    expect(resolver.canUserChatAgent("bob", "sage")).toBe(false);
  });

  it("denies a teamless user access to everything", () => {
    expect(resolver.canUserChatAgent("loner", "scribe")).toBe(false);
    expect(resolver.canUserChatAgent("loner", "sage")).toBe(false);
    expect(resolver.canUserChatAgent("loner", "scout")).toBe(false);
  });

  it("denies everyone a teamless fork", () => {
    expect(resolver.canUserChatAgent("alice", "orphan")).toBe(false);
    expect(resolver.canUserChatAgent("bob", "orphan")).toBe(false);
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
      "sage",
      "scribe",
    ]);
  });

  it("returns only the forks of the single team a user belongs to", () => {
    expect(resolver.getVisibleChatAgents("bob")).toEqual(["scout"]);
  });

  it("returns an empty set for a teamless user", () => {
    expect(resolver.getVisibleChatAgents("loner")).toEqual([]);
    expect(resolver.getVisibleChatAgents("carol")).toEqual([]);
  });

  it("never includes a teamless fork", () => {
    const visible = resolver.getVisibleChatAgents("alice");
    expect(visible).not.toContain("orphan");
  });

  it("grants every current and future user access through an All-users team", () => {
    membership.setMembers("team-red", { mode: "all" }, "admin-1");
    db.prepare("INSERT INTO user (id) VALUES (?)").run("new-user");

    expect(resolver.canUserChatAgent("carol", "scribe")).toBe(true);
    expect(resolver.canUserChatAgent("new-user", "scribe")).toBe(true);
  });

  it("deduplicates an agent reachable through explicit and All-users teams, and revokes immediately", () => {
    membership.setMembers("team-blue", { mode: "all" }, "admin-1");
    forks.setTeams("scribe", { mode: "list", teamIds: ["team-red", "team-blue"] }, "admin-1");

    expect(resolver.getVisibleChatAgents("alice").filter((id) => id === "scribe")).toEqual(["scribe"]);
    expect(resolver.canUserChatAgent("carol", "scribe")).toBe(true);

    membership.setMembers("team-blue", { mode: "list", userIds: [] }, "admin-1");
    expect(resolver.canUserChatAgent("carol", "scribe")).toBe(false);
  });
});
