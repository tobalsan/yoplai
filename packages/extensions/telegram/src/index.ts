import {
  TelegramExtensionConfigSchema,
  type AgentConfig,
  type Extension,
  type ExtensionContext,
  type TelegramComponentConfig,
} from "@yoplai/shared";
import {
  createTelegramAgentBot,
  createTelegramBot,
  type TelegramBot,
} from "./bot.js";
import { clearTelegramContext, setTelegramContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  registerActiveBot,
} from "./bot-registry.js";
import { telegramAgentTools } from "./agent-tools.js";

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
      registerActiveBot(bot.agentId, bot);
      console.log("[telegram] Started component bot");
    } catch (err) {
      console.error("[telegram] Failed to start component bot:", err);
    }
    return;
  }

  const agentBots = ctx
    .getAgents()
    .filter((agent) => agent.telegram?.token)
    .map((agent) => ({ agent, bot: createTelegramAgentBot(agent) }))
    .filter(
      (entry): entry is { agent: AgentConfig; bot: TelegramBot } => !!entry.bot
    );

  await Promise.all(
    agentBots.map(async ({ agent, bot }) => {
      try {
        await bot.start();
        registerActiveBot(agent.id, bot);
        console.log(`[telegram] Started bot for agent: ${agent.id}`);
      } catch (err) {
        console.error(
          `[telegram] Failed to start bot for agent ${agent.id}:`,
          err
        );
      }
    })
  );
}

export async function stopTelegramBots(): Promise<void> {
  for (const [agentId, bot] of getActiveBots()) {
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
  },
  async stop() {
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
