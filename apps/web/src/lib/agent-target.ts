import { createMemo, createResource, type Accessor } from "solid-js";
import { fetchAgents } from "../api";
import type { GatewayName } from "../api/gateway";

/**
 * The gateway that one agent route belongs to. The page resolves it once from the
 * local agent list, then passes it to every call, link, and cache of that page.
 * A name with no `@` is local. A name with `@` needs the list: an ID suffix alone
 * never selects a gateway, because a local agent can have `@` in its ID.
 */
export type AgentTarget =
  | { state: "loading" }
  | { state: "ready"; agentId: string; gateway: GatewayName }
  | { state: "missing"; agentId: string };

export function useAgentTarget(agentId: Accessor<string>): { target: Accessor<AgentTarget>; retry: () => void } {
  const [resolved, { refetch }] = createResource(
    () => (agentId().includes("@") ? agentId() : null),
    async (id): Promise<Exclude<AgentTarget, { state: "loading" }>> => {
      let agents;
      try { agents = await fetchAgents(); }
      catch { return { state: "missing", agentId: id }; }
      const agent = agents.find((candidate) => candidate.id === id);
      return agent ? { state: "ready", agentId: id, gateway: agent.gateway } : { state: "missing", agentId: id };
    }
  );
  const target = createMemo<AgentTarget>(() => {
    const id = agentId();
    if (!id.includes("@")) return { state: "ready", agentId: id, gateway: undefined };
    const result = resolved.state === "ready" || resolved.state === "refreshing" ? resolved() : undefined;
    return result?.agentId === id ? result : { state: "loading" };
  }, { state: "loading" });
  return { target, retry: () => void refetch() };
}
