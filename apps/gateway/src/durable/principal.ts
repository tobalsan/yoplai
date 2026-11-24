import { DURABLE_MAIN_SESSION_ID, type GatewayConfig } from "@yoplai/shared";
import { resolveRunActor } from "../extensions/runtime.js";
import { getConversationFiles } from "../media/conversation-files.js";

export function mainIdentity(owner: string, config: GatewayConfig) {
  const userId = owner === "local" ? undefined : owner;
  return {
    userId,
    sessionOwnerId: userId,
    requesterId: userId,
    ...resolveRunActor(config, userId),
    source: "web" as const,
    sender: { kind: "web" as const },
    background: false,
    sessionId: DURABLE_MAIN_SESSION_ID,
  };
}

export function mainPrincipal(agentId: string, owner: string, config: GatewayConfig) {
  const identity = mainIdentity(owner, config);
  return { ...identity, conversationFiles: getConversationFiles(agentId, identity.sessionId, identity.userId) };
}
