import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { claimAgentToolName, type ContainerInput } from "@yoplai/shared";
import { callGatewayTool, RunCancelledError } from "./gateway-client.js";
import type { CodemodeLimiter } from "./codemode-limiter.js";

export interface GatewayToolControls {
  onRunCancelled?: () => void;
  limiter?: CodemodeLimiter;
}

export function gatewayTool(
  input: ContainerInput,
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  usedToolNames: Set<string>,
  formatResult: (result: unknown, toolCallId: string) => Promise<string>,
  gatewayName = name,
  outputSchema?: Record<string, unknown>,
  controls: GatewayToolControls = {}
): ToolDefinition {
  const modelToolName = claimAgentToolName(name, usedToolNames);
  const schema = parameters as {
    properties?: Record<string, unknown>;
    required?: string[];
  };
  return {
    name: modelToolName,
    label,
    description,
    promptSnippet: description,
    outputSchema: outputSchema as ToolDefinition["outputSchema"],
    parameters: {
      ...schema,
      ...(schema.required
        ? { required: schema.required.filter((key) => key !== "timeout") }
        : {}),
      properties: {
        ...schema.properties,
        timeout: {
          type: "number",
          description: "Max seconds this call may take; default 300",
        },
      },
    } as ToolDefinition["parameters"],
    execute: async (toolCallId, params, sdkSignal) => {
      const { timeout, ...args } = params as Record<string, unknown>;
      const requested =
        typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? timeout
          : 300;
      const available =
        input.turnDeadlineAt === undefined
          ? requested
          : Math.max(0, (input.turnDeadlineAt - Date.now()) / 1000 - 1);
      if (available <= 0)
        throw new Error("timeout reduced to 0s: turn time limit");
      const budget = Math.min(requested, available);
      const note =
        requested > available
          ? `\ntimeout reduced to ${Number(budget.toFixed(3))}s: turn time limit`
          : "";
      const deadlineController = new AbortController();
      const deadline = deadlineController.signal;
      const started = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const schedule = () => {
        const remaining = budget * 1000 - (performance.now() - started);
        if (remaining <= 0) {
          deadlineController.abort(
            new DOMException("Tool deadline expired", "TimeoutError")
          );
          return;
        }
        // Node timers overflow above 2^31-1ms; long agent budgets have no cap.
        timer = setTimeout(
          schedule,
          Math.min(Math.ceil(remaining), 2 ** 31 - 1)
        );
        timer.unref();
      };
      schedule();
      const signal = sdkSignal
        ? AbortSignal.any([sdkSignal, deadline])
        : deadline;
      let release: (() => void) | undefined;
      try {
        if (controls.limiter) release = await controls.limiter.acquire(toolCallId, signal);
        signal.throwIfAborted();
        const result = await callGatewayTool(
          input.gatewayUrl,
          input.agentToken,
          gatewayName,
          args,
          input.agentId,
          input.sessionId,
          input.runId,
          {
            socketPath: input.gatewaySocketPath,
            toolCallId,
            timeoutSeconds: budget,
            modelToolName,
            signal,
          }
        );
        signal.throwIfAborted();
        const text = await formatResult(result, toolCallId);
        signal.throwIfAborted();
        return {
          content: [{ type: "text", text: text + note }],
          details: result,
          ...(outputSchema ? {
            structuredContent: JSON.parse(JSON.stringify(result ?? null)),
            isError: typeof result === "object" && result !== null && !Array.isArray(result) &&
              "isError" in result && result.isError === true ? true : undefined,
          } : {}),
        };
      } catch (error) {
        if (error instanceof RunCancelledError) {
          controls.onRunCancelled?.();
          throw error;
        }
        if (sdkSignal?.aborted && signal.reason === sdkSignal.reason)
          throw sdkSignal.reason;
        const message = deadline.aborted
          ? `tool ${modelToolName} timed out after ${Number(budget.toFixed(3))}s`
          : error instanceof Error
            ? error.message
            : String(error);
        throw new Error(message + note);
      } finally {
        clearTimeout(timer);
        release?.();
      }
    },
  };
}
