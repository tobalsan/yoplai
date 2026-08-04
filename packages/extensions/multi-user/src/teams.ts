import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { MembershipStore } from "./membership.js";
import type { ForkStore } from "./forks.js";

export const DEFAULT_TEAM_COLOR = "#6b7280";
export const DEFAULT_TEAM_ICON = "fa-solid fa-users";

export type Team = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  allUsers: boolean;
  createdBy: string;
  createdAt: string;
};

export type CreateTeamInput = {
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  createdBy: string;
};

export type UpdateTeamInput = {
  name?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
};

/**
 * Returned by {@link TeamStore.deleteTeam}. The `users` and `agents` sets name
 * the members that would be left without any team once this team is removed.
 * `teamlessUsers` resolves from real membership; `teamlessAgents` lists the
 * fork agent ids whose team link would be cleared by this delete (the
 * teamId FK is ON DELETE SET NULL, so those forks become teamless/inert).
 */
export type DeleteTeamResult = {
  deleted: boolean;
  teamlessUsers: string[];
  teamlessAgents: string[];
};

/** Thrown when a create/edit would collide with an existing team name. */
export class DuplicateTeamNameError extends Error {
  constructor(name: string) {
    super(`A team named "${name}" already exists`);
    this.name = "DuplicateTeamNameError";
  }
}

/** Thrown when an edit/delete targets a team id that does not exist. */
export class TeamNotFoundError extends Error {
  constructor(id: string) {
    super(`Team ${id} not found`);
    this.name = "TeamNotFoundError";
  }
}

// Name-based guards rather than `instanceof`: under test isolation the store
// and the route can load separate copies of this module, so class identity is
// not reliable across that boundary — the error `name` is.
export function isDuplicateTeamNameError(error: unknown): boolean {
  return error instanceof Error && error.name === "DuplicateTeamNameError";
}

export function isTeamNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "TeamNotFoundError";
}

export type TeamStore = {
  listTeams(): Team[];
  getTeam(id: string): Team | null;
  createTeam(input: CreateTeamInput): Team;
  updateTeam(id: string, input: UpdateTeamInput): Team;
  deleteTeam(id: string): DeleteTeamResult;
};

type TeamRow = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  allUsers: number;
  createdBy: string;
  createdAt: string;
};

function normalizeName(name: string): string {
  return name.trim();
}

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color ?? DEFAULT_TEAM_COLOR,
    icon: row.icon ?? DEFAULT_TEAM_ICON,
    allUsers: Boolean(row.allUsers),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    /UNIQUE constraint failed/i.test(error.message) &&
    /teams\.name|idx_teams_name/i.test(error.message)
  );
}

export function createTeamStore(
  db: Database.Database,
  membership?: MembershipStore,
  forks?: () => ForkStore | undefined
): TeamStore {
  const listStatement = db.prepare(
    "SELECT id, name, description, color, icon, allUsers, createdBy, createdAt FROM teams ORDER BY name COLLATE NOCASE"
  );
  const getStatement = db.prepare(
    "SELECT id, name, description, color, icon, allUsers, createdBy, createdAt FROM teams WHERE id = ?"
  );
  const insertStatement = db.prepare(`
    INSERT INTO teams (id, name, description, color, icon, createdBy)
    VALUES (@id, @name, @description, @color, @icon, @createdBy)
  `);
  const deleteStatement = db.prepare("DELETE FROM teams WHERE id = ?");

  function getTeam(id: string): Team | null {
    const row = getStatement.get(id) as TeamRow | undefined;
    return row ? rowToTeam(row) : null;
  }

  return {
    listTeams() {
      return (listStatement.all() as TeamRow[]).map(rowToTeam);
    },
    getTeam,
    createTeam(input) {
      const name = normalizeName(input.name);
      if (name.length === 0) {
        throw new Error("Team name is required");
      }
      const id = randomUUID();
      try {
        insertStatement.run({
          id,
          name,
          description: input.description?.trim() || null,
          // Store null when unset so the default applies at read time; this
          // keeps "default" a single source of truth rather than baking the
          // literal grey/icon into every row.
          color: input.color?.trim() || null,
          icon: input.icon?.trim() || null,
          createdBy: input.createdBy,
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new DuplicateTeamNameError(name);
        throw error;
      }
      const created = getTeam(id);
      if (!created) throw new Error("Failed to create team");
      return created;
    },
    updateTeam(id, input) {
      const existing = getStatement.get(id) as TeamRow | undefined;
      if (!existing) throw new TeamNotFoundError(id);

      const next: TeamRow = { ...existing };
      if (input.name !== undefined) {
        const name = normalizeName(input.name);
        if (name.length === 0) throw new Error("Team name is required");
        next.name = name;
      }
      if (input.description !== undefined) {
        next.description = input.description?.trim() || null;
      }
      if (input.color !== undefined) {
        next.color = input.color?.trim() || null;
      }
      if (input.icon !== undefined) {
        next.icon = input.icon?.trim() || null;
      }

      try {
        db.prepare(
          "UPDATE teams SET name = ?, description = ?, color = ?, icon = ? WHERE id = ?"
        ).run(next.name, next.description, next.color, next.icon, id);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DuplicateTeamNameError(next.name);
        }
        throw error;
      }

      const updated = getTeam(id);
      if (!updated) throw new TeamNotFoundError(id);
      return updated;
    },
    deleteTeam(id) {
      const existing = getStatement.get(id) as TeamRow | undefined;
      if (!existing) throw new TeamNotFoundError(id);

      // Compute the soon-to-be-teamless users before deleting: the ON DELETE
      // CASCADE on team_members removes those rows once the team is gone, so
      // the set must be captured while the memberships still exist.
      const teamlessUsers = membership?.usersOnlyInTeam(id) ?? [];
      // Forks currently assigned to this team lose their link when it is
      // deleted (teamId FK is ON DELETE SET NULL). Capture that set before the
      // delete so the confirmation warning names the soon-to-be-teamless
      // agents.
      const teamlessAgents =
        forks?.()
          ?.listForksForTeam(id)
          .filter((fork) => fork.assignment?.mode !== "all")
          .filter((fork) => {
            const teamIds = fork.assignment?.mode === "list" ? fork.assignment.teamIds : [];
            return teamIds.length === 1;
          })
          .map((fork) => fork.forkAgentId) ?? [];

      const result = deleteStatement.run(id);
      return {
        deleted: result.changes > 0,
        teamlessUsers,
        teamlessAgents,
      };
    },
  };
}
