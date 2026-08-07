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
  backfillFromPiSession: vi.fn(),
  bufferHistoryEvent: vi.fn(),
  createTurnBuffer: vi.fn(() => ({})),
  flushTurnBuffer: vi.fn(),
  flushUserMessage: vi.fn(),
  getFullHistory: vi.fn(),
  getSimpleHistory: vi.fn(),
  hasCanonicalHistory: vi.fn(),
  invalidateResolvedHistoryFile: vi.fn(),
  readPiSessionHistory: vi.fn(),
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
