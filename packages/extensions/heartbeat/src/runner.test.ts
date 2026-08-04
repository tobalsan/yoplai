import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  parseDurationMs,
  stripHeartbeatToken,
  containsHeartbeatToken,
  evaluateHeartbeatReply,
  isHeartbeatEnabled,
  getHeartbeatIntervalMs,
  loadHeartbeatPrompt,
  DEFAULT_HEARTBEAT_PROMPT,
} from "./runner.js";
import type {
  AgentConfig,
  ExtensionContext,
  HeartbeatConfig,
  HeartbeatEventPayload,
} from "@yoplai/shared";

// Helper to create minimal agent config for testing
function createAgent(heartbeat?: HeartbeatConfig): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    workspace: "~/test",
    model: { model: "test-model" },
    queueMode: "queue",
    heartbeat,
  };
}

describe("parseDurationMs", () => {
  describe("valid durations", () => {
    it("parses plain number as minutes (default)", () => {
      expect(parseDurationMs("5")).toBe(5 * 60 * 1000);
      expect(parseDurationMs("30")).toBe(30 * 60 * 1000);
      expect(parseDurationMs("1")).toBe(60 * 1000);
    });

    it("parses minutes with unit", () => {
      expect(parseDurationMs("5m")).toBe(5 * 60 * 1000);
      expect(parseDurationMs("30min")).toBe(30 * 60 * 1000);
      expect(parseDurationMs("1m")).toBe(60 * 1000);
    });

    it("parses hours", () => {
      expect(parseDurationMs("1h")).toBe(60 * 60 * 1000);
      expect(parseDurationMs("2hr")).toBe(2 * 60 * 60 * 1000);
      expect(parseDurationMs("24h")).toBe(24 * 60 * 60 * 1000);
    });

    it("parses seconds", () => {
      expect(parseDurationMs("30s")).toBe(30 * 1000);
      expect(parseDurationMs("60sec")).toBe(60 * 1000);
    });

    it("handles whitespace", () => {
      expect(parseDurationMs("  5m  ")).toBe(5 * 60 * 1000);
      expect(parseDurationMs(" 1h ")).toBe(60 * 60 * 1000);
    });

    it("handles case insensitivity", () => {
      expect(parseDurationMs("5M")).toBe(5 * 60 * 1000);
      expect(parseDurationMs("1H")).toBe(60 * 60 * 1000);
      expect(parseDurationMs("30S")).toBe(30 * 1000);
    });

    it("respects defaultUnit option", () => {
      expect(parseDurationMs("5", { defaultUnit: "h" })).toBe(
        5 * 60 * 60 * 1000
      );
      expect(parseDurationMs("30", { defaultUnit: "s" })).toBe(30 * 1000);
    });
  });

  describe("disabled values", () => {
    it("returns null for zero", () => {
      expect(parseDurationMs("0")).toBeNull();
      expect(parseDurationMs("0m")).toBeNull();
      expect(parseDurationMs("0h")).toBeNull();
      expect(parseDurationMs("0s")).toBeNull();
    });
  });

  describe("invalid values", () => {
    it("returns null for undefined", () => {
      expect(parseDurationMs(undefined)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseDurationMs("")).toBeNull();
      expect(parseDurationMs("   ")).toBeNull();
    });

    it("returns null for invalid format", () => {
      expect(parseDurationMs("abc")).toBeNull();
      expect(parseDurationMs("5x")).toBeNull();
      expect(parseDurationMs("-5m")).toBeNull();
    });
  });
});

describe("stripHeartbeatToken", () => {
  describe("plain token", () => {
    it("strips plain HEARTBEAT_OK", () => {
      expect(stripHeartbeatToken("HEARTBEAT_OK")).toBe("");
      expect(stripHeartbeatToken("  HEARTBEAT_OK  ")).toBe("");
    });

    it("strips case-insensitive variants", () => {
      expect(stripHeartbeatToken("heartbeat_ok")).toBe("");
      expect(stripHeartbeatToken("Heartbeat_OK")).toBe("");
      expect(stripHeartbeatToken("HEARTBEAT_ok")).toBe("");
    });

    it("strips token from middle of text", () => {
      expect(
        stripHeartbeatToken("All good! HEARTBEAT_OK - nothing to report")
      ).toBe("All good!  - nothing to report");
    });

    it("strips token from start of text", () => {
      expect(stripHeartbeatToken("HEARTBEAT_OK - nothing to report")).toBe(
        "- nothing to report"
      );
    });

    it("strips token from end of text", () => {
      expect(stripHeartbeatToken("All good! HEARTBEAT_OK")).toBe("All good!");
    });
  });

  describe("HTML wrapped tokens", () => {
    it("strips <b> wrapped token", () => {
      expect(stripHeartbeatToken("<b>HEARTBEAT_OK</b>")).toBe("");
      expect(stripHeartbeatToken("All good! <b>HEARTBEAT_OK</b>")).toBe(
        "All good!"
      );
    });

    it("strips <strong> wrapped token", () => {
      expect(stripHeartbeatToken("<strong>HEARTBEAT_OK</strong>")).toBe("");
      expect(
        stripHeartbeatToken("Status: <strong>HEARTBEAT_OK</strong> done")
      ).toBe("Status:  done");
    });

    it("strips <em> wrapped token", () => {
      expect(stripHeartbeatToken("<em>HEARTBEAT_OK</em>")).toBe("");
    });

    it("strips <i> wrapped token", () => {
      expect(stripHeartbeatToken("<i>HEARTBEAT_OK</i>")).toBe("");
    });

    it("strips <code> wrapped token", () => {
      expect(stripHeartbeatToken("<code>HEARTBEAT_OK</code>")).toBe("");
    });

    it("strips <span> wrapped token", () => {
      expect(
        stripHeartbeatToken('<span class="status">HEARTBEAT_OK</span>')
      ).toBe("");
    });
  });

  describe("Markdown wrapped tokens", () => {
    it("strips ** wrapped token (bold)", () => {
      expect(stripHeartbeatToken("**HEARTBEAT_OK**")).toBe("");
      expect(stripHeartbeatToken("All good! **HEARTBEAT_OK**")).toBe(
        "All good!"
      );
    });

    it("strips * wrapped token (italic)", () => {
      expect(stripHeartbeatToken("*HEARTBEAT_OK*")).toBe("");
    });

    // Note: underscore-wrapped tokens (_HEARTBEAT_OK_) are not stripped because
    // underscore is a word character and would cause issues with variable names
    // like MY_HEARTBEAT_OK_VALUE. This is an acceptable limitation since models
    // typically use * for markdown emphasis, not underscore.
    it("does not strip underscore-wrapped tokens (word boundary limitation)", () => {
      expect(stripHeartbeatToken("_HEARTBEAT_OK_")).toBe("_HEARTBEAT_OK_");
      expect(stripHeartbeatToken("__HEARTBEAT_OK__")).toBe("__HEARTBEAT_OK__");
    });
  });

  describe("preserves surrounding content", () => {
    it("preserves text before and after token", () => {
      expect(
        stripHeartbeatToken(
          "I checked everything. HEARTBEAT_OK. Will continue monitoring."
        )
      ).toBe("I checked everything. . Will continue monitoring.");
    });

    it("handles multiple tokens", () => {
      expect(stripHeartbeatToken("HEARTBEAT_OK - HEARTBEAT_OK")).toBe("-");
    });

    it("does not strip partial matches", () => {
      expect(stripHeartbeatToken("HEARTBEAT_OKAY")).toBe("HEARTBEAT_OKAY");
      expect(stripHeartbeatToken("XHEARTBEAT_OK")).toBe("XHEARTBEAT_OK");
      // Word boundaries: underscore is a word character, so _HEARTBEAT_OK_ won't match
      expect(stripHeartbeatToken("MY_HEARTBEAT_OK_VALUE")).toBe(
        "MY_HEARTBEAT_OK_VALUE"
      );
    });
  });
});

describe("containsHeartbeatToken", () => {
  it("returns true for plain token", () => {
    expect(containsHeartbeatToken("HEARTBEAT_OK")).toBe(true);
    expect(containsHeartbeatToken("Status: HEARTBEAT_OK")).toBe(true);
  });

  it("returns true for wrapped tokens", () => {
    expect(containsHeartbeatToken("**HEARTBEAT_OK**")).toBe(true);
    expect(containsHeartbeatToken("<b>HEARTBEAT_OK</b>")).toBe(true);
  });

  it("returns false for no token", () => {
    expect(containsHeartbeatToken("Everything is fine")).toBe(false);
    expect(containsHeartbeatToken("")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(containsHeartbeatToken("heartbeat_ok")).toBe(true);
    expect(containsHeartbeatToken("Heartbeat_Ok")).toBe(true);
  });
});

describe("evaluateHeartbeatReply", () => {
  const DEFAULT_ACK_MAX_CHARS = 300;

  describe("empty replies", () => {
    it("returns ok-empty for undefined reply", () => {
      const result = evaluateHeartbeatReply(undefined, DEFAULT_ACK_MAX_CHARS);
      expect(result.status).toBe("ok-empty");
      expect(result.shouldDeliver).toBe(false);
      expect(result.strippedText).toBe("");
    });

    it("returns ok-empty for empty string", () => {
      const result = evaluateHeartbeatReply("", DEFAULT_ACK_MAX_CHARS);
      expect(result.status).toBe("ok-empty");
      expect(result.shouldDeliver).toBe(false);
    });

    it("returns ok-empty for whitespace-only", () => {
      const result = evaluateHeartbeatReply("   \n\t  ", DEFAULT_ACK_MAX_CHARS);
      expect(result.status).toBe("ok-empty");
      expect(result.shouldDeliver).toBe(false);
    });
  });

  describe("token-only replies", () => {
    it("returns ok-token for plain HEARTBEAT_OK", () => {
      const result = evaluateHeartbeatReply(
        "HEARTBEAT_OK",
        DEFAULT_ACK_MAX_CHARS
      );
      expect(result.status).toBe("ok-token");
      expect(result.shouldDeliver).toBe(false);
      expect(result.strippedText).toBe("");
    });

    it("returns ok-token for wrapped HEARTBEAT_OK", () => {
      const result = evaluateHeartbeatReply(
        "**HEARTBEAT_OK**",
        DEFAULT_ACK_MAX_CHARS
      );
      expect(result.status).toBe("ok-token");
      expect(result.shouldDeliver).toBe(false);
    });

    it("returns ok-token when remaining text is within threshold", () => {
      const result = evaluateHeartbeatReply(
        "HEARTBEAT_OK - All good!",
        DEFAULT_ACK_MAX_CHARS
      );
      expect(result.status).toBe("ok-token");
      expect(result.shouldDeliver).toBe(false);
      expect(result.strippedText).toBe("- All good!");
    });
  });

  describe("alert replies", () => {
    it("returns sent for text without token", () => {
      const result = evaluateHeartbeatReply(
        "Hey! I noticed something you should know about.",
        DEFAULT_ACK_MAX_CHARS
      );
      expect(result.status).toBe("sent");
      expect(result.shouldDeliver).toBe(true);
      expect(result.strippedText).toBe(
        "Hey! I noticed something you should know about."
      );
    });

    it("returns sent when stripped text exceeds ackMaxChars", () => {
      const longText = "A".repeat(350);
      const result = evaluateHeartbeatReply(
        `HEARTBEAT_OK ${longText}`,
        DEFAULT_ACK_MAX_CHARS
      );
      expect(result.status).toBe("sent");
      expect(result.shouldDeliver).toBe(true);
      expect(result.strippedText.length).toBeGreaterThan(DEFAULT_ACK_MAX_CHARS);
    });
  });

  describe("ackMaxChars threshold", () => {
    it("respects custom threshold", () => {
      const text = "HEARTBEAT_OK - Short note";

      // With high threshold, should not deliver
      const result1 = evaluateHeartbeatReply(text, 100);
      expect(result1.shouldDeliver).toBe(false);

      // With low threshold, should deliver
      const result2 = evaluateHeartbeatReply(text, 5);
      expect(result2.shouldDeliver).toBe(true);
    });

    it("threshold of 0 delivers any non-empty text with token", () => {
      const result = evaluateHeartbeatReply("HEARTBEAT_OK a", 0);
      expect(result.shouldDeliver).toBe(true);
    });
  });
});

describe("isHeartbeatEnabled", () => {
  it("returns false when no heartbeat config", () => {
    const agent = createAgent(undefined);
    expect(isHeartbeatEnabled(agent)).toBe(false);
  });

  it("returns false for empty heartbeat config", () => {
    const agent = createAgent({});
    expect(isHeartbeatEnabled(agent)).toBe(false);
  });

  it("returns true for heartbeat with valid interval", () => {
    const agent = createAgent({ every: "30m" });
    expect(isHeartbeatEnabled(agent)).toBe(true);
  });

  it("returns false for heartbeat disabled with 0", () => {
    const agent = createAgent({ every: "0" });
    expect(isHeartbeatEnabled(agent)).toBe(false);
  });

  it("returns false for heartbeat disabled with 0m", () => {
    const agent = createAgent({ every: "0m" });
    expect(isHeartbeatEnabled(agent)).toBe(false);
  });
});

describe("getHeartbeatIntervalMs", () => {
  it("returns null when heartbeat disabled", () => {
    const agent = createAgent(undefined);
    expect(getHeartbeatIntervalMs(agent)).toBeNull();
  });

  it("returns null when heartbeat config has no interval", () => {
    const agent = createAgent({});
    expect(getHeartbeatIntervalMs(agent)).toBeNull();
  });

  it("returns configured interval", () => {
    const agent = createAgent({ every: "1h" });
    expect(getHeartbeatIntervalMs(agent)).toBe(60 * 60 * 1000);
  });

  it("returns null for invalid interval", () => {
    const agent = createAgent({ every: "invalid" });
    expect(getHeartbeatIntervalMs(agent)).toBeNull();
  });
});

describe("loadHeartbeatPrompt", () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Create a unique temp directory for each test
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-test-"));

    const module = await import("./runner.js");
    module.clearHeartbeatContext();
    module.setHeartbeatContext({
      getConfig: () => ({ agents: [] }) as never,
      getDataDir: () => "/tmp",
      reloadConfig: () => undefined,
      getAgent: () => undefined,
      getAgents: () => [],
      isAgentActive: () => false,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: (agent) => agent.workspace,
      runAgent: async () => ({
        payloads: [],
        meta: { durationMs: 0, sessionId: "s" },
      }),
      getSubagentTemplates: () => [],
      resolveSessionId: async () => undefined,
      getSessionEntry: async () => undefined,
      clearSessionEntry: async () => undefined,
      restoreSessionUpdatedAt: () => undefined,
      deleteSession: () => undefined,
      invalidateHistoryCache: async () => undefined,
      getSessionHistory: async () => [],
      registerDeliverySink: () => () => undefined,
      getDeliverySink: () => undefined,
      subscribe: () => () => undefined,
      emit: () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
  });

  afterEach(async () => {
    // Clean up temp directory
    try {
      await fs.rm(tmpDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }

    const module = await import("./runner.js");
    module.clearHeartbeatContext();
  });

  function createAgentWithWorkspace(heartbeat?: HeartbeatConfig): AgentConfig {
    return {
      id: "test-agent",
      name: "Test Agent",
      workspace: tmpDir,
      model: { model: "test-model" },
      queueMode: "queue",
      heartbeat,
    };
  }

  describe("config prompt (priority 1)", () => {
    it("uses config prompt when set", async () => {
      const customPrompt = "Check on critical systems every hour.";
      const agent = createAgentWithWorkspace({ prompt: customPrompt });
      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(customPrompt);
    });

    it("uses config prompt even when HEARTBEAT.md exists", async () => {
      const customPrompt = "Use this config prompt";
      const agent = createAgentWithWorkspace({ prompt: customPrompt });

      // Create HEARTBEAT.md in workspace (should be ignored)
      await fs.writeFile(
        path.join(tmpDir, "HEARTBEAT.md"),
        "# This should be ignored\nFile prompt content here."
      );

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(customPrompt);
    });
  });

  describe("HEARTBEAT.md file (priority 2)", () => {
    it("reads HEARTBEAT.md when config prompt is not set", async () => {
      const agent = createAgentWithWorkspace({});
      const fileContent =
        "# Daily Check\nReview dashboards and report anomalies.";

      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), fileContent);

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(fileContent);
    });

    it("trims whitespace from HEARTBEAT.md content", async () => {
      const agent = createAgentWithWorkspace({});
      const fileContent = "\n\n  Check systems daily.  \n\n";

      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), fileContent);

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe("Check systems daily.");
    });

    it("falls back to default when HEARTBEAT.md is empty", async () => {
      const agent = createAgentWithWorkspace({});

      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "   \n\n   ");

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT);
    });

    it("falls back to default when HEARTBEAT.md is whitespace only", async () => {
      const agent = createAgentWithWorkspace({});

      await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "");

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT);
    });
  });

  describe("default prompt (priority 3)", () => {
    it("uses default when no config prompt and no HEARTBEAT.md", async () => {
      const agent = createAgentWithWorkspace({});

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT);
    });

    it("uses default when heartbeat config is undefined", async () => {
      const agent = createAgentWithWorkspace(undefined);

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT);
    });
  });

  describe("error handling", () => {
    it("does not crash when HEARTBEAT.md is missing", async () => {
      const agent = createAgentWithWorkspace({});
      // No HEARTBEAT.md file exists

      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT);
    });

    it("does not crash when workspace directory does not exist", async () => {
      const agent: AgentConfig = {
        id: "test-agent",
        name: "Test Agent",
        workspace: "/nonexistent/path/that/does/not/exist",
        model: { model: "test-model" },
        queueMode: "queue",
        heartbeat: { every: "5m" },
      };

      // Should not throw, should return default
      const result = await loadHeartbeatPrompt(agent);
      expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT);
    });

    it("falls back to default when HEARTBEAT.md has read permission issues", async () => {
      // Skip on Windows where chmod may not work as expected
      if (process.platform === "win32") {
        return;
      }

      const agent = createAgentWithWorkspace({});
      const heartbeatPath = path.join(tmpDir, "HEARTBEAT.md");

      await fs.writeFile(heartbeatPath, "Secret content");
      await fs.chmod(heartbeatPath, 0o000); // Remove all permissions

      try {
        const result = await loadHeartbeatPrompt(agent);
        expect(result).toBe(DEFAULT_HEARTBEAT_PROMPT);
      } finally {
        // Restore permissions for cleanup
        await fs.chmod(heartbeatPath, 0o644);
      }
    });
  });
});

// Tests for runHeartbeat session preservation
// These tests verify the scope: "Session preservation: restore updatedAt so heartbeat doesn't keep sessions alive"

// Mock ExtensionContext surface
const mockGetAgent = vi.fn();
const mockGetSessionEntry = vi.fn();
const mockRestoreSessionUpdatedAt = vi.fn();
const mockIsStreaming = vi.fn();
const mockResolveSessionId = vi.fn();
const mockRunAgent = vi.fn();
const mockResolveWorkspaceDir = vi.fn();
const mockGetConfig = vi.fn();
const mockLoadConfig = mockGetConfig;
const mockEmit = vi.fn();
const mockSubscribe = vi.fn();
const mockGetAgents = vi.fn();
const mockGetDataDir = vi.fn();
const mockReloadConfig = vi.fn();
const mockIsAgentActive = vi.fn();
const mockGetSubagentTemplates = vi.fn();
const mockClearSessionEntry = vi.fn();
const mockDeleteSession = vi.fn();
const mockInvalidateHistoryCache = vi.fn();
const mockGetSessionHistory = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
const mockLoggerError = vi.fn();

function createMockExtensionContext(): ExtensionContext {
  return {
    getConfig: mockGetConfig,
    getDataDir: mockGetDataDir,
    reloadConfig: mockReloadConfig,
    getAgent: mockGetAgent,
    getAgents: mockGetAgents,
    isAgentActive: mockIsAgentActive,
    isAgentStreaming: mockIsStreaming,
    resolveWorkspaceDir: mockResolveWorkspaceDir,
    runAgent: mockRunAgent,
    getSubagentTemplates: mockGetSubagentTemplates,
    resolveSessionId: mockResolveSessionId,
    getSessionEntry: mockGetSessionEntry,
    clearSessionEntry: mockClearSessionEntry,
    restoreSessionUpdatedAt: mockRestoreSessionUpdatedAt,
    deleteSession: mockDeleteSession,
    invalidateHistoryCache: mockInvalidateHistoryCache,
    getSessionHistory: mockGetSessionHistory,
    registerDeliverySink: () => () => undefined,
    getDeliverySink: () => undefined,
    subscribe: mockSubscribe,
    emit: mockEmit,
    logger: {
      info: mockLoggerInfo,
      warn: mockLoggerWarn,
      error: mockLoggerError,
    },
  };
}

async function getRunnerModuleWithContext() {
  const module = await import("./runner.js");
  module.stopAllHeartbeats();
  module.clearHeartbeatContext();
  module.setHeartbeatsEnabled(true);
  module.setHeartbeatContext(createMockExtensionContext());
  return module;
}

function resetContextMocks(): void {
  vi.clearAllMocks();
  mockGetAgent.mockReset();
  mockGetSessionEntry.mockReset();
  mockRestoreSessionUpdatedAt.mockReset();
  mockIsStreaming.mockReset();
  mockResolveSessionId.mockReset();
  mockRunAgent.mockReset();
  mockResolveWorkspaceDir.mockReset();
  mockGetConfig.mockReset();
  mockEmit.mockReset();
  mockSubscribe.mockReset();
  mockGetAgents.mockReset();
  mockGetDataDir.mockReset();
  mockIsAgentActive.mockReset();
  mockGetSubagentTemplates.mockReset();
  mockClearSessionEntry.mockReset();
  mockDeleteSession.mockReset();
  mockInvalidateHistoryCache.mockReset();
  mockGetSessionHistory.mockReset();
  mockLoggerInfo.mockReset();
  mockLoggerWarn.mockReset();
  mockLoggerError.mockReset();

  mockRestoreSessionUpdatedAt.mockReturnValue(undefined);
  mockIsStreaming.mockReturnValue(false);
  mockResolveWorkspaceDir.mockReturnValue("/test/workspace");
  mockResolveSessionId.mockResolvedValue({
    sessionId: "test-session-id",
    updatedAt: 1000,
  });
  mockRunAgent.mockResolvedValue({
    payloads: [{ text: "HEARTBEAT_OK" }],
    meta: { durationMs: 10, sessionId: "test-session-id" },
  });
  mockGetConfig.mockReturnValue({
    agents: [],
    extensions: { scheduler: {}, heartbeat: {} },
  });
  mockGetAgents.mockImplementation(() => {
    const config = mockGetConfig();
    return Array.isArray(config.agents) ? config.agents : [];
  });
  mockGetDataDir.mockReturnValue("/tmp");
  mockIsAgentActive.mockReturnValue(true);
  mockGetSubagentTemplates.mockReturnValue([]);
  mockClearSessionEntry.mockResolvedValue(undefined);
  mockDeleteSession.mockReturnValue(undefined);
  mockInvalidateHistoryCache.mockResolvedValue(undefined);
  mockGetSessionHistory.mockResolvedValue([]);
}

describe("runHeartbeat session preservation", () => {
  beforeEach(async () => {
    vi.resetModules();
    resetContextMocks();
  });

  // Helper to get mocked runHeartbeat
  async function getRunHeartbeatWithMocks() {
    const module = await getRunnerModuleWithContext();
    return module.runHeartbeat;
  }

  it("captures original updatedAt before attempting run", async () => {
    const originalUpdatedAt = 1000;
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({
      sessionId: "existing-session",
      updatedAt: originalUpdatedAt,
      createdAt: 500,
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();
    await runHeartbeat("test-agent");

    // Verify getSessionEntry was called to capture original updatedAt
    expect(mockGetSessionEntry).toHaveBeenCalledWith("test-agent", "main");
  });

  it("restores updatedAt when session is streaming (queue busy)", async () => {
    const originalUpdatedAt = 1000;
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({
      sessionId: "streaming-session",
      updatedAt: originalUpdatedAt,
    });
    mockIsStreaming.mockReturnValue(true);

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("streaming");
    expect(mockRestoreSessionUpdatedAt).toHaveBeenCalledWith(
      "test-agent",
      "main",
      originalUpdatedAt
    );
  });

  it("restores updatedAt when no broadcastToChannel configured", async () => {
    const originalUpdatedAt = 1000;
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: {}, // No broadcastToChannel
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: originalUpdatedAt,
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no broadcastToChannel");
    expect(mockRestoreSessionUpdatedAt).toHaveBeenCalledWith(
      "test-agent",
      "main",
      originalUpdatedAt
    );
  });

  it("restores updatedAt when reply is ok-empty", async () => {
    const originalUpdatedAt = 1000;
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: originalUpdatedAt,
    });
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "" }], // Empty reply
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("ok-empty");
    expect(mockRestoreSessionUpdatedAt).toHaveBeenCalledWith(
      "test-agent",
      "main",
      originalUpdatedAt
    );
  });

  it("restores updatedAt when reply is ok-token", async () => {
    const originalUpdatedAt = 1000;
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: originalUpdatedAt,
    });
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "HEARTBEAT_OK" }],
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("ok-token");
    expect(mockRestoreSessionUpdatedAt).toHaveBeenCalledWith(
      "test-agent",
      "main",
      originalUpdatedAt
    );
  });

  it("does NOT restore updatedAt when alert should be delivered (sent status)", async () => {
    const originalUpdatedAt = 1000;
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: originalUpdatedAt,
    });
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "Hey! Something important happened!" }], // No HEARTBEAT_OK token
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("sent");
    // Should NOT restore since we're delivering an alert
    expect(mockRestoreSessionUpdatedAt).not.toHaveBeenCalled();
  });

  it("restores updatedAt when runAgent throws error", async () => {
    const originalUpdatedAt = 1000;
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: originalUpdatedAt,
    });
    mockRunAgent.mockRejectedValue(new Error("Agent error"));

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("Agent error");
    expect(mockRestoreSessionUpdatedAt).toHaveBeenCalledWith(
      "test-agent",
      "main",
      originalUpdatedAt
    );
  });

  it("safely handles when session entry does not exist (first run)", async () => {
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue(undefined); // No existing session
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "HEARTBEAT_OK" }],
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();

    // Should not throw
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("ok-token");
    // No restore call when no original updatedAt
    expect(mockRestoreSessionUpdatedAt).not.toHaveBeenCalled();
  });

  it("writes heartbeat output for completed runs", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "heartbeat-output-")
    );
    mockResolveWorkspaceDir.mockReturnValue(tmpDir);
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m", prompt: "check in" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: tmpDir,
    });
    mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });
    mockResolveSessionId.mockResolvedValue({ sessionId: "session-1" });
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "older" }, { text: "All good HEARTBEAT_OK" }],
      meta: { sessionId: "session-1" },
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("ok-token");
    const outputDir = path.join(tmpDir, "cron", "output", "__heartbeat__");
    let files: string[] = [];
    await vi.waitFor(async () => {
      files = await fs.readdir(outputDir);
      expect(files).toHaveLength(1);
    });
    const content = await fs.readFile(path.join(outputDir, files[0]), "utf-8");
    expect(content).toContain('job_id: "__heartbeat__"');
    expect(content).toContain("run_type: heartbeat");
    expect(content).toContain("result_status: ok");
    expect(content).toContain("# Heartbeat");
    expect(content).toContain("## Prompt\n\ncheck in");
    expect(content).toContain("## Response\n\nAll good HEARTBEAT_OK");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes heartbeat output for failed runs", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "heartbeat-output-")
    );
    mockResolveWorkspaceDir.mockReturnValue(tmpDir);
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m", prompt: "check in" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: tmpDir,
    });
    mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });
    mockResolveSessionId.mockResolvedValue({ sessionId: "session-1" });
    mockRunAgent.mockRejectedValue(new Error("API timeout"));

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("failed");
    const outputDir = path.join(tmpDir, "cron", "output", "__heartbeat__");
    let files: string[] = [];
    await vi.waitFor(async () => {
      files = await fs.readdir(outputDir);
      expect(files).toHaveLength(1);
    });
    const content = await fs.readFile(path.join(outputDir, files[0]), "utf-8");
    expect(content).toContain("status: error");
    expect(content).toContain("result_status: error");
    expect(content).toContain("## Error");
    expect(content).toContain("API timeout");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("noops when scheduler is disabled", async () => {
    mockGetConfig.mockReturnValue({
      agents: [],
      extensions: { scheduler: { enabled: false }, heartbeat: {} },
    });
    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });

    const runHeartbeat = await getRunHeartbeatWithMocks();
    const result = await runHeartbeat("test-agent");

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("scheduler disabled or unavailable");
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("does not restore updatedAt when global heartbeats disabled (no run attempted)", async () => {
    vi.resetModules();
    resetContextMocks();

    mockGetAgent.mockReturnValue({
      id: "test-agent",
      heartbeat: { every: "5m" },
      discord: { broadcastToChannel: "channel-1" },
      workspace: "/test",
    });
    mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

    const module = await getRunnerModuleWithContext();
    module.setHeartbeatsEnabled(false);

    const result = await module.runHeartbeat("test-agent");

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("disabled");
    expect(mockRestoreSessionUpdatedAt).not.toHaveBeenCalled();

    module.setHeartbeatsEnabled(true);
  });
});

// Tests for heartbeat lifecycle: start/stop timers, interval timing, graceful shutdown
// These tests verify the scope: "Lifecycle wiring: start/stop timers with gateway process lifecycle"

describe("heartbeat lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    resetContextMocks();
    mockResolveSessionId.mockResolvedValue({
      sessionId: "test-session",
      updatedAt: 1000,
    });
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "HEARTBEAT_OK" }],
      meta: { durationMs: 10, sessionId: "test-session" },
    });
  });

  afterEach(async () => {
    const module = await import("./runner.js");
    module.stopAllHeartbeats();
    module.clearHeartbeatContext();
    vi.useRealTimers();
  });

  async function getLifecycleModule() {
    return await getRunnerModuleWithContext();
  }

  describe("startAllHeartbeats", () => {
    it("creates timers for enabled agents on startup", async () => {
      mockLoadConfig.mockReturnValue({
        agents: [
          { id: "agent-1", heartbeat: { every: "5m" } },
          { id: "agent-2", heartbeat: { every: "10m" } },
          { id: "agent-3" }, // No heartbeat config
        ],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockImplementation((id: string) => {
        const agents: Record<string, object> = {
          "agent-1": { id: "agent-1", heartbeat: { every: "5m" } },
          "agent-2": { id: "agent-2", heartbeat: { every: "10m" } },
          "agent-3": { id: "agent-3" },
        };
        return agents[id];
      });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      const activeHeartbeats = module.getActiveHeartbeats();
      expect(activeHeartbeats).toContain("agent-1");
      expect(activeHeartbeats).toContain("agent-2");
      expect(activeHeartbeats).not.toContain("agent-3"); // No heartbeat config

      // Cleanup
      module.stopAllHeartbeats();
    });

    it("does not start heartbeat when heartbeat block absent", async () => {
      mockLoadConfig.mockReturnValue({
        agents: [{ id: "agent-no-hb" }],
      });
      mockGetAgent.mockReturnValue({ id: "agent-no-hb" });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).not.toContain("agent-no-hb");
      module.stopAllHeartbeats();
    });

    it("does not start heartbeat when every is 0", async () => {
      mockLoadConfig.mockReturnValue({
        agents: [{ id: "agent-disabled", heartbeat: { every: "0" } }],
      });
      mockGetAgent.mockReturnValue({
        id: "agent-disabled",
        heartbeat: { every: "0" },
      });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).not.toContain("agent-disabled");
      module.stopAllHeartbeats();
    });

    it("does not warn when scheduler is disabled and no agent has heartbeat", async () => {
      const agent = { id: "agent-no-hb" };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: { enabled: false }, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).toEqual([]);
      expect(mockLoggerWarn).not.toHaveBeenCalledWith(
        expect.stringContaining(
          "Scheduler extension is disabled or unavailable"
        )
      );
    });

    it("warns and noops when scheduler is disabled and heartbeat is configured", async () => {
      const agent = { id: "agent-hb", heartbeat: { every: "5m" } };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: { enabled: false }, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).toEqual([]);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Scheduler extension is disabled or unavailable"
        )
      );
    });

    it("warns and noops when scheduler extension is unavailable and heartbeat is configured", async () => {
      const agent = { id: "agent-hb", heartbeat: { every: "5m" } };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).toEqual([]);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Scheduler extension is disabled or unavailable"
        )
      );
    });

    it("warns and noops when extensions block is absent and heartbeat is configured", async () => {
      const agent = { id: "agent-hb", heartbeat: { every: "5m" } };
      mockLoadConfig.mockReturnValue({ agents: [agent] });
      mockGetAgent.mockReturnValue(agent);

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).toEqual([]);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          "Scheduler extension is disabled or unavailable"
        )
      );
    });

    it("uses getAgents so v3 config agent globs do not break iteration", async () => {
      mockLoadConfig.mockReturnValue({
        agents: "./agents/*",
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgents.mockReturnValue([
        { id: "agent-1", heartbeat: { every: "5m" } },
      ]);
      mockGetAgent.mockReturnValue({
        id: "agent-1",
        heartbeat: { every: "5m" },
      });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).toContain("agent-1");
      module.stopAllHeartbeats();
    });
  });

  describe("first heartbeat timing", () => {
    it("first heartbeat fires only after first interval (no immediate run)", async () => {
      const agent = {
        id: "agent-1",
        heartbeat: { every: "5m", prompt: "Ping" }, // 5 minutes = 300000ms
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // No immediate heartbeat run
      expect(mockRunAgent).not.toHaveBeenCalled();

      // Advance time by 4 minutes - still no heartbeat
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(mockRunAgent).not.toHaveBeenCalled();

      // Advance past 5 minutes - heartbeat should fire
      await vi.advanceTimersByTimeAsync(1 * 60 * 1000 + 100);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      module.stopAllHeartbeats();
    });

    it("does not start timer when every is absent", async () => {
      const agent = {
        id: "agent-default",
        heartbeat: { prompt: "Ping" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100);
      expect(mockRunAgent).not.toHaveBeenCalled();

      module.stopAllHeartbeats();
    });
  });

  describe("stopAllHeartbeats", () => {
    it("clears all timers on shutdown", async () => {
      mockLoadConfig.mockReturnValue({
        agents: [
          { id: "agent-1", heartbeat: { every: "5m" } },
          { id: "agent-2", heartbeat: { every: "10m" } },
        ],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockImplementation((id: string) => ({
        id,
        heartbeat: { every: id === "agent-1" ? "5m" : "10m" },
      }));

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats().length).toBe(2);

      module.stopAllHeartbeats();

      expect(module.getActiveHeartbeats().length).toBe(0);
    });

    it("no heartbeats fire after stop", async () => {
      const agent = {
        id: "agent-1",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // Stop immediately
      module.stopAllHeartbeats();

      // Advance past interval
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);

      // No heartbeat should have fired
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("does not reschedule after stop while a heartbeat run is pending", async () => {
      const agent = {
        id: "agent-1",
        heartbeat: { every: "1m", prompt: "Ping" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });
      let finishRun!: (value: unknown) => void;
      mockRunAgent.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishRun = resolve;
          })
      );

      const module = await getLifecycleModule();
      module.startAllHeartbeats();
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      module.stopAllHeartbeats();
      finishRun({
        payloads: [{ text: "HEARTBEAT_OK" }],
        meta: { sessionId: "test-session" },
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(mockRunAgent).toHaveBeenCalledTimes(1);
      expect(module.getActiveHeartbeats()).toEqual([]);
    });

    it("stops mid-cycle timer without affecting next cycle", async () => {
      const agent = {
        id: "agent-1",
        heartbeat: { every: "1m", prompt: "Ping" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // Let first heartbeat fire
      await vi.advanceTimersByTimeAsync(60 * 1000 + 100);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      // Stop before second heartbeat
      await vi.advanceTimersByTimeAsync(30 * 1000); // 30s into second cycle
      module.stopAllHeartbeats();

      // Advance more time - no more heartbeats
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(mockRunAgent).toHaveBeenCalledTimes(1); // Still just 1

      expect(module.getActiveHeartbeats().length).toBe(0);
    });
  });

  describe("individual agent start/stop", () => {
    it("startHeartbeat returns true for enabled agent", async () => {
      const agent = { id: "agent-1", heartbeat: { every: "5m" } };
      mockGetAgent.mockReturnValue(agent);
      mockLoadConfig.mockReturnValue({
        agents: [],
        extensions: { scheduler: {}, heartbeat: {} },
      });

      const module = await getLifecycleModule();
      const result = module.startHeartbeat("agent-1");

      expect(result).toBe(true);
      expect(module.getActiveHeartbeats()).toContain("agent-1");

      module.stopAllHeartbeats();
    });

    it("startHeartbeat returns false for disabled agent", async () => {
      mockGetAgent.mockReturnValue({
        id: "agent-1",
        heartbeat: { every: "0" },
      });
      mockLoadConfig.mockReturnValue({
        agents: [],
        extensions: { scheduler: {}, heartbeat: {} },
      });

      const module = await getLifecycleModule();
      const result = module.startHeartbeat("agent-1");

      expect(result).toBe(false);
      expect(module.getActiveHeartbeats()).not.toContain("agent-1");
    });

    it("startHeartbeat returns false when heartbeat config has no every", async () => {
      mockGetAgent.mockReturnValue({ id: "agent-1", heartbeat: {} });
      mockLoadConfig.mockReturnValue({
        agents: [],
        extensions: { scheduler: {}, heartbeat: {} },
      });

      const module = await getLifecycleModule();
      const result = module.startHeartbeat("agent-1");

      expect(result).toBe(false);
      expect(module.getActiveHeartbeats()).not.toContain("agent-1");
    });

    it("startHeartbeat returns false for unknown agent", async () => {
      mockGetAgent.mockReturnValue(undefined);
      mockLoadConfig.mockReturnValue({
        agents: [],
        extensions: { scheduler: {}, heartbeat: {} },
      });

      const module = await getLifecycleModule();
      const result = module.startHeartbeat("unknown-agent");

      expect(result).toBe(false);
    });

    it("stopHeartbeat clears specific agent timer", async () => {
      mockLoadConfig.mockReturnValue({
        agents: [
          { id: "agent-1", heartbeat: { every: "5m" } },
          { id: "agent-2", heartbeat: { every: "5m" } },
        ],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockImplementation((id: string) => ({
        id,
        heartbeat: { every: "5m" },
      }));

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      expect(module.getActiveHeartbeats()).toContain("agent-1");
      expect(module.getActiveHeartbeats()).toContain("agent-2");

      module.stopHeartbeat("agent-1");

      expect(module.getActiveHeartbeats()).not.toContain("agent-1");
      expect(module.getActiveHeartbeats()).toContain("agent-2");

      module.stopAllHeartbeats();
    });
  });

  describe("timer rescheduling", () => {
    it("reschedules timer after heartbeat completes", async () => {
      const agent = {
        id: "agent-1",
        heartbeat: { every: "1m", prompt: "Ping" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // First heartbeat at 1m - advance time and flush microtasks
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0); // flush async callback
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      // Second heartbeat at 2m
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);

      // Third heartbeat at 3m
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(3);

      module.stopAllHeartbeats();
    });

    it("continues rescheduling after runAgent fails", async () => {
      const agent = {
        id: "agent-1",
        heartbeat: { every: "1m", prompt: "Ping" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      // First call throws, subsequent calls succeed
      mockRunAgent
        .mockRejectedValueOnce(new Error("Agent error"))
        .mockResolvedValue({ payloads: [{ text: "HEARTBEAT_OK" }] });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // First heartbeat at 1m - throws error
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      // Second heartbeat at 2m - timer should have rescheduled despite error
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(2);

      // Third heartbeat at 3m - continues working
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(3);

      module.stopAllHeartbeats();
    });

    it("stops rescheduling when agent config removed between runs", async () => {
      let heartbeatEnabled = true;
      const enabledAgent = {
        id: "agent-1",
        heartbeat: { every: "1m", prompt: "Ping" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      const disabledAgent = {
        id: "agent-1",
        heartbeat: undefined, // Disabled
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };

      mockLoadConfig.mockReturnValue({
        agents: [{ id: "agent-1", heartbeat: { every: "1m" } }],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockImplementation(() =>
        heartbeatEnabled ? enabledAgent : disabledAgent
      );
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });
      mockRunAgent.mockImplementationOnce(async () => {
        heartbeatEnabled = false;
        return { payloads: [{ text: "HEARTBEAT_OK" }] };
      });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // First heartbeat fires
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      // Now reschedule check sees disabled config - no more heartbeats
      await vi.advanceTimersByTimeAsync(120 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      module.stopAllHeartbeats();
    });
  });

  describe("global toggle affects scheduled ticks", () => {
    it("scheduled tick skips heartbeat when globally disabled", async () => {
      const agent = {
        id: "agent-1",
        heartbeat: { every: "1m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // Disable heartbeats globally before first tick
      module.setHeartbeatsEnabled(false);

      // Advance past interval
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);

      // runAgent should NOT have been called (disabled)
      expect(mockRunAgent).not.toHaveBeenCalled();

      // Re-enable and verify heartbeats work again
      module.setHeartbeatsEnabled(true);
      await vi.advanceTimersByTimeAsync(60 * 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockRunAgent).toHaveBeenCalledTimes(1);

      module.stopAllHeartbeats();
    });

    it("toggle can be flipped at runtime and affects all agents", async () => {
      const agents = [
        {
          id: "agent-1",
          heartbeat: { every: "1m", prompt: "ping" },
          discord: { broadcastToChannel: "ch1" },
          workspace: "/t1",
        },
        {
          id: "agent-2",
          heartbeat: { every: "1m", prompt: "ping" },
          discord: { broadcastToChannel: "ch2" },
          workspace: "/t2",
        },
      ];
      mockLoadConfig.mockReturnValue({
        agents,
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockImplementation((id: string) =>
        agents.find((a) => a.id === id)
      );
      mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // Let first heartbeat cycle run
      await vi.advanceTimersByTimeAsync(60 * 1000 + 100);
      expect(mockRunAgent).toHaveBeenCalledTimes(2); // Both agents

      // Disable all
      module.setHeartbeatsEnabled(false);
      await vi.advanceTimersByTimeAsync(60 * 1000 + 100);
      expect(mockRunAgent).toHaveBeenCalledTimes(2); // No additional calls

      // Re-enable
      module.setHeartbeatsEnabled(true);
      await vi.advanceTimersByTimeAsync(60 * 1000 + 100);
      expect(mockRunAgent).toHaveBeenCalledTimes(4); // Both agents again

      module.stopAllHeartbeats();
    });
  });

  describe("graceful shutdown", () => {
    it("timer uses unref to not block process exit", async () => {
      // This test verifies behavior implicitly - timers with unref() allow process to exit
      // We test by ensuring stopAllHeartbeats cleans up properly
      const agent = {
        id: "agent-1",
        heartbeat: { every: "5m" },
      };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // Timer is active
      expect(module.getActiveHeartbeats().length).toBe(1);

      // Cleanup should be complete
      module.stopAllHeartbeats();
      expect(module.getActiveHeartbeats().length).toBe(0);
    });

    it("multiple stop calls are safe (idempotent)", async () => {
      const agent = { id: "agent-1", heartbeat: { every: "5m" } };
      mockLoadConfig.mockReturnValue({
        agents: [agent],
        extensions: { scheduler: {}, heartbeat: {} },
      });
      mockGetAgent.mockReturnValue(agent);

      const module = await getLifecycleModule();
      module.startAllHeartbeats();

      // Multiple stops should not throw
      module.stopAllHeartbeats();
      module.stopAllHeartbeats();
      module.stopAllHeartbeats();

      expect(module.getActiveHeartbeats().length).toBe(0);
    });

    it("stopHeartbeat on non-existent timer is safe", async () => {
      mockLoadConfig.mockReturnValue({
        agents: [],
        extensions: { scheduler: {}, heartbeat: {} },
      });

      const module = await getLifecycleModule();

      // Should not throw
      module.stopHeartbeat("non-existent-agent");
      expect(module.getActiveHeartbeats().length).toBe(0);
    });
  });
});

// Tests for heartbeat event emission
// These tests verify the scope: "Heartbeat status event emission (sent/ok-empty/ok-token/skipped/failed)"

describe("heartbeat event emission", () => {
  beforeEach(() => {
    vi.resetModules();
    resetContextMocks();
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "HEARTBEAT_OK" }],
      meta: { durationMs: 10, sessionId: "test-session" },
    });
    mockGetSessionEntry.mockReturnValue({ sessionId: "s", updatedAt: 1000 });
  });

  async function getEventModule() {
    return await getRunnerModuleWithContext();
  }

  describe("onHeartbeatEvent subscription", () => {
    it("listener receives event when heartbeat runs", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((payload) => {
        receivedEvents.push(payload);
      });

      await module.runHeartbeat("test-agent");

      expect(receivedEvents.length).toBe(1);
      expect(receivedEvents[0].agentId).toBe("test-agent");

      unsubscribe();
    });

    it("unsubscribe prevents further events", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((payload) => {
        receivedEvents.push(payload);
      });

      await module.runHeartbeat("test-agent");
      expect(receivedEvents.length).toBe(1);

      unsubscribe();

      await module.runHeartbeat("test-agent");
      expect(receivedEvents.length).toBe(1); // No additional events
    });

    it("multiple listeners all receive events", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });

      const module = await getEventModule();
      const events1: HeartbeatEventPayload[] = [];
      const events2: HeartbeatEventPayload[] = [];
      const events3: HeartbeatEventPayload[] = [];

      const unsub1 = module.onHeartbeatEvent((p) => events1.push(p));
      const unsub2 = module.onHeartbeatEvent((p) => events2.push(p));
      const unsub3 = module.onHeartbeatEvent((p) => events3.push(p));

      await module.runHeartbeat("test-agent");

      expect(events1.length).toBe(1);
      expect(events2.length).toBe(1);
      expect(events3.length).toBe(1);
      expect(events1[0]).toEqual(events2[0]);
      expect(events2[0]).toEqual(events3[0]);

      unsub1();
      unsub2();
      unsub3();
    });

    it("listener errors do not prevent other listeners from receiving events", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });

      const module = await getEventModule();
      const events: HeartbeatEventPayload[] = [];

      // First listener throws
      const unsub1 = module.onHeartbeatEvent(() => {
        throw new Error("Listener 1 error");
      });

      // Second listener should still receive event
      const unsub2 = module.onHeartbeatEvent((p) => events.push(p));

      // Third listener also throws
      const unsub3 = module.onHeartbeatEvent(() => {
        throw new Error("Listener 3 error");
      });

      // Should not throw despite listener errors
      await module.runHeartbeat("test-agent");

      // Second listener received the event
      expect(events.length).toBe(1);

      unsub1();
      unsub2();
      unsub3();
    });
  });

  describe("event payload structure", () => {
    it("includes ts, agentId, status for all events", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      const event = receivedEvents[0];
      expect(event.ts).toBeTypeOf("number");
      expect(event.ts).toBeGreaterThan(0);
      expect(event.agentId).toBe("test-agent");
      expect(event.status).toBeDefined();

      unsubscribe();
    });

    it("includes durationMs after successful run", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].durationMs).toBeTypeOf("number");
      expect(receivedEvents[0].durationMs).toBeGreaterThanOrEqual(0);

      unsubscribe();
    });

    it("includes reason when skipped or failed", async () => {
      // Test skipped with reason
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: {}, // No broadcastToChannel
        workspace: "/test",
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("skipped");
      expect(receivedEvents[0].reason).toBe("no broadcastToChannel");

      unsubscribe();
    });

    it("includes to channel ID when delivering alert", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "my-channel-123" },
        workspace: "/test",
      });
      mockRunAgent.mockResolvedValue({
        payloads: [{ text: "Alert! Something needs attention" }],
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("sent");
      expect(receivedEvents[0].to).toBe("my-channel-123");
      expect(receivedEvents[0].alertText).toBe(
        "Alert! Something needs attention"
      );

      unsubscribe();
    });

    it("excludes to and alertText when not delivering", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockRunAgent.mockResolvedValue({
        payloads: [{ text: "HEARTBEAT_OK" }],
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("ok-token");
      expect(receivedEvents[0].to).toBeUndefined();
      expect(receivedEvents[0].alertText).toBeUndefined();

      unsubscribe();
    });
  });

  describe("status mapping", () => {
    it("maps ok-empty for empty reply", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockRunAgent.mockResolvedValue({ payloads: [{ text: "" }] });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("ok-empty");

      unsubscribe();
    });

    it("maps ok-token for token-only reply", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockRunAgent.mockResolvedValue({
        payloads: [{ text: "**HEARTBEAT_OK**" }],
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("ok-token");

      unsubscribe();
    });

    it("maps sent for alert reply", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockRunAgent.mockResolvedValue({
        payloads: [{ text: "Important: check the logs immediately!" }],
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("sent");

      unsubscribe();
    });

    it("maps skipped for streaming session", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockIsStreaming.mockReturnValue(true);

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("skipped");
      expect(receivedEvents[0].reason).toBe("streaming");

      unsubscribe();
    });

    it("maps failed for exceptions", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockRunAgent.mockRejectedValue(new Error("API timeout"));

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("failed");
      expect(receivedEvents[0].reason).toBe("API timeout");

      unsubscribe();
    });
  });

  describe("preview field", () => {
    it("contains first 200 chars of stripped text", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      // Text longer than 200 chars
      const longText = "A".repeat(300);
      mockRunAgent.mockResolvedValue({ payloads: [{ text: longText }] });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].preview).toBeDefined();
      expect(receivedEvents[0].preview!.length).toBe(200);
      expect(receivedEvents[0].preview).toBe("A".repeat(200));

      unsubscribe();
    });

    it("does not truncate text shorter than 200 chars", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      const shortText = "Short alert message";
      mockRunAgent.mockResolvedValue({ payloads: [{ text: shortText }] });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].preview).toBe(shortText);
      expect(receivedEvents[0].preview!.length).toBeLessThan(200);

      unsubscribe();
    });

    it("handles exactly 200 chars correctly (boundary)", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      const exactText = "B".repeat(200);
      mockRunAgent.mockResolvedValue({ payloads: [{ text: exactText }] });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].preview).toBe(exactText);
      expect(receivedEvents[0].preview!.length).toBe(200);

      unsubscribe();
    });

    it("is undefined when stripped text is empty (ok-empty)", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockRunAgent.mockResolvedValue({ payloads: [{ text: "" }] });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("ok-empty");
      expect(receivedEvents[0].preview).toBeUndefined();

      unsubscribe();
    });

    it("is undefined when stripped text is empty after token removal (ok-token)", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      mockRunAgent.mockResolvedValue({ payloads: [{ text: "HEARTBEAT_OK" }] });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      expect(receivedEvents[0].status).toBe("ok-token");
      expect(receivedEvents[0].preview).toBeUndefined();

      unsubscribe();
    });

    it("strips token before calculating preview", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });
      // Long text with token in the middle
      const prefix = "Alert: ";
      const suffix = "C".repeat(300);
      mockRunAgent.mockResolvedValue({
        payloads: [{ text: `${prefix}HEARTBEAT_OK ${suffix}` }],
      });

      const module = await getEventModule();
      const receivedEvents: HeartbeatEventPayload[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) =>
        receivedEvents.push(p)
      );

      await module.runHeartbeat("test-agent");

      // Preview should be stripped text (prefix + suffix without token)
      expect(receivedEvents[0].preview).toBeDefined();
      expect(receivedEvents[0].preview!.length).toBe(200);
      expect(receivedEvents[0].preview!.startsWith("Alert:")).toBe(true);

      unsubscribe();
    });
  });

  describe("event observability", () => {
    it("events can be observed without breaking current consumers", async () => {
      mockGetAgent.mockReturnValue({
        id: "test-agent",
        heartbeat: { every: "5m" },
        discord: { broadcastToChannel: "channel-1" },
        workspace: "/test",
      });

      const module = await getEventModule();

      // Simulate consumer that logs events
      const loggedEvents: string[] = [];
      const unsubscribe = module.onHeartbeatEvent((p) => {
        loggedEvents.push(`[${p.status}] ${p.agentId}`);
      });

      // Run multiple heartbeats
      await module.runHeartbeat("test-agent");
      mockRunAgent.mockResolvedValue({
        payloads: [{ text: "Alert message" }],
      });
      await module.runHeartbeat("test-agent");

      expect(loggedEvents.length).toBe(2);
      expect(loggedEvents[0]).toContain("test-agent");
      expect(loggedEvents[1]).toContain("test-agent");

      unsubscribe();
    });
  });
});
