import type { AgentConfig, SlackComponentConfig } from "@yoplai/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllHistory } from "./utils/history.js";
import { clearActiveBots } from "./bot-registry.js";

type MockSlackApp = {
  config: Record<string, unknown>;
  client: {
    auth: { test: ReturnType<typeof vi.fn> };
    chat: {
      postMessage: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
      postEphemeral: ReturnType<typeof vi.fn>;
    };
    files: { uploadV2: ReturnType<typeof vi.fn> };
    conversations: {
      info: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
    reactions: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
  };
  message: ReturnType<typeof vi.fn>;
  event: ReturnType<typeof vi.fn>;
  command: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

type SlackMessageCallback = (args: {
  message: Record<string, unknown>;
  client: MockSlackApp["client"];
  body?: Record<string, unknown>;
}) => Promise<void>;

type SlackEventCallback = (args: {
  event: Record<string, unknown>;
  client: MockSlackApp["client"];
  body?: Record<string, unknown>;
}) => Promise<void>;

const apps: MockSlackApp[] = [];
const receivers: Array<Record<string, unknown>> = [];

vi.mock("@slack/bolt", () => ({
  SocketModeReceiver: vi.fn((config: Record<string, unknown>) => {
    const receiver = { config };
    receivers.push(receiver);
    return receiver;
  }),
  App: vi.fn((config: Record<string, unknown>) => {
    const app: MockSlackApp = {
      config,
      client: {
        auth: {
          test: vi.fn().mockResolvedValue({ user_id: "Ubot", bot_id: "Bbot" }),
        },
        chat: {
          postMessage: vi.fn().mockResolvedValue({ ts: "reply-ts" }),
          update: vi.fn().mockResolvedValue({}),
          delete: vi.fn().mockResolvedValue({}),
          postEphemeral: vi.fn().mockResolvedValue({}),
        },
        files: { uploadV2: vi.fn().mockResolvedValue({}) },
        conversations: {
          info: vi.fn().mockResolvedValue({ channel: { name: "general" } }),
          history: vi.fn().mockResolvedValue({ messages: [] }),
        },
        reactions: {
          add: vi.fn().mockResolvedValue({}),
          remove: vi.fn().mockResolvedValue({}),
        },
      },
      message: vi.fn(),
      event: vi.fn(),
      command: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    apps.push(app);
    return app;
  }),
}));

const mockRunAgent = vi.fn();
const mockGetSessionEntry = vi.fn();
const mockClearSessionEntry = vi.fn();
const mockDeleteSession = vi.fn();
const mockInvalidateHistoryCache = vi.fn();
const mockSaveMediaFile = vi.fn();
const mockReadMediaFile = vi.fn();
let dataDir = "";

vi.mock("./context.js", () => ({
  getSlackContext: vi.fn(() => ({
    runAgent: mockRunAgent,
    saveMediaFile: mockSaveMediaFile,
    readMediaFile: mockReadMediaFile,
    getDataDir: () => dataDir,
    getSessionEntry: mockGetSessionEntry,
    clearSessionEntry: mockClearSessionEntry,
    deleteSession: mockDeleteSession,
    invalidateHistoryCache: mockInvalidateHistoryCache,
    subscribe: () => () => {},
  })),
  getSlackContextIfInitialized: vi.fn(() => ({
    getDataDir: () => dataDir,
  })),
}));

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
    C1: { agent: "main", requireMention: false },
  },
};

function getMessageHandler(app: MockSlackApp): SlackMessageCallback {
  return app.message.mock.calls[0]?.[0] as SlackMessageCallback;
}

function getEventHandler(
  app: MockSlackApp,
  name: "app_mention"
): SlackEventCallback {
  const call = app.event.mock.calls.find(([eventName]) => eventName === name);
  return call?.[1] as SlackEventCallback;
}

describe("Slack inbound event deduplication", () => {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-dedupe-"));
    apps.length = 0;
    receivers.length = 0;
    vi.clearAllMocks();
    clearAllHistory();
    mockGetSessionEntry.mockResolvedValue(undefined);
    mockClearSessionEntry.mockResolvedValue({
      sessionId: "session",
      updatedAt: 1,
      createdAt: 1,
    });
    mockDeleteSession.mockReturnValue(undefined);
    mockInvalidateHistoryCache.mockResolvedValue(undefined);
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, sessionId: "session" },
    });
  });

  afterEach(async () => {
    clearActiveBots();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("collapses a Slack retry of the same event into a single agent turn", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    const message = {
      ts: "1.1",
      text: "hello",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };
    const body = { event_id: "Ev1", team_id: "T1" };

    await messageHandler({ message, client: apps[0].client, body });
    // Slack redelivers the same event_id on retry.
    await messageHandler({ message, client: apps[0].client, body });

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("collapses the overlapping message and app_mention deliveries for one user action into a single agent turn", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    const mentionHandler = getEventHandler(apps[0], "app_mention");

    const shared = {
      ts: "1.1",
      text: "hello",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };

    // Slack delivers a `message` event and, separately, an `app_mention`
    // event for the same user action, each with a distinct event_id but
    // the same channel/ts.
    await messageHandler({
      message: shared,
      client: apps[0].client,
      body: { event_id: "Ev-message", team_id: "T1" },
    });
    await mentionHandler({
      event: shared,
      client: apps[0].client,
      body: { event_id: "Ev-mention", team_id: "T1" },
    });

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("still produces two agent turns for two distinct events", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    const body = { event_id: "Ev1", team_id: "T1" };

    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
      body,
    });
    await messageHandler({
      message: {
        ts: "1.2",
        text: "hello again",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
      body: { event_id: "Ev2", team_id: "T1" },
    });

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it("still answers the app_mention delivery when the message delivery is ignored", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], {
      ...config,
      channels: { C1: { agent: "main", requireMention: true } },
    });
    // auth.test failing leaves botUserId undefined, so the `message` delivery
    // cannot see the mention and is dropped as `mention_required`. It must not
    // consume the shared channel/ts claim that the app_mention delivery needs.
    apps[0].client.auth.test.mockRejectedValue(new Error("invalid_auth"));
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    const mentionHandler = getEventHandler(apps[0], "app_mention");
    const shared = {
      ts: "1.1",
      text: "<@Ubot> deploy please",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };

    await messageHandler({
      message: shared,
      client: apps[0].client,
      body: { event_id: "Ev-message", team_id: "T1" },
    });
    await mentionHandler({
      event: shared,
      client: apps[0].client,
      body: { event_id: "Ev-mention", team_id: "T1" },
    });

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("does not let one bot's claim suppress a sibling bot's copy of the message", async () => {
    const { createSlackBot } = await import("./bot.js");
    const botA = createSlackBot([agent], config);
    const botB = createSlackBot([{ ...agent, id: "other", name: "Other" }], {
      ...config,
      channels: { C1: { agent: "other", requireMention: false } },
    });
    await botA?.start();
    await botB?.start();

    const shared = {
      ts: "1712.0001",
      text: "deploy please",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };

    // Two Slack apps, one user message: distinct event_ids, same team/channel/ts.
    await getMessageHandler(apps[0])({
      message: shared,
      client: apps[0].client,
      body: { event_id: "Ev_A", team_id: "T1" },
    });
    await getMessageHandler(apps[1])({
      message: shared,
      client: apps[1].client,
      body: { event_id: "Ev_B", team_id: "T1" },
    });

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });
});

describe("Slack inbound event claim release on failure", () => {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-dedupe-"));
    apps.length = 0;
    receivers.length = 0;
    vi.clearAllMocks();
    clearAllHistory();
    mockGetSessionEntry.mockResolvedValue(undefined);
    mockClearSessionEntry.mockResolvedValue({
      sessionId: "session",
      updatedAt: 1,
      createdAt: 1,
    });
    mockDeleteSession.mockReturnValue(undefined);
    mockInvalidateHistoryCache.mockResolvedValue(undefined);
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, sessionId: "session" },
    });
  });

  afterEach(async () => {
    clearActiveBots();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("does not suppress a retry when handling throws without the failure being reported", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    const message = {
      ts: "1.1",
      text: "hello",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };
    const body = { event_id: "Ev1", team_id: "T1" };

    // The agent turn fails, and even the error report back to Slack fails
    // (e.g. Slack itself is unreachable), so the user was never told anything.
    mockRunAgent.mockRejectedValueOnce(new Error("agent boom"));
    apps[0].client.chat.postMessage.mockRejectedValueOnce(
      new Error("slack unreachable")
    );

    await expect(
      messageHandler({ message, client: apps[0].client, body })
    ).rejects.toThrow("slack unreachable");

    // Slack retries the same event; it must produce a second agent turn
    // rather than being suppressed as a duplicate of the lost delivery.
    await messageHandler({ message, client: apps[0].client, body });

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
  });

  it("still suppresses a retry when handling fails but the error is successfully reported", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    const message = {
      ts: "1.1",
      text: "hello",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };
    const body = { event_id: "Ev1", team_id: "T1" };

    // The agent turn fails, but the error report to Slack succeeds: the user
    // was told, so this counts as successfully handled.
    mockRunAgent.mockRejectedValueOnce(new Error("agent boom"));

    await messageHandler({ message, client: apps[0].client, body });
    // Slack redelivers the same event; it must still be suppressed.
    await messageHandler({ message, client: apps[0].client, body });

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("per-agent Slack bot inbound event deduplication", () => {
  const slackAgent: AgentConfig = {
    ...agent,
    slack: {
      token: "xoxb-agent",
      appToken: "xapp-agent",
      channels: {
        C1: {
          agent: "main",
          requireMention: false,
          reactionNotifications: "off",
        },
      },
    },
  };

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-dedupe-"));
    apps.length = 0;
    receivers.length = 0;
    vi.clearAllMocks();
    clearAllHistory();
    mockGetSessionEntry.mockResolvedValue(undefined);
    mockInvalidateHistoryCache.mockResolvedValue(undefined);
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, sessionId: "session" },
    });
  });

  afterEach(async () => {
    clearActiveBots();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("collapses a Slack retry of the same event into a single agent turn", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const bot = createSlackAgentBot(slackAgent);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    const message = {
      ts: "1.1",
      text: "hello",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };
    const body = { event_id: "Ev1", team_id: "T1" };

    await messageHandler({ message, client: apps[0].client, body });
    await messageHandler({ message, client: apps[0].client, body });

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });

  it("collapses the overlapping message and app_mention deliveries into a single agent turn", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const bot = createSlackAgentBot(slackAgent);
    await bot?.start();

    const shared = {
      ts: "1.1",
      text: "hello",
      channel: "C1",
      user: "U1",
      channel_type: "channel",
    };

    await getMessageHandler(apps[0])({
      message: shared,
      client: apps[0].client,
      body: { event_id: "Ev-message", team_id: "T1" },
    });
    await getEventHandler(apps[0], "app_mention")({
      event: shared,
      client: apps[0].client,
      body: { event_id: "Ev-mention", team_id: "T1" },
    });

    expect(mockRunAgent).toHaveBeenCalledTimes(1);
  });
});
