import { registerCredentialOAuthConnector, requestCredentialConnectLink, startExtensionCredentialOAuth, type CredentialConnectHost } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import { getLoadedExtensions } from "../extensions/registry.js";
import { getOAuthService } from "../oauth/service.js";
import { extensionSecretFields, savePersonalExtensionTokens } from "./extension-tokens.js";

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
    if (target.kind === "extension-oauth") {
      return startExtensionCredentialOAuth(target.extensionId, target.targetId, options);
    }
    if (target.kind !== "oauth") throw new Error("This target requires a token form.");
    const result = await getOAuthService().startAuthorization({
      agentId: options.agentId,
      provider: target.provider,
      scopes: target.scopes,
      scope: "personal",
      userId: options.userId,
      onComplete: options.onComplete,
    });
    return result.authorizeUrl;
  },
  async fields(agentId, extensionId) {
    const { extension } = tokenTarget(agentId, extensionId);
    const required = new Set(extension.requiredSecrets ?? []);
    const schemaRequired = extension.configJsonSchema?.required;
    if (Array.isArray(schemaRequired)) for (const field of schemaRequired) {
      if (typeof field === "string") required.add(field);
    }
    const properties = extension.configJsonSchema?.properties as Record<string, { title?: string }> | undefined;
    return extensionSecretFields(extension).map((name) => ({
      name,
      label: properties?.[name]?.title ?? name,
      required: required.has(name),
    }));
  },
  async save(agentId, extensionId, userId, secrets) {
    const { agent, extension } = tokenTarget(agentId, extensionId);
    savePersonalExtensionTokens(extension, agent, loadConfig(), userId, secrets);
  },
};
