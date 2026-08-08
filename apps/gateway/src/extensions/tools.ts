import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import type { ExtensionAgentToolContext } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { getExtensionRuntime } from "./registry.js";
import type { ExtensionRuntime, LoadedExtensionAgentTool } from "./runtime.js";

export async function getExtensionAgentTools(
  agent: AgentConfig,
  config: GatewayConfig = loadConfig(),
  runtime: ExtensionRuntime = getExtensionRuntime()
): Promise<LoadedExtensionAgentTool[]> {
  return runtime.getTools(agent, config);
}

export async function executeExtensionAgentTool(
  agent: AgentConfig,
  toolName: string,
  args: unknown,
  config: GatewayConfig = loadConfig(),
  runtime: ExtensionRuntime = getExtensionRuntime(),
  sessionId?: string,
  userId?: string,
  emitProgress?: ExtensionAgentToolContext["emitProgress"]
): Promise<{ found: boolean; result?: unknown }> {
  return runtime.executeTool(
    agent,
    toolName,
    args,
    config,
    sessionId,
    userId,
    emitProgress
  );
}
