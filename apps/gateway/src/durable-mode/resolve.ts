import type { AgentConfig } from "@yoplai/shared";
import { CONFIG_DIR, isAgentActive, loadConfig } from "../config/index.js";
import { DurableModeStore } from "./store.js";

export function durableAgentEligible(agent: AgentConfig | undefined): agent is AgentConfig {
  return !!agent && isAgentActive(agent.id) && !agent.sandbox?.enabled;
}

export async function durableModeFor(userId: string | undefined, agent: AgentConfig | undefined): Promise<boolean> {
  if (!durableAgentEligible(agent)) return false;
  if (loadConfig().extensions?.multiUser?.enabled && (!userId || userId === "local")) return false;
  return new DurableModeStore(CONFIG_DIR, userId).get();
}
