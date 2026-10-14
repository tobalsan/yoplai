// Reserve only runtime activation; summary generation leaves ordinary turns free.
const activations = new Map<string, Promise<void>>();
function key(agentId: string, sessionId: string, userId?: string): string {
  return JSON.stringify([userId ?? "", agentId, sessionId]);
}
export async function waitForCompactionActivation<T>(agentId: string, sessionId: string, userId: string | undefined, begin: () => T): Promise<T> {
  while (activations.has(key(agentId, sessionId, userId))) {
    await activations.get(key(agentId, sessionId, userId));
  }
  return begin();
}
export async function activateCompaction<T>(agentId: string, sessionId: string, userId: string | undefined, activate: () => Promise<T>): Promise<T> {
  const identity = key(agentId, sessionId, userId);
  let release!: () => void;
  activations.set(identity, new Promise<void>((resolve) => { release = resolve; }));
  try {
    return await activate();
  } finally {
    activations.delete(identity);
    release();
  }
}
