import type { CodemodeLimits } from "./types.js";

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
    ...(caps ? [`Per script: at most ${caps.maxToolCalls} tool calls and ${caps.maxConcurrentToolCalls} concurrent gateway tool calls.`] : []),
  ].join("\n");
}
