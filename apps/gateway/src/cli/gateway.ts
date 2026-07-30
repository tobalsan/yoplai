import { readEnv, type Extension, type GatewayConfig } from "@yoplai/shared";
import {
  loadConfig,
  getAgent,
  setSingleAgentMode,
  setLoadedConfig,
} from "../config/index.js";
import { startServer } from "../server/index.js";
import { api } from "../server/api.core.js";
import {
  getExtensionRuntime,
  loadExtensions,
  reloadExtensions,
  setExtensionActivator,
} from "../extensions/registry.js";
import { createExtensionContext } from "../extensions/context.js";
import {
  prepareStartupConfig,
  logComponentSummary,
  resolveStartupConfig,
} from "../config/validate.js";
import { startGatewayHotReload } from "../config/hot-reload.js";

export type GatewayCommandOptions = {
  port?: string;
  host?: string;
  agentId?: string;
  dev?: boolean;
};

export type StartedGateway = {
  actualPort: number;
  config: GatewayConfig;
  extensions: Extension[];
  uiEnabled: boolean;
  uiPort: number;
};

export async function startGatewayCommand(
  opts: GatewayCommandOptions
): Promise<StartedGateway> {
  const rawConfig = loadConfig();
  const resolvedStartupConfig = await resolveStartupConfig(rawConfig);
  const extensions = await loadExtensions(resolvedStartupConfig);
  const extensionRuntime = getExtensionRuntime();
  const { resolvedConfig: config, summary } = await prepareStartupConfig(
    rawConfig,
    extensions,
    { resolvedConfig: resolvedStartupConfig }
  );
  logComponentSummary(summary);
  setLoadedConfig(config);

  console.log(`Loaded config with ${config.agents.length} agent(s)`);

  if (opts.agentId) {
    const agent = getAgent(opts.agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${opts.agentId}`);
    }
    setSingleAgentMode(opts.agentId);
    console.log(`Single-agent mode: ${agent.name} (${agent.id})`);
  }

  if (opts.dev) {
    process.env.YOPLAI_DEV = "1";
  }

  for (const extension of extensions) {
    extension.registerRoutes(api);
  }

  const port = opts.port ? parseInt(opts.port, 10) : undefined;
  const actualPort = port ?? config.gateway?.port ?? 4000;
  const envUiPort = readEnv("UI_PORT");
  const uiPort = envUiPort
    ? parseInt(envUiPort, 10)
    : (config.ui?.port ?? 3000);
  const runtimeConfig = {
    ...config,
    gateway: { ...config.gateway, port: actualPort },
    ui: { ...config.ui, port: uiPort },
  };
  const extensionContext = createExtensionContext(runtimeConfig);
  for (const extension of extensions) {
    await extension.start(extensionContext);
  }
  (await import("../dream/service.js")).startDreamTimers();

  // Allow extensions enabled at runtime (via the per-agent PATCH endpoint or a
  // config-file edit) to be brought online without a restart.
  setExtensionActivator(async (extension) => {
    extension.registerRoutes(api);
    await extension.start(extensionContext);
  });

  startServer(port, opts.host, extensionRuntime);
  startGatewayHotReload(runtimeConfig, {
    async onReload(nextConfig) {
      try {
        await reloadExtensions(nextConfig);
      } catch (error) {
        console.warn(
          `[hot-reload] Extension reconcile failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    },
    onError(error) {
      console.warn(
        `[hot-reload] Reload failed; keeping last good config: ${error instanceof Error ? error.message : String(error)}`
      );
    },
  });

  return {
    actualPort,
    config,
    extensions,
    uiEnabled: config.ui?.enabled !== false,
    uiPort,
  };
}
