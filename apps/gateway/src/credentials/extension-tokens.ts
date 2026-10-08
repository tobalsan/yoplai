import { resolveExtensionOAuth, type AgentConfig, type Extension, type GatewayConfig } from "@yoplai/shared";
import { resolveAgentEnv } from "../config/index.js";
import { getOAuthService } from "../oauth/service.js";
import { CredentialStore, type CredentialKey } from "./store.js";
import { resolveWebBaseUrl } from "../util/web-url.js";

export function extensionTokenIntegration(extensionId: string): string {
  return `extension-config:${extensionId}`;
}

/**
 * Personal values follow the user across agents, so they live under one
 * credential-store agentId. It starts with NUL, which no agent folder name can contain.
 */
const PERSONAL_EXTENSION_AGENT_ID = "\0personal-extension-shared";

/** Marks a personal disconnect so stale legacy per-agent rows are not promoted again. */
interface PersonalTombstone {
  __tombstone: true;
  deletedAt: number;
}

function isTombstone(payload: unknown): payload is PersonalTombstone {
  return typeof payload === "object" && payload !== null &&
    (payload as { __tombstone?: unknown }).__tombstone === true;
}

function personalExtensionTokenKey(userId: string, extensionId: string): CredentialKey {
  return {
    agentId: PERSONAL_EXTENSION_AGENT_ID,
    integration: extensionTokenIntegration(extensionId),
    scope: { type: "personal", userId },
  };
}

/**
 * The requester's personal values for an extension, shared by every agent.
 * On a shared miss, the legacy per-agent record is promoted (saved, then deleted).
 */
export function getPersonalExtensionTokens(
  store: CredentialStore,
  agentId: string,
  userId: string,
  extensionId: string
): PersonalExtensionValues | undefined {
  const shared = store.get<PersonalExtensionValues | PersonalTombstone>(personalExtensionTokenKey(userId, extensionId));
  if (isTombstone(shared)) return undefined;
  if (shared !== undefined) return shared;
  const legacyKey: CredentialKey = { agentId, integration: extensionTokenIntegration(extensionId), scope: { type: "personal", userId } };
  const legacy = store.get<PersonalExtensionValues>(legacyKey);
  if (legacy === undefined) return undefined;
  store.save(personalExtensionTokenKey(userId, extensionId), legacy);
  store.delete(legacyKey);
  return legacy;
}

/** Persist the requester's personal values for an extension, overwriting any tombstone. */
export function storePersonalExtensionTokens(
  store: CredentialStore,
  userId: string,
  extensionId: string,
  values: PersonalExtensionValues
): void {
  store.save(personalExtensionTokenKey(userId, extensionId), values);
}

/** Remove the requester's personal values everywhere; later reads do not resurrect legacy rows. */
export function deletePersonalExtensionTokens(
  store: CredentialStore,
  agentId: string,
  userId: string,
  extensionId: string
): void {
  const tombstone: PersonalTombstone = { __tombstone: true, deletedAt: Date.now() };
  store.save(personalExtensionTokenKey(userId, extensionId), tombstone);
  store.delete({ agentId, integration: extensionTokenIntegration(extensionId), scope: { type: "personal", userId } });
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
  const secretFields = extensionSecretFields(extension);
  const existing = getPersonalExtensionTokens(store, agent.id, userId, extension.id) ?? {};
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
  storePersonalExtensionTokens(store, userId, extension.id, tokens);
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
  const personal = userId ? getPersonalExtensionTokens(store ?? new CredentialStore(), agent.id, userId, extension.id) : undefined;
  const scoped = overlayExtensionValues(extension, agent, config, personal, env);
  if (!extension.oauth || extensionSecretFields(extension).length || !userId) return scoped;
  const entry = agent.extensions?.[extension.id] as Record<string, unknown> | undefined;
  if (!entry || entry.enabled === false || !hasPersonalOAuthGrant(extension, agent, config, userId, env)) return scoped;
  return { ...scoped, ...overlayOAuthPersonalSettings(extension, agent, config, personal) };
}

/** True when the requester has their own grant for the extension's provider, so it is used instead of the team's. */
function hasPersonalOAuthGrant(extension: Extension, agent: AgentConfig, config: GatewayConfig, userId: string, env: Record<string, string>): boolean {
  const requirement = resolveExtensionOAuth(extension, config, agent, env);
  if (!requirement) return false;
  try {
    return !!getOAuthService().getScopedConnection(agent.id, requirement.provider, { type: "personal", userId });
  } catch {
    return false;
  }
}

/**
 * Apply the requester's personal settings of an OAuth extension over the team config.
 * A boolean setting they never set is off; it does not inherit the team value.
 */
export function overlayOAuthPersonalSettings(
  extension: Extension,
  agent: AgentConfig,
  config: GatewayConfig,
  personal: PersonalExtensionValues | undefined
): { agent: AgentConfig; config: GatewayConfig } {
  const properties = (extension.configJsonSchema?.properties ?? {}) as Record<string, { type?: unknown } | undefined>;
  const values: Record<string, string | number | boolean> = {};
  for (const field of extensionPersonalFields(extension)) {
    const value = personal?.[field] ?? (properties[field]?.type === "boolean" ? false : undefined);
    if (value !== undefined) values[field] = value;
  }
  return {
    agent: { ...agent, extensions: { ...agent.extensions, [extension.id]: { ...agent.extensions?.[extension.id], ...values } } },
    config: { ...config, extensions: { ...config.extensions, [extension.id]: { ...(config.extensions?.[extension.id] as Record<string, unknown> | undefined), ...values } } },
  };
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
