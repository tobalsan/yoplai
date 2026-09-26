import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { AgentHistoryEvent, AgentStreamEvent } from "@yoplai/shared";
import { LangfuseTracer } from "../tracer.js";

let exporter: InMemorySpanExporter;
let tracer: LangfuseTracer | undefined;

function startTracer(overrides: { environment?: string } = {}): LangfuseTracer {
  tracer = new LangfuseTracer({
    publicKey: "pk-test",
    secretKey: "sk-test",
    baseUrl: "https://langfuse.test",
    flushAt: 2,
    flushInterval: 100,
    environment: "dev",
    exporter,
    ...overrides,
  });
  tracer.start();
  return tracer;
}

type Obs = {
  name: string;
  type: string;
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  attrs: Record<string, unknown>;
  input: unknown;
  output: unknown;
  metadata: Record<string, unknown>;
};

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toObs(span: ReadableSpan): Obs {
  const attrs = span.attributes as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};
  const prefix = "langfuse.observation.metadata.";
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith(prefix))
      metadata[key.slice(prefix.length)] = parse(value);
  }
  return {
    name: span.name,
    type: String(attrs["langfuse.observation.type"]),
    spanId: span.spanContext().spanId,
    traceId: span.spanContext().traceId,
    parentSpanId: span.parentSpanContext?.spanId,
    attrs,
    input: parse(attrs["langfuse.observation.input"]),
    output: parse(attrs["langfuse.observation.output"]),
    metadata,
  };
}

function observations(): Obs[] {
  return exporter.getFinishedSpans().map(toObs);
}

function byType(type: string): Obs[] {
  return observations().filter((o) => o.type === type);
}

describe("LangfuseTracer", () => {
  beforeEach(() => {
    vi.useRealTimers();
    exporter = new InMemorySpanExporter();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await tracer?.stop();
    tracer = undefined;
  });

  it("creates one root span and one generation for a basic text turn", async () => {
    const t = startTracer();

    await t.handleStreamEvent(streamEvent({ type: "text", data: "Hello" }));
    await t.handleStreamEvent(streamEvent({ type: "text", data: " world" }));
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const [root] = byType("span");
    const gens = byType("generation");
    expect(observations()).toHaveLength(2);
    expect(gens).toHaveLength(1);
    expect(root?.parentSpanId).toBeUndefined();
    expect(gens[0]?.parentSpanId).toBe(root?.spanId);
    expect(gens[0]?.traceId).toBe(root?.traceId);
    expect(gens[0]?.name).toBe("llm-turn");
    expect(gens[0]?.output).toBe("Hello world");
    expect(gens[0]?.attrs["langfuse.observation.level"]).toBe("DEFAULT");
    expect(root?.output).toBe("Hello world");
    expect(parse(root?.attrs["langfuse.trace.output"])).toBe("Hello world");
  });

  it("stamps sessionId, trace name, and environment on every observation", async () => {
    const t = startTracer({ environment: "staging" });

    await t.handleStreamEvent(streamEvent({ type: "text", data: "running" }));
    t.handleHistoryEvent(
      historyEvent({
        type: "tool_call",
        id: "tool-1",
        name: "bash",
        args: {},
        timestamp: 1,
      })
    );
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const all = observations();
    expect(all).toHaveLength(3);
    for (const obs of all) {
      expect(obs.attrs["session.id"]).toBe("yoplai:chat:agent-1:session-1");
      expect(obs.attrs["langfuse.trace.name"]).toBe("yoplai:chat:agent-1");
      expect(obs.attrs["langfuse.environment"]).toBe("staging");
      expect(obs.attrs["langfuse.trace.metadata.surface"]).toBe("chat");
    }
  });

  it("keeps the session id format and strips a duplicated surface prefix", async () => {
    const t = startTracer();

    await t.handleStreamEvent(
      streamEvent(
        { type: "text", data: "x" },
        { sessionKey: "project:PRO-1:lead", sessionId: "project:abc" }
      )
    );
    await t.handleStreamEvent(
      streamEvent(
        { type: "done" },
        { sessionKey: "project:PRO-1:lead", sessionId: "project:abc" }
      )
    );

    expect(byType("span")[0]?.attrs["session.id"]).toBe(
      "yoplai:project:agent-1:abc"
    );
    expect(byType("span")[0]?.name).toBe("yoplai:project:agent-1");
  });

  it("uses explicit webhook trace context and metadata", async () => {
    const t = startTracer();
    const overrides = {
      sessionKey: "webhook:agent-1:notion:req-1",
      source: "webhook" as const,
      trace: {
        name: "yoplai:webhook:agent-1",
        surface: "webhook",
        metadata: {
          webhookName: "notion",
          sourceUrl: "http://localhost/hooks/agent-1/notion/secret",
        },
      },
    };

    await t.handleStreamEvent(
      streamEvent({ type: "text", data: "webhook msg" }, overrides)
    );
    await t.handleStreamEvent(streamEvent({ type: "done" }, overrides));

    const root = byType("span")[0];
    expect(root?.name).toBe("yoplai:webhook:agent-1");
    expect(root?.metadata).toEqual(
      expect.objectContaining({
        source: "webhook",
        surface: "webhook",
        sessionKey: "webhook:agent-1:notion:req-1",
        webhookName: "notion",
        sourceUrl: "http://localhost/hooks/agent-1/notion/secret",
      })
    );
  });

  it("skips events with disabled trace context", async () => {
    const t = startTracer();

    t.handleHistoryEvent(
      historyEvent(
        { type: "user", text: "hello", timestamp: 1 },
        { trace: { enabled: false } }
      )
    );
    await t.handleStreamEvent(
      streamEvent(
        { type: "text", data: "answer" },
        { trace: { enabled: false } }
      )
    );
    await t.stop();

    expect(observations()).toHaveLength(0);
  });

  it("creates tool observations under the generation", async () => {
    const t = startTracer();

    await t.handleStreamEvent(streamEvent({ type: "text", data: "running" }));
    t.handleHistoryEvent(
      historyEvent({
        type: "tool_call",
        id: "tool-1",
        name: "bash",
        args: { cmd: "pwd" },
        timestamp: 1,
      })
    );
    t.handleHistoryEvent(
      historyEvent({
        type: "tool_result",
        id: "tool-1",
        name: "bash",
        content: "/tmp/project",
        isError: false,
        timestamp: 2,
      })
    );
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const [tool] = byType("tool");
    const [gen] = byType("generation");
    expect(tool?.name).toBe("bash");
    expect(tool?.parentSpanId).toBe(gen?.spanId);
    expect(tool?.input).toEqual({ cmd: "pwd" });
    expect(tool?.output).toBe("/tmp/project");
    expect(tool?.attrs["langfuse.observation.level"]).toBe("DEFAULT");
    expect(tool?.metadata).toEqual(
      expect.objectContaining({ toolCallId: "tool-1", toolName: "bash" })
    );
  });

  it("closes tools without results with a warning", async () => {
    const t = startTracer();

    await t.handleStreamEvent(streamEvent({ type: "text", data: "running" }));
    t.handleHistoryEvent(
      historyEvent({
        type: "tool_call",
        id: "tool-1",
        name: "bash",
        args: {},
        timestamp: 1,
      })
    );
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const [tool] = byType("tool");
    expect(tool?.attrs["langfuse.observation.level"]).toBe("WARNING");
    expect(tool?.attrs["langfuse.observation.status_message"]).toBe(
      "Tool result missing"
    );
  });

  it("redacts serialized tool payloads before Langfuse export", async () => {
    const t = startTracer();
    const canary = "canary-private-value";

    await t.handleStreamEvent(streamEvent({ type: "text", data: "running" }));
    t.handleHistoryEvent(
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
    t.handleHistoryEvent(
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
    await t.handleStreamEvent(
      streamEvent({ type: "error", message: `access_token=${canary}-error` })
    );

    expect(observations()).toHaveLength(3);
    expect(JSON.stringify(observations().map((o) => o.attrs))).not.toContain(
      canary
    );
  });

  it("stores meta model and usage on the generation", async () => {
    const t = startTracer();

    await t.handleStreamEvent(streamEvent({ type: "text", data: "answer" }));
    t.handleHistoryEvent(
      historyEvent({
        type: "meta",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        usage: { input: 10, output: 5, cacheRead: 2, totalTokens: 17 },
        stopReason: "end_turn",
        timestamp: 3,
      })
    );
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const [gen] = byType("generation");
    expect(gen?.attrs["langfuse.observation.model.name"]).toBe(
      "claude-sonnet-4-5"
    );
    expect(parse(gen?.attrs["langfuse.observation.usage_details"])).toEqual({
      input: 10,
      output: 5,
      total: 17,
      cacheRead: 2,
    });
    expect(gen?.metadata).toEqual(
      expect.objectContaining({ provider: "anthropic", stopReason: "end_turn" })
    );
  });

  it("stores user input on the trace and generation", async () => {
    const t = startTracer();

    t.handleHistoryEvent(
      historyEvent({ type: "user", text: "hello", timestamp: 1 })
    );
    await t.handleStreamEvent(streamEvent({ type: "text", data: "answer" }));
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const [root] = byType("span");
    expect(root?.input).toBe("hello");
    expect(parse(root?.attrs["langfuse.trace.input"])).toBe("hello");
    expect(byType("generation")[0]?.input).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("stores system prompt and channel context", async () => {
    const t = startTracer();
    const prompt = "You are Sally.\n\n[CHANNEL CONTEXT]\nchannel: slack";

    t.handleHistoryEvent(
      historyEvent({ type: "system_prompt", text: prompt, timestamp: 1 })
    );
    t.handleHistoryEvent(
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
    t.handleHistoryEvent(
      historyEvent({ type: "user", text: "hello", timestamp: 2 })
    );
    await t.handleStreamEvent(streamEvent({ type: "text", data: "answer" }));
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const [root] = byType("span");
    const [gen] = byType("generation");
    expect(root?.metadata).toEqual(
      expect.objectContaining({
        source: "web",
        sessionKey: "main",
        surface: "chat",
        channelContextRendered: "[CHANNEL CONTEXT]\nchannel: slack",
      })
    );
    for (const obs of [root, gen]) {
      expect(obs?.attrs["user.id"]).toBe("Thinh");
      expect(obs?.attrs["langfuse.trace.tags"]).toEqual([
        "channel:slack",
        "place:direct message / Thinh",
      ]);
    }
    expect(gen?.input).toEqual([
      { role: "system", content: prompt },
      { role: "user", content: "hello" },
    ]);
    expect(gen?.metadata).toEqual(
      expect.objectContaining({ systemPrompt: prompt })
    );
  });

  it("ignores orphaned tool results", async () => {
    const t = startTracer();

    expect(() =>
      t.handleHistoryEvent(
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
    await t.stop();
    expect(byType("tool")).toHaveLength(0);
  });

  it("catches flush errors", async () => {
    const t = startTracer();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = (
      t as unknown as { provider: { forceFlush: () => unknown } }
    ).provider;
    vi.spyOn(provider, "forceFlush").mockRejectedValueOnce(
      new Error("flush failed")
    );

    await t.handleStreamEvent(streamEvent({ type: "done" }));

    expect(warning).toHaveBeenCalledWith(
      "[langfuse] flush failed",
      expect.any(Error)
    );
    warning.mockRestore();
  });

  it("stores thinking text in generation metadata only", async () => {
    const t = startTracer();

    await t.handleStreamEvent(
      streamEvent({ type: "thinking", data: "thinking " })
    );
    await t.handleStreamEvent(streamEvent({ type: "thinking", data: "more" }));
    await t.handleStreamEvent(streamEvent({ type: "text", data: "answer" }));
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const [gen] = byType("generation");
    expect(gen?.output).toBe("answer");
    expect(gen?.metadata.thinking).toBe("thinking more");
  });

  it("marks the current generation as error", async () => {
    const t = startTracer();

    await t.handleStreamEvent(streamEvent({ type: "text", data: "partial" }));
    await t.handleStreamEvent(
      streamEvent({ type: "error", message: "model failed" })
    );

    const [gen] = byType("generation");
    expect(gen?.output).toBe("partial");
    expect(gen?.attrs["langfuse.observation.level"]).toBe("ERROR");
    expect(gen?.attrs["langfuse.observation.status_message"]).toBe(
      "model failed"
    );
  });

  it("creates multiple generations for a multi-turn loop under one root", async () => {
    const t = startTracer();

    t.handleHistoryEvent(
      historyEvent({ type: "user", text: "fix the bug", timestamp: 1 })
    );
    await t.handleStreamEvent(streamEvent({ type: "text", data: "" }));
    t.handleHistoryEvent(
      historyEvent({
        type: "tool_call",
        id: "tool-1",
        name: "bash",
        args: { cmd: "grep bug src/" },
        timestamp: 2,
      })
    );
    t.handleHistoryEvent(
      historyEvent({
        type: "tool_result",
        id: "tool-1",
        name: "bash",
        content: "src/main.ts:10",
        isError: false,
        timestamp: 3,
      })
    );
    t.handleHistoryEvent(historyEvent({ type: "turn_end", timestamp: 4 }));
    await t.handleStreamEvent(
      streamEvent({ type: "text", data: "Fixed the bug." })
    );
    t.handleHistoryEvent(historyEvent({ type: "turn_end", timestamp: 5 }));
    await t.handleStreamEvent(streamEvent({ type: "done" }));

    const roots = byType("span");
    const gens = byType("generation");
    expect(roots).toHaveLength(1);
    expect(gens).toHaveLength(2);
    for (const gen of gens) expect(gen.parentSpanId).toBe(roots[0]?.spanId);
    expect(byType("tool")[0]?.parentSpanId).toBe(gens[0]?.spanId);
    expect(roots[0]?.output).toBe("Fixed the bug.");
  });

  it("creates separate traces for separate sessions", async () => {
    const t = startTracer();

    for (const sessionId of ["session-a", "session-b"]) {
      await t.handleStreamEvent(
        streamEvent({ type: "text", data: "x" }, { sessionId })
      );
      await t.handleStreamEvent(streamEvent({ type: "done" }, { sessionId }));
    }

    const roots = byType("span");
    expect(roots).toHaveLength(2);
    expect(roots[0]?.traceId).not.toBe(roots[1]?.traceId);
    expect(roots.map((r) => r.attrs["session.id"])).toEqual([
      "yoplai:chat:agent-1:session-a",
      "yoplai:chat:agent-1:session-b",
    ]);
  });

  it("finalizes and removes idle traces", async () => {
    vi.useFakeTimers();
    const t = startTracer();

    await t.handleStreamEvent(streamEvent({ type: "text", data: "stale" }));
    expect(traceCount(t)).toBe(1);

    await vi.advanceTimersByTimeAsync(35 * 60 * 1000);

    expect(traceCount(t)).toBe(0);
    expect(byType("generation")[0]?.output).toBe("stale");
    expect(byType("span")).toHaveLength(1);
  });

  it("does nothing when events arrive before start", async () => {
    const t = new LangfuseTracer({
      publicKey: "pk",
      secretKey: "sk",
      exporter,
    });

    await t.handleStreamEvent(streamEvent({ type: "text", data: "ignored" }));

    expect(traceCount(t)).toBe(0);
    expect(observations()).toHaveLength(0);
  });

  it("is a no-op when keys are missing", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    tracer = new LangfuseTracer({ publicKey: "", secretKey: "", exporter });
    tracer.start();

    await tracer.handleStreamEvent(streamEvent({ type: "text", data: "x" }));
    await tracer.handleStreamEvent(streamEvent({ type: "done" }));

    expect(traceCount(tracer)).toBe(0);
    expect(observations()).toHaveLength(0);
    warning.mockRestore();
  });

  it("does not register a global OpenTelemetry tracer provider", async () => {
    const { trace } = await import("@opentelemetry/api");
    startTracer();
    const span = trace.getTracer("other").startSpan("x");
    expect(span.isRecording()).toBe(false);
    span.end();
  });
});

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

function traceCount(t: LangfuseTracer): number {
  return (t as unknown as { traces: Map<string, unknown> }).traces.size;
}
