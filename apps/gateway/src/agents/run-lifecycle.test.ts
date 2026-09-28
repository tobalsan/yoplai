import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEvent } from "../sdk/types.js";
import type { SdkAdapter, SdkCapabilities } from "../sdk/types.js";

const flushedTurns: Array<Array<HistoryEvent>> = [];
const eagerlyFlushedUsers: Array<Array<HistoryEvent>> = [];

vi.mock("../history/store.js", () => ({
  backfillFromPiSession: vi.fn(async () => false),
  createTurnBuffer: () => ({ events: [] }),
  bufferHistoryEvent: (
    buffer: { events: HistoryEvent[] },
    event: HistoryEvent
  ) => {
    buffer.events.push(event);
  },
  flushUserMessage: vi.fn(
    async (
      _agentId: string,
      _sessionId: string,
      buffer: { events: HistoryEvent[] }
    ) => {
      eagerlyFlushedUsers.push([...buffer.events]);
    }
  ),
  flushTurnBuffer: vi.fn(
    async (
      _agentId: string,
      _sessionId: string,
      buffer: { events: HistoryEvent[] }
    ) => {
      flushedTurns.push([...buffer.events]);
    }
  ),
}));

import { flushUserMessage } from "../history/store.js";
import { backfillFromPiSession } from "../history/store.js";
import { SessionRunLifecycle } from "./run-lifecycle.js";
import { agentEventBus } from "./events.js";
import {
  getSessionCurrentTurn,
  isStreaming,
  popAllPendingUserMessages,
  setSessionStreaming,
} from "./sessions.js";

const nativeCapabilities: SdkCapabilities = {
  queueWhileStreaming: true,
  interrupt: true,
  toolEvents: true,
  fullHistory: true,
};

const bufferedCapabilities: SdkCapabilities = {
  ...nativeCapabilities,
  queueWhileStreaming: false,
};

function makeAdapter(overrides: Partial<SdkAdapter> = {}): SdkAdapter {
  return {
    id: "pi",
    displayName: "Test",
    capabilities: nativeCapabilities,
    resolveDisplayModel: () => ({}),
    run: vi.fn(),
    ...overrides,
  };
}

function makeLifecycle(sessionId: string) {
  return new SessionRunLifecycle({
    agentId: "agent-lifecycle-test",
    sessionId,
  });
}

describe("beginUserTurn (pre-acceptance)", () => {
  beforeEach(() => {
    flushedTurns.length = 0;
    eagerlyFlushedUsers.length = 0;
    vi.mocked(backfillFromPiSession).mockClear();
  });

  it("eagerly persists a sanitized user message and suppresses the adapter's initial echo", async () => {
    const sessionId = `preaccept-basic-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);

    await lifecycle.beginUserTurn("hello with token=abc123 inside", 1000, [
      { path: "/tmp/a.txt", mimeType: "text/plain", filename: "a.txt", size: 3 },
    ]);

    expect(eagerlyFlushedUsers).toHaveLength(1);
    expect(eagerlyFlushedUsers[0]).toHaveLength(1);
    expect(eagerlyFlushedUsers[0][0]).toMatchObject({
      type: "user",
      text: "hello with token=[REDACTED] inside",
    });
    const acceptedEvent = eagerlyFlushedUsers[0][0] as Extract<
      HistoryEvent,
      { type: "user" }
    >;
    expect(acceptedEvent.attachments).toEqual([
      { path: "/tmp/a.txt", mimeType: "text/plain", filename: "a.txt", size: 3 },
    ]);
    expect(backfillFromPiSession).toHaveBeenCalled();
    expect(getSessionCurrentTurn("agent-lifecycle-test", sessionId)).toBe(
      lifecycle["currentTurn"]
    );

    // Adapter's initial user echo: consumed, no duplicate flush, no pending.
    lifecycle.acceptHistoryEvent({
      type: "user",
      text: "hello with token=[REDACTED] inside",
      timestamp: 1000,
    });
    expect(eagerlyFlushedUsers).toHaveLength(1);
    expect(popAllPendingUserMessages("agent-lifecycle-test", sessionId)).toEqual(
      []
    );
  });

  it("echo suppression survives turn_end and rearms (OpenClaw retry shape)", async () => {
    const sessionId = `preaccept-retry-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);

    await lifecycle.beginUserTurn("retry me", 1000);
    lifecycle.acceptHistoryEvent({ type: "user", text: "retry me", timestamp: 1000 });
    lifecycle.acceptHistoryEvent({ type: "turn_end", timestamp: 1001 });

    // First adapter attempt failed with a thinking-level error; runner
    // rearms before the retry, which re-emits its initial user event.
    lifecycle.rearmInitialEcho();
    lifecycle.acceptHistoryEvent({ type: "user", text: "retry me", timestamp: 1002 });

    expect(eagerlyFlushedUsers).toHaveLength(1);
    expect(popAllPendingUserMessages("agent-lifecycle-test", sessionId)).toEqual(
      []
    );

    // Pin completed-turn persistence: the retried turn's flush must not
    // re-emit the already-persisted user message (the first turn's buffered
    // user event is skipped by flushTurnBuffer via userFlushed).
    lifecycle.acceptHistoryEvent({ type: "assistant_text", text: "done", timestamp: 1003 });
    await lifecycle.flushTurns();
    expect(eagerlyFlushedUsers).toHaveLength(1);
    expect(flushedTurns).toHaveLength(2);
    expect(flushedTurns[1].map((e) => e.type)).toEqual(["assistant_text"]);
  });

  it("without pre-acceptance a user event still starts a turn and flushes", async () => {
    const sessionId = `no-preaccept-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);

    lifecycle.rearmInitialEcho(); // rearm without prior beginUserTurn is a no-op
    lifecycle.acceptHistoryEvent({ type: "user", text: "fresh", timestamp: 1000 });

    expect(eagerlyFlushedUsers).toHaveLength(1);
    expect(eagerlyFlushedUsers[0][0]).toMatchObject({ type: "user", text: "fresh" });
  });

  it("beginUserTurn queues as pending when a turn is already streaming", async () => {
    const sessionId = `preaccept-queue-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);
    lifecycle.beginRun();

    await lifecycle.beginUserTurn("first", 1000);
    await lifecycle.beginUserTurn("second", 2000);

    expect(eagerlyFlushedUsers).toHaveLength(1);
    const pending = popAllPendingUserMessages("agent-lifecycle-test", sessionId);
    expect(pending.map((p) => p.text)).toEqual(["second"]);
    lifecycle.finishRun();
  });
});

describe("SessionRunLifecycle", () => {
  beforeEach(() => {
    flushedTurns.length = 0;
    eagerlyFlushedUsers.length = 0;
  });

  it("queues native follow-up messages into the active handle", async () => {
    const sessionId = `native-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);
    const queueMessage = vi.fn(async () => undefined);
    const adapter = makeAdapter({ queueMessage });
    const handle = { id: "handle" };

    lifecycle.beginRun();
    lifecycle.acceptSessionHandle(handle, adapter, nativeCapabilities);

    const decision = await lifecycle.handleJoin({
      queueMode: "queue",
      capabilities: nativeCapabilities,
      adapter,
      message: "follow-up",
    });

    expect(decision).toEqual({
      handled: true,
      result: {
        text: "Message queued into current run",
        queued: true,
      },
    });
    expect(queueMessage).toHaveBeenCalledWith(handle, "follow-up", {
      source: undefined,
      slack: undefined,
    });

    lifecycle.finishRun();
  });

  it("carries source and no slack sub-object for a web-originated follow-up", async () => {
    const sessionId = `web-source-${Date.now()}`;
    const lifecycle = new SessionRunLifecycle({
      agentId: "agent-lifecycle-test",
      sessionId,
      source: "web",
    });
    const queueMessage = vi.fn(async () => undefined);
    const adapter = makeAdapter({ queueMessage });
    const handle = { id: "handle" };

    lifecycle.beginRun();
    lifecycle.acceptSessionHandle(handle, adapter, nativeCapabilities);

    await lifecycle.handleJoin({
      queueMode: "queue",
      capabilities: nativeCapabilities,
      adapter,
      message: "follow-up",
    });

    expect(queueMessage).toHaveBeenCalledWith(handle, "follow-up", {
      source: "web",
      slack: undefined,
    });

    lifecycle.finishRun();
  });

  it("carries Slack channel/thread/event identity for a Slack-originated follow-up", async () => {
    const sessionId = `slack-source-${Date.now()}`;
    const lifecycle = new SessionRunLifecycle({
      agentId: "agent-lifecycle-test",
      sessionId,
      source: "slack",
      slackDelivery: {
        channel: "C123",
        threadTs: "111.222",
        eventId: "111.333",
      },
    });
    const queueMessage = vi.fn(async () => undefined);
    const adapter = makeAdapter({ queueMessage });
    const handle = { id: "handle" };

    lifecycle.beginRun();
    lifecycle.acceptSessionHandle(handle, adapter, nativeCapabilities);

    await lifecycle.handleJoin({
      queueMode: "queue",
      capabilities: nativeCapabilities,
      adapter,
      message: "follow-up",
    });

    expect(queueMessage).toHaveBeenCalledWith(handle, "follow-up", {
      source: "slack",
      slack: {
        channel: "C123",
        threadTs: "111.222",
        eventId: "111.333",
      },
    });

    lifecycle.finishRun();
  });

  it("buffers follow-ups for sequential drain when adapter cannot queue", async () => {
    const sessionId = `buffered-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);
    const adapter = makeAdapter();

    lifecycle.beginRun();
    const decision = await lifecycle.handleJoin({
      queueMode: "queue",
      capabilities: bufferedCapabilities,
      adapter,
      message: "next turn",
      sender: { kind: "agent", agentId: "beta", hops: 2 },
    });
    lifecycle.finishRun();

    expect(decision).toEqual({
      handled: true,
      result: {
        text: "Message queued for next run",
        queued: true,
      },
    });
    expect(lifecycle.drainPendingMessages()).toEqual([
      {
        message: "next turn",
        sender: { kind: "agent", agentId: "beta", hops: 2 },
      },
    ]);
  });

  it("aborts active adapter handle and observes streaming shutdown", async () => {
    const sessionId = `abort-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);
    const abort = vi.fn();
    const adapter = makeAdapter({ abort });
    const controller = lifecycle.beginRun();
    controller.signal.addEventListener("abort", () => {
      setSessionStreaming("agent-lifecycle-test", sessionId, false);
    });
    const handle = { id: "handle" };
    lifecycle.acceptSessionHandle(handle, adapter, nativeCapabilities);

    const aborted = await lifecycle.abortActiveRun(adapter, nativeCapabilities);

    expect(aborted).toBe(true);
    expect(abort).toHaveBeenCalledWith(handle);
    expect(controller.signal.aborted).toBe(true);
    expect(isStreaming("agent-lifecycle-test", sessionId)).toBe(false);
  });

  it("waits for eager user persistence before flushing the completed turn", async () => {
    const sessionId = `eager-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);
    let releaseFlush: (() => void) | undefined;
    vi.mocked(flushUserMessage).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        })
    );

    lifecycle.acceptHistoryEvent({
      type: "user",
      text: "first",
      timestamp: 1,
    });
    lifecycle.acceptHistoryEvent({ type: "turn_end", timestamp: 2 });

    const flush = lifecycle.flushTurns();
    await Promise.resolve();
    expect(flushedTurns).toEqual([]);

    releaseFlush?.();
    await flush;
    expect(flushedTurns).toEqual([
      [{ type: "user", text: "first", timestamp: 1 }],
    ]);
  });

  it("flushes completed, current, and pending user-only turns in order", async () => {
    const sessionId = `turns-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);

    lifecycle.acceptHistoryEvent({
      type: "user",
      text: "first",
      timestamp: 1,
    });
    lifecycle.acceptHistoryEvent({
      type: "assistant_text",
      text: "answer",
      timestamp: 2,
    });
    lifecycle.acceptHistoryEvent({ type: "turn_end", timestamp: 3 });
    lifecycle.acceptHistoryEvent({
      type: "user",
      text: "second",
      timestamp: 4,
    });
    lifecycle.acceptHistoryEvent({
      type: "user",
      text: "pending",
      timestamp: 5,
    });

    await lifecycle.flushTurns();

    expect(flushedTurns).toEqual([
      [
        { type: "user", text: "first", timestamp: 1 },
        { type: "assistant_text", text: "answer", timestamp: 2 },
      ],
      [{ type: "user", text: "second", timestamp: 4 }],
      [{ type: "user", text: "pending", timestamp: 5 }],
    ]);
    expect(getSessionCurrentTurn("agent-lifecycle-test", sessionId)).toBeNull();
  });

  it("finishRun clears current turn and streaming state", () => {
    const sessionId = `finish-${Date.now()}`;
    const lifecycle = makeLifecycle(sessionId);

    lifecycle.beginRun();
    lifecycle.acceptHistoryEvent({
      type: "user",
      text: "hello",
      timestamp: 1,
    });
    lifecycle.finishRun();

    expect(isStreaming("agent-lifecycle-test", sessionId)).toBe(false);
    expect(getSessionCurrentTurn("agent-lifecycle-test", sessionId)).toBeNull();
  });

  it("returns false when aborting an idle session", async () => {
    const sessionId = `idle-${Date.now()}`;
    setSessionStreaming("agent-lifecycle-test", sessionId, false);
    const lifecycle = makeLifecycle(sessionId);

    await expect(
      lifecycle.abortActiveRun(makeAdapter(), nativeCapabilities)
    ).resolves.toBe(false);
  });

  it("setTraceMetadata merges into subsequent stream and history events, keeping existing keys", () => {
    const sessionId = `trace-metadata-${Date.now()}`;
    const lifecycle = new SessionRunLifecycle({
      agentId: "agent-lifecycle-test",
      sessionId,
      trace: { enabled: true, name: "run", metadata: { jobId: "job-1" } },
    });

    lifecycle.setTraceMetadata({ thinkingLevel: "high" });

    const streamEvents: Array<{ trace?: unknown }> = [];
    const historyEvents: Array<{ trace?: unknown }> = [];
    const offStream = agentEventBus.onStreamEvent((event) =>
      streamEvents.push(event)
    );
    const offHistory = agentEventBus.onHistoryEvent((event) =>
      historyEvents.push(event)
    );

    lifecycle.emit({ type: "text", data: "hi" });
    lifecycle.acceptHistoryEvent({
      type: "user",
      text: "hi",
      timestamp: 1,
    });

    offStream();
    offHistory();

    expect(streamEvents[0]?.trace).toEqual({
      enabled: true,
      name: "run",
      metadata: { jobId: "job-1", thinkingLevel: "high" },
    });
    expect(historyEvents[0]?.trace).toEqual({
      enabled: true,
      name: "run",
      metadata: { jobId: "job-1", thinkingLevel: "high" },
    });
  });
});
