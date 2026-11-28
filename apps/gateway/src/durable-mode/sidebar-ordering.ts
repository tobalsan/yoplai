import { addGatewaySuffix, isSupportedRemoteAgentId, removeGatewaySuffix } from "../relay/agent-id.js";

/** Leave hidden IDs in their slots and fill the other slots with the displayed order. */
export function applyVisibleOrder(stored: readonly string[], shown: readonly string[]): string[] {
  const visible = new Set(shown);
  const result: string[] = [];
  let next = 0;
  for (const id of stored) {
    if (!visible.has(id)) result.push(id);
    else if (next < shown.length) result.push(shown[next++]);
  }
  return result.concat(shown.slice(next));
}

export function projectForGateway(
  full: readonly string[],
  gatewayName: string,
  isLocal: (id: string) => boolean,
): string[] {
  const projected: string[] = [];
  for (const id of full) {
    if (isLocal(id)) continue;
    const remote = removeGatewaySuffix(id, [gatewayName]);
    if (remote.gateway) projected.push(remote.agentId);
  }
  return projected;
}

export function mergeGatewayOrder(
  full: readonly string[],
  gatewayName: string,
  remoteIds: readonly string[],
  isLocal: (id: string) => boolean,
): string[] {
  const listed = new Set(remoteIds.filter(isSupportedRemoteAgentId)
    .map((id) => addGatewaySuffix(id, gatewayName))
    .filter((id) => !isLocal(id)));
  // IDs omitted by the peer act like hidden IDs. Newly listed IDs provide
  // extra slots at the end, which are filled in the peer's order.
  return applyVisibleOrder(full, [...listed]);
}
