import { registerCredentialOAuthConnector, requestCredentialConnectLink, startExtensionCredentialOAuth, type CredentialConnectHost } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import { getLoadedExtensions, isExtensionLoaded } from "../extensions/registry.js";
import { getOAuthService } from "../oauth/service.js";
import { extensionSecretFields, extensionTokenIntegration, resolveExtensionTokenConfig, savePersonalExtensionTokens, type PersonalExtensionValues } from "./extension-tokens.js";
import { recordSettingsChange } from "../audit/store.js";
import { diffSettings } from "../audit/diff.js";
import { CredentialStore } from "./store.js";

async function actorEmail(userId: string): Promise<string | undefined> {
  if (!isExtensionLoaded("multiUser")) return undefined;
  try {
    const { getMultiUserRuntime } = await import("@yoplai/extension-multi-user");
    return (getMultiUserRuntime()?.db.prepare("SELECT email FROM user WHERE id = ?").get(userId) as { email: string } | undefined)?.email;
  } catch { return undefined; }
}

function tokenTarget(agentId: string, extensionId: string) {
  const agent = getAgent(agentId);
  const extension = getLoadedExtensions().find((entry) => entry.id === extensionId);
  if (!agent || !extension || !agent.extensions?.[extensionId] || agent.extensions[extensionId]?.enabled === false) {
    throw new Error("This credential target is unavailable.");
  }
  return { agent, extension };
}

/** Trusted host hook; calling extension routes must authenticate and check agent access. */
export const credentialConnectHost: CredentialConnectHost = {
  registerOAuthConnector: registerCredentialOAuthConnector,
  requestLink: requestCredentialConnectLink,
  async start(target, options) {
    if (!options.userId || !getAgent(options.agentId)) throw new Error("Personal credentials require an existing user and agent.");
    const email = options.actorEmail ?? await actorEmail(options.userId);
    if (target.kind === "extension-oauth") {
      return startExtensionCredentialOAuth(target.extensionId, target.targetId, { ...options, actorEmail: email });
    }
    if (target.kind !== "oauth") throw new Error("This target requires a token form.");
    const result = await getOAuthService().startAuthorization({
      agentId: options.agentId,
      provider: target.provider,
      scopes: target.scopes,
      scope: "personal",
      userId: options.userId,
      onComplete: async () => {
        recordSettingsChange({ actorUserId: options.userId, actorEmail: email, impersonatorUserId: options.impersonatorUserId, action: "oauth.connect", agentId: options.agentId,
          targetType: "oauth", targetId: target.provider, scope: "personal", changes: [{ field: "credentials", secret: "set" }] });
        await options.onComplete();
      },
    });
    return result.authorizeUrl;
  },
  async fields(agentId, extensionId) {
    const { agent, extension } = tokenTarget(agentId, extensionId);
    const required = new Set(extension.requiredSecrets ?? []);
    const schemaRequired = extension.configJsonSchema?.required;
    if (Array.isArray(schemaRequired)) for (const field of schemaRequired) {
      if (typeof field === "string") required.add(field);
    }
    const properties = extension.configJsonSchema?.properties as Record<string, { title?: string }> | undefined;
    const secrets = extensionSecretFields(extension);
    // Required settings without a team value (e.g. a username) are asked for too.
    const unsetSettings = resolveExtensionTokenConfig(extension, agent, loadConfig()).missing.filter((name) => !secrets.includes(name));
    return [...unsetSettings, ...secrets].map((name) => ({
      name,
      label: properties?.[name]?.title ?? name,
      required: required.has(name),
      secret: secrets.includes(name),
    }));
  },
  async save(agentId, extensionId, userId, secrets) {
    const { agent, extension } = tokenTarget(agentId, extensionId);
    const store = new CredentialStore();
    const key = { agentId, integration: extensionTokenIntegration(extensionId), scope: { type: "personal" as const, userId } };
    const before = store.get<PersonalExtensionValues>(key) ?? {};
    savePersonalExtensionTokens(extension, agent, loadConfig(), userId, secrets, store);
    const changes = diffSettings(before, { ...before, ...secrets }, extensionSecretFields(extension));
    if (changes.length) recordSettingsChange({ actorUserId: userId, actorEmail: await actorEmail(userId), action: "extension.personal_update", agentId,
      targetType: "extension", targetId: extensionId, scope: "personal", changes });
  },
};
