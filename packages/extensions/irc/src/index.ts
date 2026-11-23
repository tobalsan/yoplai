import { ircSettings, readAgentChannelConfig } from "./config.js";
import {
  createChannelBotReconciler,
  IrcExtensionConfigSchema,
  type Extension,
  type ExtensionContext,
  type IrcAgentConfig,
  type IrcExtensionConfig,
} from "@yoplai/shared";
import { IrcRouter } from "./router.js";
import { IrcService } from "./service.js";

const reconcileAgentBots = createChannelBotReconciler("irc", readAgentChannelConfig);
let stopSharedBot: (() => void) | undefined;
let hostContext: ExtensionContext | undefined;

function normalizeAgentConfig(
  agentId: string,
  config: IrcAgentConfig
): IrcExtensionConfig {
  return {
    ...config,
    channels: Object.fromEntries(
      Object.entries(config.channels).map(([channel, route]) => [
        channel,
        { ...route, agent: agentId },
      ])
    ),
    dm: config.dm ? { ...config.dm, agent: agentId } : undefined,
  };
}

function startService(
  ctx: ExtensionContext,
  config: IrcExtensionConfig,
  ownerAgentId?: string
): () => void {
  const service = new IrcService(
    { ...config, channels: Object.keys(config.channels) },
    (message) => router.handle(message)
  );
  const router = new IrcRouter(ctx, config, service, ownerAgentId);
  service.start();
  return () => {
    router.stop();
    service.stop();
  };
}

async function reconcileBots(ctx?: ExtensionContext) {
  if (!ctx) {
    await reconcileAgentBots([], async () => undefined);
    return;
  }
  await reconcileAgentBots(ctx.getAgents().filter((agent) => ctx.isAgentActive(agent.id)), async (agent, settings) =>
    startService(ctx, normalizeAgentConfig(agent.id, settings), agent.id)
  );
}

const ircExtension: Extension = {
  ...ircSettings,
  id: "irc",
  displayName: "IRC",
  description: "IRC channel and direct-message routing",
  dependencies: [],
  configSchema: IrcExtensionConfigSchema,
  routePrefixes: [],
  validateConfig(raw) {
    if (
      !raw ||
      (typeof raw === "object" &&
        (Object.keys(raw).length === 0 ||
          "_perAgent" in raw ||
          "_perAgentFallback" in raw))
    ) {
      return { valid: true, errors: [] };
    }
    const result = IrcExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes() {},
  async start(ctx) {
    hostContext = ctx;
    const root = IrcExtensionConfigSchema.safeParse(
      ctx.getConfig().extensions?.irc
    );
    if (root.success && root.data.enabled !== false) {
      stopSharedBot = startService(ctx, root.data);
    }

    await reconcileBots(ctx);
  },
  onConfigReload: () => reconcileBots(hostContext),
  async stop() {
    hostContext = undefined;
    await reconcileBots();
    stopSharedBot?.();
    stopSharedBot = undefined;
  },
  capabilities() {
    return ["irc"];
  },
};

export { ircExtension };
export * from "./protocol.js";
export * from "./loop-guard.js";
