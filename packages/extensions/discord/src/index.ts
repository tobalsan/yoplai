import {
  DiscordExtensionConfigSchema,
  type Extension,
  type ExtensionContext,
  type DiscordComponentConfig,
} from "@yoplai/shared";
import {
  createDiscordBot,
  createDiscordComponentBot,
  type DiscordBot,
} from "./bot.js";
import { clearDiscordContext, setDiscordContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  registerActiveBot,
} from "./bot-registry.js";
import { clearDiscordClientCache, discordAgentTools } from "./agent-tools.js";

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
      registerActiveBot(bot.agentId, bot);
      console.log("[discord] Started component bot");
    } catch (err) {
      console.error("[discord] Failed to start component bot:", err);
    }
    return;
  }

  const agents = ctx.getAgents();

  for (const agent of agents) {
    if (!ctx.isAgentActive(agent.id)) continue;
    if (!agent.discord?.token) continue;

    const bot = await createDiscordBot(agent);
    if (!bot) continue;

    try {
      await bot.start();
      registerActiveBot(agent.id, bot);
      console.log(`[discord] Started bot for agent: ${agent.id}`);
    } catch (err) {
      console.error(
        `[discord] Failed to start bot for agent ${agent.id}:`,
        err
      );
    }
  }
}

export async function stopDiscordBots(): Promise<void> {
  for (const [agentId, bot] of getActiveBots()) {
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
    const rawConfig = ctx.getConfig().extensions?.discord;

    if (rawConfig) {
      const parsed = DiscordExtensionConfigSchema.safeParse(rawConfig);
      if (parsed.success) {
        await startDiscordBots(ctx, { ...parsed.data });
      }
    }

    await startDiscordBots(ctx);
  },
  async stop() {
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
