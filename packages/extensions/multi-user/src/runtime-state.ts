import type Database from "better-sqlite3";
import type { ExtensionContext, ExtensionLogger } from "@yoplai/shared";
import type { AccessResolver } from "./access.js";
import type { AgentAssignmentStore } from "./assignments.js";
import type { MultiUserAuth } from "./auth.js";
import type { PoolCatalogResolver } from "./catalog.js";
import type { ForkStore } from "./forks.js";
import type { MembershipStore } from "./membership.js";
import type { TeamStore } from "./teams.js";

export type MultiUserRuntime = {
  auth: MultiUserAuth;
  db: Database.Database;
  assignments: AgentAssignmentStore;
  teams: TeamStore;
  membership: MembershipStore;
  forks: ForkStore;
  access: AccessResolver;
  catalog: PoolCatalogResolver;
  /** Current pool agent ids (the catalog card keys), in config order. */
  getPoolAgentIds(): string[];
  getAgent: ExtensionContext["getAgent"];
  logger: ExtensionLogger;
};

let runtime: MultiUserRuntime | null = null;

export function getMultiUserRuntime(): MultiUserRuntime | null {
  return runtime;
}

export function setMultiUserRuntime(next: MultiUserRuntime | null): void {
  runtime = next;
}
