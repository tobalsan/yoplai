import type Database from "better-sqlite3";

/**
 * Agent access and team assignment. `sourcePoolId` is retained for compatibility. `teamId` is
 * null when the fork has no legacy owner link; assignment holds current owners. The
 * who/when columns record both the original fork (`createdBy`/`createdAt`) and
 * the latest team (re)assignment (`assignedBy`/`assignedAt`, null while
 * teamless).
 */
export type AgentFork = {
  sourcePoolId: string;
  forkAgentId: string;
  teamId: string | null;
  assignment: AgentTeamAssignment;
  public: boolean;
  createdBy: string;
  createdAt: string;
  assignedBy: string | null;
  assignedAt: string | null;
};

export type AgentTeamAssignment = { mode: "list"; teamIds: string[] };

export type ForkStoreDeps = {
  db: Database.Database;
  agentExists(agentId: string): boolean;
};

export class AgentNotFoundError extends Error {
  constructor() {
    super("Agent not found");
    this.name = "AgentNotFoundError";
  }
}

export class ForkNotFoundError extends Error {
  constructor(agentId: string) {
    super(`No access record for agent ${agentId}`);
    this.name = "ForkNotFoundError";
  }
}

export function isAgentNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "AgentNotFoundError";
}

export function isForkNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "ForkNotFoundError";
}

export type ForkStore = {
  reservePrivate(agentId: string, creator: string): () => void;
  setTeams(agentId: string, assignment: AgentTeamAssignment, assignedBy: string): AgentFork;
  setPublic(agentId: string, publicValue: boolean, actorId: string): AgentFork;
  removeTeam(agentId: string, teamId: string): AgentFork;
  getForkByPool(poolId: string): AgentFork | null;
  getForkByAgentId(agentId: string): AgentFork | null;
  listForks(): AgentFork[];
  listForksForTeam(teamId: string): AgentFork[];
  listTeamsForFork(poolId: string): string[];
};

type ForkRow = {
  sourcePoolId: string;
  forkAgentId: string;
  teamId: string | null;
  createdBy: string;
  createdAt: string;
  assignedBy: string | null;
  assignedAt: string | null;
  public: number;
};

export function createForkStore(deps: ForkStoreDeps): ForkStore {
  const { db, agentExists } = deps;

  const getByPoolStatement = db.prepare(
    "SELECT sourcePoolId, forkAgentId, teamId, createdBy, createdAt, assignedBy, assignedAt, public FROM agent_forks WHERE sourcePoolId = ?"
  );
  const getByAgentIdStatement = db.prepare(
    "SELECT sourcePoolId, forkAgentId, teamId, createdBy, createdAt, assignedBy, assignedAt, public FROM agent_forks WHERE forkAgentId = ?"
  );
  const listStatement = db.prepare(
    "SELECT sourcePoolId, forkAgentId, teamId, createdBy, createdAt, assignedBy, assignedAt, public FROM agent_forks ORDER BY forkAgentId"
  );
  const listForTeamStatement = db.prepare(
    "SELECT f.sourcePoolId, f.forkAgentId, f.teamId, f.createdBy, f.createdAt, f.assignedBy, f.assignedAt, f.public FROM agent_forks f WHERE EXISTS (SELECT 1 FROM agent_fork_teams l WHERE l.forkAgentId = f.forkAgentId AND l.teamId = ?) ORDER BY f.forkAgentId"
  );
  const insertStatement = db.prepare(`
    INSERT INTO agent_forks (sourcePoolId, forkAgentId, createdBy, assignedAt)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `);
  const insertPrivate = db.prepare("INSERT INTO agent_forks (sourcePoolId, forkAgentId, createdBy, public) VALUES (?, ?, ?, 0)");
  const forgetReservation = db.prepare("DELETE FROM agent_forks WHERE forkAgentId = ? AND createdBy = ?");
  const upsertVisibility = db.prepare(`
    INSERT INTO agent_forks (sourcePoolId, forkAgentId, createdBy, public)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(forkAgentId) DO UPDATE SET public = excluded.public
  `);
  const linksForFork = db.prepare("SELECT teamId FROM agent_fork_teams WHERE forkAgentId = ? ORDER BY teamId");
  const clearLinks = db.prepare("DELETE FROM agent_fork_teams WHERE forkAgentId = ?");
  const insertLink = db.prepare("INSERT INTO agent_fork_teams (forkAgentId, teamId, assignedBy) VALUES (?, ?, ?)");

  function rowToFork(row: ForkRow): AgentFork {
    const teamIds = (linksForFork.all(row.forkAgentId) as Array<{ teamId: string }>).map((link) => link.teamId);
    return { ...row, public: Boolean(row.public), assignment: { mode: "list", teamIds } };
  }

  function getForkByPool(poolId: string): AgentFork | null {
    const row = getByPoolStatement.get(poolId) as ForkRow | undefined;
    return row ? rowToFork(row) : null;
  }

  function getForkByAgentId(forkAgentId: string): AgentFork | null {
    const row = getByAgentIdStatement.get(forkAgentId) as ForkRow | undefined;
    return row ? rowToFork(row) : null;
  }

  function requireFork(agentId: string): AgentFork {
    const fork = getForkByAgentId(agentId);
    if (!fork) throw new ForkNotFoundError(agentId);
    return fork;
  }

  const replaceTeams = db.transaction((agentId: string, assignment: AgentTeamAssignment, assignedBy: string) => {
    if (!agentExists(agentId)) throw new AgentNotFoundError();
    if (!getForkByAgentId(agentId)) {
      insertStatement.run(agentId, agentId, assignedBy);
    }
    clearLinks.run(agentId);
    for (const teamId of new Set(assignment.teamIds)) insertLink.run(agentId, teamId, assignedBy);
    return requireFork(agentId);
  });

  return {
    reservePrivate(agentId, creator) {
      insertPrivate.run(agentId, agentId, creator);
      return () => { forgetReservation.run(agentId, creator); };
    },
    setTeams(agentId, assignment, assignedBy) {
      if (assignment.mode !== "list") throw new Error("Unsupported agent assignment mode");
      return replaceTeams.immediate(agentId, assignment, assignedBy);
    },
    setPublic(agentId, publicValue, actorId) {
      if (!agentExists(agentId)) throw new AgentNotFoundError();
      upsertVisibility.run(agentId, agentId, actorId, publicValue ? 1 : 0);
      return requireFork(agentId);
    },
    removeTeam(agentId, teamId) {
      requireFork(agentId);
      db.prepare("DELETE FROM agent_fork_teams WHERE forkAgentId = ? AND teamId = ?").run(agentId, teamId);
      return requireFork(agentId);
    },
    getForkByPool,
    getForkByAgentId,
    listForks() {
      return (listStatement.all() as ForkRow[]).map(rowToFork);
    },
    listForksForTeam(teamId) {
      return (listForTeamStatement.all(teamId) as ForkRow[]).map(rowToFork);
    },
    listTeamsForFork(poolId) {
      const fork = requireFork(poolId);
      return fork.assignment.teamIds;
    },
  };
}
