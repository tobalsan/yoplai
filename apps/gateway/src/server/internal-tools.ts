import { Hono } from "hono";
import { z } from "zod";
import { type GatewayConfig } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { validateContainerToken } from "../sdk/container/tokens.js";
import { executeExtensionAgentTool } from "../extensions/tools.js";
import { getExtensionRuntime } from "../extensions/registry.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { logError, logWarn } from "../logging.js";

const InternalToolRequestSchema = z.object({
  tool: z.string(),
  args: z.unknown(),
  agentId: z.string(),
  agentToken: z.string(),
  sessionId: z.string().optional(),
});

type InternalToolsDeps = {
  getConfig: () => GatewayConfig;
  getRuntime: () => ExtensionRuntime;
  validateToken: (token: string, agentId: string) => boolean;
  executeExtensionTool: typeof executeExtensionAgentTool;
};

const defaultDeps: InternalToolsDeps = {
  getConfig: loadConfig,
  getRuntime: getExtensionRuntime,
  validateToken: validateContainerToken,
  executeExtensionTool: executeExtensionAgentTool,
};

const warnedMissingSessionIdAgents = new Set<string>();

async function dispatchInternalTool(
  deps: InternalToolsDeps,
  tool: string,
  args: unknown,
  agentId: string,
  sessionId?: string
): Promise<unknown> {
  const config = deps.getConfig();
  const agent = config.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const extensionResult = await deps.executeExtensionTool(
    agent,
    tool,
    args,
    config,
    deps.getRuntime(),
    sessionId
  );
  if (extensionResult.found) return extensionResult.result;
  throw new Error(`Unknown tool: ${tool}`);
}

export function createInternalTools(
  overrides: Partial<InternalToolsDeps> = {}
): Hono {
  const deps = { ...defaultDeps, ...overrides };
  const app = new Hono();

  app.post("/tools", async (c) => {
    const body = await c.req.json();
    const parsed = InternalToolRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    const headerAgentId = c.req.header("X-Agent-Id");
    const headerAgentToken = c.req.header("X-Agent-Token");
    if (
      (headerAgentId && headerAgentId !== parsed.data.agentId) ||
      (headerAgentToken && headerAgentToken !== parsed.data.agentToken) ||
      !deps.validateToken(parsed.data.agentToken, parsed.data.agentId)
    ) {
      return c.json({ error: "Invalid agent token" }, 403);
    }

    if (
      parsed.data.sessionId === undefined &&
      !warnedMissingSessionIdAgents.has(parsed.data.agentId)
    ) {
      warnedMissingSessionIdAgents.add(parsed.data.agentId);
      logWarn(
        "[internal-tools] request missing sessionId — sandbox image is likely stale (agent-runner predates sessionId forwarding); rebuild yoplai-agent:latest",
        { tool: parsed.data.tool, agentId: parsed.data.agentId }
      );
    }

    try {
      const result = await dispatchInternalTool(
        deps,
        parsed.data.tool,
        parsed.data.args,
        parsed.data.agentId,
        parsed.data.sessionId
      );
      return c.json(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Tool execution failed";
      if (message.startsWith("Unknown tool: ")) {
        return c.json({ error: message }, 400);
      }
      logError("[internal-tools] tool execution failed", error, {
        tool: parsed.data.tool,
        agentId: parsed.data.agentId,
      });
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

export const internalTools = createInternalTools();
