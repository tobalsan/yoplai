import { CODEMODE_OPTIONS_PREFIX, parseCodemodeSource } from "@earendil-works/pi-codemode/source";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { codemodeScriptBudget } from "@yoplai/shared";

/**
 * Gives every top-level codemode script a `timeout_ms`: its own `@options` value or 300 s,
 * trimmed to the turn deadline. Pi then stops only that script with a "Script timed out" error,
 * before the gateway watchdog would stop the whole run.
 */
export function createCodemodeDeadlineExtension(turnDeadlineAt?: number): ExtensionFactory {
  return (pi) => {
    const notes = new Map<string, string>();
    pi.on("tool_call", (event) => {
      if (event.toolName !== "codemode" || event.parentToolCallId) return;
      const input = event.input as { code?: unknown };
      if (typeof input.code !== "string") return;
      let parsed: ReturnType<typeof parseCodemodeSource>;
      try {
        parsed = parseCodemodeSource(input.code);
      } catch {
        // Pi reports its own source error and runs nothing.
        return;
      }
      const requested = codemodeScriptBudget(input.code);
      // Leave one second for the error to reach the gateway watchdog, like gateway tools.
      const available = turnDeadlineAt === undefined
        ? requested
        : Math.max(0, (turnDeadlineAt - Date.now()) / 1000 - 1);
      const budget = Math.min(requested, available);
      const timeoutMs = Math.floor(budget * 1000);
      if (timeoutMs <= 0) return { block: true, reason: "timeout reduced to 0s: turn time limit" };
      if (requested > available) notes.set(event.toolCallId, `timeout reduced to ${Number(budget.toFixed(3))}s: turn time limit`);
      const { maxOutputTokens } = parsed.options;
      const options = {
        ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
        timeout_ms: timeoutMs,
      };
      // Without an options line, parsed.code is the whole input and needs its own line.
      const body = parsed.code === input.code ? `\n${parsed.code}` : parsed.code;
      input.code = `${CODEMODE_OPTIONS_PREFIX} ${JSON.stringify(options)}${body}`;
    });
    pi.on("tool_result", (event) => {
      const note = notes.get(event.toolCallId);
      if (!note) return;
      notes.delete(event.toolCallId);
      return { content: [...event.content, { type: "text", text: note }] };
    });
  };
}
