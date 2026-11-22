import fs from "node:fs/promises";
import path from "node:path";
import type { AgentManagementMode } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";

export type AgentManagementRole = string | string[] | null | undefined;

const STAFF_ROLES = ["admin", "superadmin"];

export function hasStaffRole(role: AgentManagementRole): boolean {
  if (Array.isArray(role)) return role.some((r) => STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

export function hasSuperadminRole(role: AgentManagementRole): boolean {
  if (Array.isArray(role)) return role.includes("superadmin");
  return role === "superadmin";
}

/**
 * Effective mode after the local default. Single-user gateways (multi-user
 * extension off) allow create and edit by default. Multi-user gateways read
 * `agentManagement` from yoplai.json and default to disabled.
 */
export function effectiveAgentManagementMode(
  multiUser: boolean,
  config?: { agentManagement?: AgentManagementMode }
): AgentManagementMode {
  if (!multiUser) return "anyone";
  return config?.agentManagement ?? loadConfig().agentManagement ?? "disabled";
}

/** Create permission for the mode. The caller checks signed-in state. */
export function canCreateAgent(
  mode: AgentManagementMode,
  role: AgentManagementRole
): boolean {
  switch (mode) {
    case "anyone":
      return true;
    case "admin":
      return hasStaffRole(role);
    case "superadmin":
      return hasSuperadminRole(role);
    case "disabled":
      return false;
    default:
      return false;
  }
}

/** Edit permission. The creator always edits. Staff edit in admin modes. In anyone mode edit needs canManageAgent. Single-user calls bypass this function. */
export function canEditAgentConfig(
  mode: AgentManagementMode,
  role: AgentManagementRole,
  options: { canManage?: boolean; isCreator?: boolean } = {}
): boolean {
  if (options.isCreator) return true;
  switch (mode) {
    case "admin":
      return hasStaffRole(role);
    case "superadmin":
      return hasSuperadminRole(role);
    case "anyone":
      return Boolean(options.canManage);
    case "disabled":
      return false;
    default:
      return false;
  }
}

const creatorFile = ".creator.json";

export async function readCreatorUserId(
  workspaceDir: string
): Promise<string | null> {
  try {
    const raw = await fs.readFile(
      path.join(workspaceDir, creatorFile),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { userId?: unknown };
    return typeof parsed.userId === "string" ? parsed.userId : null;
  } catch {
    return null;
  }
}

export async function writeCreatorUserId(
  workspaceDir: string,
  userId: string | null
): Promise<void> {
  if (!userId) return;
  await fs.writeFile(
    path.join(workspaceDir, creatorFile),
    JSON.stringify({ userId }),
    { mode: 0o600 }
  );
}
