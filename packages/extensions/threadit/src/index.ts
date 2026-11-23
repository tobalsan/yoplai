import {
  ThreaditExtensionConfigSchema,
  type Extension,
  type ExtensionContext,
} from "@yoplai/shared";
import { resolveThreaditConfig, threaditSettings } from "./config.js";
import { describeFailure, MAX_BODY_CHARS, splitAnswer, ThreaditApi } from "./api.js";
import { ThreaditPoller } from "./poller.js";
import { resolveToolTarget, threaditAgentTools } from "./tools.js";

const pollers = new Map<string, ThreaditPoller>();
let hostContext: ExtensionContext | undefined;
const tools = threaditAgentTools({ getHost: () => hostContext });
let unregisterDeliverySink: (() => void) | undefined;

function resolveAgent(ctx: ExtensionContext, agentId: string) {
  const live = ctx.getAgent(agentId);
  if (!live || !ctx.isAgentActive(agentId)) return undefined;
  return resolveThreaditConfig(
    ctx.getConfig().extensions?.threadit,
    live.extensions?.threadit
  );
}

/**
 * Start a poller for each agent that has none. A poller stays for the life of
 * the extension. It idles when the agent disables threadit and resumes when
 * the config returns.
 */
function reconcilePollers(ctx: ExtensionContext): void {
  for (const agent of ctx.getAgents()) {
    if (pollers.has(agent.id)) continue;
    const resolved = resolveAgent(ctx, agent.id);
    if (!resolved || resolved.status === "skipped") continue;
    if (resolved.status === "invalid") {
      console.error(`[threadit] ${agent.id}: invalid ${resolved.reason}`);
      continue;
    }
    const poller = new ThreaditPoller({
      ctx,
      agentId: agent.id,
      config: resolved.config,
      // Read the live config so a token saved at run time applies at once.
      readConfig: () => {
        const next = resolveAgent(ctx, agent.id);
        return next?.status === "ok" ? next.config : undefined;
      },
    });
    pollers.set(agent.id, poller);
    poller.start();
  }
}

const threaditExtension: Extension = {
  ...threaditSettings,
  id: "threadit",
  displayName: "Threadit",
  description: "Threadit board agent: answers mentions and replies",
  dependencies: [],
  configSchema: ThreaditExtensionConfigSchema,
  routePrefixes: [],
  validateConfig(raw) {
    if (
      !raw ||
      (typeof raw === "object" &&
        (Object.keys(raw).length === 0 || "_perAgent" in raw))
    ) {
      return { valid: true, errors: [] };
    }
    const result = ThreaditExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes() {},
  getAgentTools(agent, context) {
    if (!context) return [];
    return resolveToolTarget(agent, context, hostContext) ? tools : [];
  },
  async start(ctx) {
    hostContext = ctx;
    unregisterDeliverySink = ctx.registerDeliverySink("threadit", async ({ agent, destination, text }) => {
      const config = resolveAgent(ctx, agent.id);
      if (config?.status !== "ok" || !config.config.token) {
        throw new Error("No Threadit token is configured for this agent.");
      }
      const [thread, parent] = (destination.channel ?? "").split(":");
      const threadId = Number(thread);
      const parentId = parent === undefined ? null : Number(parent);
      if (!Number.isSafeInteger(threadId) || threadId <= 0 || (parentId !== null && (!Number.isSafeInteger(parentId) || parentId <= 0))) {
        throw new Error("Threadit delivery requires THREAD_ID[:PARENT_MESSAGE_ID].");
      }
      const api = new ThreaditApi(config.config.baseUrl, config.config.token);
      for (const part of splitAnswer(text, MAX_BODY_CHARS)) {
        const result = await api.reply(threadId, parentId, part);
        if (!result.ok) throw new Error(`Threadit delivery failed: ${describeFailure(result)}`);
      }
    });
    reconcilePollers(ctx);
  },
  async onConfigReload() {
    if (hostContext) reconcilePollers(hostContext);
  },
  async stop() {
    unregisterDeliverySink?.();
    unregisterDeliverySink = undefined;
    hostContext = undefined;
    const all = [...pollers.values()];
    pollers.clear();
    await Promise.all(all.map((poller) => poller.stop()));
  },
  capabilities() {
    return ["threadit"];
  },
};

export { threaditExtension };
export { ThreaditPoller } from "./poller.js";
export { resolveThreaditConfig } from "./config.js";
export { threaditAgentTools } from "./tools.js";
