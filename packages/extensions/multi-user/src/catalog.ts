import type { AccessResolver } from "./access.js";
import type { ForkStore } from "./forks.js";

/**
 * The pool-catalog resolver deep module. It isolates the branchy per-card
 * presentation logic of `AgentCatalog` from the backend access work: for a
 * given pool agent and the current user it resolves the fork state and the one
 * action the card should offer. Visibility is global (every card is always
 * listed) — only the action is gated here.
 *
 * The three action states (mirroring the ALG-346 acceptance criteria):
 *   - `chat`           — a fork exists, its agent is discoverable/runnable by
 *                        the gateway config loader, and the user may chat it (a
 *                        member of the fork's team, or staff). Renders the Chat
 *                        action.
 *   - `assign_to_team` — no fork exists yet AND the user is staff. Renders the
 *                        "Assign to team" flow so an admin can fork+assign.
 *   - `none`           — visible but not chattable: the fork is teamless, or
 *                        the user shares no team with it, or no fork exists and
 *                        the user is not staff, or the fork's agent is no longer
 *                        discoverable on disk (e.g. its folder was renamed or
 *                        removed). Renders no action.
 *
 * Staff (admin / superadmin) always get a usable `chat` for any existing fork
 * regardless of team membership; the staff bypass is layered here because this
 * module (unlike the pure `AccessResolver`) is handed the caller's role.
 *
 * Every entry also carries a `reason` (non-null only when `action === "none"`)
 * so the web card can render a specific message instead of a generic
 * "Not available": `no_workspace` (the fork's agent folder isn't discoverable
 * on disk), `unassigned` (no fork, or a teamless fork), or `other_team` (a
 * non-member viewing a fork assigned to a different team). `teamName` carries
 * the fork's team display name for the `other_team` (and, for an admin
 * viewer, `no_workspace`) cases.
 */
export type PoolCatalogAction = "chat" | "assign_to_team" | "none";

export type PoolCatalogNoneReason = "no_workspace" | "unassigned" | "other_team";

export type PoolCatalogEntry = {
  /** The source pool agent id (the catalog card key). */
  poolId: string;
  /** True once the pool agent has been forked (regardless of team link). */
  forked: boolean;
  /**
   * The fork's agent id to chat, present only when `action === "chat"`. This is
   * the id the Chat action must route to (a fork is chatted, never the raw pool
   * definition).
   */
  chatAgentId: string | null;
  /** The single action the card should offer for this user. */
  action: PoolCatalogAction;
  /** Why `action` is "none"; null whenever `action !== "none"`. */
  reason: PoolCatalogNoneReason | null;
  /** The fork's team display name, when known; null otherwise. */
  teamName: string | null;
};

export type PoolCatalogResolver = {
  /** Resolve the action state for one pool agent and the current user. */
  resolvePoolAction(poolId: string, user: CatalogUser): PoolCatalogEntry;
  /** Resolve the action state for many pool agents at once (stable order). */
  resolvePoolActions(
    poolIds: string[],
    user: CatalogUser
  ): PoolCatalogEntry[];
};

/** The minimal current-user shape the resolver needs. */
export type CatalogUser = {
  id: string;
  /** True for admin/superadmin — grants the staff bypass. */
  isStaff: boolean;
};

export type PoolCatalogResolverDeps = {
  forks: ForkStore;
  access: AccessResolver;
  /**
   * Returns true iff the given agent id resolves to a discovered/runnable
   * agent (i.e. the gateway config loader found its on-disk folder). Used to
   * gate the `chat` action so a fork row whose agent folder went missing
   * (renamed/removed) doesn't offer a dead Chat action.
   */
  isAgentRunnable(agentId: string): boolean;
  /** Resolves a team id to its display name, or null if the team is gone. */
  getTeamName(teamId: string): string | null;
};

export function createPoolCatalogResolver(
  deps: PoolCatalogResolverDeps
): PoolCatalogResolver {
  const { forks, access, isAgentRunnable, getTeamName } = deps;

  function resolvePoolAction(
    poolId: string,
    user: CatalogUser
  ): PoolCatalogEntry {
    const fork = forks.getForkByPool(poolId);

    if (!fork) {
      // No fork yet. Staff can start the fork+assign flow; everyone else sees a
      // visible-but-inert card.
      return {
        poolId,
        forked: false,
        chatAgentId: null,
        action: user.isStaff ? "assign_to_team" : "none",
        reason: user.isStaff ? null : "unassigned",
        teamName: null,
      };
    }

    const teamIds = fork.assignment?.mode === "list" ? fork.assignment.teamIds : [];
    const teamName = teamIds.length === 1 ? getTeamName(teamIds[0]) : null;

    // The fork row exists, but its agent may not: an operator can rename or
    // remove the agent's on-disk folder (or, for legacy-migrated forks where
    // forkAgentId === agentId, the original pool agent folder itself) without
    // the fork row being cleaned up. If the gateway config loader can't
    // discover the agent, nobody — not even staff — can chat it, so this
    // check precedes the staff bypass below.
    if (!isAgentRunnable(fork.forkAgentId)) {
      return {
        poolId,
        forked: true,
        chatAgentId: null,
        action: "none",
        reason: "no_workspace",
        teamName,
      };
    }

    // A fork exists. Staff always chat it; other users chat it only when they
    // share the fork's (non-null) team. A teamless fork is chattable by nobody
    // but staff. Reuse the pure access resolver so the membership rule stays in
    // one place.
    const chattable =
      user.isStaff || access.canUserChatAgent(user.id, fork.forkAgentId);

    if (chattable) {
      return {
        poolId,
        forked: true,
        chatAgentId: fork.forkAgentId,
        action: "chat",
        reason: null,
        teamName: null,
      };
    }

    if (fork.assignment?.mode !== "all" && teamIds.length === 0) {
      return {
        poolId,
        forked: true,
        chatAgentId: null,
        action: "none",
        reason: "unassigned",
        teamName: null,
      };
    }

    return {
      poolId,
      forked: true,
      chatAgentId: null,
      action: "none",
      reason: "other_team",
      teamName,
    };
  }

  function resolvePoolActions(
    poolIds: string[],
    user: CatalogUser
  ): PoolCatalogEntry[] {
    return poolIds.map((poolId) => resolvePoolAction(poolId, user));
  }

  return { resolvePoolAction, resolvePoolActions };
}
