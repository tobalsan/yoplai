import type { AgentConfig } from "@yoplai/shared";
import { CONFIG_DIR, isAgentActive, loadConfig } from "../config/index.js";
import { DurableModeStore } from "./store.js";

export function durableAgentEligible(agent: AgentConfig | undefined): agent is AgentConfig {
  return !!agent && isAgentActive(agent.id) && !agent.sandbox?.enabled;
}

export async function durableModeEnabledFor(userId: string | undefined): Promise<boolean> {
  if (loadConfig().extensions?.multiUser?.enabled && (!userId || userId === "local")) return false;
  return new DurableModeStore(CONFIG_DIR, userId).get();
}

export async function durableModeFor(userId: string | undefined, agent: AgentConfig | undefined): Promise<boolean> {
  return durableAgentEligible(agent) && durableModeEnabledFor(userId);
}
