import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, Extension, GatewayConfig } from "@yoplai/shared";
import type { SdkRunParams } from "../../types.js";
import {
  clearConfigCacheForTests,
  setLoadedConfig,
} from "../../../config/index.js";

const mockCreateAgentSession = vi.fn();
const mockGetLoadedExtensions = vi.fn<() => Partial<Extension>[]>(() => []);
const mockGetExtensionAgentTools = vi.fn<() => Promise<unknown[]>>(
  async () => []
);

const RELACE_ERROR =
  "Upstream error from Relace: Queued past the 0.2s queue-time bound. Retry after 0s.";

vi.mock("../../sessions/store.js", () => ({
  getSessionCreatedAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../sessions/files.js", () => ({
  resolveSessionDataFile: vi.fn(
    async () => "/tmp/yoplai-test/sessions/session-1.jsonl"
  ),
}));

vi.mock("../../extensions/registry.js", () => ({
  getLoadedExtensions: mockGetLoadedExtensions,
}));

vi.mock("../../../extensions/tools.js", () => ({
  getExtensionAgentTools: mockGetExtensionAgentTools,
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getEnvApiKey: vi.fn(() => "env-api-key"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mockCreateAgentSession,
  SessionManager: {
    open: vi.fn(() => ({ close: vi.fn() })),
  },
  SettingsManager: {
    create: vi.fn(() => ({})),
  },
  readStoredCredential: vi.fn(() => undefined),
  ModelRuntime: {
    create: vi.fn(async () => ({
      getModel: vi.fn(() => ({ provider: "anthropic" })),
      getAuth: vi.fn(async () => ({ auth: { apiKey: "runtime-key" } })),
      setRuntimeApiKey: vi.fn(async () => undefined),
    })),
  },
  DefaultResourceLoader: class {
    async reload() {
      return undefined;
    }
  },
}));

type MockMessage = {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
};

function makeSession() {
  const state = { messages: [] as MockMessage[], systemPrompt: "You are Pi." };
  const agent = { state, continue: vi.fn(async () => undefined) };
  return {
    get messages() {
      return state.messages;
    },
    agent,
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn(async () => undefined),
    abort: vi.fn(),
    dispose: vi.fn(),
  };
}

function erroredTurn(errorMessage = RELACE_ERROR): MockMessage {
  return { role: "assistant", content: [], stopReason: "error", errorMessage };
}

function successTurn(text = "recovered"): MockMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
  };
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "pi-agent",
    name: "Pi Agent",
    workspace: "~/agents/pi-agent",
    sdk: "pi",
    queueMode: "queue",
    model: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" },
    ...overrides,
  } as AgentConfig;
}

function makeRunParams(
  agent: AgentConfig,
  abortSignal = new AbortController().signal
): SdkRunParams {
  return {
    agentId: agent.id,
    agent,
    sessionId: "session-1",
    message: "Say hi",
    workspaceDir: "/tmp/workspace",
    onEvent: vi.fn(),
    onHistoryEvent: vi.fn(),
    abortSignal,
  };
}

function retryWarnings(
  warn: ReturnType<typeof vi.spyOn>
): Array<{ msg: string; agentId?: string }> {
  return warn.mock.calls
    .map((call) => JSON.parse(String(call[0])) as { msg: string })
    .filter((entry) => entry.msg.includes("retrying transient provider error"));
}

describe("pi adapter transient provider retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearConfigCacheForTests();
    mockGetLoadedExtensions.mockReturnValue([]);
    mockGetExtensionAgentTools.mockResolvedValue([]);
  });

  it("retries a failed turn that follows tool activity without re-sending the prompt", async () => {
    const agent = makeAgent();
    setLoadedConfig({ agents: [agent] } as GatewayConfig);
    const session = makeSession();
    session.prompt.mockImplementationOnce(async () => {
      session.agent.state.messages.push(
        { role: "user", content: [{ type: "text", text: "Say hi" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "tool-1" }] },
        { role: "toolResult", content: [{ type: "text", text: "hi" }] },
        erroredTurn()
      );
    });
    session.agent.continue.mockImplementationOnce(async () => {
      session.agent.state.messages.push(successTurn());
    });
    mockCreateAgentSession.mockResolvedValue({ session });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { piAdapter } = await import("../adapter.js");
    const result = await piAdapter.run(makeRunParams(agent));

    expect(result).toEqual({ text: "recovered", aborted: false });
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
    expect(session.agent.state.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(retryWarnings(warn)).toEqual([
      {
        level: "warn",
        msg: `[agent] retrying transient provider error (attempt 1, delay 0s): ${RELACE_ERROR}`,
        agentId: "pi-agent",
      },
    ]);
  });

  it("does not retry a non-transient failure", async () => {
    const agent = makeAgent();
    setLoadedConfig({ agents: [agent] } as GatewayConfig);
    const session = makeSession();
    session.prompt.mockImplementationOnce(async () => {
      session.agent.state.messages.push(
        { role: "user", content: [{ type: "text", text: "Say hi" }] },
        erroredTurn("Invalid request: mock fatal")
      );
    });
    mockCreateAgentSession.mockResolvedValue({ session });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { piAdapter } = await import("../adapter.js");

    await expect(piAdapter.run(makeRunParams(agent))).rejects.toThrow(
      "Agent error: Invalid request: mock fatal"
    );
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.agent.continue).not.toHaveBeenCalled();
    expect(retryWarnings(warn)).toEqual([]);
  });

  it("stops retrying at retryMaxAttempts and fails the run", async () => {
    const agent = makeAgent({ retryMaxAttempts: 2, retryBaseDelay: 1 });
    setLoadedConfig({ agents: [agent] } as GatewayConfig);
    const session = makeSession();
    session.prompt.mockImplementationOnce(async () => {
      session.agent.state.messages.push(
        { role: "user", content: [{ type: "text", text: "Say hi" }] },
        erroredTurn()
      );
    });
    session.agent.continue.mockImplementation(async () => {
      session.agent.state.messages.push(erroredTurn());
    });
    mockCreateAgentSession.mockResolvedValue({ session });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { piAdapter } = await import("../adapter.js");

    await expect(piAdapter.run(makeRunParams(agent))).rejects.toThrow(
      `Agent error: ${RELACE_ERROR}`
    );
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
    expect(retryWarnings(warn)).toHaveLength(1);
  });

  it("does not retry an aborted run", async () => {
    const agent = makeAgent();
    setLoadedConfig({ agents: [agent] } as GatewayConfig);
    const controller = new AbortController();
    const session = makeSession();
    session.prompt.mockImplementationOnce(async () => {
      controller.abort();
      session.agent.state.messages.push(
        { role: "user", content: [{ type: "text", text: "Say hi" }] },
        erroredTurn()
      );
    });
    mockCreateAgentSession.mockResolvedValue({ session });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { piAdapter } = await import("../adapter.js");

    await expect(
      piAdapter.run(makeRunParams(agent, controller.signal))
    ).rejects.toThrow(`Agent error: ${RELACE_ERROR}`);
    expect(session.agent.continue).not.toHaveBeenCalled();
    expect(retryWarnings(warn)).toEqual([]);
  });
});
