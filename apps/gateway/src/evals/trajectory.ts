/**
 * ATIF (Agent Trajectory Interchange Format) writer.
 *
 * Spike-level: emits a minimal ATIF-shaped JSON document. The schema is
 * documented at https://harbor.dev/docs/atif (v1.4 at time of writing).
 * Harbor validates this against its Pydantic models when collecting
 * results, so drift will fail loudly during the next harbor run and we
 * can tighten field-by-field then.
 */

import type { StreamEvent } from "@yoplai/shared";

export type AtifStep =
  | { type: "system_prompt"; content: string }
  | { type: "user_message"; content: string }
  | { type: "assistant_message"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      content: string;
      is_error: boolean;
    };

export type AtifTrajectory = {
  schema_version: "ATIF-v1.4";
  session_id: string;
  agent: {
    name: string;
    version: string;
    model: string;
  };
  steps: AtifStep[];
  status: "completed" | "error" | "aborted";
  termination_reason?: string;
  final_metrics: {
    duration_ms: number;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
};

export class TrajectoryBuilder {
  private steps: AtifStep[] = [];

  pushSystemPrompt(content: string): void {
    if (!content) return;
    this.steps.push({ type: "system_prompt", content });
  }

  pushUserMessage(content: string): void {
    this.steps.push({ type: "user_message", content });
  }

  ingestStreamEvent(event: StreamEvent): void {
    switch (event.type) {
      case "text":
        this.appendAssistantText(event.data);
        break;
      case "thinking":
        this.steps.push({ type: "thinking", content: event.data });
        break;
      case "tool_call":
        this.steps.push({
          type: "tool_call",
          id: event.id,
          name: event.name,
          arguments: event.arguments,
        });
        break;
      case "tool_result":
        this.steps.push({
          type: "tool_result",
          id: event.id,
          name: event.name,
          content: event.content,
          is_error: event.isError,
        });
        break;
      // tool_start, tool_end, done, error: not represented as ATIF steps
      default:
        break;
    }
  }

  /**
   * Coalesce consecutive `text` events into a single assistant_message
   * step. Pi/Claude both stream tokens, so we'd otherwise emit hundreds
   * of single-char steps.
   */
  private appendAssistantText(chunk: string): void {
    const last = this.steps[this.steps.length - 1];
    if (last && last.type === "assistant_message") {
      last.content += chunk;
      return;
    }
    this.steps.push({ type: "assistant_message", content: chunk });
  }

  build(args: {
    sessionId: string;
    agent: { name: string; version: string; model: string };
    status: AtifTrajectory["status"];
    terminationReason?: string;
    finalMetrics: AtifTrajectory["final_metrics"];
  }): AtifTrajectory {
    return {
      schema_version: "ATIF-v1.4",
      session_id: args.sessionId,
      agent: args.agent,
      steps: this.steps,
      status: args.status,
      termination_reason: args.terminationReason,
      final_metrics: args.finalMetrics,
    };
  }
}
