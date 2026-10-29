import type { CodemodeLimits } from "@yoplai/shared";

type Script = { count: number; active: number; queue: Array<() => void> };

/** Per-run admission and queue state, isolated by each codemode invocation. */
export class CodemodeLimiter {
  private scripts = new Map<string, Script>();
  private parents = new Map<string, Script>();

  constructor(private limits: Required<CodemodeLimits>) {}

  admit(toolCallId: string, parentToolCallId?: string): string | undefined {
    if (!parentToolCallId) return;
    let script = this.scripts.get(parentToolCallId);
    if (!script) {
      script = { count: 0, active: 0, queue: [] };
      this.scripts.set(parentToolCallId, script);
    }
    if (script.count >= this.limits.maxToolCalls) {
      return `Codemode call limit reached (${script.count} tool calls in one script; cap ${this.limits.maxToolCalls}). Split the work into more codemode calls: process a part of the items per call, save progress to a file, and resume from it.`;
    }
    script.count += 1;
    this.parents.set(toolCallId, script);
  }

  async acquire(toolCallId: string, signal?: AbortSignal): Promise<(() => void) | undefined> {
    const script = this.parents.get(toolCallId);
    if (!script) return;
    signal?.throwIfAborted();
    if (script.active >= this.limits.maxConcurrentToolCalls) {
      await new Promise<void>((resolve, reject) => {
        const enter = () => {
          signal?.removeEventListener("abort", abort);
          script.active += 1;
          resolve();
        };
        const abort = () => {
          script.queue.splice(script.queue.indexOf(enter), 1);
          reject(signal?.reason);
        };
        script.queue.push(enter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else {
      script.active += 1;
    }
    return () => {
      script.active -= 1;
      script.queue.shift()?.();
    };
  }
}
