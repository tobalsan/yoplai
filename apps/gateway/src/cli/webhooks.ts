import type { Command } from "commander";
import {
  generateWebhookSecret,
  getWebhookSecretsPath,
  loadWebhookSecrets,
  saveWebhookSecrets,
  webhookSecretKey,
} from "@yoplai/extension-webhooks";
import { readEnv, resolveBindHost, resolveHomeDir } from "@yoplai/shared";
import { loadConfig } from "../config/index.js";
import { logError } from "../logging.js";

type RotateWebhookSecretParams = {
  agentId: string;
  webhookName: string;
  dataDir?: string;
  baseUrl?: string;
};

type RotateWebhookSecretResult = {
  key: string;
  secret: string;
  url: string;
};

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function getWebhookBaseUrl(): string {
  const envUrl = readEnv("API_URL") ?? readEnv("URL");
  if (envUrl?.trim()) return trimTrailingSlash(envUrl.trim());

  try {
    const config = loadConfig();
    if (config.server?.baseUrl) {
      return trimTrailingSlash(config.server.baseUrl);
    }
    const host = config.gateway?.host ?? resolveBindHost(config.gateway?.bind);
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    const port = config.gateway?.port ?? 4000;
    return `http://${displayHost}:${port}`;
  } catch {
    return "http://localhost:4000";
  }
}

export function rotateWebhookSecret(
  params: RotateWebhookSecretParams
): RotateWebhookSecretResult {
  const dataDir = params.dataDir ?? resolveHomeDir();
  const baseUrl = trimTrailingSlash(params.baseUrl ?? getWebhookBaseUrl());
  const secrets = loadWebhookSecrets(dataDir);
  const key = webhookSecretKey(params.agentId, params.webhookName);

  if (!Object.hasOwn(secrets, key)) {
    throw new Error(
      `Webhook secret not found for ${key} in ${getWebhookSecretsPath(dataDir)}`
    );
  }

  const secret = generateWebhookSecret();
  secrets[key] = secret;
  saveWebhookSecrets(dataDir, secrets);

  return {
    key,
    secret,
    url: `${baseUrl}/hooks/${params.agentId}/${params.webhookName}/${secret}`,
  };
}

export function registerWebhookCommands(program: Command): void {
  const webhooks = program.command("webhooks").description("Manage webhooks");

  webhooks
    .command("rotate")
    .description("Rotate a webhook secret")
    .argument("<agent_id>", "Agent ID")
    .argument("<webhook_name>", "Webhook name")
    .action((agentId: string, webhookName: string) => {
      try {
        const result = rotateWebhookSecret({ agentId, webhookName });
        console.log(`New URL: ${result.url}`);
        console.log("Old URL is immediately invalid.");
      } catch (err) {
        logError("Error", err);
        process.exit(1);
      }
    });
}
