import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import type { ExtensionAgentToolContext } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { getExtensionRuntime } from "./registry.js";
import type { ExtensionRuntime, LoadedExtensionAgentTool } from "./runtime.js";

export async function getExtensionAgentTools(
  agent: AgentConfig,
  config: GatewayConfig = loadConfig(),
  runtime: ExtensionRuntime = getExtensionRuntime(),
  userId?: string
): Promise<LoadedExtensionAgentTool[]> {
  const tools = await runtime.getTools(agent, config, userId);
  return tools.map((tool) => ({
    ...tool,
    parameters: stripSchemaPatterns(tool.parameters) as Record<string, unknown>,
  }));
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
