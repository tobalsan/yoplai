import type { ContainerFileOutputRequest, ExtensionAgentToolContext } from "@yoplai/shared";

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
  conversationFiles?: ExtensionAgentToolContext["conversationFiles"];
  oauthProviders?: string[];
  userId?: string;
  sessionOwnerId?: string | null;
  requesterId?: string;
  projectId?: string;
  emitProgress?: (event: {
    label: string;
    current?: number;
    total?: number;
    taskId?: string;
  }) => void;
  registerFileOutput?: (
    event: ContainerFileOutputRequest,
    signal: AbortSignal
  ) => Promise<void>;
  createdAt: number;
  abortController: AbortController;
};

export function registerContainerToken(
  token: string,
  context: Omit<ContainerTokenContext, "createdAt" | "abortController">
): void {
  activeTokens.set(token, {
    ...context,
    createdAt: Date.now(),
    abortController: new AbortController(),
  });
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
  abortContainerRun(token);
  activeTokens.delete(token);
}

export function abortContainerRun(tokenOrRunId: string): void {
  const context = activeTokens.get(tokenOrRunId);
  if (context) {
    context.abortController.abort();
    return;
  }
  for (const entry of activeTokens.values()) {
    if (entry.runId === tokenOrRunId) entry.abortController.abort();
  }
}
