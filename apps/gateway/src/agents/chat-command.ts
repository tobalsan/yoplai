import type { AgentConfig, GatewayConfig, RunAgentParams } from "@yoplai/shared";
import { resolveWorkspaceDir } from "../config/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";

export async function findChatCommand(
  runtime: ExtensionRuntime | undefined, agent: AgentConfig, config: GatewayConfig,
  sessionId: string, params: RunAgentParams, message: string,
) {
  const commands = await runtime?.getChatCommands(agent, config, resolveWorkspaceDir(agent.workspace), sessionId, params.userId, params);
  return commands?.find((command) => command.command === message.trim());
}
