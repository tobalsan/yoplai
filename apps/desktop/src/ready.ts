export interface WaitForReadyOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Return true when the URL answers with a 2xx status. */
  probe?: (url: string) => Promise<boolean>;
  /** Return true to stop waiting early (for example, a child exited). */
  shouldAbort?: () => boolean;
}

async function httpOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Poll every URL until all answer OK. Throw on timeout or abort. */
export async function waitForReady(urls: string[], options: WaitForReadyOptions): Promise<void> {
  const probe = options.probe ?? httpOk;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + options.timeoutMs;
  const pending = new Set(urls);
  while (pending.size > 0) {
    if (options.shouldAbort?.()) throw new Error("Start aborted");
    for (const url of [...pending]) {
      if (await probe(url)) pending.delete(url);
    }
    if (pending.size === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${[...pending].join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
