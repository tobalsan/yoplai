const activeTokens = new Map<
  string,
  ContainerTokenContext
>();

export type ContainerTokenContext = {
  agentId: string;
  sessionId: string;
  runId: string;
  containerName: string;
  roots: { workspace: string; data: string; uploads: string };
  userId?: string;
  emitProgress?: (event: {
    label: string;
    current?: number;
    total?: number;
    taskId?: string;
  }) => void;
  createdAt: number;
};

export function registerContainerToken(
  token: string,
  context: Omit<ContainerTokenContext, "createdAt">
): void {
  activeTokens.set(token, { ...context, createdAt: Date.now() });
}

export function validateContainerToken(token: string, agentId: string): boolean {
  return activeTokens.get(token)?.agentId === agentId;
}

export function getContainerTokenUserId(token: string, agentId: string): string | undefined {
  const entry = activeTokens.get(token);
  return entry?.agentId === agentId ? entry.userId : undefined;
}

export function getContainerTokenContext(
  token: string
): ContainerTokenContext | undefined {
  return activeTokens.get(token);
}

export function removeContainerToken(token: string): void {
  activeTokens.delete(token);
}
