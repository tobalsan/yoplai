import { readAgentChannelConfig, telegramSettings } from "./config.js";
import {
  TelegramExtensionConfigSchema,
  createChannelBotReconciler,
  startRegisteredChannelBot,
  type AgentConfig,
  type DeliveryDestination,
  type Extension,
  type ExtensionContext,
  type TelegramComponentConfig,
} from "@yoplai/shared";
import {
  createTelegramAgentBot,
  createTelegramBot,
  type TelegramBot,
} from "./bot.js";
import { clearTelegramContext, getTelegramContext, setTelegramContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerComponentBot,
} from "./bot-registry.js";
import { getTelegramDeliveryOffer, sendTelegramMessage, telegramAgentTools } from "./agent-tools.js";

let unregisterDeliverySink: (() => void) | undefined;

/** Delivery destination → Telegram chat ID: `user` (preferred) or `channel`. */
function toChatId(destination: DeliveryDestination): string | undefined {
  return destination.user ?? destination.channel;
}

type StartTelegramBotsOptions = {
  agents: AgentConfig[];
  componentConfig: TelegramComponentConfig;
};

export async function startTelegramBots(
  ctx: ExtensionContext,
  options?: StartTelegramBotsOptions
): Promise<void> {
  setTelegramContext(ctx);

  if (options) {
    const bot = createTelegramBot(options.agents, options.componentConfig);
    if (!bot) return;

    try {
      await bot.start();
      registerComponentBot(bot);
      console.log("[telegram] Started component bot");
    } catch (err) {
      console.error("[telegram] Failed to start component bot:", err);
    }
    return;
  }

  await reconcileBots(ctx);
}

const reconcileAgentBots = createChannelBotReconciler("telegram", readAgentChannelConfig);

async function reconcileBots(ctx?: ExtensionContext): Promise<void> {
  const agents = ctx?.getAgents().filter((agent) => ctx.isAgentActive(agent.id)) ?? [];
  await reconcileAgentBots(agents, (agent) => startRegisteredChannelBot(getActiveBots(), agent.id, createTelegramAgentBot(agent)));
}


export async function stopTelegramBots(): Promise<void> {
  await reconcileBots();
  const bots = [...getActiveBots()];
  const component = getComponentBot();
  if (component) bots.push(["telegram", component]);
  for (const [agentId, bot] of bots) {
    try {
      await bot.stop();
      console.log(`[telegram] Stopped bot: ${agentId}`);
    } catch (err) {
      console.error(`[telegram] Failed to stop bot ${agentId}:`, err);
    }
  }
  clearActiveBots();
}

export { getActiveBot };

const telegramExtension: Extension = {
  ...telegramSettings,
  id: "telegram",
  displayName: "Telegram",
  description: "Telegram integration for direct-message routing",
  dependencies: [],
  configSchema: TelegramExtensionConfigSchema,
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
    const result = TelegramExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes() {},
  getAgentTools(_agent, context) {
    if (context?.config.extensions?.telegram?.enabled === false) return [];
    return telegramAgentTools();
  },
  async start(ctx) {
    const rawConfig = ctx.getConfig().extensions?.telegram;

    if (rawConfig) {
      const parsed = TelegramExtensionConfigSchema.safeParse(rawConfig);
      if (parsed.success) {
        await startTelegramBots(ctx, {
          agents: ctx.getAgents(),
          componentConfig: { ...parsed.data },
        });
      }
    }

    await startTelegramBots(ctx);

    unregisterDeliverySink = ctx.registerDeliverySink(
      "telegram",
      async ({ agent, destination, text }) => {
        const chatId = toChatId(destination);
        if (!chatId) {
          throw new Error(
            "telegram delivery requires a channel or user destination"
          );
        }
        await sendTelegramMessage(
          agent,
          ctx.getConfig(),
          undefined,
          chatId,
          text
        );
      },
      ({ agent }) => getTelegramDeliveryOffer(agent)
    );
  },
  onConfigReload: () => reconcileBots(getTelegramContext()),
  async stop() {
    unregisterDeliverySink?.();
    unregisterDeliverySink = undefined;
    await stopTelegramBots();
    clearTelegramContext();
  },
  capabilities() {
    return ["telegram"];
  },
};

export {
  telegramExtension,
  createTelegramAgentBot,
  createTelegramBot,
  type TelegramBot,
};
