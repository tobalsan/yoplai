import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ExtensionContext, GatewayConfig } from "@yoplai/shared";
import { clearSlackClientCache, createSlackDeliverySink } from "./agent-tools.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import { clearSlackContext, setSlackContext } from "./context.js";
import { createProactiveDmNoteStore } from "./proactive-dm-notes.js";
import type { SlackBot } from "./bot.js";
import type { SlackWebClient } from "./types.js";

vi.mock("./proactive-dm-notes.js", () => ({
  createProactiveDmNoteStore: vi.fn(() => ({
    addNote: vi.fn(),
    close: vi.fn(),
  })),
}));

function agent(id: string): AgentConfig {
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    workspaceDir: `/tmp/${id}`,
    model: { provider: "test", model: "test" },
    queueMode: "queue",
  };
}

function config(): GatewayConfig {
  return {
    version: 3,
    agents: [],
    extensions: undefined,
    sessions: { idleMinutes: 360 },
    agentFab: false,
  } as unknown as GatewayConfig;
}

function registerMockBot(agentId: string, client: Partial<SlackWebClient>): void {
  registerActiveBot(agentId, {
    agentId,
    app: { client },
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as SlackBot);
}

function ctx(): ExtensionContext {
  return { getConfig: () => config() } as unknown as ExtensionContext;
}

describe("slack delivery sink", () => {
  afterEach(() => {
    clearActiveBots();
    clearSlackClientCache();
    clearSlackContext();
    vi.clearAllMocks();
  });

  it("sends to the channel ID for a channel destination", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "1.1" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    const sink = createSlackDeliverySink(ctx());

    await sink({
      agent: agent("alpha"),
      destination: { channel: "C0123456789" },
      text: "cron result",
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C0123456789",
      mrkdwn: true,
    });
  });

  it("sends to the user ID via the channel param for a user destination", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "2.2" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    const sink = createSlackDeliverySink(ctx());

    await sink({
      agent: agent("alpha"),
      destination: { user: "U0123456789" },
      text: "cron result",
    });

    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "U0123456789",
      mrkdwn: true,
    });
  });

  it("stays successful when the proactive-DM note write fails after the post", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "3.3" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    const close = vi.fn();
    vi.mocked(createProactiveDmNoteStore).mockReturnValueOnce({
      addNote: vi.fn(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }),
      close,
    } as never);
    const warn = vi.fn();
    setSlackContext({
      getConfig: () => config(),
      getDataDir: () => "/tmp/slack-data",
      logger: { info: vi.fn(), warn, error: vi.fn() },
    } as unknown as ExtensionContext);
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({
        agent: agent("alpha"),
        destination: { user: "U0123456789" },
        text: "digest",
      })
    ).resolves.toBeUndefined();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("SQLITE_BUSY: database is locked")
    );
  });

  it("throws when the destination has neither channel nor user", async () => {
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({ agent: agent("alpha"), destination: {}, text: "cron result" })
    ).rejects.toThrow("Slack delivery requires a channel or user destination.");
  });

  it("throws when no Slack client can be resolved for the agent", async () => {
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({
        agent: agent("alpha"),
        destination: { channel: "C1" },
        text: "cron result",
      })
    ).rejects.toThrow("No Slack token is configured for this agent.");
  });
});
