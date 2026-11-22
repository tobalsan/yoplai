import type { GatewayConfig } from "@yoplai/shared";
import { isLoopbackAddress } from "../relay/state.js";
import type { SkillActor } from "../skills/types.js";

export type AgentManagementValue = GatewayConfig["agentManagement"];
export type AgentManagementMode = "off" | "superadmin" | "admin" | "anyone";

export function effectiveAgentManagement(config: AgentManagementValue, stored: AgentManagementMode | undefined) {
  const value = config ?? (stored === "off" ? false : stored);
  const mode = value === true ? "admin" : value || "off";
  const source = config !== undefined ? "config" : stored !== undefined ? "ui" : "default";
  return { value, mode, source, locked: source === "config" };
}

export function agentManagementPolicy(input: {
  value: AgentManagementValue;
  multiUser: boolean;
  desktop: boolean;
  listenerAddress?: string;
  actor?: SkillActor;
}) {
  const { value, multiUser, desktop, listenerAddress, actor } = input;
  if (!multiUser) {
    const allowed = desktop || (value === undefined
      ? listenerAddress !== undefined && isLoopbackAddress(listenerAddress)
      : value !== false);
    return { canCreate: allowed, canEditAgent: (_ownerId?: string) => allowed };
  }

  const superadmin = actor?.role === "superadmin";
  const staff = superadmin || actor?.role === "admin";
  const canCreate = value === "anyone" ? !!actor
    : value === "superadmin" ? superadmin
    : (value === true || value === "admin") && staff;
  return {
    canCreate,
    canEditAgent: (ownerId?: string) => canCreate && (staff || ownerId === actor?.userId),
  };
}
