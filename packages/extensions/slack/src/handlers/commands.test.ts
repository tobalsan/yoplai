import type { AgentConfig, SlackComponentConfig } from "@yoplai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleAbortCommand,
  handleHelpCommand,
  handleNewCommand,
  handlePingCommand,
  type SlackCommandTarget,
} from "./commands.js";
import { getSlackContext } from "../context.js";

vi.mock("../context.js", () => ({
  getSlackContext: vi.fn(),
}));

const mockRunAgent = vi.fn();
const mockClearSessionEntry = vi.fn();
const mockDeleteSession = vi.fn();
const mockInvalidateHistoryCache = vi.fn();

const agent: AgentConfig = {
  id: "main",
  name: "Main",
  workspace: "~/main",
  model: { provider: "anthropic", model: "claude" },
  queueMode: "queue",
};

const config: SlackComponentConfig = {
  token: "xoxb-test",
  appToken: "xapp-test",
  channels: {
    C1: { agent: "main", threadPolicy: "always" },
  },
  dm: { enabled: true, agent: "main" },
};

const target: SlackCommandTarget = {
  agent,
  config,
  channelConfig: config.channels?.C1,
  isDm: false,
};

describe("Slack command handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSlackContext).mockReturnValue({
      runAgent: mockRunAgent,
      clearSessionEntry: mockClearSessionEntry,
      deleteSession: mockDeleteSession,
      invalidateHistoryCache: mockInvalidateHistoryCache,
    } as never);
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, sessionId: "session" },
    });
    mockClearSessionEntry.mockResolvedValue({
      sessionId: "session",
      updatedAt: 1,
      createdAt: 1,
    });
    mockInvalidateHistoryCache.mockResolvedValue(undefined);
  });

  it("clears /new against the route session without running the agent", async () => {
    const respond = vi.fn();
    await handleNewCommand(
      { channel_id: "C1", user_id: "U1", text: "" },
      target,
      respond
    );

    expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "slack:C1");
    expect(mockDeleteSession).toHaveBeenCalledWith("main", "session");
    expect(mockInvalidateHistoryCache).toHaveBeenCalledWith(
      "main",
      "session"
    );
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "Context cleared, new session started.",
      response_type: "ephemeral",
    });
  });

  it("runs /stop against requested session", async () => {
    const respond = vi.fn();
    await handleAbortCommand(
      { channel_id: "C1", user_id: "U1", text: "custom" },
      target,
      respond
    );
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({ message: "/stop", sessionKey: "custom" })
    );
  });

  it("uses main session for DMs", async () => {
    const respond = vi.fn();
    await handleNewCommand(
      { channel_id: "D1", user_id: "U1", text: "" },
      { ...target, isDm: true, channelConfig: undefined },
      respond
    );
    expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "main");
  });

  it("responds to help and ping ephemerally", async () => {
    const helpRespond = vi.fn();
    const pingRespond = vi.fn();
    await handleHelpCommand({ channel_id: "C1", user_id: "U1" }, target, helpRespond);
    await handlePingCommand({ channel_id: "C1", user_id: "U1" }, target, pingRespond);

    expect(helpRespond.mock.calls[0][0].text).toContain("/new");
    expect(helpRespond.mock.calls[0][0].text).toContain("/stop");
    expect(helpRespond.mock.calls[0][0].text).toContain("!new");
    expect(helpRespond.mock.calls[0][0].text).toContain("!stop");
    expect(helpRespond.mock.calls[0][0].text).not.toContain("/abort");
    expect(helpRespond.mock.calls[0][0].response_type).toBe("ephemeral");
    expect(pingRespond.mock.calls[0][0].text).toContain("Main");
    expect(pingRespond.mock.calls[0][0].response_type).toBe("ephemeral");
  });
});
