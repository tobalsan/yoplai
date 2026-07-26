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
  isAbortTrigger: vi.fn(() => false),
}));

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
