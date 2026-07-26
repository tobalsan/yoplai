import {
  readEnv,
  resolveBindHost,
  type Extension,
  type ExtensionContext,
} from "@yoplai/shared";
import type { Hono } from "hono";
import { z } from "zod";
import {
  registerWebhookRoutes,
  clearWebhooksRuntime,
  setWebhooksRuntime,
} from "./routes.js";
import { ensureWebhookSecrets, webhookSecretKey } from "./secrets.js";

const WebhooksExtensionConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    _perAgent: z.boolean().optional(),
  })
  .passthrough();

export function getGatewayBaseUrl(ctx: ExtensionContext): string {
  const config = ctx.getConfig();
  if (readEnv("DEV") === "1") {
    const host = config.gateway?.host ?? resolveBindHost(config.gateway?.bind);
    const publicHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const port = readEnv("GATEWAY_PORT") ?? config.gateway?.port ?? 4000;
    return `http://${publicHost}:${port}`;
  }
  if (config.server?.baseUrl) return config.server.baseUrl.replace(/\/$/, "");
  const host = config.gateway?.host ?? resolveBindHost(config.gateway?.bind);
  const port = config.gateway?.port ?? 4000;
  return `http://${host}:${port}`;
}

const webhooksExtension: Extension = {
  id: "webhooks",
  displayName: "Webhooks",
  description: "Route inbound HTTP webhooks to agents",
  dependencies: [],
  configSchema: WebhooksExtensionConfigSchema,
  routePrefixes: ["/hooks"],
  validateConfig(raw) {
    const result = WebhooksExtensionConfigSchema.safeParse(raw);
    return {
      valid: result.success,
      errors: result.success
        ? []
        : result.error.issues.map((issue) => issue.message),
    };
  },
  registerRoutes(app: Hono) {
    registerWebhookRoutes(app);
  },
  async start(ctx: ExtensionContext) {
    const { secrets } = ensureWebhookSecrets(ctx.getDataDir(), ctx.getAgents());
    setWebhooksRuntime({ ctx, secrets });

    const baseUrl = getGatewayBaseUrl(ctx);
    for (const agent of ctx.getAgents()) {
      for (const webhookName of Object.keys(agent.webhooks ?? {})) {
        const secret = secrets[webhookSecretKey(agent.id, webhookName)];
        if (!secret) continue;
        ctx.logger.info(
          `[webhooks] ${agent.id}/${webhookName} -> ${baseUrl}/hooks/${agent.id}/${webhookName}/${secret}`
        );
      }
    }
  },
  async stop() {
    clearWebhooksRuntime();
  },
  capabilities() {
    return ["webhooks"];
  },
};

export { webhooksExtension };
export {
  ensureWebhookSecrets,
  generateWebhookSecret,
  getCachedWebhookSecrets,
  getWebhookSecretsPath,
  loadWebhookSecrets,
  reloadWebhookSecrets,
  saveWebhookSecrets,
  setCachedWebhookSecrets,
  webhookSecretKey,
} from "./secrets.js";
export { interpolateWebhookPrompt, resolveWebhookPrompt } from "./prompt.js";
