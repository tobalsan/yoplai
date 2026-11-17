import type { Stack, StackStart } from "./stack.js";

export interface StackController {
  /** Current ready stack, or null while none runs. */
  current: () => Stack | null;
  /** Start a stack. A call while a start runs joins that start. Resolves to the ready stack. */
  restart: () => Promise<Stack>;
  /** Cancel a pending start and stop every child. */
  shutdown: () => Promise<void>;
}

/** Keeps one start handle from the moment children can exist. */
export function createStackController(start: () => StackStart): StackController {
  let stack: Stack | null = null;
  let pending: StackStart | null = null;
  let pendingReady: Promise<Stack> | null = null;
  let closed = false;
  let stopping: Promise<void> | null = null;

  const restart = (): Promise<Stack> => {
    if (pendingReady) return pendingReady;
    const run = async (): Promise<Stack> => {
      const previous = stack;
      stack = null;
      stopping = previous ? previous.stop() : null;
      await stopping;
      if (closed) throw new Error("Start cancelled");
      const handle = start();
      pending = handle;
      try {
        stack = await handle.ready;
        return stack;
      } finally {
        pending = null;
        pendingReady = null;
      }
    };
    pendingReady = run();
    return pendingReady;
  };

  return {
    current: () => stack,
    restart,
    shutdown: async () => {
      closed = true;
      await Promise.all([stopping, pending?.stop(), stack?.stop()]);
    },
  };
}
