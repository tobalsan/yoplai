import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryEvent } from "../sdk/types.js";
import type { SdkAdapter, SdkCapabilities } from "../sdk/types.js";

const flushedTurns: Array<Array<HistoryEvent>> = [];
const eagerlyFlushedUsers: Array<Array<HistoryEvent>> = [];

vi.mock("../history/store.js", () => ({
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
import { SessionRunLifecycle } from "./run-lifecycle.js";
import {
  getSessionCurrentTurn,
  isStreaming,
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
    expect(queueMessage).toHaveBeenCalledWith(handle, "follow-up");

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
    });
    lifecycle.finishRun();

    expect(decision).toEqual({
      handled: true,
      result: {
        text: "Message queued for next run",
        queued: true,
      },
    });
    expect(lifecycle.drainPendingMessages()).toEqual(["next turn"]);
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
});
