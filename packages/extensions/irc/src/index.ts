import {
  IrcAgentConfigSchema,
  IrcExtensionConfigSchema,
  type Extension,
  type ExtensionContext,
  type IrcAgentConfig,
  type IrcExtensionConfig,
} from "@yoplai/shared";
import { IrcRouter } from "./router.js";
import { IrcService } from "./service.js";

const services: IrcService[] = [];
const routers: IrcRouter[] = [];

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
): void {
  const service = new IrcService(
    { ...config, channels: Object.keys(config.channels) },
    (message) => router.handle(message)
  );
  const router = new IrcRouter(ctx, config, service, ownerAgentId);
  services.push(service);
  routers.push(router);
  service.start();
}

const ircExtension: Extension = {
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
    const root = IrcExtensionConfigSchema.safeParse(
      ctx.getConfig().extensions?.irc
    );
    if (root.success && root.data.enabled !== false) {
      startService(ctx, root.data);
    }

    for (const agent of ctx.getAgents()) {
      if (!ctx.isAgentActive(agent.id)) continue;
      const parsed = IrcAgentConfigSchema.safeParse(agent.irc);
      if (!parsed.success) continue;
      startService(ctx, normalizeAgentConfig(agent.id, parsed.data), agent.id);
    }
  },
  async stop() {
    for (const router of routers.splice(0)) router.stop();
    for (const service of services.splice(0)) service.stop();
  },
  capabilities() {
    return ["irc"];
  },
};

export { ircExtension };
export * from "./protocol.js";
export * from "./loop-guard.js";
