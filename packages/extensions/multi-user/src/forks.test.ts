import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgentForksTable, ensureTeamsTable } from "./db.js";
import {
  createForkStore,
  forkIdForPool,
  type ForkStore,
  type PoolAgentRef,
} from "./forks.js";

let db: Database.Database;
let store: ForkStore;
let homeDir: string;
let poolDir: string;
let forksDir: string;
let reloadCount = 0;
const tempDirs: string[] = [];

function writePoolAgent(id: string): PoolAgentRef {
  const dir = path.join(poolDir, id);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "agent.yaml"),
    `id: ${id}\nname: ${id}\nmodel:\n  provider: anthropic\n  model: claude\n`
  );
  fs.writeFileSync(path.join(dir, "SOUL.md"), "pool soul\n");
  // Excluded runtime artifacts that must NOT be copied into a fork.
  fs.writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
  fs.writeFileSync(path.join(dir, "data", "state.json"), "{}\n");
  return { id, workspaceDir: dir };
}

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-forks-"));
  tempDirs.push(homeDir);
  poolDir = path.join(homeDir, "pool");
  forksDir = path.join(homeDir, "agents");
  fs.mkdirSync(poolDir, { recursive: true });
  reloadCount = 0;

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

  const poolAgents = new Map<string, PoolAgentRef>();
  poolAgents.set("scribe", writePoolAgent("scribe"));

  store = createForkStore({
    db,
    getForksDir: () => forksDir,
    getPoolAgent: (poolId) => poolAgents.get(poolId) ?? null,
    reloadConfig: () => {
      reloadCount += 1;
    },
  });
});

afterEach(() => {
  db.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("fork store", () => {
  it("setTeams copies the folder and writes the link row", () => {
    const fork = store.setTeams("scribe", { mode: "list", teamIds: ["team-a"] }, "admin-1");

    const forkId = forkIdForPool("scribe");
    expect(forkId).toBe("scribe");
    expect(fork.forkAgentId).toBe(forkId);
    expect(fork.sourcePoolId).toBe("scribe");
    expect(fork.assignment).toEqual({ mode: "list", teamIds: ["team-a"] });
    expect(fork.createdBy).toBe("admin-1");
    expect(fork.assignment).toEqual({ mode: "list", teamIds: ["team-a"] });

    const forkFolder = path.join(forksDir, forkId);
    expect(fs.existsSync(forkFolder)).toBe(true);
    // Copied content.
    expect(fs.readFileSync(path.join(forkFolder, "SOUL.md"), "utf8")).toBe(
      "pool soul\n"
    );
    // agent.yaml id matches the fork folder basename.
    const yaml = fs.readFileSync(path.join(forkFolder, "agent.yaml"), "utf8");
    expect(yaml).toContain(`id: ${forkId}`);
    expect(yaml).toContain("name: scribe");
    // Excluded runtime artifacts are not copied.
    expect(fs.existsSync(path.join(forkFolder, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(forkFolder, "data"))).toBe(false);
    // Discovery reload was triggered so the fork becomes runnable.
    expect(reloadCount).toBe(1);
  });

  it("enforces fork-once: re-assigning reuses the single fork", () => {
    const first = store.setTeams("scribe", { mode: "list", teamIds: ["team-a"] }, "admin-1");
    const forkFolder = path.join(forksDir, first.forkAgentId);
    // Mutate the fork folder so we can detect an unwanted re-copy.
    fs.writeFileSync(path.join(forkFolder, "marker.txt"), "keep-me\n");

    const second = store.setTeams("scribe", { mode: "list", teamIds: ["team-b"] }, "admin-1");

    expect(second.forkAgentId).toBe(first.forkAgentId);
    expect(second.assignment).toEqual({ mode: "list", teamIds: ["team-b"] });
    expect(store.listForks()).toHaveLength(1);
    // The folder was not re-copied: the marker survives.
    expect(fs.existsSync(path.join(forkFolder, "marker.txt"))).toBe(true);
    // Only the first assignment forked; the second reused it (no extra reload
    // from a copy).
    expect(reloadCount).toBe(1);
  });

  it("setTeams replaces the explicit list without duplicating", () => {
    store.setTeams("scribe", { mode: "list", teamIds: ["team-a"] }, "admin-1");
    const moved = store.setTeams("scribe", { mode: "list", teamIds: ["team-b"] }, "admin-1");

    expect(moved.assignment).toEqual({ mode: "list", teamIds: ["team-b"] });
    expect(store.listForksForTeam("team-a")).toHaveLength(0);
    expect(store.listForksForTeam("team-b")).toHaveLength(1);
    expect(store.listForks()).toHaveLength(1);
  });

  it("supports multiple teams, All teams, and leaving All with no remembered links", () => {
    store.setTeams("scribe", { mode: "list", teamIds: ["team-a", "team-b"] }, "admin-1");
    expect(store.listForksForTeam("team-a")).toHaveLength(1);
    expect(store.listForksForTeam("team-b")).toHaveLength(1);

    store.setTeams("scribe", { mode: "all" }, "admin-1");
    expect(store.listForksForTeam("team-c")).toHaveLength(1);
    expect(() => store.removeTeam("scribe", "team-a")).toThrow(/All-teams/);

    expect(store.setTeams("scribe", { mode: "list", teamIds: [] }, "admin-1").assignment).toEqual({ mode: "list", teamIds: [] });
    expect(store.listForksForTeam("team-a")).toHaveLength(0);
  });

  it("an empty list leaves the fork teamless but keeps its folder", () => {
    const fork = store.setTeams("scribe", { mode: "list", teamIds: ["team-a"] }, "admin-1");
    const forkFolder = path.join(forksDir, fork.forkAgentId);

    const inert = store.setTeams("scribe", { mode: "list", teamIds: [] }, "admin-1");
    expect(inert.assignment).toEqual({ mode: "list", teamIds: [] });
    // Fork row + folder persist (teamless/inert, never deleted).
    expect(store.getForkByPool("scribe")).not.toBeNull();
    expect(fs.existsSync(forkFolder)).toBe(true);
  });

  it("removes a partial fork when workspace validation fails", () => {
    const invalidPoolDir = path.join(poolDir, "invalid");
    fs.mkdirSync(invalidPoolDir, { recursive: true });
    fs.writeFileSync(
      path.join(invalidPoolDir, "agent.yaml"),
      "name: Invalid\n"
    );
    store = createForkStore({
      db,
      getForksDir: () => forksDir,
      getPoolAgent: (poolId) =>
        poolId === "invalid"
          ? { id: poolId, workspaceDir: invalidPoolDir }
          : null,
    });

    expect(() => store.setTeams("invalid", { mode: "list", teamIds: ["team-a"] }, "admin-1")).toThrow(
      /no top-level id field/
    );
    expect(fs.existsSync(path.join(forksDir, "invalid"))).toBe(false);
    expect(store.getForkByPool("invalid")).toBeNull();
  });

  it("rejects assigning an unknown pool id", () => {
    expect(() => store.setTeams("ghost", { mode: "list", teamIds: ["team-a"] }, "admin-1")).toThrow(
      /Pool agent ghost not found/
    );
  });

});
