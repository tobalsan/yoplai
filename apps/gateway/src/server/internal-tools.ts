import { Hono } from "hono";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type GatewayConfig } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import {
  getContainerTokenContext,
  type ContainerTokenContext,
} from "../sdk/container/tokens.js";
import { extractText } from "../media/extract.js";
import { executeExtensionAgentTool } from "../extensions/tools.js";
import { getExtensionRuntime } from "../extensions/registry.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { logError, logWarn } from "../logging.js";

const InternalToolRequestSchema = z.object({
  tool: z.string(),
  args: z.unknown(),
  agentId: z.string().optional(),
  agentToken: z.string(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  containerName: z.string().optional(),
});

type InternalToolsDeps = {
  getConfig: () => GatewayConfig;
  getRuntime: () => ExtensionRuntime;
  getTokenContext: (token: string) => ContainerTokenContext | undefined;
  executeExtensionTool: typeof executeExtensionAgentTool;
};

const defaultDeps: InternalToolsDeps = {
  getConfig: loadConfig,
  getRuntime: getExtensionRuntime,
  getTokenContext: getContainerTokenContext,
  executeExtensionTool: executeExtensionAgentTool,
};

const warnedMissingSessionIdAgents = new Set<string>();

function requestIdentityMatches(
  request: z.infer<typeof InternalToolRequestSchema>,
  context: ContainerTokenContext
): boolean {
  return (
    (request.agentId === undefined || request.agentId === context.agentId) &&
    (request.sessionId === undefined || request.sessionId === context.sessionId) &&
    (request.runId === undefined || request.runId === context.runId) &&
    (request.containerName === undefined || request.containerName === context.containerName)
  );
}

function resolveDocumentPath(
  requestedPath: string,
  roots: ContainerTokenContext["roots"]
): string {
  const mappings = [
    ["/workspace/uploads", roots.uploads],
    ["/workspace/data", roots.data],
    ["/workspace", roots.workspace],
  ] as const;
  const mapping = mappings.find(([containerRoot]) =>
    requestedPath === containerRoot || requestedPath.startsWith(`${containerRoot}/`)
  );
  if (!mapping) throw new Error("Document path is outside approved container roots");
  const relative = path.relative(mapping[0], requestedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Document path traversal is not allowed");
  }
  return path.join(mapping[1], relative);
}

async function extractDocument(
  args: unknown,
  context: ContainerTokenContext
): Promise<{ text: string }> {
  const parsed = z.object({ path: z.string().min(1) }).safeParse(args);
  if (!parsed.success) throw new Error("extract_document requires a path");
  if (path.extname(parsed.data.path).toLowerCase() !== ".pdf") {
    throw new Error("extract_document supports PDF files only");
  }
  const filePath = resolveDocumentPath(parsed.data.path, context.roots);
  let realPath: string;
  try {
    realPath = await fs.realpath(filePath);
  } catch {
    throw new Error("Document was not found under an approved container root");
  }
  const approvedRoots = await Promise.all(
    Object.values(context.roots).map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return undefined;
      }
    })
  );
  const approved = approvedRoots.some((root) => {
    if (!root) return false;
    const relative = path.relative(root, realPath);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
  if (!approved) throw new Error("Document path is outside approved container roots");
  return { text: (await extractText(realPath, "application/pdf")) ?? "" };
}

async function dispatchInternalTool(
  deps: InternalToolsDeps,
  tool: string,
  args: unknown,
  agentId: string,
  sessionId?: string,
  userId?: string,
  emitProgress?: ContainerTokenContext["emitProgress"]
): Promise<unknown> {
  const config = deps.getConfig();
  const agent = config.agents.find((candidate) => candidate.id === agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  const extensionResult = emitProgress
    ? await deps.executeExtensionTool(
        agent,
        tool,
        args,
        config,
        deps.getRuntime(),
        sessionId,
        userId,
        emitProgress
      )
    : userId === undefined
      ? await deps.executeExtensionTool(
          agent,
          tool,
          args,
          config,
          deps.getRuntime(),
          sessionId
        )
      : await deps.executeExtensionTool(
          agent,
          tool,
          args,
          config,
          deps.getRuntime(),
          sessionId,
          userId
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
    const context = deps.getTokenContext(parsed.data.agentToken);
    if (
      (headerAgentId !== undefined && headerAgentId !== context?.agentId) ||
      (headerAgentToken !== undefined && headerAgentToken !== parsed.data.agentToken) ||
      !context ||
      !requestIdentityMatches(parsed.data, context)
    ) {
      return c.json({ error: "Invalid agent token" }, 403);
    }

    if (
      parsed.data.sessionId === undefined &&
      !warnedMissingSessionIdAgents.has(context.agentId)
    ) {
      warnedMissingSessionIdAgents.add(context.agentId);
      logWarn(
        "[internal-tools] request missing sessionId — sandbox image is likely stale (agent-runner predates sessionId forwarding); rebuild yoplai-agent:latest",
        { tool: parsed.data.tool, agentId: context.agentId }
      );
    }

    try {
      const result = parsed.data.tool === "extract_document"
        ? await extractDocument(parsed.data.args, context)
        : await dispatchInternalTool(
          deps,
          parsed.data.tool,
          parsed.data.args,
          context.agentId,
          context.sessionId,
          context.userId,
          context.emitProgress
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
        agentId: context.agentId,
      });
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

export const internalTools = createInternalTools();
