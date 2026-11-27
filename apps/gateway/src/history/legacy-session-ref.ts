export function legacySessionRef(agentId: string, sessionId: string): string {
  return `legacy:${agentId}:${sessionId.replaceAll("%", "%25").replaceAll("#", "%23")}`;
}

export function parseLegacySessionRef(agentId: string, ref: string) {
  const prefix = `legacy:${agentId}:`;
  if (!ref.startsWith(prefix)) return;
  const match = /^([^#]+)(?:#(\d+))?$/.exec(ref.slice(prefix.length));
  if (!match) return;
  const sessionId = match[1].replace(/%25|%23/g, (escape) => escape === "%25" ? "%" : "#");
  const index = match[2] === undefined ? undefined : Number(match[2]);
  if (index !== undefined && !Number.isSafeInteger(index)) return;
  return { sessionId, index };
}
