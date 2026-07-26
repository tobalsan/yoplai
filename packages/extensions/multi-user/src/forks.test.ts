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
  db.prepare(
    "INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)"
  ).run("team-a", "Team A", "admin-1");
  db.prepare(
    "INSERT INTO teams (id, name, createdBy) VALUES (?, ?, ?)"
  ).run("team-b", "Team B", "admin-1");

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
  it("forkAndAssign copies the folder and writes the link row", () => {
    const fork = store.forkAndAssign("scribe", "team-a", "admin-1");

    const forkId = forkIdForPool("scribe");
    expect(forkId).toBe("scribe");
    expect(fork.forkAgentId).toBe(forkId);
    expect(fork.sourcePoolId).toBe("scribe");
    expect(fork.teamId).toBe("team-a");
    expect(fork.createdBy).toBe("admin-1");
    expect(fork.assignedBy).toBe("admin-1");

    const forkFolder = path.join(forksDir, forkId);
    expect(fs.existsSync(forkFolder)).toBe(true);
    // Copied content.
    expect(fs.readFileSync(path.join(forkFolder, "SOUL.md"), "utf8")).toBe(
      "pool soul\n"
    );
    // agent.yaml id matches the fork folder basename.
    const yaml = fs.readFileSync(
      path.join(forkFolder, "agent.yaml"),
      "utf8"
    );
    expect(yaml).toContain(`id: ${forkId}`);
    expect(yaml).toContain("name: scribe");
    // Excluded runtime artifacts are not copied.
    expect(fs.existsSync(path.join(forkFolder, ".env"))).toBe(false);
    expect(fs.existsSync(path.join(forkFolder, "data"))).toBe(false);
    // Discovery reload was triggered so the fork becomes runnable.
    expect(reloadCount).toBe(1);
  });

  it("enforces fork-once: re-assigning reuses the single fork", () => {
    const first = store.forkAndAssign("scribe", "team-a", "admin-1");
    const forkFolder = path.join(forksDir, first.forkAgentId);
    // Mutate the fork folder so we can detect an unwanted re-copy.
    fs.writeFileSync(path.join(forkFolder, "marker.txt"), "keep-me\n");

    const second = store.forkAndAssign("scribe", "team-b", "admin-1");

    expect(second.forkAgentId).toBe(first.forkAgentId);
    expect(second.teamId).toBe("team-b");
    expect(store.listForks()).toHaveLength(1);
    // The folder was not re-copied: the marker survives.
    expect(fs.existsSync(path.join(forkFolder, "marker.txt"))).toBe(true);
    // Only the first assignment forked; the second reused it (no extra reload
    // from a copy).
    expect(reloadCount).toBe(1);
  });

  it("reassign moves the single fork to another team (no duplicate)", () => {
    store.forkAndAssign("scribe", "team-a", "admin-1");
    const moved = store.reassign("scribe", "team-b", "admin-1");

    expect(moved.teamId).toBe("team-b");
    expect(store.listForksForTeam("team-a")).toHaveLength(0);
    expect(store.listForksForTeam("team-b")).toHaveLength(1);
    expect(store.listForks()).toHaveLength(1);
  });

  it("unassign clears the team link but keeps the fork folder", () => {
    const fork = store.forkAndAssign("scribe", "team-a", "admin-1");
    const forkFolder = path.join(forksDir, fork.forkAgentId);

    const inert = store.unassign("scribe");
    expect(inert.teamId).toBeNull();
    expect(inert.assignedBy).toBeNull();
    expect(inert.assignedAt).toBeNull();
    // Fork row + folder persist (teamless/inert, never deleted).
    expect(store.getForkByPool("scribe")).not.toBeNull();
    expect(fs.existsSync(forkFolder)).toBe(true);
  });

  it("rejects assigning an unknown pool id", () => {
    expect(() => store.forkAndAssign("ghost", "team-a", "admin-1")).toThrow(
      /Pool agent ghost not found/
    );
  });

  it("rejects reassign/unassign when no fork exists", () => {
    expect(() => store.reassign("scribe", "team-a", "admin-1")).toThrow(
      /No fork exists/
    );
    expect(() => store.unassign("scribe")).toThrow(/No fork exists/);
  });
});
