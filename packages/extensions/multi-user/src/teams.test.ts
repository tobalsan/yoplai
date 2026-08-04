import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgentForksTable, ensureTeamsTable } from "./db.js";
import {
  DEFAULT_TEAM_COLOR,
  DEFAULT_TEAM_ICON,
  DuplicateTeamNameError,
  TeamNotFoundError,
  createTeamStore,
  type TeamStore,
} from "./teams.js";
import { createForkStore } from "./forks.js";

let db: Database.Database;
let store: TeamStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Minimal `user` table so the createdBy foreign key resolves.
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO user (id) VALUES (?)").run("admin-1");
  ensureTeamsTable(db);
  store = createTeamStore(db);
});

afterEach(() => {
  db.close();
});

describe("team store", () => {
  it("creates a team and lists it", () => {
    const team = store.createTeam({
      name: "Platform",
      description: "Core platform team",
      color: "#ff0000",
      icon: "fa-solid fa-rocket",
      createdBy: "admin-1",
    });

    expect(team).toMatchObject({
      name: "Platform",
      description: "Core platform team",
      color: "#ff0000",
      icon: "fa-solid fa-rocket",
      createdBy: "admin-1",
    });
    expect(team.id).toBeTruthy();
    expect(team.createdAt).toBeTruthy();

    const teams = store.listTeams();
    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe(team.id);
  });

  it("applies default color and icon when omitted", () => {
    const team = store.createTeam({ name: "Design", createdBy: "admin-1" });
    expect(team.color).toBe(DEFAULT_TEAM_COLOR);
    expect(team.icon).toBe(DEFAULT_TEAM_ICON);
    expect(team.description).toBeNull();

    // Re-read to confirm defaults resolve at read time, not just in memory.
    const fetched = store.getTeam(team.id);
    expect(fetched?.color).toBe(DEFAULT_TEAM_COLOR);
    expect(fetched?.icon).toBe(DEFAULT_TEAM_ICON);
  });

  it("treats blank color/icon as unset and falls back to defaults", () => {
    const team = store.createTeam({
      name: "QA",
      color: "   ",
      icon: "",
      createdBy: "admin-1",
    });
    expect(team.color).toBe(DEFAULT_TEAM_COLOR);
    expect(team.icon).toBe(DEFAULT_TEAM_ICON);
  });

  it("rejects duplicate names (case-insensitive)", () => {
    store.createTeam({ name: "Platform", createdBy: "admin-1" });
    expect(() =>
      store.createTeam({ name: "platform", createdBy: "admin-1" })
    ).toThrow(DuplicateTeamNameError);
  });

  it("edits name, description, color and icon", () => {
    const team = store.createTeam({ name: "Old", createdBy: "admin-1" });
    const updated = store.updateTeam(team.id, {
      name: "New",
      description: "updated",
      color: "#00ff00",
      icon: "fa-solid fa-star",
    });
    expect(updated).toMatchObject({
      id: team.id,
      name: "New",
      description: "updated",
      color: "#00ff00",
      icon: "fa-solid fa-star",
    });
  });

  it("clearing color/icon on edit restores defaults", () => {
    const team = store.createTeam({
      name: "Ops",
      color: "#123456",
      icon: "fa-solid fa-gear",
      createdBy: "admin-1",
    });
    const updated = store.updateTeam(team.id, { color: null, icon: null });
    expect(updated.color).toBe(DEFAULT_TEAM_COLOR);
    expect(updated.icon).toBe(DEFAULT_TEAM_ICON);
  });

  it("rejects an edit that would duplicate another team's name", () => {
    store.createTeam({ name: "Alpha", createdBy: "admin-1" });
    const beta = store.createTeam({ name: "Beta", createdBy: "admin-1" });
    expect(() => store.updateTeam(beta.id, { name: "alpha" })).toThrow(
      DuplicateTeamNameError
    );
  });

  it("throws when editing a missing team", () => {
    expect(() => store.updateTeam("nope", { name: "X" })).toThrow(
      TeamNotFoundError
    );
  });

  it("deletes a team and returns the teamless-set shape", () => {
    const team = store.createTeam({ name: "Temp", createdBy: "admin-1" });
    const result = store.deleteTeam(team.id);
    expect(result).toEqual({
      deleted: true,
      teamlessUsers: [],
      teamlessAgents: [],
    });
    expect(store.getTeam(team.id)).toBeNull();
    expect(store.listTeams()).toHaveLength(0);
  });

  it("throws when deleting a missing team", () => {
    expect(() => store.deleteTeam("nope")).toThrow(TeamNotFoundError);
  });
});

describe("team store deleteTeam teamlessAgents", () => {
  let fdb: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-team-forks-"));
    fdb = new Database(":memory:");
    fdb.pragma("foreign_keys = ON");
    fdb.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
    fdb.prepare("INSERT INTO user (id) VALUES (?)").run("admin-1");
    ensureTeamsTable(fdb);
    ensureAgentForksTable(fdb);
  });

  afterEach(() => {
    fdb.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("names forks assigned to the team as soon-to-be teamless", () => {
    const poolDir = path.join(tempDir, "pool", "scribe");
    fs.mkdirSync(poolDir, { recursive: true });
    fs.writeFileSync(path.join(poolDir, "agent.yaml"), "id: scribe\nname: scribe\n");

    const forks = createForkStore({
      db: fdb,
      getForksDir: () => path.join(tempDir, "agents"),
      getPoolAgent: (poolId) =>
        poolId === "scribe" ? { id: "scribe", workspaceDir: poolDir } : null,
    });
    const teamStore = createTeamStore(fdb, undefined, () => forks);
    const team = teamStore.createTeam({ name: "Team A", createdBy: "admin-1" });
    forks.setTeams("scribe", { mode: "list", teamIds: [team.id] }, "admin-1");

    const result = teamStore.deleteTeam(team.id);
    expect(result.deleted).toBe(true);
    expect(result.teamlessAgents).toEqual(["scribe"]);
    // The fork row persists but its only explicit link is removed.
    expect(forks.getForkByPool("scribe")?.assignment).toEqual({ mode: "list", teamIds: [] });
  });
});
