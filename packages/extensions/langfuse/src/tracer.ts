import {
  ROOT_CONTEXT,
  context,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  LangfuseOtelSpanAttributes,
  setLangfuseTracerProvider,
  startObservation,
  type LangfuseGenerationAttributes,
  type LangfuseSpanAttributes,
} from "@langfuse/tracing";

import {
  sanitizeForStorage,
  type AgentContext,
  type AgentHistoryEvent,
  type AgentStreamEvent,
} from "@yoplai/shared";
import type { GenerationState, TraceState } from "./types.js";

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

export type LangfuseTracerConfig = {
  publicKey: string;
  secretKey: string;
  baseUrl?: string;
  flushAt?: number;
  flushInterval?: number;
  debug?: boolean;
  environment?: string;
  /** Test hook: replace the OTLP exporter (e.g. with an in-memory exporter). */
  exporter?: SpanExporter;
};

function toSurface(event: AgentStreamEvent | AgentHistoryEvent): string {
  if (event.trace?.surface) return event.trace.surface;
  if (event.sessionKey?.startsWith("project:")) return "project";
  if (event.sessionKey?.startsWith("webhook:")) return "webhook";
  return "chat";
}

function contextAttributes(context: AgentContext): {
  userId?: string;
  tags?: string[];
} {
  if (context.kind === "web") {
    return { userId: context.name, tags: ["channel:web"] };
  }
  const tags = [`channel:${context.kind}`];
  for (const block of context.blocks) {
    if (block.type === "metadata") {
      return { userId: block.sender, tags: [...tags, `place:${block.place}`] };
    }
  }
  return { tags };
}

export class LangfuseTracer {
  private provider: NodeTracerProvider | null = null;
  private idleCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private readonly traces = new Map<string, TraceState>();

  constructor(private readonly config: LangfuseTracerConfig) {}

  start(): void {
    if (this.provider) return;
    if (!this.config.publicKey || !this.config.secretKey) {
      console.warn("[langfuse] missing publicKey/secretKey; tracing disabled");
      return;
    }

    // Private provider: never registered globally, so other OTel
    // instrumentation in the gateway is untouched. setLangfuseTracerProvider
    // only scopes the provider inside the @langfuse/tracing module.
    this.provider = new NodeTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: this.config.publicKey,
          secretKey: this.config.secretKey,
          baseUrl: this.config.baseUrl,
          flushAt: this.config.flushAt,
          // Legacy config is in milliseconds (langfuse v3); v5 takes seconds.
          flushInterval:
            this.config.flushInterval === undefined
              ? undefined
              : this.config.flushInterval / 1000,
          environment: this.config.environment,
          exporter: this.config.exporter,
        }),
      ],
    });
    setLangfuseTracerProvider(this.provider);

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

    const provider = this.provider;
    if (provider) {
      await this.flushLangfuse(provider);
      await this.shutdownLangfuse(provider);
      setLangfuseTracerProvider(null);
      this.provider = null;
    }
  }

  async handleStreamEvent(event: AgentStreamEvent): Promise<void> {
    event = sanitizeForStorage(event);
    if (!this.provider) return;
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
    if (!this.provider) return;
    if (event.trace?.enabled === false) return;
    if (!isTracedHistoryEvent(event)) return;

    const trace =
      event.type === "tool_result"
        ? this.traces.get(this.traceKey(event))
        : this.getTrace(event);
    if (!trace) return;

    trace.lastActivity = Date.now();

    switch (event.type) {
      case "system_context": {
        const { userId, tags } = contextAttributes(event.context);
        trace.userId = userId;
        trace.tags = tags;
        if (userId) {
          trace.trace.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_USER_ID,
            userId
          );
        }
        if (tags) {
          trace.trace.otelSpan.setAttribute(
            LangfuseOtelSpanAttributes.TRACE_TAGS,
            tags
          );
        }
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
      }
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
        const span = this.startObservationFor(trace, () =>
          startObservation(
            event.name,
            { input: event.args, metadata: { toolCallId: event.id } },
            {
              asType: "tool",
              parentSpanContext: generation.generation.otelSpan.spanContext(),
            }
          )
        );
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

        const end: LangfuseSpanAttributes = {
          output: event.content,
          level: event.isError ? "ERROR" : "DEFAULT",
          statusMessage: event.isError ? event.content : undefined,
          metadata: {
            toolCallId: event.id,
            toolName: event.name,
            details: event.details,
          },
        };
        span.span.update(end).end();
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

    if (!this.provider) {
      throw new Error("Langfuse tracer is not started");
    }

    const surface = toSurface(event);
    const traceName = event.trace?.name ?? `yoplai:${surface}:${event.agentId}`;
    const rawSessionId = event.sessionId.startsWith(`${surface}:`)
      ? event.sessionId.slice(surface.length + 1)
      : event.sessionId;
    const sessionId = `yoplai:${surface}:${event.agentId}:${rawSessionId}`;

    const state: Omit<TraceState, "trace"> = {
      traceName,
      sessionId,
      propagatedMetadata: stringEntries({
        source: event.source,
        sessionKey: event.sessionKey,
        surface,
      }),
      lastActivity: Date.now(),
      output: [],
    };
    // Root observation = the Langfuse trace. Start from ROOT_CONTEXT so an
    // unrelated active span from other gateway instrumentation can't adopt it.
    const root = this.startObservationFor(state, () =>
      startObservation(traceName, {
        metadata: {
          source: event.source,
          sessionKey: event.sessionKey,
          surface,
          ...event.trace?.metadata,
        },
      })
    );
    const traceState: TraceState = { ...state, trace: root };
    this.traces.set(key, traceState);
    return traceState;
  }

  private getGeneration(
    trace: TraceState,
    event: AgentStreamEvent | AgentHistoryEvent
  ): GenerationState {
    if (trace.currentGeneration) return trace.currentGeneration;

    const metadata = trace.pendingSystemPrompt
      ? { systemPrompt: trace.pendingSystemPrompt }
      : undefined;
    const parent = trace.trace.otelSpan.spanContext();
    const generation = this.startObservationFor(trace, () =>
      startObservation(
        "llm-turn",
        {
          input: buildGenerationInput(
            trace.pendingSystemPrompt,
            trace.pendingUserInput
          ),
          metadata: {
            source: event.source,
            sessionKey: event.sessionKey,
            ...(metadata ?? {}),
          },
        },
        { asType: "generation", parentSpanContext: parent }
      )
    );
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
    trace.trace.setTraceIO({ input });
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

    const update: LangfuseGenerationAttributes = {
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

    generation.generation.update(update).end();
    trace.currentGeneration = undefined;
  }

  private finalizeTrace(trace: TraceState): void {
    const output = trace.output.join("") || undefined;
    trace.trace.update({ output });
    trace.trace.setTraceIO({ output });
    trace.trace.end();
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
      span.span
        .update({ level: "WARNING", statusMessage: "Tool result missing" })
        .end();
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

  /**
   * Creates an observation and stamps sessionId/userId/tags/traceName/metadata
   * on it client-side (Langfuse v4 no longer copies trace attributes to
   * observations server-side). Attributes are set directly on the span rather
   * than via propagateAttributes, which needs a global OTel context manager
   * we deliberately don't register. Starts from ROOT_CONTEXT so an active span
   * from other gateway instrumentation can't adopt our trace; parenting is
   * explicit via parentSpanContext.
   */
  private startObservationFor<T extends { otelSpan: Span }>(
    trace: Pick<
      TraceState,
      "sessionId" | "traceName" | "userId" | "tags" | "propagatedMetadata"
    >,
    create: () => T
  ): T {
    const observation = context.with(ROOT_CONTEXT, create);
    const attributes: Attributes = {
      [LangfuseOtelSpanAttributes.TRACE_SESSION_ID]: trace.sessionId,
      [LangfuseOtelSpanAttributes.TRACE_NAME]: trace.traceName,
    };
    if (trace.userId) {
      attributes[LangfuseOtelSpanAttributes.TRACE_USER_ID] = trace.userId;
    }
    if (trace.tags)
      attributes[LangfuseOtelSpanAttributes.TRACE_TAGS] = trace.tags;
    for (const [key, value] of Object.entries(trace.propagatedMetadata)) {
      attributes[`${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`] = value;
    }
    observation.otelSpan.setAttributes(attributes);
    return observation;
  }

  private async flushLangfuse(provider = this.provider): Promise<void> {
    if (!provider) return;

    try {
      await provider.forceFlush();
    } catch (error) {
      console.warn("[langfuse] flush failed", sanitizeForStorage(error));
    }
  }

  private async shutdownLangfuse(provider: NodeTracerProvider): Promise<void> {
    try {
      await provider.shutdown();
    } catch (error) {
      console.warn("[langfuse] shutdown failed", sanitizeForStorage(error));
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

function stringEntries(
  record: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
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
