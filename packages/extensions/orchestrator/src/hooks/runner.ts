import { spawn } from "node:child_process";
import type { StateStore } from "../state/store.js";
import { sanitizedWorkerEnv } from "../worker-runner/env.js";

export async function runHook(input: { command?: string; phase: string; cwd: string; runId: string; store?: StateStore; env: Record<string, string | undefined>; exitCode?: number }): Promise<number> {
  if (!input.command) return 0;
  const env = sanitizedWorkerEnv(input.env);
  if (input.phase === "after_run" && input.exitCode !== undefined) {
    env.YOPLAI_EXIT_CODE = String(input.exitCode);
    env.AIHUB_EXIT_CODE = String(input.exitCode);
  }
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", input.command!], { cwd: input.cwd, env });
    child.stdout.on("data", (chunk) => input.store?.appendEvent(input.runId, `hook.${input.phase}.stdout`, chunk.toString()));
    child.stderr.on("data", (chunk) => input.store?.appendEvent(input.runId, `hook.${input.phase}.stderr`, chunk.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
