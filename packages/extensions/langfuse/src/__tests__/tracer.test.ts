import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHistoryEvent, AgentStreamEvent } from "@yoplai/shared";
import { LangfuseTracer } from "../tracer.js";

const langfuseMock = vi.hoisted(() => {
  type MockGeneration = {
    args: unknown;
    update: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    span: ReturnType<typeof vi.fn>;
    spans: MockSpan[];
  };
  type MockSpan = {
    args: unknown;
    update: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  type MockTrace = {
    args: unknown;
    generation: ReturnType<typeof vi.fn>;
    span: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    generations: MockGeneration[];
    spans: MockSpan[];
  };
  type MockLangfuse = {
    config: unknown;
    trace: ReturnType<typeof vi.fn>;
    flushAsync: ReturnType<typeof vi.fn>;
    shutdownAsync: ReturnType<typeof vi.fn>;
  };

  const instances: MockLangfuse[] = [];
  const traces: MockTrace[] = [];
  const generations: MockGeneration[] = [];
  const spans: MockSpan[] = [];

  const Langfuse = vi.fn(function (this: MockLangfuse, config: unknown) {
    this.config = config;
    this.trace = vi.fn((args: unknown) => {
      const trace: MockTrace = {
        args,
        generations: [],
        spans: [],
        update: vi.fn(),
        generation: vi.fn((generationArgs: unknown) => {
          const generation: MockGeneration = {
            args: generationArgs,
            update: vi.fn(),
            end: vi.fn(),
            spans: [],
            span: vi.fn((spanArgs: unknown) => {
              const span: MockSpan = {
                args: spanArgs,
                update: vi.fn(),
                end: vi.fn(),
              };
              generation.spans.push(span);
              spans.push(span);
              return span;
            }),
          };
          trace.generations.push(generation);
          generations.push(generation);
          return generation;
        }),
        span: vi.fn((spanArgs: unknown) => {
          const span: MockSpan = {
            args: spanArgs,
            update: vi.fn(),
            end: vi.fn(),
          };
          trace.spans.push(span);
          spans.push(span);
          return span;
        }),
      };
      traces.push(trace);
      return trace;
    });
    this.flushAsync = vi.fn(async () => undefined);
    this.shutdownAsync = vi.fn(async () => undefined);
    instances.push(this);
  });

  return { Langfuse, generations, instances, spans, traces };
});

vi.mock("langfuse", () => ({ default: langfuseMock.Langfuse }));

const tracerConfig = {
  publicKey: "pk-test",
  secretKey: "sk-test",
  baseUrl: "https://langfuse.test",
  flushAt: 2,
  flushInterval: 100,
  environment: "dev",
};

describe("LangfuseTracer", () => {
  beforeEach(() => {
    vi.useRealTimers();
    langfuseMock.Langfuse.mockClear();
    langfuseMock.instances.length = 0;
    langfuseMock.traces.length = 0;
    langfuseMock.generations.length = 0;
    langfuseMock.spans.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one trace and one generation for a basic text turn", async () => {
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "Hello" })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: " world" })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(langfuseMock.Langfuse).toHaveBeenCalledWith({
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://langfuse.test",
      flushAt: 2,
      flushInterval: 100,
      environment: "dev",
    });
    expect(langfuseMock.traces).toHaveLength(1);
    expect(langfuseMock.traces[0]?.generation).toHaveBeenCalledTimes(1);
    expect(langfuseMock.generations[0]?.update).toHaveBeenCalledWith({
      output: "Hello world",
      metadata: { thinking: undefined },
      level: "DEFAULT",
      statusMessage: undefined,
    });
    expect(langfuseMock.generations[0]?.end).toHaveBeenCalledTimes(1);

    // Trace should have output set via finalizeTrace
    expect(langfuseMock.traces[0]?.update).toHaveBeenCalledWith({
      output: "Hello world",
    });

    await tracer.stop();
  });

  it("names traces as yoplai:<surface>:<agentId>", async () => {
    const tracer = startTracer();

    // Chat surface (default sessionKey)
    await tracer.handleStreamEvent(
      streamEvent(
        { type: "text", data: "chat msg" },
        { sessionId: "session-chat" }
      )
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "done" }, { sessionId: "session-chat" })
    );

    expect(langfuseMock.traces[0]?.args).toEqual(
      expect.objectContaining({ name: "yoplai:chat:agent-1" })
    );

    // Project surface
    await tracer.handleStreamEvent(
      streamEvent(
        { type: "text", data: "project msg" },
        { sessionKey: "project:PRO-1:lead" }
      )
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "done" }, { sessionKey: "project:PRO-1:lead" })
    );

    expect(langfuseMock.traces[1]?.args).toEqual(
      expect.objectContaining({ name: "yoplai:project:agent-1" })
    );

    await tracer.stop();
  });

  it("uses explicit webhook trace context and metadata", async () => {
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent(
        { type: "text", data: "webhook msg" },
        {
          sessionKey: "webhook:agent-1:notion:req-1",
          source: "webhook",
          trace: {
            name: "yoplai:webhook:agent-1",
            surface: "webhook",
            metadata: {
              webhookName: "notion",
              sourceUrl: "http://localhost/hooks/agent-1/notion/secret",
            },
          },
        }
      )
    );
    await tracer.handleStreamEvent(
      streamEvent(
        { type: "done" },
        {
          sessionKey: "webhook:agent-1:notion:req-1",
          source: "webhook",
          trace: {
            name: "yoplai:webhook:agent-1",
            surface: "webhook",
            metadata: { webhookName: "notion" },
          },
        }
      )
    );

    expect(langfuseMock.traces[0]?.args).toEqual(
      expect.objectContaining({
        name: "yoplai:webhook:agent-1",
        metadata: expect.objectContaining({
          source: "webhook",
          surface: "webhook",
          sessionKey: "webhook:agent-1:notion:req-1",
          webhookName: "notion",
          sourceUrl: "http://localhost/hooks/agent-1/notion/secret",
        }),
      })
    );

    await tracer.stop();
  });

  it("skips events with disabled trace context", async () => {
    const tracer = startTracer();

    tracer.handleHistoryEvent(
      historyEvent(
        { type: "user", text: "hello", timestamp: 1 },
        { trace: { enabled: false } }
      )
    );
    await tracer.handleStreamEvent(
      streamEvent(
        { type: "text", data: "answer" },
        { trace: { enabled: false } }
      )
    );

    expect(langfuseMock.traces).toHaveLength(0);

    await tracer.stop();
  });

  it("sets trace input from user history event", async () => {
    const tracer = startTracer();

    tracer.handleHistoryEvent(
      historyEvent({ type: "user", text: "hello", timestamp: 1 })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "answer" })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    // Trace-level input should be set from user event
    expect(langfuseMock.traces[0]?.update).toHaveBeenCalledWith({
      input: "hello",
    });

    await tracer.stop();
  });

  it("creates generation child spans from tool calls and results", async () => {
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "running" })
    );
    tracer.handleHistoryEvent(
      historyEvent({
        type: "tool_call",
        id: "tool-1",
        name: "bash",
        args: { cmd: "pwd" },
        timestamp: 1,
      })
    );
    tracer.handleHistoryEvent(
      historyEvent({
        type: "tool_result",
        id: "tool-1",
        name: "bash",
        content: "/tmp/project",
        isError: false,
        timestamp: 2,
      })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(langfuseMock.traces[0]?.span).not.toHaveBeenCalled();
    expect(langfuseMock.generations[0]?.span).toHaveBeenCalledWith({
      name: "bash",
      input: { cmd: "pwd" },
      metadata: { toolCallId: "tool-1" },
    });
    expect(langfuseMock.spans[0]?.end).toHaveBeenCalledWith({
      output: "/tmp/project",
      level: "DEFAULT",
      statusMessage: undefined,
      metadata: {
        toolCallId: "tool-1",
        toolName: "bash",
        details: undefined,
      },
    });

    await tracer.stop();
  });

  it("redacts serialized tool payloads before Langfuse export", async () => {
    const tracer = startTracer();
    const canary = "canary-private-value";

    await tracer.handleStreamEvent(streamEvent({ type: "text", data: "running" }));
    tracer.handleHistoryEvent(
      historyEvent({
        type: "tool_call",
        id: "tool-1",
        name: "download",
        args: {
          url: `https://files.example.test/report.csv?X-Amz-Signature=${canary}`,
          authorization: `Bearer ${canary}`,
        },
        timestamp: 1,
      })
    );
    tracer.handleHistoryEvent(
      historyEvent({
        type: "tool_result",
        id: "tool-1",
        name: "download",
        content: `Authorization: Bearer ${canary}-result`,
        details: {
          diff: `https://files.example.test/report.csv?X-Amz-Credential=${canary}-details`,
        },
        isError: true,
        timestamp: 2,
      })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "error", message: `access_token=${canary}-error` })
    );

    expect(JSON.stringify(langfuseMock.generations)).not.toContain(canary);
    expect(JSON.stringify(langfuseMock.spans)).not.toContain(canary);
    await tracer.stop();
  });

  it("stores meta model and usage on the generation", async () => {
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "answer" })
    );
    tracer.handleHistoryEvent(
      historyEvent({
        type: "meta",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 2,
          totalTokens: 17,
        },
        stopReason: "end_turn",
        timestamp: 3,
      })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(langfuseMock.generations[0]?.update).toHaveBeenCalledWith({
      output: "answer",
      metadata: {
        thinking: undefined,
        provider: "anthropic",
        stopReason: "end_turn",
      },
      level: "DEFAULT",
      statusMessage: undefined,
      model: "claude-sonnet-4-5",
      usageDetails: {
        input: 10,
        output: 5,
        total: 17,
        cacheRead: 2,
      },
    });

    await tracer.stop();
  });

  it("stores user history text as generation input", async () => {
    const tracer = startTracer();

    tracer.handleHistoryEvent(
      historyEvent({ type: "user", text: "hello", timestamp: 1 })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "answer" })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(langfuseMock.generations[0]?.args).toEqual(
      expect.objectContaining({
        input: [{ role: "user", content: "hello" }],
      })
    );
    expect(langfuseMock.generations[0]?.update).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ role: "user", content: "hello" }],
      })
    );

    await tracer.stop();
  });

  it("stores system prompt on the trace and generation", async () => {
    const tracer = startTracer();

    tracer.handleHistoryEvent(
      historyEvent({
        type: "system_prompt",
        text: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
        timestamp: 1,
      })
    );
    tracer.handleHistoryEvent(
      historyEvent({
        type: "system_context",
        rendered: "[CHANNEL CONTEXT]\nchannel: slack",
        context: {
          kind: "slack",
          blocks: [
            {
              type: "metadata",
              channel: "slack",
              place: "direct message / Thinh",
              conversationType: "direct_message",
              sender: "Thinh",
            },
          ],
        },
        timestamp: 1,
      })
    );
    tracer.handleHistoryEvent(
      historyEvent({ type: "user", text: "hello", timestamp: 2 })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "answer" })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(langfuseMock.traces[0]?.update).toHaveBeenCalledWith({
      input: "hello",
    });
    expect(langfuseMock.traces[0]?.update).toHaveBeenCalledWith({
      userId: "Thinh",
      tags: ["channel:slack", "place:direct message / Thinh"],
      metadata: {
        source: "web",
        sessionKey: "main",
        surface: "chat",
        channelContext: {
          kind: "slack",
          blocks: [
            {
              type: "metadata",
              channel: "slack",
              place: "direct message / Thinh",
              conversationType: "direct_message",
              sender: "Thinh",
            },
          ],
        },
        channelContextRendered: "[CHANNEL CONTEXT]\nchannel: slack",
      },
    });
    expect(langfuseMock.generations[0]?.args).toEqual(
      expect.objectContaining({
        input: [
          {
            role: "system",
            content: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
          },
          { role: "user", content: "hello" },
        ],
        metadata: {
          source: "web",
          sessionKey: "main",
          systemPrompt: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
        },
      })
    );
    expect(langfuseMock.generations[0]?.update).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            role: "system",
            content: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
          },
          { role: "user", content: "hello" },
        ],
        metadata: {
          systemPrompt: "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack",
          thinking: undefined,
        },
      })
    );

    await tracer.stop();
  });

  it("ignores orphaned tool results", async () => {
    const tracer = startTracer();

    expect(() =>
      tracer.handleHistoryEvent(
        historyEvent({
          type: "tool_result",
          id: "missing",
          name: "bash",
          content: "no call",
          isError: true,
          timestamp: 1,
        })
      )
    ).not.toThrow();
    expect(langfuseMock.spans).toHaveLength(0);

    await tracer.stop();
  });

  it("catches flushAsync errors", async () => {
    const tracer = startTracer();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    langfuseMock.instances[0]?.flushAsync.mockRejectedValueOnce(
      new Error("flush failed")
    );

    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(warning).toHaveBeenCalledWith(
      "[langfuse] flushAsync failed",
      expect.any(Error)
    );
    warning.mockRestore();

    await tracer.stop();
  });

  it("stores thinking text in generation metadata only", async () => {
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent({ type: "thinking", data: "thinking " })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "thinking", data: "more" })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "answer" })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(langfuseMock.generations[0]?.update).toHaveBeenCalledWith({
      output: "answer",
      metadata: { thinking: "thinking more" },
      level: "DEFAULT",
      statusMessage: undefined,
    });

    await tracer.stop();
  });

  it("marks the current generation as error", async () => {
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "partial" })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "error", message: "model failed" })
    );

    expect(langfuseMock.generations[0]?.update).toHaveBeenCalledWith({
      output: "partial",
      metadata: { thinking: undefined },
      level: "ERROR",
      statusMessage: "model failed",
    });
    expect(langfuseMock.generations[0]?.end).toHaveBeenCalledTimes(1);

    await tracer.stop();
  });

  it("creates multiple generations for multi-turn agent loop under one trace", async () => {
    const tracer = startTracer();

    // Turn 1: model calls tools (text + tool_call + tool_result + meta + turn_end)
    tracer.handleHistoryEvent(
      historyEvent({ type: "user", text: "fix the bug", timestamp: 1 })
    );
    await tracer.handleStreamEvent(streamEvent({ type: "text", data: "" }));
    tracer.handleHistoryEvent(
      historyEvent({
        type: "tool_call",
        id: "tool-1",
        name: "bash",
        args: { cmd: "grep bug src/" },
        timestamp: 2,
      })
    );
    tracer.handleHistoryEvent(
      historyEvent({
        type: "tool_result",
        id: "tool-1",
        name: "bash",
        content: "src/main.ts:10",
        isError: false,
        timestamp: 3,
      })
    );
    tracer.handleHistoryEvent(historyEvent({ type: "turn_end", timestamp: 4 }));

    // Turn 2: model responds with final answer
    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "Fixed the bug." })
    );
    tracer.handleHistoryEvent(historyEvent({ type: "turn_end", timestamp: 5 }));

    // Entire runAgent call ends
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    // One trace, two generations
    expect(langfuseMock.traces).toHaveLength(1);
    expect(langfuseMock.traces[0]?.generation).toHaveBeenCalledTimes(2);
    expect(langfuseMock.generations).toHaveLength(2);
    expect(langfuseMock.generations[0]?.end).toHaveBeenCalledTimes(1);
    expect(langfuseMock.generations[1]?.end).toHaveBeenCalledTimes(1);

    // Trace gets the combined output
    expect(langfuseMock.traces[0]?.update).toHaveBeenCalledWith({
      output: "Fixed the bug.",
    });

    await tracer.stop();
  });

  it("creates separate traces for separate sessions", async () => {
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "one" }, { sessionId: "session-a" })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "done" }, { sessionId: "session-a" })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "two" }, { sessionId: "session-b" })
    );
    await tracer.handleStreamEvent(
      streamEvent({ type: "done" }, { sessionId: "session-b" })
    );

    expect(langfuseMock.traces).toHaveLength(2);
    expect(langfuseMock.traces[0]?.args).toEqual(
      expect.objectContaining({ sessionId: "yoplai:chat:agent-1:session-a" })
    );
    expect(langfuseMock.traces[1]?.args).toEqual(
      expect.objectContaining({ sessionId: "yoplai:chat:agent-1:session-b" })
    );

    await tracer.stop();
  });

  it("finalizes and removes idle traces", async () => {
    vi.useFakeTimers();
    const tracer = startTracer();

    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "stale" })
    );

    expect(traceCount(tracer)).toBe(1);

    await vi.advanceTimersByTimeAsync(35 * 60 * 1000);

    expect(traceCount(tracer)).toBe(0);
    expect(langfuseMock.generations[0]?.update).toHaveBeenCalledWith(
      expect.objectContaining({ output: "stale" })
    );
    expect(langfuseMock.generations[0]?.end).toHaveBeenCalledTimes(1);

    await tracer.stop();
  });

  it("does nothing when events arrive before start", async () => {
    const tracer = new LangfuseTracer(tracerConfig);

    await tracer.handleStreamEvent(
      streamEvent({ type: "text", data: "ignored" })
    );

    expect(langfuseMock.Langfuse).not.toHaveBeenCalled();
    expect(traceCount(tracer)).toBe(0);
  });

  it("passes environment to Langfuse SDK", async () => {
    const tracer = startTracer();

    expect(langfuseMock.Langfuse).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "dev" })
    );

    await tracer.stop();
  });
});

function startTracer(): LangfuseTracer {
  const tracer = new LangfuseTracer(tracerConfig);
  tracer.start();
  return tracer;
}

function streamEvent(
  event: Pick<AgentStreamEvent, "type"> & Partial<AgentStreamEvent>,
  overrides: Partial<
    Pick<
      AgentStreamEvent,
      "agentId" | "sessionId" | "sessionKey" | "source" | "trace"
    >
  > = {}
): AgentStreamEvent {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    sessionKey: "main",
    source: "web",
    ...event,
    ...overrides,
  } as AgentStreamEvent;
}

function historyEvent(
  event: Pick<AgentHistoryEvent, "type"> & Partial<AgentHistoryEvent>,
  overrides: Partial<
    Pick<
      AgentHistoryEvent,
      "agentId" | "sessionId" | "sessionKey" | "source" | "trace"
    >
  > = {}
): AgentHistoryEvent {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    sessionKey: "main",
    source: "web",
    ...event,
    ...overrides,
  } as AgentHistoryEvent;
}

function traceCount(tracer: LangfuseTracer): number {
  return (tracer as unknown as { traces: Map<string, unknown> }).traces.size;
}
