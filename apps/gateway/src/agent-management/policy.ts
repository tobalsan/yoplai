import type { GatewayConfig } from "@yoplai/shared";

/** Who is asking. Single-user gateways have no user id and no roles. */
export type Requester = { multiUser: boolean; userId?: string; roles: string[] };
export type ManagementMode = "off" | "single" | "superadmin" | "admin" | "anyone";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLocalGateway(config: GatewayConfig): boolean {
  const gateway = config.gateway;
  const host = gateway?.host;
  return (host === undefined || LOOPBACK_HOSTS.has(host)) && (gateway?.bind ?? "loopback") === "loopback";
}

/**
 * Effective mode. Unset: on for a local single-user gateway, off for a remote, headless, or multi-user one.
 * Pool and fork setups keep their own agent management, so they stay off.
 */
export function resolveMode(config: GatewayConfig, multiUser: boolean): ManagementMode {
  if (config.forkedAgents) return "off";
  const setting = config.agentManagement;
  if (setting === undefined) return !multiUser && isLocalGateway(config) ? "single" : "off";
  if (setting === false) return "off";
  if (!multiUser) return "single";
  return setting === true ? "admin" : setting;
}

export const isStaff = (requester: Requester) => requester.roles.some((role) => role === "admin" || role === "superadmin");
const hasRole = (requester: Requester, ...roles: string[]) => requester.roles.some((role) => roles.includes(role));

export function canCreate(mode: ManagementMode, requester: Requester): boolean {
  switch (mode) {
    case "off": return false;
    case "single": return !requester.multiUser;
    case "superadmin": return hasRole(requester, "superadmin");
    case "admin": return hasRole(requester, "admin", "superadmin");
    case "anyone": return requester.userId !== undefined;
  }
}

/** Edit follows create. In "anyone" mode a user edits own agents, and staff edit every agent. */
export function canEdit(mode: ManagementMode, requester: Requester, ownerId: string | undefined): boolean {
  if (!canCreate(mode, requester)) return false;
  if (mode !== "anyone") return true;
  return hasRole(requester, "admin", "superadmin") || (ownerId !== undefined && ownerId === requester.userId);
}
