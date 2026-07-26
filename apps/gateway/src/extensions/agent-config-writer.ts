import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { AgentYamlConfigSchema } from "@yoplai/shared";

/**
 * Write path for an agent's `config.extensions`. Runtime agent config is
 * read-only today; this is the only place that mutates an agent's `agent.yaml`.
 *
 * The change is applied to the raw parsed YAML (not the runtime-resolved
 * config) so we preserve `$env:NAME` sentinels and any fields the schema passes
 * through, then re-validated against `AgentYamlConfigSchema` before it is
 * written back atomically. Secret values never land as plaintext in
 * `agent.yaml`: they are written as `$env:NAME` sentinels there and the concrete
 * value is appended/updated in the agent's `.env` file, matching the runtime
 * `resolveEnvRefs` resolver.
 */

export type ExtensionConfigPatch = {
  /** Flip the extension on/off for this agent. */
  enabled?: boolean;
  /**
   * Non-secret config fields to merge into `extensions.<id>`. Values are
   * written verbatim into `agent.yaml`.
   */
  config?: Record<string, unknown>;
  /**
   * Secret fields. Each value is written to the agent's `.env` file and
   * referenced from `agent.yaml` as `$env:NAME` (never plaintext). The env var
   * name is derived from the extension id and field name.
   */
  secrets?: Record<string, string>;
};

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

async function writeLocked(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // Imported lazily: `proper-lockfile` registers SIGTERM/SIGINT handlers at
  // import time, and this module is on the gateway server import graph. A
  // top-level import would register those handlers before the gateway's own
  // graceful-shutdown handler, shadowing it.
  const { default: lockfile } = await import("proper-lockfile");
  const release = await lockfile.lock(path.dirname(filePath), {
    retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
    realpath: false,
  });
  try {
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
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

  await writeLocked(envPath, `${next.join("\n")}\n`);
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
  patch: ExtensionConfigPatch
): Promise<Record<string, unknown>> {
  const agentPath = path.join(workspaceDir, "agent.yaml");
  const raw = await fs.readFile(agentPath, "utf8");
  const parsed = yaml.load(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Malformed agent.yaml at ${agentPath}`);
  }

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

  extensions[extensionId] = current;
  const nextConfig = { ...parsed, extensions };

  // Re-validate against the schema before persisting anything. `$env:NAME`
  // sentinels are plain strings, so they pass validation without needing the
  // env var to be set.
  const validation = AgentYamlConfigSchema.safeParse(nextConfig);
  if (!validation.success) {
    throw new Error(
      `agent.yaml would be invalid after update: ${validation.error.message}`
    );
  }

  // Write secrets first so a mid-write crash can't leave a $env ref pointing at
  // a missing value.
  if (Object.keys(envVars).length > 0) {
    await upsertEnvVars(path.join(workspaceDir, ".env"), envVars);
  }

  const yamlContent = yaml.dump(nextConfig, {
    noRefs: true,
    lineWidth: 100,
    sortKeys: false,
  });
  await writeLocked(agentPath, yamlContent);

  return nextConfig;
}
