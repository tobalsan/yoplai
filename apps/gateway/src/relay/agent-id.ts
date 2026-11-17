import { isSupportedRemoteAgentId, splitGatewaySuffix } from "@yoplai/shared/agent-id-wire";

export { addGatewaySuffix, isSupportedRemoteAgentId } from "@yoplai/shared/agent-id-wire";

/**
 * Removes the suffix of a linked gateway. The text after the last `@` counts as a gateway name only when a
 * linked gateway has that name, and only when the HTTP transport carries the raw ID that remains
 * (`isSupportedRemoteAgentId`, which lists the supported characters). Any other ID stays whole and
 * is never relayed.
 */
export function removeGatewaySuffix(
  agentId: string,
  gatewayNames: readonly string[]
): { agentId: string; gateway?: string } {
  const split = splitGatewaySuffix(agentId, gatewayNames);
  return split.gateway !== undefined && !isSupportedRemoteAgentId(split.agentId) ? { agentId } : split;
}
