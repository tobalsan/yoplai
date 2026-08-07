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
  createdAt: number;
};

export function registerContainerToken(
  token: string,
  context: Omit<ContainerTokenContext, "createdAt">
): void {
  activeTokens.set(token, { ...context, createdAt: Date.now() });
}

export function getContainerTokenContext(
  token: string
): ContainerTokenContext | undefined {
  return activeTokens.get(token);
}

export function removeContainerToken(token: string): void {
  activeTokens.delete(token);
}
