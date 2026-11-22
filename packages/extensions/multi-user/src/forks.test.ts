import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgentForksTable, ensureTeamsTable } from "./db.js";
import { createForkStore, type ForkStore } from "./forks.js";

let db: Database.Database;
let store: ForkStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO user (id) VALUES (?)").run("admin-1");
  ensureTeamsTable(db);
  ensureAgentForksTable(db);
  db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(
    "team-a",
    "Team A",
    "admin-1"
  );
  db.prepare("INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)").run(
    "team-b",
    "Team B",
    "admin-1"
  );

  store = createForkStore({ db, agentExists: (id) => id === "scribe" });
});

afterEach(() => db.close());

describe("fork store", () => {
  it("keeps visibility private by default and changes it without changing ownership", () => {
    const fork = store.setTeams("scribe", { mode: "list", teamIds: ["team-a"] }, "admin-1");
    expect(fork.public).toBe(false);
    expect(store.setPublic("scribe", true, "admin-1")).toMatchObject({ public: true, assignment: { mode: "list", teamIds: ["team-a"] } });
    expect(store.getForkByAgentId("scribe")?.public).toBe(true);
    expect(store.setPublic("scribe", false, "admin-1").public).toBe(false);
  });

  it("setTeams replaces the explicit list without duplicating", () => {
    store.setTeams("scribe", { mode: "list", teamIds: ["team-a"] }, "admin-1");
    const moved = store.setTeams("scribe", { mode: "list", teamIds: ["team-b"] }, "admin-1");

    expect(moved.assignment).toEqual({ mode: "list", teamIds: ["team-b"] });
    expect(store.listForksForTeam("team-a")).toHaveLength(0);
    expect(store.listForksForTeam("team-b")).toHaveLength(1);
    expect(store.listForks()).toHaveLength(1);
  });

  it("keeps multiple team links explicit and rejects retired assignment mode", () => {
    store.setTeams("scribe", { mode: "list", teamIds: ["team-a", "team-b"] }, "admin-1");
    expect(store.listForksForTeam("team-a")).toHaveLength(1);
    expect(store.listForksForTeam("team-b")).toHaveLength(1);
    expect(() => store.setTeams("scribe", JSON.parse('{"mode":"all"}'), "admin-1")).toThrow(/assignment/i);
    expect(store.removeTeam("scribe", "team-a").assignment).toEqual({ mode: "list", teamIds: ["team-b"] });
    expect(store.listForksForTeam("team-c")).toEqual([]);
  });

  it("an empty list keeps the access record Private and teamless", () => {
    store.setTeams("scribe", { mode: "list", teamIds: ["team-a"] }, "admin-1");

    const inert = store.setTeams("scribe", { mode: "list", teamIds: [] }, "admin-1");
    expect(inert.assignment).toEqual({ mode: "list", teamIds: [] });
    expect(store.getForkByAgentId("scribe")?.public).toBe(false);
  });

  it("rejects assigning an unknown agent", () => {
    expect(() => store.setTeams("ghost", { mode: "list", teamIds: ["team-a"] }, "admin-1")).toThrow(
      /Agent not found/
    );
  });

});
