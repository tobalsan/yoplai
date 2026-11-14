/** A remote agent shows as `<agentId>@<gatewayName>`. A local agent has no suffix. */
export function addGatewaySuffix(agentId: string, gatewayName: string): string {
  return `${agentId}@${gatewayName}`;
}

/**
 * Agent IDs have no character rule, so the text after the last `@` counts as a
 * gateway name only when a linked gateway has that name.
 */
export function removeGatewaySuffix(
  agentId: string,
  gatewayNames: readonly string[]
): { agentId: string; gateway?: string } {
  const at = agentId.lastIndexOf("@");
  if (at <= 0) return { agentId };
  const gateway = agentId.slice(at + 1);
  if (!gatewayNames.includes(gateway)) return { agentId };
  return { agentId: agentId.slice(0, at), gateway };
}
