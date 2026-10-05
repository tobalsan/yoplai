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

/** Apply the regular configuration API's validation to the personal-only form. */
export function savePersonalExtensionTokens(
  extension: Extension,
  agent: AgentConfig,
  config: GatewayConfig,
  userId: string,
  secrets: Record<string, string>,
  store = new CredentialStore()
): void {
  const fields = extensionSecretFields(extension);
  if (!userId || Object.entries(secrets).some(([field, value]) => !fields.includes(field) || typeof value !== "string" || !value || value === "********" || value.startsWith("$env:"))) {
    throw new Error("Invalid personal credential fields");
  }
  const key = { agentId: agent.id, integration: extensionTokenIntegration(extension.id), scope: { type: "personal" as const, userId } };
  const tokens = { ...store.get<Record<string, string>>(key), ...secrets };
  const prospective = { ...agent, extensions: { ...agent.extensions, [extension.id]: { ...agent.extensions?.[extension.id], enabled: true, ...tokens } } };
  const scoped = resolveExtensionTokenConfig(extension, prospective, config);
  const validation = extension.validateAgentConfig?.(scoped.agent, scoped.config, resolveAgentEnv(agent, config));
  if (scoped.missing.length || validation?.valid === false) {
    throw new Error("Extension configuration is invalid");
  }
  store.save(key, tokens);
}

/** Overlay only this requester's token fields; shared non-secret settings stay intact. */
export function resolveExtensionTokenConfig(
  extension: Extension,
  agent: AgentConfig,
  config: GatewayConfig,
  userId?: string,
  store?: CredentialStore,
  env = resolveAgentEnv(agent, config)
): { agent: AgentConfig; config: GatewayConfig; missing: string[]; connectUrl: string } {
  const connectUrl = `${resolveWebBaseUrl(config)}/agents/${encodeURIComponent(agent.id)}/extensions/${encodeURIComponent(extension.id)}/config`;
  const fields = extensionSecretFields(extension);
  const rawAgent = agent.extensions?.[extension.id] as Record<string, unknown> | undefined;
  if (!fields.length || !rawAgent || rawAgent.enabled === false) {
    return { agent, config, missing: [], connectUrl };
  }
  const root = config.extensions?.[extension.id] as Record<string, unknown> | undefined;
  const personal = userId ? (store ?? new CredentialStore()).get<Record<string, string>>({
    agentId: agent.id,
    integration: extensionTokenIntegration(extension.id),
    scope: { type: "personal", userId },
  }) : undefined;
  const tokens: Record<string, string> = {};
  const missing: string[] = [];
  const required = new Set(extension.requiredSecrets ?? []);
  const schemaRequired = extension.configJsonSchema?.required;
  if (Array.isArray(schemaRequired)) for (const field of schemaRequired) {
    if (typeof field === "string" && fields.includes(field)) required.add(field);
  }
  const agentConfig = { ...rawAgent };
  const rootConfig = { ...root };
  for (const field of fields) {
    const personalValue = personal?.[field];
    let value: unknown = personalValue ?? rawAgent[field] ?? root?.[field];
    if (typeof value === "string" && value.startsWith("$env:")) {
      // Personal tokens are literal credentials, never references to host secrets.
      value = personalValue !== undefined ? undefined : env[value.slice(5)];
    }
    if (typeof value !== "string" || value.length === 0) {
      delete agentConfig[field];
      delete rootConfig[field];
      if (!required.has(field)) continue;
      missing.push(field);
      // Build metadata even when unconnected; execution is guarded below the host boundary.
      tokens[field] = "__YOPLAI_MISSING_CREDENTIAL__";
    } else tokens[field] = value;
  }
  return {
    agent: { ...agent, extensions: { ...agent.extensions, [extension.id]: { ...agentConfig, ...tokens } } },
    config: { ...config, extensions: { ...config.extensions, [extension.id]: { ...rootConfig, ...tokens } } },
    missing,
    connectUrl,
  };
}
