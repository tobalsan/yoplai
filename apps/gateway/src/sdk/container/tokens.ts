const activeTokens = new Map<
  string,
  { agentId: string; containerName: string; createdAt: number; userId?: string }
>();

export function registerContainerToken(
  token: string,
  agentId: string,
  containerName: string,
  userId?: string
): void {
  activeTokens.set(token, {
    agentId,
    containerName,
    userId,
    createdAt: Date.now(),
  });
}

export function getContainerTokenUserId(
  token: string,
  agentId: string
): string | undefined {
  const entry = activeTokens.get(token);
  return entry?.agentId === agentId ? entry.userId : undefined;
}

export function validateContainerToken(
  token: string,
  agentId: string
): boolean {
  return activeTokens.get(token)?.agentId === agentId;
}

export function removeContainerToken(token: string): void {
  activeTokens.delete(token);
}
