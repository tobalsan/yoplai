import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentConfig } from "@yoplai/shared";

export type WebhookSecrets = Record<string, string>;

const SECRET_FILE = "webhook-secrets.json";
const SECRET_FILE_MODE = 0o600;

type CachedWebhookSecrets = {
  mtimeMs: number | null;
  secrets: WebhookSecrets;
};

const secretsCache = new Map<string, CachedWebhookSecrets>();

export function webhookSecretKey(agentId: string, webhookName: string): string {
  return `${agentId}:${webhookName}`;
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function getWebhookSecretsPath(dataDir: string): string {
  return path.join(dataDir, SECRET_FILE);
}

function getSecretFileMtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function loadWebhookSecrets(dataDir: string): WebhookSecrets {
  const filePath = getWebhookSecretsPath(dataDir);
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) return {};

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${SECRET_FILE} must contain a JSON object`);
  }

  const secrets: WebhookSecrets = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`${SECRET_FILE} value for ${key} must be a string`);
    }
    secrets[key] = value;
  }
  return secrets;
}

export function reloadWebhookSecrets(dataDir: string): WebhookSecrets {
  const filePath = getWebhookSecretsPath(dataDir);
  const secrets = loadWebhookSecrets(dataDir);
  secretsCache.set(filePath, {
    mtimeMs: getSecretFileMtime(filePath),
    secrets,
  });
  return secrets;
}

export function getCachedWebhookSecrets(dataDir: string): WebhookSecrets {
  const filePath = getWebhookSecretsPath(dataDir);
  const mtimeMs = getSecretFileMtime(filePath);
  const cached = secretsCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.secrets;
  return reloadWebhookSecrets(dataDir);
}

export function setCachedWebhookSecrets(
  dataDir: string,
  secrets: WebhookSecrets
): void {
  const filePath = getWebhookSecretsPath(dataDir);
  secretsCache.set(filePath, {
    mtimeMs: getSecretFileMtime(filePath),
    secrets,
  });
}

export function saveWebhookSecrets(
  dataDir: string,
  secrets: WebhookSecrets
): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = getWebhookSecretsPath(dataDir);
  fs.writeFileSync(filePath, `${JSON.stringify(secrets, null, 2)}\n`, {
    encoding: "utf8",
    mode: SECRET_FILE_MODE,
  });
  fs.chmodSync(filePath, SECRET_FILE_MODE);
  setCachedWebhookSecrets(dataDir, secrets);
}

export function ensureWebhookSecrets(
  dataDir: string,
  agents: AgentConfig[]
): { secrets: WebhookSecrets; changed: boolean } {
  const secrets = loadWebhookSecrets(dataDir);
  let changed = false;

  for (const agent of agents) {
    for (const webhookName of Object.keys(agent.webhooks ?? {})) {
      const key = webhookSecretKey(agent.id, webhookName);
      if (secrets[key]) continue;
      secrets[key] = generateWebhookSecret();
      changed = true;
    }
  }

  if (changed) saveWebhookSecrets(dataDir, secrets);
  return { secrets, changed };
}
