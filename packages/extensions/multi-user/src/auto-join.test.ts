import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ensureTeamsTable, ensureTeamMembersTable } from "./db.js";
import { createTeamStore } from "./teams.js";
import { createMembershipStore } from "./membership.js";
import { autoJoinPublicTeams } from "./auto-join.js";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(
    "CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user (id) VALUES ('admin'), ('new-user')"
  );
  ensureTeamsTable(db);
  ensureTeamMembersTable(db);
});
afterEach(() => db.close());

it("joins public teams once, skipping private and All users saved memberships", () => {
  const teams = createTeamStore(db);
  const membership = createMembershipStore(db);
  const publicTeam = teams.createTeam({ name: "Public", createdBy: "admin" });
  const privateTeam = teams.createTeam({
    name: "Private",
    private: true,
    createdBy: "admin",
  });
  const allTeam = teams.createTeam({ name: "All", createdBy: "admin" });
  membership.setMembers(allTeam.id, { mode: "all" }, "admin");
  autoJoinPublicTeams(db, "new-user");
  autoJoinPublicTeams(db, "new-user");
  expect(membership.listUsersForTeam(publicTeam.id)).toEqual(["new-user"]);
  expect(membership.isMember(privateTeam.id, "new-user")).toBe(false);
  expect(membership.listSavedMemberProfilesForTeam(allTeam.id)).toEqual([]);
  membership.setMembers(allTeam.id, { mode: "list", userIds: [] }, "admin");
  expect(membership.isMember(allTeam.id, "new-user")).toBe(false);
  membership.removeMember(publicTeam.id, "new-user");
  teams.updateTeam(privateTeam.id, { private: false });
  teams.updateTeam(publicTeam.id, { private: true });
  expect(membership.listTeamsForUser("new-user")).toEqual([]);
});

it("does nothing with no teams", () => {
  autoJoinPublicTeams(db, "new-user");
  expect(createMembershipStore(db).listTeamsForUser("new-user")).toEqual([]);
});
