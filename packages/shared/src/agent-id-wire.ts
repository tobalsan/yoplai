/**
 * Qualified agent IDs and the remote agent IDs that the relay carries. Browser and Node both run this file.
 *
 * A remote agent shows as `<agentId>@<gatewayName>`; a local agent has no suffix. An ID may hold `@`, so the text
 * after the last `@` names a gateway only when a linked gateway has that name.
 *
 * Supported remote agent IDs: the relay sends the raw ID as one path segment of an HTTP request, and a segment
 * may not hold what the outbound path guard refuses. A raw remote agent ID is therefore supported when it is not
 * empty, is not `.` or `..`, and holds no `/`, `\`, `%`, `?`, `#`, or control character (Unicode category Cc),
 * and has well-formed Unicode. Every other character is supported, including `@`, spaces, and non-ASCII letters.
 * The relay does not list a remote agent with another ID and does not treat its suffix as a gateway.
 */

/** A remote agent shows as `<agentId>@<gatewayName>`. */
export function addGatewaySuffix(agentId: string, gatewayName: string): string {
  return `${agentId}@${gatewayName}`;
}

/** The raw ID and the gateway of a qualified ID, or the ID itself when its last `@` text names no listed gateway. */
export function splitGatewaySuffix(
  agentId: string,
  gatewayNames: readonly string[]
): { agentId: string; gateway?: string } {
  const at = agentId.lastIndexOf("@");
  if (at <= 0) return { agentId };
  const gateway = agentId.slice(at + 1);
  if (!gatewayNames.includes(gateway)) return { agentId };
  return { agentId: agentId.slice(0, at), gateway };
}

/**
 * The rule for one decoded segment of a path that the relay sends to a linked gateway. The outbound path guard
 * and `isSupportedRemoteAgentId` both use it, so the guard and the promise cannot differ.
 */
export function isCarriedPathSegment(decoded: string): boolean {
  return decoded !== "." && decoded !== ".." && !/[/\\%?#\p{Cc}]/u.test(decoded);
}

/** True when the HTTP transport carries this raw remote agent ID. */
export function isSupportedRemoteAgentId(rawId: string): boolean {
  if (!rawId || !isCarriedPathSegment(rawId)) return false;
  try {
    encodeURIComponent(rawId);
    return true;
  } catch {
    return false;
  }
}
