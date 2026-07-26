import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ExtensionBaseConfigSchema,
  type AgentConfig,
  type AgentConfigRoute,
  type Extension,
  type ExtensionAgentToolContext,
  type ExtensionAgentTool,
  type ExtensionHookContext,
  type GatewayConfig,
  type ValidationResult,
} from "./types.js";
import type { OAuthRequirement, ResolvedOAuth } from "./oauth/types.js";

export interface ResolvedToolExtensionConfig {
  global: Record<string, unknown>;
  root: Record<string, unknown>;
  agent: Record<string, unknown>;
  merged: Record<string, unknown>;
  /**
   * Present only when the extension declared an `oauth` requirement. Carries a
   * fresh access token when connected, or a structured not-connected signal —
   * never a raw secret.
   */
  oauth?: ResolvedOAuth;
}

export interface ToolExtensionTool {
  name: string;
  description: string;
  parameters: z.AnyZodObject;
  execute(
    params: unknown,
    context: ExtensionAgentToolContext
  ): Promise<unknown>;
}

export interface ToolExtensionDefinition {
  id: string;
  displayName: string;
  description: string;
  systemPrompt?: string;
  configSchema: z.ZodTypeAny;
  agentConfigSchema?: z.ZodTypeAny;
  requiredSecrets: string[];
  /** Config field names the generic UI should collapse under advanced settings. */
  advancedConfigFields?: string[];
  /**
   * Optional self-registered, agent-keyed config route. Declare this to own a
   * bespoke config UI instead of the schema-driven auto-form. The path must
   * include the `:agentId` param (e.g. `"/agents/:agentId/extensions/mcp"`).
   */
  configRoute?: AgentConfigRoute;
  /**
   * Declares that this extension needs an OAuth token. When set, `createTools`
   * receives `config.oauth` with a fresh access token (or a not-connected
   * signal) resolved at tool-build time by the host.
   */
  oauth?: OAuthRequirement;
  createTools(config: ResolvedToolExtensionConfig): ToolExtensionTool[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stripEnabled(value: Record<string, unknown>): Record<string, unknown> {
  const { enabled: _enabled, ...rest } = value;
  void _enabled;
  return rest;
}

function resolveEnvRefs(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$env:")) {
    const envName = value.slice("$env:".length);
    const envValue = process.env[envName];
    if (envValue === undefined) {
      throw new Error(
        `Env var "${envName}" not set (referenced in extension config)`
      );
    }
    return envValue;
  }
  if (Array.isArray(value)) {
    return value.map(resolveEnvRefs);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveEnvRefs(item)])
    );
  }
  return value;
}

function getRootConfig(
  config: GatewayConfig,
  extensionId: string
): Record<string, unknown> {
  return toRecord(
    (config.extensions as Record<string, unknown> | undefined)?.[extensionId]
  );
}

function getAgentConfig(
  agent: AgentConfig,
  extensionId: string
): Record<string, unknown> | undefined {
  const extensions = agent.extensions as Record<string, unknown> | undefined;
  if (!extensions || !(extensionId in extensions)) return undefined;
  return toRecord(extensions[extensionId]);
}

function resolveToolExtensionConfig(
  definition: ToolExtensionDefinition,
  config: GatewayConfig,
  agent: AgentConfig
): ResolvedToolExtensionConfig | undefined {
  const rawAgent = getAgentConfig(agent, definition.id);
  if (!rawAgent || rawAgent.enabled === false) return undefined;

  const rawRoot = getRootConfig(config, definition.id);
  const root = resolveEnvRefs(stripEnabled(rawRoot)) as Record<string, unknown>;
  const agentConfig = resolveEnvRefs(stripEnabled(rawAgent)) as Record<
    string,
    unknown
  >;
  if (definition.agentConfigSchema) {
    definition.agentConfigSchema.parse(agentConfig);
  }

  const resolved = {
    global: root,
    root,
    agent: agentConfig,
    merged: { ...root, ...agentConfig },
  };

  definition.configSchema.parse(resolved.merged);
  for (const secretName of definition.requiredSecrets) {
    const value = resolved.merged[secretName];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `Extension "${definition.id}" for agent "${agent.id}" missing required secret "${secretName}"`
      );
    }
  }
  return resolved;
}

async function resolveOAuthForDefinition(
  definition: ToolExtensionDefinition,
  agent: AgentConfig,
  context: ExtensionHookContext
): Promise<ResolvedOAuth | undefined> {
  if (!definition.oauth) return undefined;
  if (!context.resolveOAuth) {
    return {
      connected: false,
      provider: definition.oauth.provider,
      reason: "provider_not_configured",
      message: `OAuth provider "${definition.oauth.provider}" is not configured on this host.`,
    };
  }
  return context.resolveOAuth(agent, definition.oauth);
}

function validateToolExtensionAgentConfigs(
  definition: ToolExtensionDefinition,
  config: GatewayConfig
): ValidationResult {
  const errors: string[] = [];
  for (const agent of config.agents) {
    try {
      resolveToolExtensionConfig(definition, config, agent);
    } catch (error) {
      errors.push(
        `Extension "${definition.id}" for agent "${agent.id}" config invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

function getMountedToolName(
  definition: ToolExtensionDefinition,
  toolName: string
): string {
  return toolName.startsWith(`${definition.id}_`)
    ? toolName
    : `${definition.id}_${toolName}`;
}

function renderMountedToolNames(
  definition: ToolExtensionDefinition,
  resolved: ResolvedToolExtensionConfig
): string {
  return [
    "Yoplai exposes this extension's tools with these exact names:",
    ...definition
      .createTools(resolved)
      .map(
        (tool) =>
          `- ${getMountedToolName(definition, tool.name)}: ${tool.description}`
      ),
  ].join("\n");
}

export function defineToolExtension(
  definition: ToolExtensionDefinition
): Extension {
  return {
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    dependencies: [],
    configSchema: ExtensionBaseConfigSchema,
    // Surface the real config shape as JSON-schema for config UIs. The
    // Extension-level `configSchema` above stays the base (validation only
    // gates `enabled`); `configJsonSchema` carries the tool extension's actual
    // Zod `configSchema` so the catalog can drive a schema-based form.
    configJsonSchema: zodToJsonSchema(definition.configSchema, {
      $refStrategy: "none",
    }) as Record<string, unknown>,
    requiredSecrets: definition.requiredSecrets,
    advancedConfigFields: definition.advancedConfigFields,
    configRoute: definition.configRoute,
    routePrefixes: [],
    validateConfig(raw) {
      const result = ExtensionBaseConfigSchema.safeParse(raw ?? {});
      return {
        valid: result.success,
        errors: result.success
          ? []
          : result.error.issues.map((issue) => issue.message),
      };
    },
    validateAgentConfigs(config) {
      return validateToolExtensionAgentConfigs(definition, config);
    },
    registerRoutes() {
      return undefined;
    },
    async start() {
      return undefined;
    },
    async stop() {
      return undefined;
    },
    capabilities() {
      return [];
    },
    async getSystemPromptContributions(agent, context) {
      if (!context) return undefined;
      const resolved = resolveToolExtensionConfig(
        definition,
        context.config,
        agent
      );
      if (!resolved) return undefined;
      resolved.oauth = await resolveOAuthForDefinition(
        definition,
        agent,
        context
      );
      return [
        definition.systemPrompt?.trim() || undefined,
        renderMountedToolNames(definition, resolved),
      ].filter((prompt): prompt is string => Boolean(prompt));
    },
    async getAgentTools(agent, context): Promise<ExtensionAgentTool[]> {
      if (!context) return [];
      const resolved = resolveToolExtensionConfig(
        definition,
        context.config,
        agent
      );
      if (!resolved) return [];
      resolved.oauth = await resolveOAuthForDefinition(
        definition,
        agent,
        context
      );
      return definition.createTools(resolved).map((tool) => ({
        name: getMountedToolName(definition, tool.name),
        description: tool.description,
        parameters: zodToJsonSchema(tool.parameters, {
          $refStrategy: "none",
        }) as Record<string, unknown>,
        execute: (params, context) => tool.execute(params, context),
      }));
    },
  };
}
