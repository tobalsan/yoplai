import type {
  AgentConfig,
  Extension,
  ExtensionAgentTool,
  ExtensionAgentToolContext,
  ExtensionHookContext,
  GatewayConfig,
  OAuthRequirement,
  ResolvedOAuth,
} from "@yoplai/shared";
import { requestCredentialConnectLink, resolveExtensionOAuth, extensionConfigFieldNames, registerOAuthProviders } from "@yoplai/shared";
import { resolveAgentEnv } from "../config/index.js";
import { getOAuthService } from "../oauth/service.js";
import { extensionSecretFields, resolveExtensionTokenConfig } from "../credentials/extension-tokens.js";

function buildHookContext(
  agent: AgentConfig,
  config: GatewayConfig,
  userId?: string
): ExtensionHookContext {
  return {
    config,
    env: resolveAgentEnv(agent, config),
    userId,
    resolveOAuth: (
      agent: AgentConfig,
      requirement: OAuthRequirement,
      requesterUserId?: string
    ): Promise<ResolvedOAuth> =>
      getOAuthService().resolveToken(agent.id, requirement, requesterUserId),
  };
}

/** External OAuth extensions return their own refusal; give Slack requesters the single-pass connect link instead. */
function withOAuthConnectLink(
  extension: Extension,
  execute: ExtensionAgentTool["execute"]
): ExtensionAgentTool["execute"] {
  if (!extension.oauth) return execute;
  return async (args, context) => {
    const scoped = resolveExtensionTokenConfig(extension, context.agent, context.config, context.userId);
    const requirement = resolveExtensionOAuth(extension, scoped.config, scoped.agent, resolveAgentEnv(scoped.agent, scoped.config));
    if (!requirement) return execute(args, context);
    const oauth = await getOAuthService().resolveToken(context.agent.id, requirement, context.userId);
    if (!oauth.connected && oauth.reason !== "provider_not_configured") {
      const link = await requestCredentialConnectLink(context, { kind: "oauth", ...requirement });
      if (link) return { error: "oauth_connection_required", ...(oauth.reason === "insufficient_scope" ? { connected: false, reason: oauth.reason } : {}), authorizeUrl: link, message: `Connect your personal ${oauth.provider} account at ${link}, then try again.` };
    }
    return execute(args, context);
  };
}

export type LoadedExtensionAgentTool = ExtensionAgentTool & {
  extensionId: string;
};

export type ExtensionRouteMetadata = {
  id: string;
  routePrefixes: string[];
  allowWhenDisabled?: boolean;
};

export type ExtensionRouteMatcher = {
  extension: string;
  allowWhenDisabled?: boolean;
  matches: (path: string) => boolean;
};

export type ExtensionCapabilities = {
  extensions: Record<string, true>;
  capabilities: Record<string, string[]>;
  multiUser: boolean;
  home?: string;
};

function routePrefixToMatcher(prefix: string): (path: string) => boolean {
  if (!prefix.includes(":")) {
    return (path) => path === prefix || path.startsWith(`${prefix}/`);
  }

  const pattern = prefix
    .split("/")
    .map((segment) => {
      if (!segment) return "";
      if (segment.startsWith(":")) return "[^/]+";
      return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  const regex = new RegExp(`^${pattern}$`);
  return (path) => regex.test(path);
}

function isExplicitlyDisabled(
  config: GatewayConfig,
  extensionId: string
): boolean {
  const extensionConfig = (
    extensionId === "multiUser"
      ? config.extensions?.multiUser
      : config.extensions?.[
          extensionId as keyof NonNullable<GatewayConfig["extensions"]>
        ]
  ) as { enabled?: boolean } | undefined;

  return !!(
    extensionConfig &&
    typeof extensionConfig === "object" &&
    "enabled" in extensionConfig &&
    extensionConfig.enabled === false
  );
}

function hasEnabledConfig(config: GatewayConfig, extensionId: string): boolean {
  const extensionConfig = (
    extensionId === "multiUser"
      ? config.extensions?.multiUser
      : config.extensions?.[
          extensionId as keyof NonNullable<GatewayConfig["extensions"]>
        ]
  ) as { enabled?: boolean } | undefined;

  return !!extensionConfig && extensionConfig.enabled !== false;
}

/** Register extension-shipped OAuth descriptors; a conflict names the extension. */
export function registerExtensionOAuthProviders(extensions: Extension[]): void {
  for (const extension of extensions) {
    try {
      registerOAuthProviders(extension.oauthProviders ?? []);
    } catch (error) {
      throw new Error(
        `Extension "${extension.id}" cannot register OAuth provider: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

export class ExtensionRuntime {
  #extensions: Extension[] = [];
  #extensionIds = new Set<string>();
  #homeExtensionId: string | undefined;
  #routeMatchers: ExtensionRouteMatcher[];

  constructor(routeMetadata: ExtensionRouteMetadata[] = []) {
    this.#routeMatchers = this.#buildRouteMatchers(routeMetadata);
  }

  load(extensions: Extension[], homeExtensionId?: string): Extension[] {
    registerExtensionOAuthProviders(extensions);
    this.#mergeRouteMetadata(
      extensions.map((extension) => ({
        id: extension.id,
        routePrefixes: extension.routePrefixes,
      }))
    );
    this.#extensions = [...extensions];
    this.#extensionIds = new Set(extensions.map((extension) => extension.id));
    this.#homeExtensionId = homeExtensionId;
    return this.getLoadedExtensions();
  }

  async unload(): Promise<void> {
    for (const extension of [...this.#extensions].reverse()) {
      await extension.stop();
    }
    this.#extensions = [];
    this.#extensionIds = new Set();
    this.#homeExtensionId = undefined;
  }

  async reload(
    extensions: Extension[],
    homeExtensionId?: string
  ): Promise<Extension[]> {
    await this.unload();
    return this.load(extensions, homeExtensionId);
  }

  getLoadedExtensions(): Extension[] {
    return [...this.#extensions];
  }

  isEnabled(extensionId: string, config?: GatewayConfig): boolean {
    if (extensionId !== "mcp" && config && isExplicitlyDisabled(config, extensionId)) return false;
    if (this.#extensionIds.has(extensionId)) return true;
    return config ? hasEnabledConfig(config, extensionId) : false;
  }

  getHomeExtension(): string | undefined {
    return this.#homeExtensionId;
  }

  isMultiUserEnabled(): boolean {
    return this.#extensionIds.has("multiUser");
  }

  getRouteMatchers(): ExtensionRouteMatcher[] {
    return [...this.#routeMatchers];
  }

  async getTools(
    agent: AgentConfig,
    config: GatewayConfig,
    userId?: string
  ): Promise<LoadedExtensionAgentTool[]> {
    const groups = await Promise.all(
      this.#extensions.map(async (extension) => {
        try {
          const scoped = resolveExtensionTokenConfig(extension, agent, config, userId);
          const hookContext = buildHookContext(scoped.agent, scoped.config, userId);
          const tools =
            (await extension.getAgentTools?.(scoped.agent, hookContext)) ?? [];
          return tools.map((tool) => ({
            ...tool,
            extensionId: extension.id,
            // Rebuild at call time: credentials, and for OAuth the grant deciding personal vs team settings, may have changed.
            execute: withOAuthConnectLink(extension, extensionSecretFields(extension).length === 0 && !extension.oauth ? tool.execute : async (args: unknown, context: ExtensionAgentToolContext) => {
              const current = resolveExtensionTokenConfig(extension, context.agent, context.config, context.userId);
              if (current.missing.length) {
                const connectUrl = await requestCredentialConnectLink(context, { kind: "token", extensionId: extension.id }) ?? current.connectUrl;
                return {
                  error: "extension_credentials_required",
                  message: `Add your own token using Just me at [Configure ${extension.displayName}](${connectUrl}) before using this tool. An admin can also configure Whole team credentials.`,
                  connectUrl,
                };
              }
              const callTools = await extension.getAgentTools?.(current.agent, buildHookContext(current.agent, current.config, context.userId));
              const callTool = callTools?.find((candidate) => candidate.name === tool.name);
              if (!callTool) return { error: "extension_tool_unavailable", connectUrl: current.connectUrl };
              return callTool.execute(args, { ...context, agent: current.agent, config: current.config });
            }),
          }));
        } catch (error) {
          console.warn("Skipping extension tools", {
            extensionId: extension.id,
            agentId: agent.id,
            fields: extensionConfigFieldNames(error),
          });
          return [];
        }
      })
    );
    const tools = groups.flat();
    const seen = new Set<string>();
    for (const tool of tools) {
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate extension agent tool: ${tool.name}`);
      }
      seen.add(tool.name);
    }
    return tools;
  }

  async getTool(
    agent: AgentConfig,
    toolName: string,
    config: GatewayConfig,
    userId?: string
  ): Promise<LoadedExtensionAgentTool | undefined> {
    return (await this.getTools(agent, config, userId)).find(
      (tool) => tool.name === toolName
    );
  }

  async executeTool(
    agent: AgentConfig,
    toolName: string,
    args: unknown,
    config: GatewayConfig,
    sessionId?: string,
    userId?: string,
    emitProgress?: import("@yoplai/shared").ExtensionAgentToolContext["emitProgress"]
  ): Promise<{ found: boolean; result?: unknown }> {
    const tool = await this.getTool(agent, toolName, config, userId);
    if (!tool) return { found: false };
    const env = resolveAgentEnv(agent, config);
    return {
      found: true,
      result: await tool.execute(args, {
        agent,
        config,
        env,
        sessionId,
        userId,
        emitProgress,
      }),
    };
  }

  async getPromptContributions(
    agent: AgentConfig,
    config: GatewayConfig,
    userId?: string
  ): Promise<string[]> {
    const contributions = await Promise.all(
      this.#extensions.map(async (extension) => {
        try {
          const scoped = resolveExtensionTokenConfig(extension, agent, config, userId);
          if (scoped.missing.length) return [
            `${extension.displayName} requires credentials. Ask the user to add their own token using Just me at [Configure ${extension.displayName}](${scoped.connectUrl}) before using its tools. For Slack requests, call the requested tool to receive a single personal connection link; do not send this web configuration link.`,
          ];
          const hookContext = buildHookContext(scoped.agent, scoped.config, userId);
          const contribution = await extension.getSystemPromptContributions?.(
            scoped.agent,
            hookContext
          );
          if (!contribution) return [];
          return Array.isArray(contribution) ? contribution : [contribution];
        } catch (error) {
          console.warn("Skipping extension prompt", {
            extensionId: extension.id,
            agentId: agent.id,
            fields: extensionConfigFieldNames(error),
          });
          return [];
        }
      })
    );

    return contributions.flat().filter((prompt) => prompt.trim().length > 0);
  }

  async getPrompts(
    agent: AgentConfig,
    config: GatewayConfig,
    userId?: string
  ): Promise<string[]> {
    return this.getPromptContributions(agent, config, userId);
  }

  getCapabilities(): ExtensionCapabilities {
    const visibleExtensions = this.#extensions.filter(
      (extension) =>
        extension.id !== "taskLifecycle" &&
        extension.id !== "capabilityDiscovery"
    );
    return {
      extensions: Object.fromEntries(
        visibleExtensions.map((extension) => [extension.id, true])
      ),
      capabilities: Object.fromEntries(
        visibleExtensions.map((extension) => [
          extension.id,
          extension.capabilities(),
        ])
      ),
      multiUser: this.isMultiUserEnabled(),
      home: this.#homeExtensionId,
    };
  }

  #buildRouteMatchers(
    routeMetadata: ExtensionRouteMetadata[]
  ): ExtensionRouteMatcher[] {
    return routeMetadata.flatMap((extension) =>
      extension.routePrefixes.map((prefix) => ({
        extension: extension.id,
        allowWhenDisabled: extension.allowWhenDisabled,
        matches: routePrefixToMatcher(prefix),
      }))
    );
  }

  #mergeRouteMetadata(routeMetadata: ExtensionRouteMetadata[]): void {
    const knownIds = new Set(
      this.#routeMatchers.map((matcher) => matcher.extension)
    );
    const newMetadata = routeMetadata.filter(
      (extension) => !knownIds.has(extension.id)
    );
    this.#routeMatchers.push(...this.#buildRouteMatchers(newMetadata));
  }
}

export const emptyExtensionRuntime = new ExtensionRuntime();
