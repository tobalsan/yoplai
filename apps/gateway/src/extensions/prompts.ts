import type { AgentConfig, GatewayConfig, ExtensionAgentToolContext, ExtensionRunInfo } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { getExtensionRuntime } from "./registry.js";
import type { ExtensionRuntime } from "./runtime.js";

export async function getExtensionSystemPromptContributions(
  agent: AgentConfig,
  config: GatewayConfig = loadConfig(),
  runtime: ExtensionRuntime = getExtensionRuntime(),
  userId?: string,
  identity?: Pick<ExtensionAgentToolContext, "sessionOwnerId" | "requesterId" | "actorUserId" | "actorKind"> & ExtensionRunInfo
): Promise<string[]> {
  return runtime.getPromptContributions(agent, config, userId, identity);
}
