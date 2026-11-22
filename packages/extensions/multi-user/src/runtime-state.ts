import type Database from "better-sqlite3";
import type { ExtensionContext, ExtensionLogger } from "@yoplai/shared";
import type { AccessResolver } from "./access.js";
import type { AgentAssignmentStore } from "./assignments.js";
import type { MultiUserAuth } from "./auth.js";
import type { ForkStore } from "./forks.js";
import type { GatewayLinkService } from "./gateway-link.js";
import type { MembershipStore } from "./membership.js";
import type { OnboardingStore } from "./onboarding.js";
import type { ConnectPromptStore } from "./connect-prompt.js";
import type { TeamStore } from "./teams.js";

export type MultiUserRuntime = {
  auth: MultiUserAuth;
  db: Database.Database;
  assignments: AgentAssignmentStore;
  teams: TeamStore;
  membership: MembershipStore;
  forks: ForkStore;
  onboarding: OnboardingStore;
  connectPrompt: ConnectPromptStore;
  access: AccessResolver;
  /** Set after crash recovery ran. Absent in a runtime that never started the link service. */
  gatewayLinks?: GatewayLinkService;
  getAgent: ExtensionContext["getAgent"];
  getAgentOwner?: ExtensionContext["getAgentOwner"];
  notifyAgentListChanged: ExtensionContext["notifyAgentListChanged"];
  logger: ExtensionLogger;
  audit?: ExtensionContext["audit"];
};

let runtime: MultiUserRuntime | null = null;

export function getMultiUserRuntime(): MultiUserRuntime | null {
  return runtime;
}

export function setMultiUserRuntime(next: MultiUserRuntime | null): void {
  runtime = next;
}

/** True when the gateway link service finished recovery. The remote advertises link support only then. */
export function isGatewayLinkReady(): boolean {
  return runtime?.gatewayLinks?.isReady() === true;
}

/** Agents with no access record are Public. */
export function canUserUseAgent(userId: string, agentId: string): boolean {
  const activeRuntime = getMultiUserRuntime();
  if (!activeRuntime) return true;
  if (!activeRuntime.forks.getForkByAgentId(agentId)) return true;
  return activeRuntime.getAgentOwner?.(agentId) === userId || activeRuntime.access.canUserChatAgent(userId, agentId);
}
