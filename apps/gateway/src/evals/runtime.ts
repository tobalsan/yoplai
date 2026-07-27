/**
 * Headless eval runtime.
 *
 * Boots the absolute minimum needed to execute one agent turn loop:
 *   - load + resolve config
 *   - load extensions
 *   - call runAgent() with an event collector
 *
 * Skipped (vs `yoplai gateway`):
 *   - HTTP server / WebSocket
 *   - HTTP routes and long-running extension services
 *   - multi-user auth
 *   - web UI
 *   - tailscale serve
 *
 * The carve-out works because `prepareStartupConfig(rawConfig, [])` already
 * accepts an empty extension list (this is what `yoplai send` does).
 */

import { loadConfig, getAgent, setLoadedConfig } from "../config/index.js";
import {
  resolveStartupConfig,
  prepareStartupConfig,
} from "../config/validate.js";
import { getExtensionRuntime, loadExtensions } from "../extensions/registry.js";
import { runAgent } from "../agents/index.js";
import type { StreamEvent } from "@yoplai/shared";
import { TrajectoryBuilder, type AtifTrajectory } from "./trajectory.js";

export type EvalToolCall = {
  id: string;
  name: string;
  arguments: unknown;
  ok: boolean;
  result?: string;
  durationMs: number;
};

export type EvalResult = {
  status: "completed" | "error";
  agent: string;
  model: string;
  finalMessage: string;
  toolCalls: EvalToolCall[];
  metrics: {
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  artifacts: Array<{ path: string; type: string }>;
  error?: string;
};

export type RunEvalOptions = {
  agentId: string;
  instruction: string;
  modelOverride?: string;
  configPath?: string;
};

export type RunEvalOutcome = {
  result: EvalResult;
  trajectory: AtifTrajectory;
};

/**
 * Aggregates a `runAgent` event stream into an EvalResult + ATIF trajectory.
 *
 * Pairs `tool_call` with the matching `tool_result` by id, tracks per-tool
 * wall-clock from `tool_start` → `tool_end`, and concatenates assistant
 * `text` events into `finalMessage`.
 */
class EventCollector {
  private finalMessage = "";
  private readonly toolCallsById = new Map<string, EvalToolCall>();
  private readonly toolStartAt = new Map<string, number>();
  private readonly toolOrder: string[] = [];
  readonly trajectory = new TrajectoryBuilder();

  ingest(event: StreamEvent): void {
    this.trajectory.ingestStreamEvent(event);

    switch (event.type) {
      case "text":
        this.finalMessage += event.data;
        break;
      case "tool_call": {
        const call: EvalToolCall = {
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          ok: false,
          durationMs: 0,
        };
        this.toolCallsById.set(event.id, call);
        this.toolOrder.push(event.id);
        break;
      }
      case "tool_start": {
        // tool_start is emitted before tool_call by some adapters; key by
        // toolName as a best-effort fallback. We only need wall-clock so
        // store under a synthetic key keyed by name+order.
        this.toolStartAt.set(event.toolName, Date.now());
        break;
      }
      case "tool_end": {
        const start = this.toolStartAt.get(event.toolName);
        if (start !== undefined) {
          // Attribute duration to the most recent matching call.
          for (let i = this.toolOrder.length - 1; i >= 0; i--) {
            const call = this.toolCallsById.get(this.toolOrder[i])!;
            if (call.name === event.toolName && call.durationMs === 0) {
              call.durationMs = Date.now() - start;
              break;
            }
          }
          this.toolStartAt.delete(event.toolName);
        }
        break;
      }
      case "tool_result": {
        const call = this.toolCallsById.get(event.id);
        if (call) {
          call.ok = !event.isError;
          call.result = event.content;
        }
        break;
      }
      default:
        break;
    }
  }

  getFinalMessage(): string {
    return this.finalMessage.trim();
  }

  getToolCalls(): EvalToolCall[] {
    return this.toolOrder.map((id) => this.toolCallsById.get(id)!);
  }
}

/**
 * Boot the minimal runtime, run the agent once, and return both an
 * EvalResult (the verifier-facing JSON) and the ATIF trajectory.
 *
 * Throws on infra errors (bad config, missing agent). Agent runtime errors
 * are captured into `result.status = "error"` rather than thrown — Harbor
 * verifier failures are the right place to differentiate.
 */
export async function runEval(opts: RunEvalOptions): Promise<RunEvalOutcome> {
  // 1. Load + resolve config (same path as `yoplai send`)
  const rawConfig = loadConfig(opts.configPath);
  const resolvedStartupConfig = await resolveStartupConfig(rawConfig);
  const extensions = await loadExtensions(resolvedStartupConfig);
  const extensionRuntime = getExtensionRuntime();
  const { resolvedConfig: config } = await prepareStartupConfig(
    rawConfig,
    extensions,
    { resolvedConfig: resolvedStartupConfig }
  );
  setLoadedConfig(config);

  // 2. Resolve agent (infra error if not found)
  const agent = getAgent(opts.agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${opts.agentId}`);
  }

  if (opts.modelOverride && !agent.model.provider) {
    throw new Error(
      `Cannot override model for agent ${agent.id}: configured model has no provider`
    );
  }
  const model = opts.modelOverride
    ? { provider: agent.model.provider!, model: opts.modelOverride }
    : undefined;

  // 3. Run the agent, collecting events
  const collector = new EventCollector();
  collector.trajectory.pushUserMessage(opts.instruction);

  const startedAt = Date.now();
  let runError: Error | undefined;
  let runDurationMs = 0;
  let sessionId = "eval";

  try {
    const runResult = await runAgent({
      agentId: agent.id,
      message: opts.instruction,
      // Each eval invocation is a fresh single-turn session.
      sessionId: `eval-${Date.now()}`,
      extensionRuntime,
      model,
      source: "cli",
      onEvent: (event) => collector.ingest(event),
    });
    runDurationMs = runResult.meta.durationMs;
    sessionId = runResult.meta.sessionId;
  } catch (err) {
    runError = err instanceof Error ? err : new Error(String(err));
    runDurationMs = Date.now() - startedAt;
  }

  // 4. Build EvalResult + ATIF trajectory
  const status = runError ? "error" : "completed";
  const modelName = `${model?.provider ?? agent.model.provider}/${model?.model ?? agent.model.model}`;

  const result: EvalResult = {
    status,
    agent: agent.id,
    model: modelName,
    finalMessage: collector.getFinalMessage(),
    toolCalls: collector.getToolCalls(),
    metrics: {
      durationMs: runDurationMs,
      // TODO: pull token + cost from adapter result once exposed on
      // RunAgentResult.meta. Spike leaves these as zero.
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    },
    artifacts: [],
    ...(runError ? { error: runError.message } : {}),
  };

  const trajectory = collector.trajectory.build({
    sessionId,
    agent: {
      name: agent.id,
      version: "0.1.0",
      model: modelName,
    },
    status,
    terminationReason: runError?.message,
    finalMetrics: {
      duration_ms: runDurationMs,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
    },
  });

  return { result, trajectory };
}
