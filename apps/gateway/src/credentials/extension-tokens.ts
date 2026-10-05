import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import { resolveAgentEnv } from "../config/index.js";
import { CredentialStore } from "./store.js";
import { resolveWebBaseUrl } from "../util/web-url.js";

export function extensionTokenIntegration(extensionId: string): string {
  return `extension-config:${extensionId}`;
}

export function extensionSecretFields(extension: { requiredSecrets?: string[]; configJsonSchema?: Record<string, unknown> | null }): string[] {
  const fields = new Set(extension.requiredSecrets ?? []);
  const properties = extension.configJsonSchema?.properties;
  if (properties && typeof properties === "object") {
    for (const [name, property] of Object.entries(properties)) {
      if (property && typeof property === "object" &&
          (property.writeOnly === true || property.format === "password")) fields.add(name);
    }
  }
  return [...fields];
}

export type PersonalExtensionValues = Record<string, string | number | boolean>;

/** Every config field a requester may set for themselves (secrets plus shared settings). */
export function extensionPersonalFields(extension: { requiredSecrets?: string[]; configJsonSchema?: Record<string, unknown> | null }): string[] {
  const properties = extension.configJsonSchema?.properties;
  const names = properties && typeof properties === "object" ? Object.keys(properties) : [];
  return [...new Set([...extensionSecretFields(extension), ...names])].filter((name) => name !== "enabled");
}

/** True when a submitted personal value is acceptable for this field. */
export function isValidPersonalValue(extension: Extension, field: string, value: unknown): boolean {
  if (!extensionPersonalFields(extension).includes(field)) return false;
  if (extensionSecretFields(extension).includes(field)) {
    return typeof value === "string" && !!value && value !== "********" && !value.startsWith("$env:");
  }
  if (typeof value === "string") return !value.startsWith("$env:");
  return typeof value === "number" || typeof value === "boolean";
}

/** Apply the regular configuration API's validation to the personal-only form. */
export function savePersonalExtensionTokens(
  extension: Extension,
  agent: AgentConfig,
  config: GatewayConfig,
  userId: string,
  values: PersonalExtensionValues,
  store = new CredentialStore(),
  replaceSettings = false
): void {
  if (!userId || Object.entries(values).some(([field, value]) => !isValidPersonalValue(extension, field, value))) {
    throw new Error("Invalid personal credential fields");
  }
  const key = { agentId: agent.id, integration: extensionTokenIntegration(extension.id), scope: { type: "personal" as const, userId } };
  const secretFields = extensionSecretFields(extension);
  const existing = store.get<PersonalExtensionValues>(key) ?? {};
  // The web form sends the full set of setting overrides, so stale ones are dropped.
  const kept = replaceSettings ? Object.fromEntries(Object.entries(existing).filter(([field]) => secretFields.includes(field))) : existing;
  const tokens = { ...kept, ...values };
  const prospective = { ...agent, extensions: { ...agent.extensions, [extension.id]: { ...agent.extensions?.[extension.id], enabled: true } } };
  const scoped = overlayExtensionValues(extension, prospective, config, tokens);
  const validation = extension.validateAgentConfig?.(scoped.agent, scoped.config, resolveAgentEnv(agent, config));
  if (scoped.missing.length || validation?.valid === false) {
    const knownFields = extensionPersonalFields(extension);
    const error = new Error("Extension configuration is invalid") as Error & { fields: string[] };
    error.fields = scoped.missing.length ? scoped.missing : (validation?.valid === false ? validation.errors : []).map((field) => knownFields.includes(field) ? field : "config");
    throw error;
  }
  store.save(key, tokens);
}

/** Overlay this requester's personal values; fields they did not set keep the shared value. */
export function resolveExtensionTokenConfig(
  extension: Extension,
  agent: AgentConfig,
  config: GatewayConfig,
  userId?: string,
  store?: CredentialStore,
  env = resolveAgentEnv(agent, config)
): { agent: AgentConfig; config: GatewayConfig; missing: string[]; connectUrl: string } {
  const personal = userId ? (store ?? new CredentialStore()).get<PersonalExtensionValues>({
    agentId: agent.id,
    integration: extensionTokenIntegration(extension.id),
    scope: { type: "personal", userId },
  }) : undefined;
  return overlayExtensionValues(extension, agent, config, personal, env);
}

/** Overlay a requester's values on shared config: secrets resolve `$env:` refs, settings keep them. */
function overlayExtensionValues(
  extension: Extension,
  agent: AgentConfig,
  config: GatewayConfig,
  personal: PersonalExtensionValues | undefined,
  env = resolveAgentEnv(agent, config)
): { agent: AgentConfig; config: GatewayConfig; missing: string[]; connectUrl: string } {
  const connectUrl = `${resolveWebBaseUrl(config)}/agents/${encodeURIComponent(agent.id)}/extensions/${encodeURIComponent(extension.id)}/config`;
  const fields = extensionSecretFields(extension);
  const rawAgent = agent.extensions?.[extension.id] as Record<string, unknown> | undefined;
  if (!fields.length || !rawAgent || rawAgent.enabled === false) {
    return { agent, config, missing: [], connectUrl };
  }
  const root = config.extensions?.[extension.id] as Record<string, unknown> | undefined;
  const tokens: Record<string, unknown> = {};
  const missing: string[] = [];
  const required = new Set(extension.requiredSecrets ?? []);
  const schemaRequired = extension.configJsonSchema?.required;
  if (Array.isArray(schemaRequired)) for (const field of schemaRequired) {
    if (typeof field === "string") required.add(field);
  }
  const agentConfig = { ...rawAgent };
  const rootConfig = { ...root };
  for (const field of extensionPersonalFields(extension)) {
    const secret = fields.includes(field);
    const personalValue = personal?.[field];
    let value: unknown = personalValue ?? rawAgent[field] ?? root?.[field];
    if (secret && typeof value === "string" && value.startsWith("$env:")) {
      // Personal tokens are literal credentials, never references to host secrets.
      value = personalValue !== undefined ? undefined : env[value.slice(5)];
    }
    if (value === undefined || value === null || value === "") {
      delete agentConfig[field];
      delete rootConfig[field];
      if (!required.has(field)) continue;
      missing.push(field);
      // Build metadata even when unconnected; execution is guarded below the host boundary.
      tokens[field] = "__YOPLAI_MISSING_CREDENTIAL__";
    } else if (secret || personalValue !== undefined) tokens[field] = value;
  }
  return {
    agent: { ...agent, extensions: { ...agent.extensions, [extension.id]: { ...agentConfig, ...tokens } } },
    config: { ...config, extensions: { ...config.extensions, [extension.id]: { ...rootConfig, ...tokens } } },
    missing,
    connectUrl,
  };
}
