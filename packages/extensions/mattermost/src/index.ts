import { mattermostSettings, readAgentChannelConfig } from "./config.js";
import {
  MattermostExtensionConfigSchema,
  createChannelBotReconciler,
  startRegisteredChannelBot,
  type AgentConfig,
  type Extension,
  type ExtensionContext,
  type MattermostComponentConfig,
} from "@yoplai/shared";
import {
  createMattermostAgentBot,
  createMattermostBot,
} from "./bot.js";
import { clearMattermostContext, getMattermostContext, setMattermostContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerComponentBot,
  resolveMattermostDmOwner,
} from "./bot-registry.js";
import {
  createMattermostDeliverySink,
  getMattermostDeliveryOffer,
  mattermostAgentTools,
} from "./agent-tools.js";

const reconcileAgentBots = createChannelBotReconciler("mattermost", readAgentChannelConfig);

async function reconcileBots(ctx?: ExtensionContext): Promise<void> {
  const agents = ctx?.getAgents().filter((agent) => ctx.isAgentActive(agent.id)) ?? [];
  await reconcileAgentBots(agents, (agent) => startRegisteredChannelBot(getActiveBots(), agent.id, createMattermostAgentBot(agent)));
}

let unregisterDeliverySink: (() => void) | undefined;
let unregisterOwnerResolver: (() => void) | undefined;

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
      registerComponentBot(bot);
      console.log("[mattermost] Started component bot");
    } catch (err) {
      console.error("[mattermost] Failed to start component bot:", err);
    }
    return;
  }

  await reconcileBots(ctx);
}

export async function stopMattermostBots(): Promise<void> {
  await reconcileBots();
  const bots = [...getActiveBots()];
  const component = getComponentBot();
  if (component) bots.push(["mattermost", component]);
  for (const [agentId, bot] of bots) {
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
  ...mattermostSettings,
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
    unregisterOwnerResolver = ctx.registerChannelOwnerResolver?.("mattermost", resolveMattermostDmOwner);
    unregisterDeliverySink = ctx.registerDeliverySink(
      "mattermost",
      createMattermostDeliverySink(ctx),
      ({ agent }) => getMattermostDeliveryOffer(agent, ctx.getConfig())
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
  onConfigReload: () => reconcileBots(getMattermostContext()),
  async stop() {
    unregisterOwnerResolver?.();
    unregisterOwnerResolver = undefined;
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
};
export type { MattermostBot } from "./bot.js";
export {
  ThreadSessionBindingStore,
  type ThreadSessionBinding,
} from "./thread-session-bindings.js";

export { readAgentChannelConfig } from "./config.js";
