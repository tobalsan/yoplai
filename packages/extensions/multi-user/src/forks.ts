import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Directory entries excluded when copying a pool workspace into an agent. These
 * are per-instance runtime artifacts (secrets, agent scratch data, uploads),
 * never part of the shared read-only definition, so a fresh fork must start
 * without them. Adapted from the `agent-templates` branch `FORK_EXCLUDES`.
 */
export const FORK_EXCLUDES = new Set([".env", "data", "uploads"]);

/**
 * A fork's runnable agent id matches its source pool id. The fork row carries
 * the provenance link, while the on-disk agent stays simple: `agents/<poolId>`.
 * The id doubles as the fork folder basename, which the gateway config loader
 * requires to equal the `agent.yaml` id.
 */
export function forkIdForPool(poolId: string): string {
  return poolId;
}

/**
 * The provenance link row: `sourcePoolId -> forkAgentId -> teamId`. `teamId` is
 * null when the fork is teamless/inert (never assigned, or unassigned). The
 * who/when columns record both the original fork (`createdBy`/`createdAt`) and
 * the latest team (re)assignment (`assignedBy`/`assignedAt`, null while
 * teamless).
 */
export type AgentFork = {
  sourcePoolId: string;
  forkAgentId: string;
  teamId: string | null;
  createdBy: string;
  createdAt: string;
  assignedBy: string | null;
  assignedAt: string | null;
};

/** Minimal shape of a discovered pool agent the store needs to fork it. */
export type PoolAgentRef = {
  id: string;
  workspaceDir: string;
};

export type ForkStoreDeps = {
  db: Database.Database;
  /** Resolves a pool agent id to its discovered definition, or null. */
  getPoolAgent(poolId: string): PoolAgentRef | null;
  /** Absolute directory the fork folders live in (covered by the agents glob). */
  getForksDir(): string;
  /** Re-run agent discovery so a freshly copied fork becomes runnable. */
  reloadConfig?(): void;
};

/** Thrown when assigning a pool id that does not resolve to a pool agent. */
export class PoolAgentNotFoundError extends Error {
  constructor(poolId: string) {
    super(`Pool agent ${poolId} not found`);
    this.name = "PoolAgentNotFoundError";
  }
}

/** Thrown when reassign/unassign targets a pool id that has never been forked. */
export class ForkNotFoundError extends Error {
  constructor(poolId: string) {
    super(`No fork exists for pool agent ${poolId}`);
    this.name = "ForkNotFoundError";
  }
}

export function isPoolAgentNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "PoolAgentNotFoundError";
}

export function isForkNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "ForkNotFoundError";
}

export type ForkStore = {
  /**
   * Assign a pool agent to a team. On first assignment this copies the pool
   * workspace into the forks dir, rewrites the copied `agent.yaml` id to the
   * fork id, and writes the link row. If a fork already exists it is reused
   * (fork-once) and its team link is updated — no second folder is created.
   */
  forkAndAssign(poolId: string, teamId: string, assignedBy: string): AgentFork;
  /** Move an existing fork's link to a different team (single-team invariant). */
  reassign(poolId: string, teamId: string, assignedBy: string): AgentFork;
  /** Clear the team link while keeping the fork folder (teamless/inert). */
  unassign(poolId: string): AgentFork;
  getForkByPool(poolId: string): AgentFork | null;
  /** Resolve a fork by its agent id (the chat/list surface key). */
  getForkByAgentId(forkAgentId: string): AgentFork | null;
  listForks(): AgentFork[];
  listForksForTeam(teamId: string): AgentFork[];
};

type ForkRow = {
  sourcePoolId: string;
  forkAgentId: string;
  teamId: string | null;
  createdBy: string;
  createdAt: string;
  assignedBy: string | null;
  assignedAt: string | null;
};

/**
 * Copy `sourceDir` into `destDir`, skipping {@link FORK_EXCLUDES} at the top
 * level. The copy is otherwise byte-for-byte: no per-team customization is
 * applied here.
 */
function copyWorkspace(sourceDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (FORK_EXCLUDES.has(entry.name)) continue;
    const from = path.join(sourceDir, entry.name);
    const to = path.join(destDir, entry.name);
    fs.cpSync(from, to, { recursive: true });
  }
}

/**
 * Ensure the top-level `id:` value in an `agent.yaml` matches `forkId`, leaving
 * the rest of the file untouched. A line-scoped rewrite avoids a YAML round-trip
 * if the copied file ever needs normalization.
 */
function rewriteAgentYamlId(agentYamlPath: string, forkId: string): void {
  const original = fs.readFileSync(agentYamlPath, "utf8");
  // Match the first top-level (column-0) `id:` key.
  const idLine = /^id:[ \t]*\S.*$/m;
  if (!idLine.test(original)) {
    throw new Error(`agent.yaml at ${agentYamlPath} has no top-level id field`);
  }
  const rewritten = original.replace(idLine, `id: ${forkId}`);
  fs.writeFileSync(agentYamlPath, rewritten);
}

function rowToFork(row: ForkRow): AgentFork {
  return { ...row };
}

export function createForkStore(deps: ForkStoreDeps): ForkStore {
  const { db, getPoolAgent, getForksDir, reloadConfig } = deps;

  const getByPoolStatement = db.prepare(
    "SELECT sourcePoolId, forkAgentId, teamId, createdBy, createdAt, assignedBy, assignedAt FROM agent_forks WHERE sourcePoolId = ?"
  );
  const getByAgentIdStatement = db.prepare(
    "SELECT sourcePoolId, forkAgentId, teamId, createdBy, createdAt, assignedBy, assignedAt FROM agent_forks WHERE forkAgentId = ?"
  );
  const listStatement = db.prepare(
    "SELECT sourcePoolId, forkAgentId, teamId, createdBy, createdAt, assignedBy, assignedAt FROM agent_forks ORDER BY forkAgentId"
  );
  const listForTeamStatement = db.prepare(
    "SELECT sourcePoolId, forkAgentId, teamId, createdBy, createdAt, assignedBy, assignedAt FROM agent_forks WHERE teamId = ? ORDER BY forkAgentId"
  );
  const insertStatement = db.prepare(`
    INSERT INTO agent_forks (sourcePoolId, forkAgentId, teamId, createdBy, assignedBy, assignedAt)
    VALUES (@sourcePoolId, @forkAgentId, @teamId, @createdBy, @assignedBy, CURRENT_TIMESTAMP)
  `);
  const updateTeamStatement = db.prepare(
    "UPDATE agent_forks SET teamId = ?, assignedBy = ?, assignedAt = CURRENT_TIMESTAMP WHERE sourcePoolId = ?"
  );
  const clearTeamStatement = db.prepare(
    "UPDATE agent_forks SET teamId = NULL, assignedBy = NULL, assignedAt = NULL WHERE sourcePoolId = ?"
  );

  function getForkByPool(poolId: string): AgentFork | null {
    const row = getByPoolStatement.get(poolId) as ForkRow | undefined;
    return row ? rowToFork(row) : null;
  }

  function getForkByAgentId(forkAgentId: string): AgentFork | null {
    const row = getByAgentIdStatement.get(forkAgentId) as ForkRow | undefined;
    return row ? rowToFork(row) : null;
  }

  function requireFork(poolId: string): AgentFork {
    const fork = getForkByPool(poolId);
    if (!fork) throw new ForkNotFoundError(poolId);
    return fork;
  }

  function createFork(poolId: string, assignedBy: string): void {
    const pool = getPoolAgent(poolId);
    if (!pool) throw new PoolAgentNotFoundError(poolId);

    const forkId = forkIdForPool(poolId);
    const destDir = path.join(getForksDir(), forkId);

    // The link row is the source of truth for "already forked"; if the folder
    // somehow lingers from a prior run without a row, replace it so the copy is
    // a clean, byte-for-byte reflection of the current pool source.
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true });
    }

    try {
      copyWorkspace(pool.workspaceDir, destDir);
      rewriteAgentYamlId(path.join(destDir, "agent.yaml"), forkId);
      insertStatement.run({
        sourcePoolId: poolId,
        forkAgentId: forkId,
        teamId: null,
        createdBy: assignedBy,
        assignedBy: null,
      });
    } catch (error) {
      // A failed copy/YAML rewrite/row insert is not a fork. Remove the partial
      // folder so a corrected pool definition can be retried cleanly.
      fs.rmSync(destDir, { recursive: true, force: true });
      throw error;
    }

    // Make the new fork discoverable through the agents glob immediately.
    // Keep this outside rollback: once the row and complete folder exist the
    // fork is durable, even if config reload itself reports another problem.
    reloadConfig?.();
  }

  return {
    forkAndAssign(poolId, teamId, assignedBy) {
      // Fork-once: only copy + insert when no fork exists yet. An already
      // forked pool reuses its single fork and simply (re)points the link.
      if (!getForkByPool(poolId)) {
        createFork(poolId, assignedBy);
      }
      updateTeamStatement.run(teamId, assignedBy, poolId);
      return requireFork(poolId);
    },
    reassign(poolId, teamId, assignedBy) {
      // reassign never creates a fork: it moves the existing single fork's link
      // to a new team, preserving the one-fork / one-team invariants.
      requireFork(poolId);
      updateTeamStatement.run(teamId, assignedBy, poolId);
      return requireFork(poolId);
    },
    unassign(poolId) {
      requireFork(poolId);
      // Clear the team link only; the fork folder and row persist so the fork
      // is teamless/inert rather than deleted.
      clearTeamStatement.run(poolId);
      return requireFork(poolId);
    },
    getForkByPool,
    getForkByAgentId,
    listForks() {
      return (listStatement.all() as ForkRow[]).map(rowToFork);
    },
    listForksForTeam(teamId) {
      return (listForTeamStatement.all(teamId) as ForkRow[]).map(rowToFork);
    },
  };
}
