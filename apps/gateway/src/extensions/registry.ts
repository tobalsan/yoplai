import path from "node:path";
import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import { discoverExternalExtensions, readEnv } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";
import { ExtensionRuntime } from "./runtime.js";
import { taskLifecycleExtension } from "../tasks/extension.js";

type ExtensionRegistration = {
  load: () => Promise<Extension>;
  packageName?: string;
  exportName?: string;
  getConfig: (config: GatewayConfig) => unknown;
  routePrefixes: string[];
  loadWhenDisabled?: boolean;
  allowRoutesWhenDisabled?: boolean;
};

type ExtensionModule = Record<string, unknown>;

const MONOREPO_DEV_EXTENSION_IMPORTS: Record<string, string> = {
  "@yoplai/extension-board": new URL(
    "../../../../packages/extensions/board/src/index.ts",
    import.meta.url
  ).href,
  "@yoplai/extension-projects": new URL(
    "../../../../packages/extensions/projects/src/index.ts",
    import.meta.url
  ).href,
  "@yoplai/extension-orchestrator": new URL(
    "../../../../packages/extensions/orchestrator/src/index.ts",
    import.meta.url
  ).href,
};

function isModuleNotFound(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

function isMonorepoDevRuntime(): boolean {
  return (
    readEnv("WEB_DEV") === "1" ||
    process.env.NODE_OPTIONS?.includes("--conditions=development") === true
  );
}

async function importExtensionModule(
  packageName: string
): Promise<ExtensionModule> {
  try {
    return (await import(packageName)) as ExtensionModule;
  } catch (error) {
    const devImport = MONOREPO_DEV_EXTENSION_IMPORTS[packageName];
    if (isModuleNotFound(error) && devImport && isMonorepoDevRuntime()) {
      return (await import(devImport)) as ExtensionModule;
    }
    throw error;
  }
}

async function importExtension(
  packageName: string,
  exportName: string
): Promise<Extension> {
  try {
    const module = await importExtensionModule(packageName);
    const extension = module[exportName];
    if (!extension) {
      throw new Error(
        `Package "${packageName}" does not export "${exportName}"`
      );
    }
    return extension as Extension;
  } catch (error) {
    if (isModuleNotFound(error)) {
      throw new Error(
        `Extension package "${packageName}" is required because it is enabled, but it is not installed. Install the package or disable the extension in config.`
      );
    }
    throw error;
  }
}

function builtInExtension(
  packageName: string,
  exportName: string,
  options: Omit<ExtensionRegistration, "load" | "packageName" | "exportName">
): ExtensionRegistration {
  return {
    ...options,
    packageName,
    exportName,
    load: () => importExtension(packageName, exportName),
  };
}

const EXTENSION_LOAD_PRIORITY: Record<string, number> = {
  webhooks: -10,
  subagents: -5,
  discord: 10,
  irc: 10,
  slack: 10,
  telegram: 10,
};

const EXTENSION_REGISTRY: Record<string, ExtensionRegistration> = {
  irc: {
    packageName: "@yoplai/extension-irc",
    load: () =>
      import("@yoplai/extension-irc").then((module) => module.ircExtension),
    getConfig: (config) => {
      const hasPerAgent = config.agents?.some((agent) => agent.irc);
      const rootConfig = config.extensions?.irc;
      if (rootConfig && (rootConfig.enabled !== false || !hasPerAgent)) {
        return { ...rootConfig, _perAgentFallback: hasPerAgent };
      }
      return hasPerAgent ? { _perAgent: true } : rootConfig;
    },
    routePrefixes: [],
  },
  discord: {
    packageName: "@yoplai/extension-discord",
    load: () =>
      import("@yoplai/extension-discord").then(
        (module) => module.discordExtension
      ),
    getConfig: (config) => {
      const hasPerAgent = config.agents?.some((a) => a.discord?.token);
      if (config.extensions?.discord) {
        return { ...config.extensions.discord, _perAgentFallback: hasPerAgent };
      }
      return hasPerAgent ? { _perAgent: true } : undefined;
    },
    routePrefixes: [],
  },
  slack: {
    packageName: "@yoplai/extension-slack",
    load: () =>
      import("@yoplai/extension-slack").then((module) => module.slackExtension),
    getConfig: (config) => {
      const hasPerAgent = config.agents?.some((a) => a.slack?.token);
      if (config.extensions?.slack) {
        return { ...config.extensions.slack, _perAgentFallback: hasPerAgent };
      }
      return hasPerAgent ? { _perAgent: true } : undefined;
    },
    routePrefixes: [],
  },
  telegram: {
    packageName: "@yoplai/extension-telegram",
    load: () =>
      import("@yoplai/extension-telegram").then(
        (module) => module.telegramExtension
      ),
    getConfig: (config) => {
      const hasPerAgent = config.agents?.some((a) => a.telegram?.token);
      if (config.extensions?.telegram) {
        return {
          ...config.extensions.telegram,
          _perAgentFallback: hasPerAgent,
        };
      }
      return hasPerAgent ? { _perAgent: true } : undefined;
    },
    routePrefixes: [],
  },
  scheduler: {
    load: () =>
      import("@yoplai/extension-scheduler").then(
        (module) => module.schedulerExtension
      ),
    getConfig: (config) => config.extensions?.scheduler,
    routePrefixes: ["/api/schedules"],
    loadWhenDisabled: true,
    allowRoutesWhenDisabled: true,
  },
  heartbeat: {
    load: () =>
      import("@yoplai/extension-heartbeat").then(
        (module) => module.heartbeatExtension
      ),
    getConfig: (config) => {
      const hasPerAgent = config.agents.some((agent) => agent.heartbeat?.every);
      if (config.extensions?.heartbeat) {
        return {
          ...config.extensions.heartbeat,
          _perAgentFallback: hasPerAgent,
        };
      }
      return hasPerAgent ? { _perAgent: true } : undefined;
    },
    routePrefixes: ["/api/agents/:id/heartbeat"],
  },
  projects: builtInExtension(
    "@yoplai/extension-projects",
    "projectsExtension",
    {
      getConfig: (config) => config.extensions?.projects,
      routePrefixes: [
        "/api/areas",
        "/api/projects",
        "/api/activity",
        "/api/taskboard",
      ],
    }
  ),
  subagents: {
    load: () =>
      import("@yoplai/extension-subagents").then(
        (module) => module.subagentsExtension
      ),
    getConfig: (config) => config.extensions?.subagents,
    routePrefixes: ["/api/subagents"],
  },
  orchestrator: builtInExtension(
    "@yoplai/extension-orchestrator",
    "orchestratorExtension",
    {
      getConfig: (config) => config.extensions?.orchestrator,
      routePrefixes: ["/api/orchestrator"],
    }
  ),
  langfuse: {
    load: () =>
      import("@yoplai/extension-langfuse").then(
        (module) => module.langfuseExtension
      ),
    getConfig: (config) => config.extensions?.langfuse,
    routePrefixes: [],
  },
  webhooks: {
    packageName: "@yoplai/extension-webhooks",
    load: () =>
      import("@yoplai/extension-webhooks").then(
        (module) => module.webhooksExtension
      ),
    getConfig: (config) => {
      const hasWebhooks = config.agents?.some(
        (agent) => agent.webhooks && Object.keys(agent.webhooks).length > 0
      );
      return hasWebhooks ? { _perAgent: true } : undefined;
    },
    routePrefixes: ["/hooks"],
  },
  multiUser: {
    load: () =>
      import("@yoplai/extension-multi-user").then(
        (module) => module.multiUserExtension
      ),
    getConfig: (config) => config.extensions?.multiUser,
    routePrefixes: ["/api/auth", "/api/me", "/api/admin", "/api/teams"],
  },
  board: builtInExtension("@yoplai/extension-board", "boardExtension", {
    getConfig: (config) => config.extensions?.board,
    routePrefixes: ["/api/board"],
  }),
};

/**
 * Stock extensions that can also be configured at the agent.yaml root (for
 * example, `agent.slack`) instead of under `agent.extensions`. Heartbeat is
 * omitted because it is factory-only and never appears in the catalog.
 */
const AGENT_ROOT_CONFIG_KEYS: Record<string, string> = {
  discord: "discord",
  slack: "slack",
  telegram: "telegram",
  irc: "irc",
  webhooks: "webhooks",
};

export function hasAgentRootConfig(
  agent: AgentConfig,
  extensionId: string
): boolean {
  const key = AGENT_ROOT_CONFIG_KEYS[extensionId];
  if (!key) return false;
  const value = (agent as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value).length > 0;
}

const extensionRuntime = new ExtensionRuntime(getKnownExtensionRouteMetadata());

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getRootExtensionConfig(
  config: GatewayConfig,
  id: string
): Record<string, unknown> | undefined {
  const extensions = config.extensions as Record<string, unknown> | undefined;
  const value = extensions?.[id];
  if (value === undefined) return undefined;
  return toRecord(value);
}

function hasEnabledAgentExtensionConfig(
  config: GatewayConfig,
  id: string
): boolean {
  return config.agents.some((agent) => {
    const extensions = agent.extensions as Record<string, unknown> | undefined;
    if (!extensions || !(id in extensions)) return false;
    return toRecord(extensions[id]).enabled !== false;
  });
}

export function getKnownExtensionRouteMetadata(): Array<{
  id: string;
  routePrefixes: string[];
  allowWhenDisabled?: boolean;
}> {
  return Object.entries(EXTENSION_REGISTRY).map(([id, registration]) => ({
    id,
    routePrefixes: registration.routePrefixes,
    allowWhenDisabled: registration.allowRoutesWhenDisabled,
  }));
}

/** Built-in extension ids in the static registry, with their route prefixes. */
export function getBuiltInExtensionRegistrations(): Array<{
  id: string;
  routePrefixes: string[];
  load: () => Promise<Extension>;
  packageName?: string;
}> {
  return Object.entries(EXTENSION_REGISTRY).map(([id, registration]) => ({
    id,
    routePrefixes: registration.routePrefixes,
    load: registration.load,
    packageName: registration.packageName,
  }));
}

/** Directory scanned for runtime (external) extensions. */
export function getExternalExtensionsPath(config: GatewayConfig): string {
  return config.extensionsPath ?? path.join(CONFIG_DIR, "extensions");
}

export function topoSort(extensions: Extension[]): Extension[] {
  const ordered: Extension[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(
    extensions.map((extension) => [extension.id, extension])
  );

  function visit(extension: Extension): void {
    if (visited.has(extension.id)) return;
    if (visiting.has(extension.id)) {
      throw new Error(
        `Circular extension dependency involving "${extension.id}"`
      );
    }
    visiting.add(extension.id);
    for (const dependency of extension.dependencies) {
      const dependencyExtension = byId.get(dependency);
      if (!dependencyExtension) {
        throw new Error(
          `Extension "${extension.id}" requires "${dependency}" which is not enabled`
        );
      }
      visit(dependencyExtension);
    }
    visiting.delete(extension.id);
    visited.add(extension.id);
    ordered.push(extension);
  }

  for (const extension of extensions) {
    visit(extension);
  }

  return ordered;
}

/**
 * Activates a not-yet-loaded extension into the running gateway: registers its
 * routes and starts it. Wired once at startup (see cli/gateway.ts) so the
 * registry can bring extensions online without importing the server/context
 * modules (which would be a circular import). Undefined until wired.
 */
type ExtensionActivator = (extension: Extension) => Promise<void>;
let activateExtension: ExtensionActivator | undefined;

export function setExtensionActivator(activator: ExtensionActivator): void {
  activateExtension = activator;
}

/**
 * Compute the desired set of extensions to load for a config, resolving the
 * home-route owner. Pure w.r.t. runtime state — does not touch the runtime.
 */
async function deriveExtensionsToLoad(
  config: GatewayConfig
): Promise<{ extensions: Extension[]; homeExtensionId: string | undefined }> {
  const extensions: Extension[] = [taskLifecycleExtension];
  const rawConfigs = new Map<string, Record<string, unknown>>();

  const registrations = Object.entries(EXTENSION_REGISTRY).sort(
    ([leftId], [rightId]) =>
      (EXTENSION_LOAD_PRIORITY[leftId] ?? 0) -
      (EXTENSION_LOAD_PRIORITY[rightId] ?? 0)
  );

  for (const [id, registration] of registrations) {
    const extensionConfig = toRecord(registration.getConfig(config));
    const hasConfig = registration.getConfig(config) !== undefined;

    // Most extensions are skipped when explicitly disabled. Scheduler is
    // special: disabled means no timer firing, but API/CLI routes stay usable.
    if (extensionConfig?.enabled === false && !registration.loadWhenDisabled)
      continue;

    // Skip extensions that have no config — must be opted in via config.extensions[id]
    if (!hasConfig) continue;

    const extension = await registration.load();
    const configToValidate = extensionConfig;
    const validation = extension.validateConfig(configToValidate);
    if (!validation.valid) {
      throw new Error(
        `Extension "${id}" config invalid: ${validation.errors.join(", ")}`
      );
    }
    extensions.push(extension);
    rawConfigs.set(id, configToValidate);
  }

  // Discover external extensions
  const extensionsPath = getExternalExtensionsPath(config);
  const external = await discoverExternalExtensions(extensionsPath);
  for (const { extension, id } of external) {
    if (EXTENSION_REGISTRY[id]) {
      throw new Error(
        `External extension "${id}" conflicts with a built-in extension id`
      );
    }
    if (extensions.some((candidate) => candidate.id === id)) {
      throw new Error(`Duplicate extension id "${id}"`);
    }

    const extensionConfig = getRootExtensionConfig(config, id);
    const hasAgentConfig = hasEnabledAgentExtensionConfig(config, id);
    if (extensionConfig?.enabled === false) continue;
    if (!extensionConfig && !hasAgentConfig) {
      continue;
    }

    const configToValidate = extensionConfig ?? {};
    const validation = extension.validateConfig(configToValidate);
    if (!validation.valid) {
      throw new Error(
        `Extension "${id}" config invalid: ${validation.errors.join(", ")}`
      );
    }
    extensions.push(extension);
    rawConfigs.set(id, configToValidate);
  }

  const loadedExtensions = topoSort(extensions);
  const loadedExtensionIds = new Set(
    loadedExtensions.map((extension) => extension.id)
  );

  // Resolve home route ownership
  // Parse each extension's raw config through its own configSchema to resolve defaults
  const homeClaimants = loadedExtensions.filter((extension) => {
    const raw = rawConfigs.get(extension.id);
    if (!raw) return false;
    try {
      const parsed = extension.configSchema.parse(raw) as Record<
        string,
        unknown
      >;
      return parsed.home === true;
    } catch {
      return false;
    }
  });
  if (homeClaimants.length > 1) {
    const names = homeClaimants.map((e) => `"${e.id}"`).join(", ");
    throw new Error(
      `Multiple extensions claim home route: ${names}. Only one extension can have home: true.`
    );
  }
  const homeExtensionId = homeClaimants[0]?.id;

  for (const agent of config.agents) {
    const agentExtensions = agent.extensions as
      | Record<string, unknown>
      | undefined;
    if (!agentExtensions) continue;
    for (const [id, value] of Object.entries(agentExtensions)) {
      if (toRecord(value).enabled === false) continue;
      if (!loadedExtensionIds.has(id)) {
        console.warn(
          `[extensions] agent "${agent.id}" references unknown extension "${id}"`
        );
      }
    }
  }

  return { extensions: loadedExtensions, homeExtensionId };
}

export async function loadExtensions(
  config: GatewayConfig
): Promise<Extension[]> {
  const { extensions, homeExtensionId } = await deriveExtensionsToLoad(config);
  extensionRuntime.load(extensions, homeExtensionId);
  return extensionRuntime.getLoadedExtensions();
}

/**
 * Reconcile the running extension set against the current config WITHOUT a
 * restart. Only ever ADDS: extensions that the config now wants but that were
 * not loaded at startup are activated (routes registered + started) and folded
 * into the runtime set. Already-loaded extensions are never re-started or
 * dropped, so this is safe to call on every per-agent enable / config change.
 * A no-op (aside from the derivation) when nothing new is needed.
 */
export async function reloadExtensions(
  config: GatewayConfig
): Promise<Extension[]> {
  const { extensions: desired, homeExtensionId } =
    await deriveExtensionsToLoad(config);

  const current = extensionRuntime.getLoadedExtensions();
  const currentIds = new Set(current.map((extension) => extension.id));
  const newlyNeeded = desired.filter(
    (extension) => !currentIds.has(extension.id)
  );
  if (newlyNeeded.length === 0) {
    return current;
  }
  if (!activateExtension) {
    console.warn(
      `[extensions] cannot activate ${newlyNeeded
        .map((extension) => `"${extension.id}"`)
        .join(", ")} at runtime: no activator wired; restart required`
    );
    return current;
  }

  // Preserve everything already running; append the new ones. Re-topo the
  // union so newly added dependencies are ordered ahead of their dependents.
  const merged = topoSort([...current, ...newlyNeeded]);
  const newlyNeededIds = new Set(newlyNeeded.map((extension) => extension.id));

  // Activate (register routes + start) only the new extensions, in topo order.
  for (const extension of merged) {
    if (!newlyNeededIds.has(extension.id)) continue;
    await activateExtension(extension);
  }

  extensionRuntime.load(
    merged,
    homeExtensionId ?? extensionRuntime.getHomeExtension()
  );
  return extensionRuntime.getLoadedExtensions();
}

export function getLoadedExtensions(): Extension[] {
  return extensionRuntime.getLoadedExtensions();
}

export function isMultiUserLoaded(): boolean {
  return extensionRuntime.isMultiUserEnabled();
}

export function isExtensionLoaded(extensionId: string): boolean {
  return extensionRuntime.isEnabled(extensionId);
}

export function getHomeExtension(): string | undefined {
  return extensionRuntime.getHomeExtension();
}

export function getExtensionRuntime(): ExtensionRuntime {
  return extensionRuntime;
}

export function createExtensionRuntime(
  extensions: Extension[],
  homeExtensionId?: string
): ExtensionRuntime {
  const runtime = new ExtensionRuntime(getKnownExtensionRouteMetadata());
  runtime.load(extensions, homeExtensionId);
  return runtime;
}
