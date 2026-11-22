import type { GatewayConfig } from "@yoplai/shared";

export type AgentConfigAccess = { create: boolean; edit: boolean };

export const NO_AGENT_CONFIG: AgentConfigAccess = { create: false, edit: false };

const STAFF_ROLES = ["admin", "superadmin"];

export function isStaffRole(role: unknown): boolean {
  if (Array.isArray(role)) return role.some((item) => typeof item === "string" && STAFF_ROLES.includes(item));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

export type AgentConfigRequest = {
  config: GatewayConfig;
  /** The multi-user extension is loaded. */
  multiUser: boolean;
  /** Single-user gateway that listens on loopback only. */
  local: boolean;
  /** The signed-in requester, or `null` without a session. Single-user callers pass `null`. */
  requester: { role: unknown } | null;
};

/**
 * Single-user: `agentCreation` in yoplai.json. Unset means on for a local gateway and off for a remote one.
 * Multi-user: `extensions.multiUser.agentCreation`: `disabled` (default), `admin`, or `anyone`.
 * Edit follows create. The caller still checks agent access for each agent.
 */
export function agentConfigAccess(request: AgentConfigRequest): AgentConfigAccess {
  if (!request.multiUser) {
    const allowed = request.config.agentCreation ?? request.local;
    return { create: allowed, edit: allowed };
  }
  if (!request.requester) return NO_AGENT_CONFIG;
  const mode = request.config.extensions?.multiUser?.agentCreation ?? "disabled";
  const allowed = mode === "anyone" || (mode === "admin" && isStaffRole(request.requester.role));
  return { create: allowed, edit: allowed };
}
