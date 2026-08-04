import type { MembershipStore } from "./membership.js";
import type { ForkStore } from "./forks.js";

/**
 * The chat-access resolver deep module. Chat access is derived purely from
 * team membership — the old `agent_assignments` allowlist is no longer a
 * source of truth (its rows are migrated into the team model at bootstrap).
 *
 * The rule, for a non-staff user:
 *   a user may chat a fork **iff they share ≥1 team with it**.
 * A fork holds exactly one team link (nullable). "Share ≥1 team" therefore
 * reduces to: the fork's `teamId` is non-null AND the user belongs to it.
 * Consequences that fall out of this rule directly:
 *   - teamless user  → belongs to no team → shares nothing → chats no one.
 *   - teamless fork  → `teamId` is null   → shares nothing → chattable by none.
 *
 * Staff (admin / superadmin) bypass the rule entirely and may chat any agent;
 * the bypass is applied by the callers that hold the role (`hasAgentAccess`,
 * `getAgentFilter`), so this module stays a pure membership resolver and is
 * unit-testable without an auth context.
 */
export type AccessResolver = {
  /**
   * True iff `userId` shares a team with the fork behind `forkAgentId`. Returns
   * false for a teamless user, a teamless fork, an unshared team, or an agent
   * id that is not a known fork. Does NOT apply staff bypass — callers layer
   * that on top.
   */
  canUserChatAgent(userId: string, forkAgentId: string): boolean;
  /**
   * The union of fork agent ids chattable across all of `userId`'s teams. For
   * a teamless user this is the empty set. Does NOT apply staff bypass.
   */
  getVisibleChatAgents(userId: string): string[];
};

export type AccessResolverDeps = {
  membership: MembershipStore;
  forks: ForkStore;
};

export function createAccessResolver(deps: AccessResolverDeps): AccessResolver {
  const { membership, forks } = deps;

  function canUserChatAgent(userId: string, forkAgentId: string): boolean {
    const fork = forks.getForkByAgentId(forkAgentId);
    // Unknown agent or a teamless/inert fork is chattable by nobody.
    if (!fork) return false;
    if (fork.assignment?.mode === "all") return membership.listTeamsForUser(userId).length > 0;
    const teamIds = fork.assignment?.mode === "list" ? fork.assignment.teamIds : [];
    return teamIds.some((teamId) => membership.isMember(teamId, userId));
  }

  function getVisibleChatAgents(userId: string): string[] {
    const teamIds = new Set(membership.listTeamsForUser(userId));
    if (teamIds.size === 0) return [];
    // Union across the user's teams: every fork whose (non-null) team the user
    // belongs to. A fork has a single team, so no dedup across forks is needed,
    // but the ids come back sorted for a stable, deterministic surface.
    return forks
      .listForks()
      .filter((fork) => fork.assignment?.mode === "all" || (fork.assignment?.mode === "list" ? fork.assignment.teamIds : []).some((teamId) => teamIds.has(teamId)))
      .map((fork) => fork.forkAgentId)
      .sort();
  }

  return { canUserChatAgent, getVisibleChatAgents };
}
