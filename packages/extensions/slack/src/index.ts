import {
  SlackExtensionConfigSchema,
  type AgentConfig,
  type Extension,
  type ExtensionContext,
  type SlackComponentConfig,
} from "@yoplai/shared";
import {
  createSlackAgentBot,
  createSlackBot,
  type SlackBot,
} from "./bot.js";
import { clearSlackContext, setSlackContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  registerActiveBot,
} from "./bot-registry.js";
import {
  clearSlackClientCache,
  createSlackDeliverySink,
  slackAgentTools,
} from "./agent-tools.js";
import {
  SlackProgressStore,
  setSlackProgressStore,
} from "./progress-store.js";

type StartSlackBotsOptions = {
  agents: AgentConfig[];
  componentConfig: SlackComponentConfig;
};

export async function startSlackBots(
  ctx: ExtensionContext,
  options?: StartSlackBotsOptions
): Promise<void> {
  setSlackContext(ctx);
  setSlackProgressStore(new SlackProgressStore(ctx.getDataDir()));

  if (options) {
    const bot = createSlackBot(options.agents, options.componentConfig);
    if (!bot) return;

    try {
      await bot.start();
      registerActiveBot(bot.agentId, bot);
      console.log("[slack] Started component bot");
    } catch (err) {
      console.error("[slack] Failed to start component bot:", err);
    }
    return;
  }

  const agentBots = ctx
    .getAgents()
    .filter((agent) => agent.slack?.token && agent.slack?.appToken)
    .map((agent) => ({ agent, bot: createSlackAgentBot(agent) }))
    .filter((entry): entry is { agent: AgentConfig; bot: SlackBot } => !!entry.bot);

  await Promise.all(
    agentBots.map(async ({ agent, bot }) => {
      try {
        await bot.start();
        registerActiveBot(agent.id, bot);
        console.log(`[slack] Started bot for agent: ${agent.id}`);
      } catch (err) {
        console.error(`[slack] Failed to start bot for agent ${agent.id}:`, err);
      }
    })
  );
}

export async function stopSlackBots(): Promise<void> {
  for (const [agentId, bot] of getActiveBots()) {
    try {
      await bot.stop();
      console.log(`[slack] Stopped bot: ${agentId}`);
    } catch (err) {
      console.error(`[slack] Failed to stop bot ${agentId}:`, err);
    }
  }
  clearActiveBots();
  clearSlackClientCache();
  setSlackProgressStore(undefined);
}

export { getActiveBot };
export {
  createSlackThreadSessionBindingStore,
  SlackThreadSessionBindingStore,
  type SetSlackThreadSessionBindingInput,
  type SlackThreadSessionBinding,
} from "./thread-session-bindings.js";

let unregisterDeliverySink: (() => void) | undefined;

const slackExtension: Extension = {
  id: "slack",
  displayName: "Slack",
  description: "Slack integration for channel and DM routing",
  dependencies: [],
  configSchema: SlackExtensionConfigSchema,
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
    const result = SlackExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes() {},
  getAgentTools(_agent, context) {
    if (context?.config.extensions?.slack?.enabled === false) return [];
    return slackAgentTools();
  },
  async start(ctx) {
    const rawConfig = ctx.getConfig().extensions?.slack;

    if (rawConfig) {
      const parsed = SlackExtensionConfigSchema.safeParse(rawConfig);
      if (parsed.success) {
        await startSlackBots(ctx, {
          agents: ctx.getAgents(),
          componentConfig: { ...parsed.data },
        });
      }
    }

    await startSlackBots(ctx);
    unregisterDeliverySink = ctx.registerDeliverySink(
      "slack",
      createSlackDeliverySink(ctx)
    );
  },
  async stop() {
    await stopSlackBots();
    unregisterDeliverySink?.();
    unregisterDeliverySink = undefined;
    clearSlackContext();
  },
  capabilities() {
    return ["slack"];
  },
};

export { slackExtension, createSlackAgentBot, createSlackBot, type SlackBot };
