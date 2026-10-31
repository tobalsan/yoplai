import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import type { ExtensionAgentToolContext, ExtensionRunInfo } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { logWarn } from "../logging.js";
import { getExtensionRuntime } from "./registry.js";
import type { ExtensionRuntime, LoadedExtensionAgentTool } from "./runtime.js";
import { validateToolParameters } from "./tool-schema.js";

export async function getExtensionAgentTools(
  agent: AgentConfig,
  config: GatewayConfig = loadConfig(),
  runtime: ExtensionRuntime = getExtensionRuntime(),
  userId?: string,
  identity?: Pick<ExtensionAgentToolContext, "sessionOwnerId" | "requesterId" | "actorUserId" | "actorKind"> & ExtensionRunInfo
): Promise<LoadedExtensionAgentTool[]> {
  const tools = await runtime.getTools(agent, config, userId, identity);
  return tools.flatMap((tool) => {
    const result = validateToolParameters(stripSchemaPatterns(tool.parameters) as Record<string, unknown>);
    if (result.ok) return [{ ...tool, parameters: result.schema }];
    logWarn("Dropping extension tool with invalid parameters", {
      agentId: agent.id,
      extensionId: tool.extensionId,
      toolName: tool.name,
      reason: result.reason,
    });
    return [];
  });
}

// Some providers (e.g. opencode-go) reject lookaround regexes such as the one
// Zod v4's z.email() emits; tools validate their own inputs anyway.
function stripSchemaPatterns(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripSchemaPatterns);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key, value]) => !(key === "pattern" && typeof value === "string"))
      .map(([key, value]) => [key, stripSchemaPatterns(value)])
  );
}

export async function executeExtensionAgentTool(
  agent: AgentConfig,
  toolName: string,
  args: unknown,
  config: GatewayConfig = loadConfig(),
  runtime: ExtensionRuntime = getExtensionRuntime(),
  sessionId?: string,
  userId?: string,
  emitProgress?: ExtensionAgentToolContext["emitProgress"],
  signal?: AbortSignal,
  identity?: Pick<ExtensionAgentToolContext, "sessionOwnerId" | "requesterId" | "actorUserId" | "actorKind" | "conversationFiles">
): Promise<{ found: boolean; result?: unknown }> {
  return runtime.executeTool(
    agent,
    toolName,
    args,
    config,
    sessionId,
    userId,
    emitProgress,
    signal,
    identity
  );
}
