import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@yoplai/shared";
import type { SdkAdapter } from "../sdk/types.js";

const getAgent = vi.fn();
const resolveWorkspaceDir = vi.fn((workspace: string) => workspace);
const getSdkAdapter = vi.fn();
const getDefaultSdkId = vi.fn(() => "pi");
const getSessionThinkLevel = vi.fn();
const setSessionThinkLevel = vi.fn();
const appendSessionMeta = vi.fn();
const isAbortTrigger = vi.fn(() => false);
const pauseTaskForControlCommand = vi.fn();
const getTask = vi.fn();
const maybeAutoTitleSession = vi.fn();

vi.mock("../config/index.js", () => ({
  CONFIG_DIR: "/tmp/yoplai-runner-test",
  getAgent,
  resolveWorkspaceDir,
}));

vi.mock("../sdk/registry.js", () => ({
  getSdkAdapter,
  getDefaultSdkId,
}));

vi.mock("../sdk/container/adapter.js", () => ({
  getContainerAdapter: vi.fn(),
}));

vi.mock("../sessions/index.js", () => ({
  resolveSessionId: vi.fn(),
  getSessionEntry: vi.fn(),
  isAbortTrigger,
}));

vi.mock("../tasks/store.js", () => ({ getTask, pauseTaskForControlCommand }));

vi.mock("../sessions/store.js", () => ({
  DEFAULT_MAIN_KEY: "main",
  getSessionThinkLevel,
  setSessionThinkLevel,
}));

vi.mock("../history/store.js", () => ({
  appendSessionMeta,
  backfillFromPiSession: vi.fn(async () => false),
  bufferHistoryEvent: vi.fn(
    (
      buffer: { events?: unknown[] },
      event: unknown
    ) => {
      (buffer.events ??= []).push(event);
    }
  ),
  createTurnBuffer: vi.fn(() => ({})),
  flushTurnBuffer: vi.fn(),
  flushUserMessage: vi.fn(),
  getFullHistory: vi.fn(),
  getSimpleHistory: vi.fn(),
  hasCanonicalHistory: vi.fn(),
  invalidateResolvedHistoryFile: vi.fn(),
  readPiSessionHistory: vi.fn(),
}));

vi.mock("../maintenance/session-auto-title.js", () => ({
  maybeAutoTitleSession,
}));

vi.mock("./events.js", () => ({
  agentEventBus: {
    emitStreamEvent: vi.fn(),
    emitHistoryEvent: vi.fn(),
    emitStatusChange: vi.fn(),
  },
}));

function createAdapter() {
  return {
    id: "pi",
    displayName: "Pi",
    capabilities: {
      queueWhileStreaming: false,
      interrupt: false,
      toolEvents: true,
      fullHistory: true,
    },
    resolveDisplayModel: vi.fn(),
    run: vi.fn().mockResolvedValue({ text: "ok" }),
  } satisfies SdkAdapter;
}

function createAgent(config: Partial<AgentConfig>): AgentConfig {
  return {
    id: "alpha",
    name: "Alpha",
    workspace: "/tmp/alpha",
    sdk: "pi",
    model: { provider: "anthropic", model: "claude" },
    queueMode: "queue",
    ...config,
  } as AgentConfig;
}

describe("runAgent think level resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSessionThinkLevel.mockResolvedValue("low");
  });

  it("prefers agent.reasoning over legacy thinkLevel and persisted session state", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(
      createAgent({
        auth: { mode: "oauth" },
        reasoning: "high",
        thinkLevel: "minimal",
      })
    );

    const { runAgent } = await import("./runner.js");
    await runAgent({
      agentId: "alpha",
      message: "hello",
      sessionId: "session-1",
      sessionKey: "main",
    });

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({ thinkLevel: "high" })
    );
    expect(getSessionThinkLevel).not.toHaveBeenCalled();
  });

  it("falls back to legacy thinkLevel when reasoning is absent", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(
      createAgent({
        auth: { mode: "oauth" },
        thinkLevel: "medium",
      })
    );

    const { runAgent } = await import("./runner.js");
    await runAgent({
      agentId: "alpha",
      message: "hello",
      sessionId: "session-1",
      sessionKey: "main",
    });

    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({ thinkLevel: "medium" })
    );
  });
});

describe("runAgent user message pre-acceptance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAbortTrigger.mockReturnValue(false);
    getTask.mockResolvedValue(undefined);
  });

  it("awaits persisted user message before invoking the adapter and suppresses its echo", async () => {
    const adapter = createAdapter();
    adapter.run.mockImplementation(async (params: {
      onHistoryEvent: (event: unknown) => void;
    }) => {
      params.onHistoryEvent({ type: "user", text: "hello", timestamp: 1 });
      return { text: "ok" };
    });
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));

    const { flushUserMessage } = await import("../history/store.js");
    let release: () => void = () => {};
    (flushUserMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const { runAgent } = await import("./runner.js");
    let settled = false;
    const run = runAgent({
      agentId: "alpha",
      message: "hello",
      sessionId: "session-pre-1",
    }).then((r) => {
      settled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 20));
    // Acceptance still in flight: the adapter must not have started.
    expect(adapter.run).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    release();
    await run;
    expect(adapter.run).toHaveBeenCalledTimes(1);
    // Adapter's user echo consumed: exactly one eager flush.
    expect(flushUserMessage).toHaveBeenCalledTimes(1);
  });

  it("aborts the run before the adapter when persistence fails", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));

    const { flushUserMessage } = await import("../history/store.js");
    (flushUserMessage as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => Promise.reject(new Error("disk full"))
    );

    const { runAgent } = await import("./runner.js");
    await expect(
      runAgent({ agentId: "alpha", message: "hello", sessionId: "session-pre-2" })
    ).rejects.toThrow("disk full");
    expect(adapter.run).not.toHaveBeenCalled();

    const { isStreaming } = await import("./sessions.js");
    expect(isStreaming("alpha", "session-pre-2")).toBe(false);
  });

  it("does not pre-accept empty messages", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));

    const { flushUserMessage } = await import("../history/store.js");
    (flushUserMessage as ReturnType<typeof vi.fn>).mockClear();

    const { runAgent } = await import("./runner.js");
    await runAgent({
      agentId: "alpha",
      message: "   ",
      sessionId: "session-pre-3",
    });

    expect(flushUserMessage).not.toHaveBeenCalled();
    expect(adapter.run).toHaveBeenCalledTimes(1);
  });

  it("pre-accepts the directive-stripped message", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(
      createAgent({ auth: { mode: "oauth" }, reasoning: "high" })
    );

    const { flushUserMessage } = await import("../history/store.js");
    (flushUserMessage as ReturnType<typeof vi.fn>).mockClear();

    const { runAgent } = await import("./runner.js");
    await runAgent({
      agentId: "alpha",
      message: "/think high say hi",
      sessionId: "session-pre-4",
    });

    expect(flushUserMessage).toHaveBeenCalledTimes(1);
    const acceptedBuffer = (flushUserMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][2] as { events: Array<{ type: string; text: string }> };
    expect(acceptedBuffer.events).toEqual([
      { type: "user", text: "say hi", attachments: undefined, timestamp: expect.any(Number) },
    ]);
    expect(adapter.run).toHaveBeenCalledWith(
      expect.objectContaining({ message: "say hi" })
    );
  });

  it("single flush across thinking-level fallback retries", async () => {
    const adapter = createAdapter();
    let attempt = 0;
    adapter.run.mockImplementation(async (params: {
      onHistoryEvent: (event: unknown) => void;
    }) => {
      attempt += 1;
      params.onHistoryEvent({
        type: "user",
        text: "fallback me",
        timestamp: attempt,
      });
      if (attempt === 1) {
        throw new Error("thinking level not supported");
      }
      return { text: "ok" };
    });
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({ reasoning: "high" }));

    const { flushUserMessage } = await import("../history/store.js");
    (flushUserMessage as ReturnType<typeof vi.fn>).mockClear();

    const { runAgent } = await import("./runner.js");
    await runAgent({
      agentId: "alpha",
      message: "fallback me",
      sessionId: "session-pre-5",
    });

    expect(adapter.run).toHaveBeenCalledTimes(2);
    expect(flushUserMessage).toHaveBeenCalledTimes(1);
  });
});

describe("runAgent core session auto-title", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAbortTrigger.mockReturnValue(false);
    getTask.mockResolvedValue(undefined);
  });

  it("starts titling only after the done event", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));
    const sawTitleAtDone: boolean[] = [];

    const { runAgent } = await import("./runner.js");
    await runAgent({
      agentId: "alpha",
      message: "hello",
      sessionId: "session-title",
      onEvent: (event) => {
        if (event.type === "done") sawTitleAtDone.push(maybeAutoTitleSession.mock.calls.length > 0);
      },
    });

    expect(sawTitleAtDone).toEqual([false]);
    expect(maybeAutoTitleSession).toHaveBeenCalledWith({
      agentId: "alpha",
      sessionId: "session-title",
      userId: undefined,
    });
  });

  it("does not title aborted runs", async () => {
    const adapter = createAdapter();
    adapter.run.mockResolvedValue({ text: "partial", aborted: true });
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));

    const { runAgent } = await import("./runner.js");
    await runAgent({ agentId: "alpha", message: "hello", sessionId: "session-aborted" });

    expect(maybeAutoTitleSession).not.toHaveBeenCalled();
  });
});

describe("runAgent control commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAbortTrigger.mockReturnValue(false);
    getTask.mockResolvedValue(undefined);
  });

  it("pauses the active durable task for an explicit abort command", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));
    isAbortTrigger.mockReturnValue(true);
    const { setSessionStreaming } = await import("./sessions.js");
    setSessionStreaming("alpha", "session-1", true);

    const { runAgent } = await import("./runner.js");
    await runAgent({
      agentId: "alpha",
      message: "/abort",
      sessionId: "session-1",
      userId: "user-1",
    });

    expect(pauseTaskForControlCommand).toHaveBeenCalledWith(
      "alpha",
      "session-1",
      "/abort",
      "user-1"
    );
  });

  it("does not alter task state for ordinary follow-ups", async () => {
    const adapter = createAdapter();
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));

    const { runAgent } = await import("./runner.js");
    await runAgent({ agentId: "alpha", message: "moment", sessionId: "session-2" });

    expect(pauseTaskForControlCommand).not.toHaveBeenCalled();
  });

  it.each(["web", "slack"])(
    "queues a %s fragment instead of interrupting active work",
    async (source) => {
      const adapter = createAdapter();
      getSdkAdapter.mockReturnValue(adapter);
      getAgent.mockReturnValue(createAgent({ queueMode: "interrupt" }));
      getTask.mockResolvedValue({ id: "task-a", status: "active" });
      const { setSessionStreaming } = await import("./sessions.js");
      setSessionStreaming("alpha", `session-${source}`, true);

      const { runAgent } = await import("./runner.js");
      const result = await runAgent({
        agentId: "alpha",
        message: "moment",
        sessionId: `session-${source}`,
        source,
      });

      expect(result.meta).toMatchObject({ queued: true });
      expect(adapter.run).not.toHaveBeenCalled();
      expect(pauseTaskForControlCommand).not.toHaveBeenCalled();
    }
  );
});

describe("runAgent silent response", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isAbortTrigger.mockReturnValue(false);
    getTask.mockResolvedValue(undefined);
  });

  it("suppresses NO_REPLY text while retaining normal completion", async () => {
    const adapter = createAdapter();
    adapter.run.mockImplementation(async (params: { onEvent: (event: unknown) => void }) => {
      params.onEvent({ type: "text", data: "NO_" });
      params.onEvent({ type: "text", data: "REPLY" });
      return { text: "NO_REPLY" };
    });
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));
    const onEvent = vi.fn();

    const { runAgent } = await import("./runner.js");
    const result = await runAgent({
      agentId: "alpha",
      message: "do not reply",
      sessionId: "silent-session",
      onEvent,
    });

    expect(result.payloads).toEqual([]);
    expect(result.meta.silent).toBe(true);
    expect(onEvent.mock.calls.map(([event]) => event.type)).toEqual(["done"]);
  });

  it("streams an earlier assistant message but suppresses a final NO_REPLY message", async () => {
    const adapter = createAdapter();
    adapter.run.mockImplementation(async (params: { onEvent: (event: unknown) => void }) => {
      params.onEvent({ type: "text", data: "Let me check" });
      params.onEvent({ type: "tool_start", toolName: "check" });
      params.onEvent({ type: "tool_end", toolName: "check" });
      params.onEvent({ type: "text", data: "NO_REPLY" });
      return { text: "NO_REPLY" };
    });
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));
    const onEvent = vi.fn();

    const { runAgent } = await import("./runner.js");
    const result = await runAgent({
      agentId: "alpha",
      message: "check",
      sessionId: "silent-multi-message",
      onEvent,
    });

    expect(result.payloads).toEqual([]);
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "text", data: "Let me check" },
      { type: "tool_start", toolName: "check" },
      { type: "tool_end", toolName: "check" },
      expect.objectContaining({ type: "done" }),
    ]);
  });

  it("flushes buffered non-token text before a thrown failure", async () => {
    const adapter = createAdapter();
    adapter.run.mockImplementation(async (params: { onEvent: (event: unknown) => void }) => {
      params.onEvent({ type: "text", data: "NO" });
      throw new Error("failed");
    });
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));
    const onEvent = vi.fn();

    const { runAgent } = await import("./runner.js");
    await expect(runAgent({
      agentId: "alpha",
      message: "fail",
      sessionId: "buffered-failure",
      onEvent,
    })).rejects.toThrow("failed");
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "text", data: "NO" },
      { type: "error", message: "failed" },
    ]);
  });

  it("returns non-silent result text unchanged", async () => {
    const adapter = createAdapter();
    adapter.run.mockResolvedValue({ text: "Hello NO_REPLY world" });
    getSdkAdapter.mockReturnValue(adapter);
    getAgent.mockReturnValue(createAgent({}));

    const { runAgent } = await import("./runner.js");
    const result = await runAgent({
      agentId: "alpha",
      message: "hello",
      sessionId: "non-silent-token",
    });
    expect(result.payloads).toEqual([{ text: "Hello NO_REPLY world" }]);
  });
});
