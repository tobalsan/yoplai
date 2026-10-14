import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
import { describeImage } from "../media/describe.js";
import { executeExtensionAgentTool } from "../extensions/tools.js";
import { getExtensionRuntime } from "../extensions/registry.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { logError, logWarn } from "../logging.js";
import { resolveOAuthToken, type OAuthTokenLookup } from "../sdk/container/oauth-tokens.js";
import {
  listDashboardSlugs,
  normalizeDashboardSlug,
  openDashboardFile,
} from "../canvas/dashboard-files.js";
import { dashboardCsp, renderDashboardHtml } from "../canvas/routes.js";

const InternalToolRequestSchema = z.object({
  tool: z.string(),
  args: z.unknown(),
  agentId: z.string().optional(),
  agentToken: z.string(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
  containerName: z.string().optional(),
});

const OAuthTokenRequestSchema = z.object({
  provider: z.string(),
  agentId: z.string().optional(),
  agentToken: z.string(),
  sessionId: z.string().optional(),
  runId: z.string().optional(),
});

type InternalToolsDeps = {
  getConfig: () => GatewayConfig;
  getRuntime: () => ExtensionRuntime;
  getTokenContext: (token: string) => ContainerTokenContext | undefined;
  executeExtensionTool: typeof executeExtensionAgentTool;
  resolveOAuthToken: (
    provider: string,
    allowedProviders: readonly string[]
  ) => Promise<OAuthTokenLookup>;
};

const defaultDeps: InternalToolsDeps = {
  getConfig: loadConfig,
  getRuntime: getExtensionRuntime,
  getTokenContext: getContainerTokenContext,
  executeExtensionTool: executeExtensionAgentTool,
  resolveOAuthToken,
};

const warnedMissingSessionIdAgents = new Set<string>();

function requestIdentityMatches(
  request: {
    agentId?: string;
    sessionId?: string;
    runId?: string;
    containerName?: string;
  },
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

async function describeContainerImage(args: unknown, context: ContainerTokenContext, config: GatewayConfig): Promise<{ description: string }> {
  const parsed = z.object({ path: z.string().min(1), question: z.string().optional() }).safeParse(args);
  if (!parsed.success) throw new Error("describe_image requires a path");
  const filePath = resolveDocumentPath(parsed.data.path, context.roots);
  const mimeType = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" }[path.extname(filePath).toLowerCase()];
  if (!mimeType) throw new Error("describe_image supports PNG, JPEG, GIF, WebP, and SVG files only");
  const realPath = await fs.realpath(filePath).catch(() => { throw new Error("Image was not found under an approved container root"); });
  const roots = await Promise.all(Object.values(context.roots).map((root) => fs.realpath(root).catch(() => undefined)));
  if (!roots.some((root) => root && !path.relative(root, realPath).startsWith("..") && !path.isAbsolute(path.relative(root, realPath)))) throw new Error("Image path is outside approved container roots");
  return { description: await describeImage(await fs.readFile(realPath), mimeType, config, parsed.data.question) };
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

  app.get("/dashboards/:slug/html", async (c) => {
    const token = c.req.header("X-Agent-Token") ?? c.req.query("token");
    const context = token ? deps.getTokenContext(token) : undefined;
    if (!context) return c.json({ error: "Invalid agent token" }, 401);
    const config = deps.getConfig();
    const agent = config.agents.find(
      (candidate) => candidate.id === context.agentId
    );
    if (!agent || config.canvas?.enabled === false) return c.notFound();
    let slug: string;
    try {
      slug = normalizeDashboardSlug(c.req.param("slug"));
    } catch {
      return c.notFound();
    }
    try {
      const file = await openDashboardFile(agent, slug);
      let html: string;
      try {
        html = await file.readFile("utf8");
      } finally {
        await file.close();
      }
      const search = new URL(c.req.url).searchParams;
      const themeValue = search.get("theme");
      const theme =
        themeValue === "light" || themeValue === "dark" ? themeValue : null;
      search.delete("theme");
      search.delete("token");
      const params = Object.fromEntries(search.entries());
      const links = Object.fromEntries(
        (await listDashboardSlugs(agent)).map((target) => {
          const query = new URLSearchParams({ token: token! });
          if (theme) query.set("theme", theme);
          return [
            target,
            `/internal/dashboards/${encodeURIComponent(target)}/html?${query}`,
          ];
        })
      );
      html = await renderDashboardHtml(agent, html, {}, params, links, theme, {
        token: token!,
        ...(theme ? { theme } : {}),
      });
      c.header(
        "Content-Security-Policy",
        dashboardCsp(config, new URL(c.req.url).origin)
      );
      c.header("Cache-Control", "no-store");
      return c.html(html);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return c.notFound();
      throw error;
    }
  });

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
        : parsed.data.tool === "describe_image"
          ? await describeContainerImage(parsed.data.args, context, deps.getConfig())
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
      // Pass through upstream HTTP errors (e.g. Google 404) instead of masking them as 500.
      const status = (error as { status?: unknown } | null)?.status;
      const httpStatus =
        typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
          ? (status as ContentfulStatusCode)
          : 500;
      return c.json({ error: message }, httpStatus);
    }
  });

  app.post("/oauth-token", async (c) => {
    const body = await c.req.json();
    const parsed = OAuthTokenRequestSchema.safeParse(body);
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

    let result: OAuthTokenLookup;
    try {
      result = await deps.resolveOAuthToken(
        parsed.data.provider,
        context.oauthProviders ?? []
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "OAuth token renewal failed";
      logError("[internal-tools] oauth token renewal failed", error, {
        agentId: context.agentId,
        provider: parsed.data.provider,
      });
      return c.json({ error: message }, 502);
    }
    if (result.status === "forbidden") {
      return c.json({ error: "Provider is not available for OAuth renewal" }, 403);
    }
    if (result.status === "not_found") {
      return c.json({ error: "No stored OAuth credential for provider" }, 404);
    }
    return c.json({
      accessToken: result.accessToken,
      expiresAt: result.expiresAt,
    });
  });

  return app;
}

export const internalTools = createInternalTools();
