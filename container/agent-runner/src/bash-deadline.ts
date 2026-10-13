import {
  createBashToolDefinition,
  type ToolDefinition,
  type BashToolInput,
} from "@earendil-works/pi-coding-agent";

export function createDeadlineBashTool(
  cwd: string,
  deadlineAt: number
): ToolDefinition {
  const native = createBashToolDefinition(cwd);
  return {
    name: native.name,
    label: native.label,
    description: native.description,
    parameters: native.parameters,
    promptSnippet: native.promptSnippet,
    promptGuidelines: native.promptGuidelines,
    constrainedSampling: native.constrainedSampling,
    execute: async (id, params, signal, onUpdate, context) => {
      const args: Parameters<typeof native.execute> = [
        id,
        params as BashToolInput,
        signal,
        onUpdate,
        context,
      ];
      const requested = args[1].timeout;
      const remaining = Math.max(0, (deadlineAt - Date.now()) / 1000);
      // Leave one second for the native error to reach the gateway watchdog.
      const available = Math.max(0, remaining - 1);
      const budget =
        typeof requested === "number" &&
        Number.isFinite(requested) &&
        requested > 0
          ? requested
          : 300;
      if (available <= 0) {
        throw new Error("timeout reduced to 0s: turn time limit");
      }
      const reduced = budget > available;
      const note = `timeout reduced to ${Number(available.toFixed(3))}s: turn time limit`;
      // Missing/invalid timeouts retain native behavior unless the turn limit wins.
      args[1] = { ...args[1], ...(reduced ? { timeout: available } : {}) };
      try {
        const result = await native.execute(...args);
        return reduced
          ? {
              ...result,
              content: [
                ...result.content,
                { type: "text" as const, text: note },
              ],
            }
          : result;
      } catch (error) {
        if (!reduced) throw error;
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${note}`
        );
      }
    },
  };
}
