import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  streamMessage,
  subscribeToFileChanges,
  subscribeToRealtime,
  subscribeToSession,
} from "./client";

type MessageEventLike = { data: string };

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (event: MessageEventLike) => void;
  onerror?: () => void;
  onclose?: () => void;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  receive(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  triggerError() {
    this.onerror?.();
  }
}

describe("streamMessage", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost:5173" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes streaming events to callbacks", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const onThinking = vi.fn();
    const onToolCall = vi.fn();
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();
    const onSessionReset = vi.fn();
    const onProgress = vi.fn();

    const cleanup = streamMessage(
      "agent-1",
      "hello",
      "main",
      onText,
      onDone,
      onError,
      {
        onThinking,
        onToolCall,
        onToolStart,
        onToolEnd,
        onSessionReset,
        onProgress,
      }
    );

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    ws.open();
    expect(ws.sent.length).toBe(1);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "send",
      agentId: "agent-1",
      sessionKey: "main",
      message: "hello",
    });

    ws.receive({ type: "text", data: "hi" });
    ws.receive({ type: "thinking", data: "plan" });
    ws.receive({ type: "tool_call", id: "1", name: "bash", arguments: { cmd: "ls" } });
    ws.receive({ type: "tool_start", toolName: "bash" });
    ws.receive({ type: "tool_end", toolName: "bash", isError: false });
    ws.receive({ type: "session_reset", sessionId: "s1" });
    ws.receive({ type: "progress", label: "Checking files", current: 1, total: 2, taskId: "task-1" });
    ws.receive({ type: "done", meta: { durationMs: 12 } });
    ws.receive({ type: "error", message: "nope" });

    expect(onText).toHaveBeenCalledWith("hi");
    expect(onThinking).toHaveBeenCalledWith("plan");
    expect(onToolCall).toHaveBeenCalledWith("1", "bash", { cmd: "ls" });
    expect(onToolStart).toHaveBeenCalledWith("bash");
    expect(onToolEnd).toHaveBeenCalledWith("bash", false);
    expect(onSessionReset).toHaveBeenCalledWith("s1");
    expect(onProgress).toHaveBeenCalledWith({ label: "Progress updated.", current: 1, total: 2, taskId: "task-1" });
    expect(onDone).toHaveBeenCalledWith({ durationMs: 12 });
    expect(onError).toHaveBeenCalledWith("nope");

    cleanup();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("reports connection errors", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    streamMessage("agent-2", "hi", "main", onText, onDone, onError);

    const ws = MockWebSocket.instances[0];
    ws.triggerError();

    expect(onError).toHaveBeenCalledWith("Connection error");
  });

  it("calls onError when socket closes without a terminal done/error event", () => {
    const onDone = vi.fn();
    const onError = vi.fn();

    streamMessage("agent-3", "hi", "main", vi.fn(), onDone, onError);

    const ws = MockWebSocket.instances[0];
    ws.open();
    // Socket closes with no done/error — stale thinking state scenario
    ws.close();

    expect(onError).toHaveBeenCalledWith("Connection closed");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("does not call onError on close after a done event was received", () => {
    const onDone = vi.fn();
    const onError = vi.fn();

    streamMessage("agent-4", "hi", "main", vi.fn(), onDone, onError);

    const ws = MockWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "done", meta: { durationMs: 50 } });
    ws.close();

    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("does not call onError on close after an error event was received", () => {
    const onDone = vi.fn();
    const onError = vi.fn();

    streamMessage("agent-5", "hi", "main", vi.fn(), onDone, onError);

    const ws = MockWebSocket.instances[0];
    ws.open();
    ws.receive({ type: "error", message: "backend failure" });
    ws.close();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("backend failure");
  });

  it("does not call onError on close after explicit cleanup", () => {
    const onDone = vi.fn();
    const onError = vi.fn();

    const cleanup = streamMessage("agent-6", "hi", "main", vi.fn(), onDone, onError);

    const ws = MockWebSocket.instances[0];
    ws.open();
    cleanup();

    expect(onError).not.toHaveBeenCalled();
  });
});

describe("subscribeToSession", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost:5173" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reloads history once the subscription is active", () => {
    const onHistoryUpdated = vi.fn();

    const cleanup = subscribeToSession("agent-1", "project:PRO-1:lead-1", {
      onHistoryUpdated,
    });

    const ws = MockWebSocket.instances[0];
    expect(ws).toBeTruthy();

    ws.open();

    expect(ws.sent).toEqual([
      JSON.stringify({
        type: "subscribe",
        agentId: "agent-1",
        sessionKey: "project:PRO-1:lead-1",
      }),
    ]);
    expect(onHistoryUpdated).toHaveBeenCalledTimes(1);

    cleanup();
  });
});

describe("subscribeToFileChanges", () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:5173" },
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      cleanup?.();
    }
    vi.unstubAllGlobals();
  });

  it("delivers file and agent events and cleans up shared socket", () => {
    const onFileChanged = vi.fn();
    const onAgentChanged = vi.fn();

    const cleanup = subscribeToFileChanges({ onFileChanged, onAgentChanged });
    cleanups.push(cleanup);
    const ws = MockWebSocket.instances[0];

    expect(ws).toBeTruthy();
    ws.open();
    expect(ws.sent).toEqual([]);

    ws.receive({
      type: "file_changed",
      projectId: "PRO-1",
      file: "README.md",
    });
    ws.receive({ type: "agent_changed", projectId: "PRO-1" });

    expect(onFileChanged).toHaveBeenCalledWith("PRO-1", "README.md");
    expect(onAgentChanged).toHaveBeenCalledWith("PRO-1");

    cleanup();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("shares one socket across subscribers", () => {
    const first = subscribeToFileChanges({ onAgentChanged: vi.fn() });
    const second = subscribeToFileChanges({ onFileChanged: vi.fn() });
    cleanups.push(second, first);

    expect(MockWebSocket.instances.length).toBe(1);
    const ws = MockWebSocket.instances[0];
    ws.open();

    first();
    expect(ws.readyState).not.toBe(MockWebSocket.CLOSED);
    second();
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });
});

describe("subscribeToRealtime", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:5173" },
      setTimeout,
      clearTimeout,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends session interests and filters project events", () => {
    const onEvent = vi.fn();
    const cleanup = subscribeToRealtime({
      interests: [
        { type: "session", agentId: "agent-1", sessionKey: "main" },
        { type: "project", projectId: "PRO-1" },
      ],
      onEvent,
    });

    const ws = MockWebSocket.instances[0];
    ws.open();

    expect(ws.sent).toContain(
      JSON.stringify({
        type: "subscribe",
        agentId: "agent-1",
        sessionKey: "main",
      })
    );

    ws.receive({ type: "file_changed", projectId: "PRO-2", file: "README.md" });
    ws.receive({ type: "file_changed", projectId: "PRO-1", file: "README.md" });
    ws.receive({ type: "text", data: "hi" });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, {
      type: "file_changed",
      projectId: "PRO-1",
      file: "README.md",
    });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: "text", data: "hi" });

    cleanup();
    expect(ws.sent).toContain(JSON.stringify({ type: "unsubscribe" }));
  });
});
