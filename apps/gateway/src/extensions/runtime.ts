import type {
  AgentConfig,
  Extension,
  ExtensionAgentTool,
  ExtensionHookContext,
  GatewayConfig,
  OAuthRequirement,
  ResolvedOAuth,
} from "@yoplai/shared";
import { extensionConfigFieldNames } from "@yoplai/shared";
import { resolveAgentEnv } from "../config/index.js";
import { getOAuthService } from "../oauth/service.js";

function buildHookContext(
  agent: AgentConfig,
  config: GatewayConfig
): ExtensionHookContext {
  return {
    config,
    env: resolveAgentEnv(agent, config),
    resolveOAuth: (agent: AgentConfig, requirement: OAuthRequirement): Promise<ResolvedOAuth> =>
      getOAuthService().resolveToken(agent.id, requirement),
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

export class ExtensionRuntime {
  #extensions: Extension[] = [];
  #extensionIds = new Set<string>();
  #homeExtensionId: string | undefined;
  #routeMatchers: ExtensionRouteMatcher[];

  constructor(routeMetadata: ExtensionRouteMetadata[] = []) {
    this.#routeMatchers = this.#buildRouteMatchers(routeMetadata);
  }

  load(extensions: Extension[], homeExtensionId?: string): Extension[] {
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
    if (config && isExplicitlyDisabled(config, extensionId)) return false;
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
    config: GatewayConfig
  ): Promise<LoadedExtensionAgentTool[]> {
    const hookContext = buildHookContext(agent, config);
    const groups = await Promise.all(
      this.#extensions.map(async (extension) => {
        try {
          const tools =
            (await extension.getAgentTools?.(agent, hookContext)) ?? [];
          return tools.map((tool) => ({ ...tool, extensionId: extension.id }));
        } catch (error) {
          console.warn("Skipping extension tools", { extensionId: extension.id, agentId: agent.id, fields: extensionConfigFieldNames(error) });
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
    config: GatewayConfig
  ): Promise<LoadedExtensionAgentTool | undefined> {
    return (await this.getTools(agent, config)).find(
      (tool) => tool.name === toolName
    );
  }

  async executeTool(
    agent: AgentConfig,
    toolName: string,
    args: unknown,
    config: GatewayConfig,
    sessionId?: string
  ): Promise<{ found: boolean; result?: unknown }> {
    const tool = await this.getTool(agent, toolName, config);
    if (!tool) return { found: false };
    const env = resolveAgentEnv(agent, config);
    return {
      found: true,
      result: await tool.execute(args, { agent, config, env, sessionId }),
    };
  }

  async getPromptContributions(
    agent: AgentConfig,
    config: GatewayConfig
  ): Promise<string[]> {
    const hookContext = buildHookContext(agent, config);
    const contributions = await Promise.all(
      this.#extensions.map(async (extension) => {
        try {
          const contribution = await extension.getSystemPromptContributions?.(
            agent,
            hookContext
          );
          if (!contribution) return [];
          return Array.isArray(contribution) ? contribution : [contribution];
        } catch (error) {
          console.warn("Skipping extension prompt", { extensionId: extension.id, agentId: agent.id, fields: extensionConfigFieldNames(error) });
          return [];
        }
      })
    );

    return contributions.flat().filter((prompt) => prompt.trim().length > 0);
  }

  async getPrompts(
    agent: AgentConfig,
    config: GatewayConfig
  ): Promise<string[]> {
    return this.getPromptContributions(agent, config);
  }

  getCapabilities(): ExtensionCapabilities {
    return {
      extensions: Object.fromEntries(
        this.#extensions.map((extension) => [extension.id, true])
      ),
      capabilities: Object.fromEntries(
        this.#extensions.map((extension) => [
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
