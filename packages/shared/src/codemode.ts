import { parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import type { CodemodeLimits } from "./types.js";

const DEFAULT_SCRIPT_SECONDS = 300;

/** Seconds a codemode script may run before the container stops it; 300 unless its first-line `// @options` sets a valid `timeout_ms`. */
export function codemodeScriptBudget(code: string): number {
  try {
    const { timeoutMs } = parseCodemodeSource(code).options;
    return timeoutMs === undefined ? DEFAULT_SCRIPT_SECONDS : timeoutMs / 1000;
  } catch {
    // Pi rejects invalid sources before the script runs.
    return DEFAULT_SCRIPT_SECONDS;
  }
}

export function resolveCodemodeLimits(config?: CodemodeLimits) {
  return {
    maxToolCalls: config?.maxToolCalls ?? 200,
    maxConcurrentToolCalls: config?.maxConcurrentToolCalls ?? 10,
  };
}

export function codemodeGuidance(caps?: Required<CodemodeLimits>): string {
  return [
    "Run one small batch first. Measure the latency, then estimate the full job before you run it.",
    "Split a long job into codemode calls that each fit the timeout. Save progress to a file and resume from it.",
    "Stop the loop on a 409, or after 3 failures in a row. Do not hide errors with an empty `.catch()`.",
    "Before a job that takes more than about 1 minute, tell the user the plan, the call count, and the time.",
    ...(caps
      ? [
          `Per script: at most ${caps.maxToolCalls} tool calls and ${caps.maxConcurrentToolCalls} concurrent gateway tool calls.`,
          `Each script stops after ${DEFAULT_SCRIPT_SECONDS} seconds by default. To raise it, make the first line \`// @options: {"timeout_ms": N}\` (N in milliseconds); it is cut to the time left in the turn.`,
          "A script that times out stops and its running tool calls are cancelled. Only output from `text()`, `console.log` or `image()` and files written by nested tools survive; `store()` writes are lost when a script fails.",
          "So print or write the results after each batch, and size batches from the measured small batch.",
        ]
      : []),
  ].join("\n");
}
