import { readAgentChannelConfig, discordSettings } from "./config.js";
import {
  DiscordExtensionConfigSchema,
  createChannelBotReconciler,
  startRegisteredChannelBot,
  type DeliverySink,
  type Extension,
  type ExtensionContext,
  type DiscordComponentConfig,
} from "@yoplai/shared";
import {
  createDiscordBot,
  createDiscordComponentBot,
  type DiscordBot,
} from "./bot.js";
import { clearDiscordContext, getDiscordContext, setDiscordContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerComponentBot,
} from "./bot-registry.js";
import {
  clearDiscordClientCache,
  discordAgentTools,
  getDiscordDeliveryOffer,
  sendDiscordDelivery,
} from "./agent-tools.js";

let unregisterDeliverySink: (() => void) | undefined;

function createDiscordDeliverySink(ctx: ExtensionContext): DeliverySink {
  return ({ agent, destination, text }) =>
    sendDiscordDelivery(agent, ctx.getConfig(), destination, text);
}

export async function startDiscordBots(
  ctx: ExtensionContext,
  componentConfig?: DiscordComponentConfig
): Promise<void> {
  setDiscordContext(ctx);

  if (componentConfig) {
    const bot = await createDiscordComponentBot(
      ctx.getAgents(),
      componentConfig
    );
    if (!bot) return;

    try {
      await bot.start();
      registerComponentBot(bot);
      console.log("[discord] Started component bot");
    } catch (err) {
      console.error("[discord] Failed to start component bot:", err);
    }
    return;
  }

  await reconcileBots(ctx);
}

const reconcileAgentBots = createChannelBotReconciler("discord", (agent) => {
  const settings = readAgentChannelConfig(agent);
  return settings?.token?.trim() ? settings : undefined;
});

async function reconcileBots(ctx?: ExtensionContext): Promise<void> {
  const agents = ctx?.getAgents().filter((agent) => ctx.isAgentActive(agent.id)) ?? [];
  await reconcileAgentBots(agents, (agent) => startRegisteredChannelBot(getActiveBots(), agent.id, createDiscordBot(agent)));
}


export async function stopDiscordBots(): Promise<void> {
  await reconcileBots();
  const bots = [...getActiveBots()];
  const component = getComponentBot();
  if (component) bots.push(["discord", component]);
  for (const [agentId, bot] of bots) {
    try {
      await bot.stop();
      console.log(`[discord] Stopped bot for agent: ${agentId}`);
    } catch (err) {
      console.error(`[discord] Failed to stop bot for agent ${agentId}:`, err);
    }
  }
  clearActiveBots();
  clearDiscordClientCache();
}

const discordExtension: Extension = {
  ...discordSettings,
  id: "discord",
  displayName: "Discord",
  description: "Discord integration for channel and DM routing",
  dependencies: [],
  configSchema: DiscordExtensionConfigSchema,
  routePrefixes: [],
  validateConfig(raw) {
    if (
      !raw ||
      (typeof raw === "object" &&
        (Object.keys(raw as object).length === 0 ||
          "_perAgent" in (raw as object) ||
          "_perAgentFallback" in (raw as object)))
    ) {
      return { valid: true, errors: [] };
    }
    const result = DiscordExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes() {},
  getAgentTools(_agent, context) {
    if (context?.config.extensions?.discord?.enabled === false) return [];
    return discordAgentTools();
  },
  async start(ctx) {
    unregisterDeliverySink = ctx.registerDeliverySink(
      "discord",
      createDiscordDeliverySink(ctx),
      ({ agent }) => getDiscordDeliveryOffer(agent, ctx.getConfig())
    );

    const rawConfig = ctx.getConfig().extensions?.discord;

    if (rawConfig) {
      const parsed = DiscordExtensionConfigSchema.safeParse(rawConfig);
      if (parsed.success) {
        await startDiscordBots(ctx, { ...parsed.data });
      }
    }

    await startDiscordBots(ctx);
  },
  onConfigReload: () => reconcileBots(getDiscordContext()),
  async stop() {
    unregisterDeliverySink?.();
    unregisterDeliverySink = undefined;
    await stopDiscordBots();
    clearDiscordContext();
  },
  capabilities() {
    return ["discord"];
  },
};

export { discordExtension, createDiscordBot, type DiscordBot };
export { getActiveBot };
export {
  createThreadSessionBindingStore,
  ThreadSessionBindingStore,
  type SetThreadSessionBindingInput,
  type ThreadSessionBinding,
} from "./thread-session-bindings.js";
export { getForumSubscribers } from "./forum-subscribers.js";

export { readAgentChannelConfig } from "./config.js";
