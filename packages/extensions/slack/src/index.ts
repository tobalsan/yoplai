import { readAgentChannelConfig, slackSettings } from "./config.js";
import {
  SlackExtensionConfigSchema,
  createChannelBotReconciler,
  startRegisteredChannelBot,
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
import { clearSlackContext, getSlackContext, setSlackContext } from "./context.js";
import {
  clearActiveBots,
  getActiveBot,
  getActiveBots,
  getComponentBot,
  registerComponentBot,
  resolveSlackDmOwner,
} from "./bot-registry.js";
import {
  clearSlackClientCache,
  createSlackDeliverySink,
  createSlackUserNotifier,
  getSlackDeliveryOffer,
  slackAgentTools,
} from "./agent-tools.js";
import {
  SlackProgressStore,
  setSlackProgressStore,
} from "./progress-store.js";
import { getSlackPairingService, setSlackPairingService, SlackPairingService } from "./pairing.js";
import { registerCredentialConnectRoutes } from "./credential-connect-routes.js";
import { createCredentialConnectLink, clearCredentialConnectRequests } from "./credential-connect.js";
import { registerCredentialConnectLinkProvider, registerSlackPairingLinkProvider } from "@yoplai/shared";
import { registerSlackPairingRoutes } from "./pairing-routes.js";

export { getSlackPairingService, SlackPairingService } from "./pairing.js";

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
      registerComponentBot(bot);
      console.log("[slack] Started component bot");
    } catch (err) {
      console.error("[slack] Failed to start component bot:", err);
    }
    return;
  }

  await reconcileBots(ctx);
}

const reconcileAgentBots = createChannelBotReconciler("slack", readAgentChannelConfig);

async function reconcileBots(ctx?: ExtensionContext): Promise<void> {
  const agents = ctx?.getAgents().filter((agent) => ctx.isAgentActive(agent.id)) ?? [];
  await reconcileAgentBots(agents, (agent) => startRegisteredChannelBot(getActiveBots(), agent.id, createSlackAgentBot(agent)));
}


export async function stopSlackBots(): Promise<void> {
  await reconcileBots();
  const bots = [...getActiveBots()];
  const component = getComponentBot();
  if (component) bots.push(["slack", component]);
  for (const [agentId, bot] of bots) {
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

let unregisterConnectLinks: (() => void) | undefined;
let unregisterPairingLinks: (() => void) | undefined;
let unregisterDeliverySink: (() => void) | undefined;
let unregisterOwnerResolver: (() => void) | undefined;
let unregisterUserNotifier: (() => void) | undefined;

const slackExtension: Extension = {
  ...slackSettings,
  id: "slack",
  displayName: "Slack",
  description: "Slack integration for channel and DM routing",
  dependencies: [],
  configSchema: SlackExtensionConfigSchema,
  routePrefixes: ["/api/slack"],
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
  registerRoutes(app) { registerSlackPairingRoutes(app); registerCredentialConnectRoutes(app); },
  getAgentTools(_agent, context) {
    if (context?.config.extensions?.slack?.enabled === false) return [];
    return slackAgentTools();
  },
  async start(ctx) {
    unregisterOwnerResolver = ctx.registerChannelOwnerResolver?.("slack", resolveSlackDmOwner);
    unregisterConnectLinks = registerCredentialConnectLinkProvider(createCredentialConnectLink);
    unregisterPairingLinks = registerSlackPairingLinkProvider(async (context) => {
      const pair = slackAgentTools().find((tool) => tool.name === "slack.pair")!;
      const result = await pair.execute({}, context) as { ok?: boolean; link?: string };
      return result.ok ? result.link : undefined;
    });
    const config = ctx.getConfig();
    if (config.extensions?.multiUser?.enabled) {
      const baseUrl = config.server?.baseUrl ?? config.web?.baseUrl ?? `http://localhost:${config.ui?.port ?? 3000}`;
      setSlackPairingService(new SlackPairingService(ctx.getDataDir(), baseUrl));
    }
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
    unregisterUserNotifier = ctx.registerUserNotifier("slack", createSlackUserNotifier(ctx));
    unregisterDeliverySink = ctx.registerDeliverySink(
      "slack",
      createSlackDeliverySink(ctx),
      ({ agent, userId }) => getSlackDeliveryOffer(agent, ctx.getConfig(), userId)
    );
  },
  onConfigReload: () => reconcileBots(getSlackContext()),
  async stop() {
    unregisterOwnerResolver?.();
    unregisterOwnerResolver = undefined;
    unregisterPairingLinks?.();
    unregisterPairingLinks = undefined;
    unregisterConnectLinks?.();
    unregisterConnectLinks = undefined;
    clearCredentialConnectRequests();
    await stopSlackBots();
    unregisterUserNotifier?.();
    unregisterUserNotifier = undefined;
    unregisterDeliverySink?.();
    unregisterDeliverySink = undefined;
    getSlackPairingService()?.close();
    setSlackPairingService(undefined);
    clearSlackContext();
  },
  capabilities() {
    return ["slack"];
  },
};

export { slackExtension, createSlackAgentBot, createSlackBot, type SlackBot };

export { readAgentChannelConfig } from "./config.js";
