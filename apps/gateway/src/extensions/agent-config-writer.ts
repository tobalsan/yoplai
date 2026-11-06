import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument, type Document } from "yaml";
import { AgentYamlConfigSchema } from "@yoplai/shared";
import type { ExtensionConfigPatch } from "@yoplai/shared";

/**
 * Write path for an agent's extension config and webhook credentials.
 * Mutations preserve the raw agent.yaml and serialize under its directory lock.
 *
 * The change is applied to the raw parsed YAML (not the runtime-resolved
 * config) so we preserve `$env:NAME` sentinels and any fields the schema passes
 * through, then re-validated against `AgentYamlConfigSchema` before it is
 * written back atomically. Secret values never land as plaintext in
 * `agent.yaml`: they are written as `$env:NAME` sentinels there and the concrete
 * value is appended/updated in the agent's `.env` file, matching the runtime
 * `resolveEnvRefs` resolver.
 */

export type { ExtensionConfigPatch };

export class ExtensionConfigValidationError extends Error {
  constructor(readonly fields: string[]) {
    super("Extension configuration is invalid");
  }
}

export type ExtensionConfigValidator = (
  nextConfig: Record<string, unknown>,
  pendingEnv: Record<string, string>
) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Derive a stable env var name for a secret field. Secrets live in the
 * agent's own `.env` file, so no agent-scoping prefix is needed.
 * e.g. extension "acme-crm" + field "apiKey" → `ACME_CRM_API_KEY`.
 */
export function secretEnvName(extensionId: string, field: string): string {
  const toEnvSegment = (value: string) =>
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // camelCase → camel_Case
      .replace(/[^A-Za-z0-9]+/g, "_") // non-alnum runs → _
      .replace(/^_+|_+$/g, "") // trim leading/trailing _
      .toUpperCase();
  return `${toEnvSegment(extensionId)}_${toEnvSegment(field)}`;
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

/** Keep ownership checks and all agent config reads/writes in one transaction. */
async function updateAgentConfig(
  workspaceDir: string,
  mutate: (
    doc: Document,
    parsed: Record<string, unknown>
  ) => {
    envVars?: Record<string, string>;
    staleEnv?: string[];
  } | void,
  validate?: ExtensionConfigValidator
): Promise<Record<string, unknown>> {
  // Imported lazily so proper-lockfile's signal handlers do not shadow the
  // gateway's graceful-shutdown handler during server module initialization.
  const { default: lockfile } = await import("proper-lockfile");
  const release = await lockfile.lock(workspaceDir, {
    retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
    realpath: false,
  });
  try {
    const agentPath = path.join(workspaceDir, "agent.yaml");
    const doc = parseDocument(await fs.readFile(agentPath, "utf8"));
    const parsed = doc.toJS() as unknown;
    if (!isRecord(parsed))
      throw new Error(`Malformed agent.yaml at ${agentPath}`);
    const { envVars = {}, staleEnv = [] } = mutate(doc, parsed) ?? {};
    const nextConfig = doc.toJS() as Record<string, unknown>;
    const validation = AgentYamlConfigSchema.safeParse(nextConfig);
    if (!validation.success) {
      throw new Error(
        `agent.yaml would be invalid after update: ${validation.error.message}`
      );
    }
    validate?.(nextConfig, envVars);

    // Secrets land before their references; removed values leave only once
    // agent.yaml no longer references them. These helpers share this lock.
    const envPath = path.join(workspaceDir, ".env");
    if (Object.keys(envVars).length > 0) await upsertEnvVars(envPath, envVars);
    await writeAtomic(agentPath, doc.toString());
    if (staleEnv.length > 0) await removeEnvVars(envPath, staleEnv);
    return nextConfig;
  } finally {
    await release();
  }
}

/** Escape a value for the agent's `.env` file (dotenv KEY=value format). */
function formatEnvValue(value: string): string {
  // Quote when the value contains characters that would break a bare
  // assignment; escape embedded quotes and backslashes.
  if (/[\s"'#\\]/.test(value) || value === "") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Upsert `KEY=value` lines into an env file, preserving any unrelated lines.
 * Existing keys are replaced in place; new keys are appended.
 */
async function upsertEnvVars(
  envPath: string,
  vars: Record<string, string>
): Promise<void> {
  let existing = "";
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch {
    existing = "";
  }

  const lines = existing.length > 0 ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(vars));

  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match && remaining.has(match[1])) {
      const key = match[1];
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${formatEnvValue(value)}`;
    }
    return line;
  });

  // Drop a single trailing empty line so appends don't accumulate blank lines.
  if (next.length > 0 && next[next.length - 1] === "") next.pop();
  for (const [key, value] of remaining) {
    next.push(`${key}=${formatEnvValue(value)}`);
  }

  await writeAtomic(envPath, `${next.join("\n")}\n`);
}

/** Remove `KEY=value` lines from an env file, preserving every other line. */
async function removeEnvVars(envPath: string, keys: string[]): Promise<void> {
  let existing: string;
  try {
    existing = await fs.readFile(envPath, "utf8");
  } catch {
    return;
  }
  const lines = existing.split("\n");
  const next = lines.filter((line) => !keys.includes(/^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? ""));
  if (next.length !== lines.length) await writeAtomic(envPath, next.join("\n"));
}

/**
 * Apply an extension config change to an agent's `agent.yaml`.
 *
 * @param workspaceDir Absolute path to the agent's workspace (contains
 *   `agent.yaml` and, for secrets, `.env`).
 * @param extensionId The extension whose per-agent config to update.
 * @param patch The change to merge (enabled flag, config fields, secrets).
 * @returns The re-validated agent config after the write.
 */
export async function updateAgentExtensionConfig(
  workspaceDir: string,
  extensionId: string,
  patch: ExtensionConfigPatch,
  validate?: ExtensionConfigValidator
): Promise<Record<string, unknown>> {
  return updateAgentConfig(
    workspaceDir,
    (doc, parsed) => {
      const extensions = isRecord(parsed.extensions)
        ? { ...parsed.extensions }
        : {};
      const current = isRecord(extensions[extensionId])
        ? { ...(extensions[extensionId] as Record<string, unknown>) }
        : {};

      if (patch.enabled !== undefined) {
        current.enabled = patch.enabled;
      }
      if (patch.config) {
        for (const [key, value] of Object.entries(patch.config)) {
          current[key] = value;
        }
      }

      // Secrets: write $env:NAME sentinels into the yaml and collect the real
      // values for the env file. Never write the concrete value into agent.yaml.
      const envVars: Record<string, string> = {};
      if (patch.secrets) {
        for (const [field, value] of Object.entries(patch.secrets)) {
          const envName = secretEnvName(extensionId, field);
          current[field] = `$env:${envName}`;
          envVars[envName] = value;
        }
      }

      const staleEnv: string[] = [];
      for (const field of patch.removeSecrets ?? []) {
        const envName = secretEnvName(extensionId, field);
        if (current[field] === `$env:${envName}`) staleEnv.push(envName);
        delete current[field];
      }

      // Mutate the raw YAML document to retain comments and unresolved env refs.
      doc.setIn(["extensions", extensionId], current);
      return { envVars, staleEnv };
    },
    validate
  );
}

export class WebhookConfigUpdateError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string
  ) {
    super(message);
  }
}

export type WebhookPatch = {
  credentialMode?: "owner" | "team";
  enabled?: boolean;
};

export async function updateAgentWebhook(
  workspaceDir: string,
  webhookName: string,
  patch: WebhookPatch,
  userId?: string
): Promise<Record<string, unknown>> {
  const { credentialMode, enabled } = patch;
  return updateAgentConfig(workspaceDir, (doc, parsed) => {
    if (credentialMode === "owner" && !userId) {
      throw new WebhookConfigUpdateError(
        400,
        "Owner credentials require an authenticated user"
      );
    }
    const current = isRecord(parsed.webhooks)
      ? parsed.webhooks[webhookName]
      : undefined;
    if (!isRecord(current)) {
      throw new WebhookConfigUpdateError(404, "Webhook not found");
    }
    if (
      current.credentialMode === "owner" &&
      (!userId || current.ownerUserId !== userId)
    ) {
      throw new WebhookConfigUpdateError(
        403,
        "Only the webhook owner can change its credentials"
      );
    }
    if (credentialMode) {
      doc.setIn(["webhooks", webhookName, "credentialMode"], credentialMode);
      if (credentialMode === "owner") {
        doc.setIn(["webhooks", webhookName, "ownerUserId"], userId);
      } else {
        doc.deleteIn(["webhooks", webhookName, "ownerUserId"]);
      }
    }
    if (enabled === false) {
      doc.setIn(["webhooks", webhookName, "enabled"], false);
    } else if (enabled === true) {
      doc.deleteIn(["webhooks", webhookName, "enabled"]);
    }
  });
}
