import {
  MattermostExtensionConfigSchema,
  type AgentConfig,
  type Extension,
  type ExtensionContext,
  type MattermostComponentConfig,
} from "@yoplai/shared";
import {
  createMattermostAgentBot,
  createMattermostBot,
  type MattermostBot,
} from "./bot.js";
import { clearMattermostContext, setMattermostContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  registerActiveBot,
} from "./bot-registry.js";
import {
  createMattermostDeliverySink,
  mattermostAgentTools,
} from "./agent-tools.js";

let unregisterDeliverySink: (() => void) | undefined;

type StartMattermostBotsOptions = {
  agents: AgentConfig[];
  componentConfig: MattermostComponentConfig;
};

export async function startMattermostBots(
  ctx: ExtensionContext,
  options?: StartMattermostBotsOptions
): Promise<void> {
  setMattermostContext(ctx);

  if (options) {
    if (options.componentConfig.enabled === false) return;
    const bot = createMattermostBot(options.agents, options.componentConfig);
    if (!bot) return;

    try {
      await bot.start();
      // Registered under the literal "mattermost" id, like discord/slack/telegram.
      registerActiveBot(bot.agentId, bot);
      console.log("[mattermost] Started component bot");
    } catch (err) {
      console.error("[mattermost] Failed to start component bot:", err);
    }
    return;
  }

  const agentBots = ctx
    .getAgents()
    .filter((agent) => agent.mattermost?.token && ctx.isAgentActive(agent.id))
    .map((agent) => ({ agent, bot: createMattermostAgentBot(agent) }))
    .filter(
      (entry): entry is { agent: AgentConfig; bot: MattermostBot } =>
        !!entry.bot
    );

  await Promise.all(
    agentBots.map(async ({ agent, bot }) => {
      try {
        await bot.start();
        registerActiveBot(agent.id, bot);
        console.log(`[mattermost] Started bot for agent: ${agent.id}`);
      } catch (err) {
        console.error(
          `[mattermost] Failed to start bot for agent ${agent.id}:`,
          err
        );
      }
    })
  );
}

export async function stopMattermostBots(): Promise<void> {
  for (const [agentId, bot] of getActiveBots()) {
    try {
      await bot.stop();
      console.log(`[mattermost] Stopped bot: ${agentId}`);
    } catch (err) {
      console.error(`[mattermost] Failed to stop bot ${agentId}:`, err);
    }
  }
  clearActiveBots();
}

export { getActiveBot };

const mattermostExtension: Extension = {
  id: "mattermost",
  displayName: "Mattermost",
  description: "Mattermost integration for channel, thread and DM routing",
  dependencies: [],
  configSchema: MattermostExtensionConfigSchema,
  routePrefixes: [],
  validateConfig(raw) {
    if (
      !raw ||
      (typeof raw === "object" &&
        (Object.keys(raw as object).length === 0 ||
          "_perAgent" in (raw as object)))
    ) {
      return { valid: true, errors: [] };
    }
    // The registry adds `_perAgentFallback`; zod strips unknown keys anyway.
    const result = MattermostExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map(
            (issue) =>
              `${issue.path.join(".") || "mattermost"}: ${issue.message}`
          ),
    };
  },
  registerRoutes() {},
  getAgentTools(_agent, context) {
    if (context?.config.extensions?.mattermost?.enabled === false) return [];
    return mattermostAgentTools();
  },
  async start(ctx) {
    unregisterDeliverySink = ctx.registerDeliverySink(
      "mattermost",
      createMattermostDeliverySink(ctx)
    );

    const rawConfig = ctx.getConfig().extensions?.mattermost;
    if (rawConfig) {
      const parsed = MattermostExtensionConfigSchema.safeParse(rawConfig);
      if (parsed.success) {
        await startMattermostBots(ctx, {
          agents: ctx.getAgents(),
          componentConfig: { ...parsed.data },
        });
      } else {
        // Paths and messages only: never the submitted values (the token).
        console.error(
          "[mattermost] Invalid extensions.mattermost config:",
          parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")
        );
      }
    }

    await startMattermostBots(ctx);
  },
  async stop() {
    unregisterDeliverySink?.();
    unregisterDeliverySink = undefined;
    await stopMattermostBots();
    clearMattermostContext();
  },
  capabilities() {
    return ["mattermost"];
  },
};

export {
  mattermostExtension,
  createMattermostAgentBot,
  createMattermostBot,
  type MattermostBot,
};
export {
  ThreadSessionBindingStore,
  type ThreadSessionBinding,
} from "./thread-session-bindings.js";
