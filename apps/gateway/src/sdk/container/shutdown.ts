import * as childProcess from "node:child_process";

const pending = new Map<string, Promise<void>>();

function docker(args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Docker command timed out")),
      timeout
    );
    childProcess.execFile("docker", args, { timeout }, (error, stdout) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function isStopped(
  containerName: string,
  timeout: number
): Promise<boolean> {
  try {
    const state = await docker(
      ["inspect", "--format", "{{.State.Running}}", containerName],
      timeout
    );
    return state.trim() === "false";
  } catch (error) {
    return (
      error instanceof Error &&
      /No such (object|container)/i.test(error.message)
    );
  }
}

/** Coalesced, bounded enforcement; a successful stop command alone is insufficient. */
export function stopThenKill(containerName: string): Promise<void> {
  const existing = pending.get(containerName);
  if (existing) return existing;
  const operation = (async () => {
    const deadline = Date.now() + 15_000;
    let stopSucceeded = false;
    try {
      await docker(["stop", containerName], 10_000);
      stopSucceeded = true;
    } catch {
      // A failed stop must always fall back to kill.
    }
    if (
      !stopSucceeded ||
      !(await isStopped(containerName, Math.min(1000, deadline - Date.now())))
    ) {
      try {
        await docker(
          ["kill", containerName],
          Math.max(1, Math.min(2000, deadline - Date.now()))
        );
      } catch {
        // An absent container is safe; verify rather than trusting command errors.
      }
    }
    while (Date.now() < deadline) {
      if (
        await isStopped(
          containerName,
          Math.max(1, Math.min(1000, deadline - Date.now()))
        )
      )
        return;
      if (Date.now() < deadline) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(100, deadline - Date.now()))
        );
      }
    }
    throw new Error(
      `Container shutdown enforcement failed: ${containerName} not confirmed stopped within 15s`
    );
  })();
  pending.set(containerName, operation);
  void operation.finally(() => pending.delete(containerName)).catch(() => {});
  return operation;
}
