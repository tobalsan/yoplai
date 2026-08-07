import Langfuse from "langfuse";

import {
  sanitizeForStorage,
  type AgentHistoryEvent,
  type AgentStreamEvent,
} from "@yoplai/shared";
import type { GenerationState, SpanState, TraceState } from "./types.js";

const IDLE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const TRACE_IDLE_TTL_MS = 30 * 60 * 1000;

type TracedStreamEvent = Extract<
  AgentStreamEvent,
  { type: "text" | "thinking" | "done" | "error" }
>;

type TracedHistoryEvent = Extract<
  AgentHistoryEvent,
  | { type: "system_context" }
  | { type: "system_prompt" }
  | { type: "tool_call" | "tool_result" | "meta" | "user" | "turn_end" }
>;

type GenerationUpdate = Parameters<GenerationState["generation"]["update"]>[0];
type SpanEnd = NonNullable<Parameters<SpanState["span"]["end"]>[0]>;

export type LangfuseTracerConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  flushAt?: number;
  flushInterval?: number;
  debug?: boolean;
  environment?: string;
};

function toSurface(event: AgentStreamEvent | AgentHistoryEvent): string {
  if (event.trace?.surface) return event.trace.surface;
  if (event.sessionKey?.startsWith("project:")) return "project";
  if (event.sessionKey?.startsWith("webhook:")) return "webhook";
  return "chat";
}

export class LangfuseTracer {
  private langfuse: Langfuse | null = null;
  private idleCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly traces = new Map<string, TraceState>();

  constructor(private readonly config: LangfuseTracerConfig) {}

  start(): void {
    if (this.langfuse) return;

    this.langfuse = new Langfuse({
      publicKey: this.config.publicKey,
      secretKey: this.config.secretKey,
      baseUrl: this.config.baseUrl,
      flushAt: this.config.flushAt,
      flushInterval: this.config.flushInterval,
      environment: this.config.environment,
    });

    this.idleCleanupInterval = setInterval(
      () => void this.cleanupIdleTraces(),
      IDLE_CLEANUP_INTERVAL_MS
    );
  }

  async stop(): Promise<void> {
    if (this.idleCleanupInterval) {
      clearInterval(this.idleCleanupInterval);
      this.idleCleanupInterval = null;
    }

    for (const [key, state] of this.traces) {
      this.finalizeGeneration(state);
      this.finalizeTrace(state);
      this.traces.delete(key);
    }

    const langfuse = this.langfuse;
    if (langfuse) {
      await this.flushLangfuse(langfuse);
      await this.shutdownLangfuse(langfuse);
      this.langfuse = null;
    }
  }

  async handleStreamEvent(event: AgentStreamEvent): Promise<void> {
    event = sanitizeForStorage(event);
    if (!this.langfuse) return;
    if (event.trace?.enabled === false) return;
    if (!isTracedStreamEvent(event)) return;

    const trace = this.getTrace(event);
    trace.lastActivity = Date.now();

    switch (event.type) {
      case "text": {
        const generation = this.getGeneration(trace, event);
        generation.output.push(event.data);
        trace.output.push(event.data);
        break;
      }
      case "thinking": {
        const generation = this.getGeneration(trace, event);
        generation.thinking.push(event.data);
        break;
      }
      case "done":
        this.finalizeGeneration(trace);
        this.finalizeTrace(trace);
        this.removeTrace(trace, event);
        await this.flushLangfuse();
        break;
      case "error":
        this.finalizeGeneration(trace, event.message);
        this.finalizeTrace(trace);
        this.removeTrace(trace, event);
        await this.flushLangfuse();
        break;
      default:
        break;
    }
  }

  handleHistoryEvent(event: AgentHistoryEvent): void {
    event = sanitizeForStorage(event);
    if (!this.langfuse) return;
    if (event.trace?.enabled === false) return;
    if (!isTracedHistoryEvent(event)) return;

    const trace =
      event.type === "tool_result"
        ? this.traces.get(this.traceKey(event))
        : this.getTrace(event);
    if (!trace) return;

    trace.lastActivity = Date.now();

    switch (event.type) {
      case "system_context":
        trace.trace.update({
          metadata: {
            source: event.source,
            sessionKey: event.sessionKey,
            surface: toSurface(event),
            channelContext: event.context,
            channelContextRendered: event.rendered,
            ...event.trace?.metadata,
          },
        });
        break;
      case "system_prompt":
        this.setSystemPrompt(trace, event.text);
        break;
      case "user":
        this.setUserInput(trace, event.text);
        break;
      case "turn_end":
        // Finalize current generation so next text/thinking starts a fresh one.
        // The trace stays open until "done" stream event.
        this.finalizeGeneration(trace);
        break;
      case "tool_call": {
        const generation = this.getGeneration(trace, event);
        const span = generation.generation.span({
          name: event.name,
          input: event.args,
          metadata: {
            toolCallId: event.id,
          },
        });
        generation.openSpans.set(event.id, {
          span,
          id: event.id,
          name: event.name,
          input: event.args,
          startedAt: event.timestamp,
        });
        break;
      }
      case "tool_result": {
        const generation = trace.currentGeneration;
        const span = generation?.openSpans.get(event.id);
        if (!generation || !span) return;

        const end: SpanEnd = {
          output: event.content,
          level: event.isError ? "ERROR" : "DEFAULT",
          statusMessage: event.isError ? event.content : undefined,
          metadata: {
            toolCallId: event.id,
            toolName: event.name,
            details: event.details,
          },
        };
        span.span.end(end);
        generation.openSpans.delete(event.id);
        break;
      }
      case "meta": {
        const generation = this.getGeneration(trace, event);
        generation.model = event.model;
        generation.provider = event.provider;
        generation.usage = event.usage;
        generation.stopReason = event.stopReason;
        break;
      }
      default:
        break;
    }
  }

  private getTrace(event: AgentStreamEvent | AgentHistoryEvent): TraceState {
    const key = this.traceKey(event);
    const existing = this.traces.get(key);
    if (existing) return existing;

    if (!this.langfuse) {
      throw new Error("Langfuse tracer is not started");
    }

    const surface = toSurface(event);
    const traceName = event.trace?.name ?? `yoplai:${surface}:${event.agentId}`;

    const trace = this.langfuse.trace({
      name: traceName,
      sessionId: event.sessionId,
      input: undefined,
      output: undefined,
      metadata: {
        source: event.source,
        sessionKey: event.sessionKey,
        surface,
        ...event.trace?.metadata,
      },
    });
    const state: TraceState = {
      trace,
      lastActivity: Date.now(),
      output: [],
    };
    this.traces.set(key, state);
    return state;
  }

  private getGeneration(
    trace: TraceState,
    event: AgentStreamEvent | AgentHistoryEvent
  ): GenerationState {
    if (trace.currentGeneration) return trace.currentGeneration;

    const metadata = trace.pendingSystemPrompt
      ? { systemPrompt: trace.pendingSystemPrompt }
      : undefined;
    const generation = trace.trace.generation({
      name: "llm-turn",
      input: buildGenerationInput(
        trace.pendingSystemPrompt,
        trace.pendingUserInput
      ),
      metadata: {
        source: event.source,
        sessionKey: event.sessionKey,
        ...(metadata ?? {}),
      },
    });
    trace.currentGeneration = {
      generation,
      openSpans: new Map(),
      output: [],
      thinking: [],
      metadata,
      systemPrompt: trace.pendingSystemPrompt,
      userInput: trace.pendingUserInput,
    };
    trace.pendingSystemPrompt = undefined;
    trace.pendingUserInput = undefined;
    return trace.currentGeneration;
  }

  private setUserInput(trace: TraceState, input: string): void {
    trace.trace.update({ input });
    if (trace.currentGeneration) {
      trace.currentGeneration.userInput = input;
      trace.currentGeneration.generation.update({
        input: buildGenerationInput(
          trace.currentGeneration.systemPrompt,
          input
        ),
      });
      return;
    }
    trace.pendingUserInput = input;
  }

  private setSystemPrompt(trace: TraceState, prompt: string): void {
    if (trace.currentGeneration) {
      trace.currentGeneration.systemPrompt = prompt;
      trace.currentGeneration.metadata = {
        ...(trace.currentGeneration.metadata ?? {}),
        systemPrompt: prompt,
      };
      trace.currentGeneration.generation.update({
        input: buildGenerationInput(prompt, trace.currentGeneration.userInput),
        metadata: trace.currentGeneration.metadata,
      });
      return;
    }
    trace.pendingSystemPrompt = prompt;
  }

  private finalizeGeneration(trace: TraceState, errorMessage?: string): void {
    const generation = trace.currentGeneration;
    if (!generation) return;

    this.closeOpenSpans(generation);

    const thinking = generation.thinking.join("");
    const metadata: Record<string, unknown> = {
      ...(generation.metadata ?? {}),
      thinking: thinking || undefined,
    };
    if (generation.provider) metadata.provider = generation.provider;
    if (generation.stopReason) metadata.stopReason = generation.stopReason;

    const update: GenerationUpdate = {
      output: generation.output.join(""),
      metadata,
      level: errorMessage ? "ERROR" : "DEFAULT",
      statusMessage: errorMessage,
    };
    const input = buildGenerationInput(
      generation.systemPrompt,
      generation.userInput
    );
    if (input !== undefined) update.input = input;
    if (generation.model) update.model = generation.model;
    const usageDetails = toUsageDetails(generation.usage);
    if (usageDetails) update.usageDetails = usageDetails;

    generation.generation.update(update);
    generation.generation.end();
    trace.currentGeneration = undefined;
  }

  private finalizeTrace(trace: TraceState): void {
    const output = trace.output.join("");
    trace.trace.update({
      output: output || undefined,
    });
  }

  private removeTrace(
    _trace: TraceState,
    event: AgentStreamEvent | AgentHistoryEvent
  ): void {
    const key = this.traceKey(event);
    this.traces.delete(key);
  }

  private closeOpenSpans(generation: GenerationState): void {
    for (const span of generation.openSpans.values()) {
      span.span.end({
        level: "WARNING",
        statusMessage: "Tool result missing",
      });
    }
    generation.openSpans.clear();
  }

  private async cleanupIdleTraces(): Promise<void> {
    const cutoff = Date.now() - TRACE_IDLE_TTL_MS;
    let removedTrace = false;

    for (const [key, state] of this.traces) {
      if (state.lastActivity >= cutoff) continue;

      this.finalizeGeneration(state);
      this.finalizeTrace(state);
      this.traces.delete(key);
      removedTrace = true;
    }

    if (removedTrace) {
      await this.flushLangfuse();
    }
  }

  private async flushLangfuse(langfuse = this.langfuse): Promise<void> {
    if (!langfuse) return;

    try {
      await langfuse.flushAsync();
    } catch (error) {
      console.warn("[langfuse] flushAsync failed", sanitizeForStorage(error));
    }
  }

  private async shutdownLangfuse(langfuse: Langfuse): Promise<void> {
    try {
      await langfuse.shutdownAsync();
    } catch (error) {
      console.warn("[langfuse] shutdownAsync failed", sanitizeForStorage(error));
    }
  }

  private traceKey(event: AgentStreamEvent | AgentHistoryEvent): string {
    return `${event.agentId}:${event.sessionId}`;
  }
}

type LangfuseChatMessage = {
  role: "system" | "user";
  content: string;
};

function buildGenerationInput(
  systemPrompt: string | undefined,
  userInput: string | undefined
): LangfuseChatMessage[] | undefined {
  const messages: LangfuseChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  if (userInput) {
    messages.push({ role: "user", content: userInput });
  }
  return messages.length > 0 ? messages : undefined;
}

function toUsageDetails(
  usage: GenerationState["usage"]
): Record<string, number> | undefined {
  if (!usage) return undefined;

  const details: Record<string, number> = {
    input: usage.input,
    output: usage.output,
    total: usage.totalTokens,
  };
  if (usage.cacheRead !== undefined) details.cacheRead = usage.cacheRead;
  if (usage.cacheWrite !== undefined) details.cacheWrite = usage.cacheWrite;
  return details;
}

function isTracedStreamEvent(
  event: AgentStreamEvent
): event is TracedStreamEvent {
  return (
    event.type === "text" ||
    event.type === "thinking" ||
    event.type === "done" ||
    event.type === "error"
  );
}

function isTracedHistoryEvent(
  event: AgentHistoryEvent
): event is TracedHistoryEvent {
  return (
    event.type === "system_context" ||
    event.type === "system_prompt" ||
    event.type === "tool_call" ||
    event.type === "tool_result" ||
    event.type === "meta" ||
    event.type === "user" ||
    event.type === "turn_end"
  );
}
