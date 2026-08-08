import type { AgentConfig, SlackComponentConfig } from "@yoplai/shared";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllHistory, getHistory, recordMessage } from "./utils/history.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import { createSlackThreadSessionBindingStore } from "./thread-session-bindings.js";

type MockStreamEvent = {
  type: "thinking" | "done" | "error" | "file_output";
  data?: string;
  fileId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  source?: string;
};

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
    files: {
      uploadV2: ReturnType<typeof vi.fn>;
    };
    conversations: {
      info: ReturnType<typeof vi.fn>;
      history: ReturnType<typeof vi.fn>;
    };
    reactions: {
      add: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
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
}) => Promise<void>;

type SlackCommandCallback = (args: {
  command: { channel_id: string; user_id: string; text?: string };
  ack: () => Promise<unknown>;
  respond: (message: unknown) => Promise<unknown>;
}) => Promise<void>;

type SlackEventCallback = (args: {
  event: Record<string, unknown>;
  client: MockSlackApp["client"];
}) => Promise<void>;

const apps: MockSlackApp[] = [];
const receivers: Array<Record<string, unknown>> = [];
const streamHandlers = vi.hoisted(
  () => [] as Array<(event: MockStreamEvent) => void | Promise<void>>
);

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
        files: {
          uploadV2: vi.fn().mockResolvedValue({}),
        },
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
    subscribe: (_event: string, handler: (payload: unknown) => void) => {
      const wrapped = (event: MockStreamEvent) => handler(event);
      streamHandlers.push(wrapped);
      return () => {
        const index = streamHandlers.indexOf(wrapped);
        if (index >= 0) streamHandlers.splice(index, 1);
      };
    },
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
    C1: {
      agent: "main",
      requireMention: false,
      reactionNotifications: "all",
    },
  },
  dm: { enabled: true, agent: "main" },
};

function getMessageHandler(app: MockSlackApp): SlackMessageCallback {
  return app.message.mock.calls[0]?.[0] as SlackMessageCallback;
}

function getEventHandler(
  app: MockSlackApp,
  name: "reaction_added" | "reaction_removed" | "app_mention"
): SlackEventCallback {
  const call = app.event.mock.calls.find(([eventName]) => eventName === name);
  return call?.[1] as SlackEventCallback;
}

function getCommandHandler(
  app: MockSlackApp,
  name: "/new" | "/stop" | "/help" | "/ping"
): SlackCommandCallback {
  const call = app.command.mock.calls.find(
    ([commandName]) => commandName === name
  );
  return call?.[1] as SlackCommandCallback;
}

describe("createSlackBot", () => {
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-notes-"));
    apps.length = 0;
    receivers.length = 0;
    streamHandlers.length = 0;
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
    mockSaveMediaFile.mockImplementation(
      async (data: Uint8Array, mimeType: string, filename?: string) => ({
        path: `/media/inbound/${filename ?? "file"}`,
        mimeType,
        filename,
        size: data.byteLength,
      })
    );
    mockReadMediaFile.mockResolvedValue({
      data: Buffer.from([4, 5, 6]),
      filename: "summary.pdf",
      mimeType: "application/pdf",
      size: 3,
    });
    mockRunAgent.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 1, sessionId: "session" },
    });
    vi.unstubAllGlobals();
  });

  afterEach(async () => {
    clearActiveBots();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("creates a Bolt Socket Mode app and registers handlers", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);

    expect(bot).not.toBeNull();
    expect(apps[0].config).toEqual({
      token: "xoxb-test",
      receiver: receivers[0],
    });
    expect(receivers[0]?.config).toEqual({
      appToken: "xapp-test",
      clientPingTimeout: 20000,
    });
    expect(apps[0].message).toHaveBeenCalledOnce();
    expect(apps[0].event).toHaveBeenCalledWith(
      "app_mention",
      expect.any(Function)
    );
    expect(apps[0].event).toHaveBeenCalledWith(
      "reaction_added",
      expect.any(Function)
    );
    expect(apps[0].event).toHaveBeenCalledWith(
      "reaction_removed",
      expect.any(Function)
    );
    expect(apps[0].command).toHaveBeenCalledTimes(4);
    expect(apps[0].command).toHaveBeenCalledWith("/stop", expect.any(Function));
    expect(apps[0].command).not.toHaveBeenCalledWith(
      "/abort",
      expect.any(Function)
    );
  });

  it("injects proactive DM notes once for user and IM-channel sends only", async () => {
    const { slackAgentTools } = await import("./agent-tools.js");
    const { createSlackBot } = await import("./bot.js");
    createSlackBot([agent], config);
    registerActiveBot("main", {
      agentId: "main",
      app: { client: apps[0].client },
      start: vi.fn(),
      stop: vi.fn(),
    } as never);
    const sendMessage = slackAgentTools().find(
      (tool) => tool.name === "slack.send_message"
    );
    if (!sendMessage) throw new Error("missing slack.send_message");

    await sendMessage.execute(
      { channel: "U1", text: "I sent the rollout details." },
      { agent, config: { extensions: { slack: config } } as never }
    );
    await sendMessage.execute(
      { channel: "D1", text: "I also sent the timeline." },
      { agent, config: { extensions: { slack: config } } as never }
    );
    await sendMessage.execute(
      { channel: "C1", text: "Channel-only update." },
      { agent, config: { extensions: { slack: config } } as never }
    );

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        thread_ts: "1.0",
        text: "What did you send in this thread?",
        channel: "D1",
        user: "U1",
        channel_type: "im",
      },
      client: apps[0].client,
    });
    expect(mockRunAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          blocks: expect.not.arrayContaining([
            expect.objectContaining({ type: "proactive_dm_notes" }),
          ]),
        }),
      })
    );

    await messageHandler({
      message: {
        ts: "1.2",
        text: "What did you send?",
        channel: "D1",
        user: "U1",
        channel_type: "im",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          blocks: expect.arrayContaining([
            {
              type: "proactive_dm_notes",
              notes: [
                "I sent the rollout details.",
                "I also sent the timeline.",
              ],
            },
          ]),
        }),
      })
    );

    await messageHandler({
      message: {
        ts: "1.3",
        text: "And now?",
        channel: "D1",
        user: "U1",
        channel_type: "im",
      },
      client: apps[0].client,
    });
    expect(mockRunAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          blocks: expect.not.arrayContaining([
            expect.objectContaining({ type: "proactive_dm_notes" }),
          ]),
        }),
      })
    );
  });

  it("starts and stops the Bolt app", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();
    await bot?.stop();

    expect(apps[0].client.auth.test).toHaveBeenCalledOnce();
    expect(apps[0].start).toHaveBeenCalledOnce();
    expect(apps[0].stop).toHaveBeenCalledOnce();
  });

  it("does not subscribe to broadcasts when Socket Mode startup fails", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    apps[0].start.mockRejectedValueOnce(new Error("connection failed"));

    await expect(bot?.start()).rejects.toThrow("connection failed");

    expect(streamHandlers).toHaveLength(0);
  });

  it("records history only after messages pass gating", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], {
      ...config,
      channels: { C1: { agent: "main" } },
    });
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello without mention",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(getHistory("C1", 10)).toEqual([]);
    expect(mockRunAgent).not.toHaveBeenCalled();

    await messageHandler({
      message: {
        ts: "2.2",
        text: "<@Ubot> hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(getHistory("C1", 10)).toEqual([
      expect.objectContaining({ author: "U1", content: "<@Ubot> hello" }),
    ]);
    expect(mockRunAgent).toHaveBeenCalledOnce();
  });

  it("converts direct replies to Slack mrkdwn", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();
    mockRunAgent.mockResolvedValueOnce({
      payloads: [{ text: "**ok** [docs](https://example.com)" }],
      meta: { durationMs: 1, sessionId: "session" },
    });

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "*ok* <https://example.com|docs>",
      })
    );
  });

  it("resumes a bound thread session and delivers its reply once", async () => {
    const store = createSlackThreadSessionBindingStore(dataDir);
    store.setBinding({
      channelId: "C1",
      threadTs: "1.0",
      sessionId: "bound-session",
      agentId: "main",
    });
    store.close();
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], {
      ...config,
      channels: { C1: { agent: "main" } },
    });
    await bot?.start();

    await getMessageHandler(apps[0])({
      message: {
        ts: "1.1",
        thread_ts: "1.0",
        text: "follow up",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "bound-session",
        sessionKey: "slack:C1:1.0",
        background: true,
      })
    );
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: "1.0", text: "ok" })
    );
  });

  it("carries Slack channel/thread/event identity for a threaded follow-up message", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    await getMessageHandler(apps[0])({
      message: {
        ts: "1.1",
        thread_ts: "1.0",
        text: "follow up",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        slackDelivery: { channel: "C1", threadTs: "1.0", eventId: "1.1" },
      })
    );
  });

  it("keeps bound replies in their thread when thread policy is never", async () => {
    const store = createSlackThreadSessionBindingStore(dataDir);
    store.setBinding({
      channelId: "C1",
      threadTs: "1.0",
      sessionId: "bound-session",
      agentId: "main",
    });
    store.close();
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], {
      ...config,
      channels: { C1: { agent: "main", threadPolicy: "never" } },
    });
    await bot?.start();

    await getMessageHandler(apps[0])({
      message: {
        ts: "1.1",
        thread_ts: "1.0",
        text: "follow up",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: "1.0" })
    );
  });

  it("falls back to normal thread routing when a bound session cannot resume", async () => {
    const store = createSlackThreadSessionBindingStore(dataDir);
    store.setBinding({
      channelId: "C1",
      threadTs: "1.0",
      sessionId: "missing-session",
      agentId: "main",
    });
    store.close();
    mockRunAgent
      .mockRejectedValueOnce(new Error("session not found"))
      .mockResolvedValueOnce({
        payloads: [{ text: "fallback" }],
        meta: { durationMs: 1, sessionId: "new-session" },
      });
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], {
      ...config,
      channels: { C1: { agent: "main", threadPolicy: "never" } },
    });
    await bot?.start();

    await getMessageHandler(apps[0])({
      message: {
        ts: "1.1",
        thread_ts: "1.0",
        text: "follow up",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: "missing-session" })
    );
    expect(mockRunAgent).toHaveBeenNthCalledWith(
      2,
      expect.not.objectContaining({ sessionId: expect.anything() })
    );
    expect(mockRunAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionKey: "slack:C1:1.0" })
    );
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ thread_ts: expect.anything() })
    );
  });

  it("does not auto-deliver after slack.send_message posts to the bound thread", async () => {
    const store = createSlackThreadSessionBindingStore(dataDir);
    store.setBinding({
      channelId: "C1",
      threadTs: "1.0",
      sessionId: "bound-session",
      agentId: "main",
    });
    store.close();
    mockRunAgent.mockImplementationOnce(async (params) => {
      params.onEvent?.({
        type: "tool_call",
        id: "tool-1",
        name: "slack.send_message",
        arguments: { channel: "C1", threadTs: "1.0" },
      });
      params.onEvent?.({
        type: "tool_result",
        id: "tool-1",
        name: "slack.send_message",
        content: '{"ok":true}',
        isError: false,
      });
      return {
        payloads: [{ text: "duplicate" }],
        meta: { durationMs: 1, sessionId: "bound-session" },
      };
    });
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    await getMessageHandler(apps[0])({
      message: {
        ts: "1.1",
        thread_ts: "1.0",
        text: "follow up",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Working on it…", thread_ts: "1.0" })
    );
  });

  it("auto-delivers when a thread-targeted Slack tool call fails", async () => {
    const store = createSlackThreadSessionBindingStore(dataDir);
    store.setBinding({
      channelId: "C1",
      threadTs: "1.0",
      sessionId: "bound-session",
      agentId: "main",
    });
    store.close();
    mockRunAgent.mockImplementationOnce(async (params) => {
      params.onEvent?.({
        type: "tool_call",
        id: "tool-1",
        name: "slack.send_message",
        arguments: { channel: "C1", threadTs: "1.0" },
      });
      params.onEvent?.({
        type: "tool_result",
        id: "tool-1",
        name: "slack.send_message",
        content: "Slack API failed",
        isError: true,
      });
      return {
        payloads: [{ text: "fallback" }],
        meta: { durationMs: 1, sessionId: "bound-session" },
      };
    });
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    await getMessageHandler(apps[0])({
      message: {
        ts: "1.1",
        thread_ts: "1.0",
        text: "follow up",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).toHaveBeenCalledTimes(2);
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_ts: "1.0", text: "fallback" })
    );
  });

  it("shows a specific Slack error for container idle timeouts", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();
    mockRunAgent.mockRejectedValueOnce(
      new Error(
        "Container idle timed out after 300s without activity; last activity was history_tool_result 310s ago"
      )
    );

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Request timed out while I was still working. Please retry, or narrow the request if it is broad.",
      })
    );
  });

  it("shows a specific Slack error for container max runtime", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();
    mockRunAgent.mockRejectedValueOnce(
      new Error("Container exceeded max runtime after 900s")
    );

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Request ran too long and was stopped. Please retry with a narrower request.",
      })
    );
  });

  it("keeps generic Slack error text for other errors", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();
    mockRunAgent.mockRejectedValueOnce(new Error("Unexpected failure"));

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Sorry, I encountered an error processing your message.",
      })
    );
  });

  it("passes Slack file_share image files as agent attachments", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        )
    );
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        subtype: "file_share",
        text: "what is wrong?",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "screen.png",
            mimetype: "image/png",
            size: 3,
            url_private_download: "https://files.slack.test/screen.png",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockSaveMediaFile).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      "image/png",
      "screen.png"
    );
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "what is wrong?",
        attachments: [
          {
            path: "/media/inbound/screen.png",
            mimeType: "image/png",
            filename: "screen.png",
            size: 3,
          },
        ],
      })
    );
  });

  it("invokes the agent for a file-only Slack message", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        )
    );
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "doc.pdf",
            mimetype: "application/pdf",
            size: 3,
            url_private_download: "https://files.slack.test/doc.pdf",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "",
        attachments: [expect.objectContaining({ filename: "doc.pdf" })],
      })
    );
  });

  it("passes downloaded Slack docx and xlsx files through the message handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([4, 5, 6, 7]), { status: 200 })
        )
    );
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "read these",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "brief.docx",
            mimetype:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 3,
            url_private_download: "https://files.slack.test/brief.docx",
          },
          {
            id: "F2",
            name: "budget.xlsx",
            mimetype:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            size: 4,
            url_private_download: "https://files.slack.test/budget.xlsx",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockSaveMediaFile).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "brief.docx"
    );
    expect(mockSaveMediaFile).toHaveBeenCalledWith(
      Buffer.from([4, 5, 6, 7]),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "budget.xlsx"
    );
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "read these",
        attachments: [
          expect.objectContaining({ filename: "brief.docx" }),
          expect.objectContaining({ filename: "budget.xlsx" }),
        ],
      })
    );
  });

  it("inlines Slack snippets into the agent message", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "explain this",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "example.ts",
            mode: "snippet",
            mimetype: "text/plain",
            preview: "const x = 1;",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockSaveMediaFile).not.toHaveBeenCalled();
    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("const x = 1;"),
        attachments: [],
      })
    );
  });

  it("posts a threaded error for oversized Slack files", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "large.pdf",
            mimetype: "application/pdf",
            size: 26 * 1024 * 1024,
            url_private_download: "https://files.slack.test/large.pdf",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1.1",
        text: expect.stringContaining("large.pdf"),
      })
    );
  });

  it("posts a threaded error for unsupported Slack files", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "archive.zip",
            mimetype: "application/zip",
            size: 3,
            url_private_download: "https://files.slack.test/archive.zip",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1.1",
        text: expect.stringContaining("Unsupported file type"),
      })
    );
  });

  it("posts a threaded error for supported extensions with mismatched MIME", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "report.pdf",
            mimetype: "text/plain",
            size: 3,
            url_private_download: "https://files.slack.test/report.pdf",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1.1",
        text: expect.stringContaining("Unsupported file type"),
      })
    );
  });

  it("posts a threaded error for Slack download failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("nope", { status: 403 }))
    );
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "screen.png",
            mimetype: "image/png",
            size: 3,
            url_private_download: "https://files.slack.test/screen.png",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: "1.1",
        text: expect.stringContaining("Slack download failed with 403"),
      })
    );
  });

  it("continues with valid files when mixed Slack files include errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(new Uint8Array([1, 2, 3]), { status: 200 })
        )
    );
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "use these",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
        files: [
          {
            id: "F1",
            name: "screen.png",
            mimetype: "image/png",
            size: 3,
            url_private_download: "https://files.slack.test/screen.png",
          },
          {
            id: "F2",
            name: "archive.zip",
            mimetype: "application/zip",
            size: 3,
            url_private_download: "https://files.slack.test/archive.zip",
          },
        ],
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "use these",
        attachments: [expect.objectContaining({ filename: "screen.png" })],
      })
    );
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("archive.zip"),
      })
    );
  });

  it("uploads agent file outputs to the originating Slack thread", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();
    mockRunAgent.mockImplementationOnce(async (params) => {
      params.onEvent?.({
        type: "file_output",
        fileId: "file-1",
        filename: "summary.pdf",
        mimeType: "application/pdf",
        size: 3,
      });
      return {
        payloads: [{ text: "done" }],
        meta: { durationMs: 1, sessionId: "session" },
      };
    });

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "make a pdf",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(mockReadMediaFile).toHaveBeenCalledWith("file-1");
    expect(apps[0].client.files.uploadV2).toHaveBeenCalledWith({
      channel_id: "C1",
      thread_ts: "1.1",
      file: Buffer.from([4, 5, 6]),
      filename: "summary.pdf",
      title: "summary.pdf",
    });
  });

  it("updates one threaded progress message for a lifecycle milestone and completion", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();
    mockRunAgent.mockImplementationOnce(async (params) => {
      params.onEvent?.({ type: "progress", label: "internal detail" });
      return { payloads: [{ text: "done" }], meta: { durationMs: 1, sessionId: "session" } };
    });
    await getMessageHandler(apps[0])({ message: { ts: "1.2", text: "work", channel: "C1", user: "U1", channel_type: "channel" }, client: apps[0].client });
    expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: "1.2", text: "Working on it…" }));
    expect(apps[0].client.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: "Progress updated." }));
    expect(apps[0].client.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: "Completed." }));
  });

  it("blocks /new for users outside channel allowlist", async () => {
    const { createSlackBot } = await import("./bot.js");
    createSlackBot([agent], {
      ...config,
      channels: {
        C1: { agent: "main", requireMention: false, users: ["U1"] },
      },
    });

    const newHandler = getCommandHandler(apps[0], "/new");
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await newHandler({
      command: { channel_id: "C1", user_id: "U2", text: "" },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "No agent is configured for this Slack route.",
      response_type: "ephemeral",
    });
  });

  it("blocks /new for DM users outside allowFrom", async () => {
    const { createSlackBot } = await import("./bot.js");
    createSlackBot([agent], {
      ...config,
      dm: { enabled: true, agent: "main", allowFrom: ["U1"] },
    });

    const newHandler = getCommandHandler(apps[0], "/new");
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);
    await newHandler({
      command: { channel_id: "D1", user_id: "U2", text: "" },
      ack,
      respond,
    });

    expect(ack).toHaveBeenCalledOnce();
    expect(mockRunAgent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      text: "No agent is configured for this Slack route.",
      response_type: "ephemeral",
    });
  });

  it("streams thinking into a thread and deletes it by default", async () => {
    vi.useFakeTimers();
    try {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], {
        ...config,
        showThinking: true,
      });
      await bot?.start();

      mockRunAgent.mockImplementationOnce(async (params) => {
        await Promise.all(
          streamHandlers.map((handler) =>
            handler({
              type: "thinking",
              data: "first thought",
              agentId: params.agentId,
              sessionId: "session",
              sessionKey: params.sessionKey,
              source: "slack",
            })
          )
        );
        // Advance past throttle interval so next update goes through
        vi.advanceTimersByTime(4000);
        await Promise.all(
          streamHandlers.map((handler) =>
            handler({
              type: "thinking",
              data: "wrong session",
              agentId: params.agentId,
              sessionId: "other-session",
              sessionKey: params.sessionKey,
              source: "slack",
            })
          )
        );
        vi.advanceTimersByTime(4000);
        await Promise.all(
          streamHandlers.map((handler) =>
            handler({
              type: "thinking",
              data: "second thought",
              agentId: params.agentId,
              sessionId: "session",
              sessionKey: params.sessionKey,
              source: "slack",
            })
          )
        );
        return {
          payloads: [{ text: "ok" }],
          meta: { durationMs: 1, sessionId: "session" },
        };
      });

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "hello",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(apps[0].client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C1",
          text: "🧠 Thinking:\nfirst thought",
          thread_ts: "1.1",
        })
      );
      expect(apps[0].client.chat.update).toHaveBeenCalledWith({
        channel: "C1",
        ts: "reply-ts",
        text: "🧠 Thinking:\nfirst thoughtsecond thought",
        mrkdwn: true,
      });
      expect(apps[0].client.chat.delete).toHaveBeenCalledWith({
        channel: "C1",
        ts: "reply-ts",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for pending thinking post before cleanup deletes it", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], {
      ...config,
      showThinking: true,
    });
    await bot?.start();

    let resolvePost!: (value: { ts?: string }) => void;
    const pendingPost = new Promise<{ ts?: string }>((resolve) => {
      resolvePost = resolve;
    });
    apps[0].client.chat.postMessage.mockImplementationOnce(() =>
      Promise.resolve({ ts: "progress-ts" })
    );
    apps[0].client.chat.postMessage.mockImplementationOnce(() => pendingPost);

    mockRunAgent.mockImplementationOnce(async (params) => {
      for (const handler of streamHandlers) {
        Promise.resolve(
          handler({
            type: "thinking",
            data: "racy",
            agentId: params.agentId,
            sessionId: "session",
            sessionKey: params.sessionKey,
            source: "slack",
          })
        ).catch(() => undefined);
      }
      for (const handler of streamHandlers) {
        Promise.resolve(
          handler({
            type: "done",
            agentId: params.agentId,
            sessionId: "session",
            sessionKey: params.sessionKey,
            source: "slack",
          })
        ).catch(() => undefined);
      }
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 1, sessionId: "session" },
      };
    });

    const messageHandler = getMessageHandler(apps[0]);
    const messagePromise = messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(apps[0].client.chat.delete).not.toHaveBeenCalled();

    resolvePost({ ts: "thinking-ts" });
    await messagePromise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apps[0].client.chat.delete).toHaveBeenCalledWith({
      channel: "C1",
      ts: "thinking-ts",
    });
  });

  it("overrides tentative session binding with runAgent sessionId", async () => {
    vi.useFakeTimers();
    try {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], {
        ...config,
        showThinking: true,
      });
      await bot?.start();

      apps[0].client.chat.postMessage.mockImplementation(async (message) => {
        if (message.text === "ok") {
          vi.advanceTimersByTime(4000);
          await Promise.all(
            streamHandlers.map((handler) =>
              handler({
                type: "thinking",
                data: "stale after result",
                agentId: "main",
                sessionId: "stale-session",
                sessionKey: "slack:C1",
                source: "slack",
              })
            )
          );
          vi.advanceTimersByTime(4000);
          await Promise.all(
            streamHandlers.map((handler) =>
              handler({
                type: "thinking",
                data: "correct after result",
                agentId: "main",
                sessionId: "correct-session",
                sessionKey: "slack:C1",
                source: "slack",
              })
            )
          );
        }
        return {
          ts: message.text?.includes("Thinking") ? "thinking-ts" : "reply-ts",
        };
      });

      mockRunAgent.mockImplementationOnce(async (params) => {
        await Promise.all(
          streamHandlers.map((handler) =>
            handler({
              type: "thinking",
              data: "tentative stale",
              agentId: params.agentId,
              sessionId: "stale-session",
              sessionKey: params.sessionKey,
              source: "slack",
            })
          )
        );
        return {
          payloads: [{ text: "ok" }],
          meta: { durationMs: 1, sessionId: "correct-session" },
        };
      });

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "hello",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(apps[0].client.chat.update).toHaveBeenCalledWith({
        channel: "C1",
        ts: "thinking-ts",
        text: "🧠 Thinking:\ntentative stalecorrect after result",
        mrkdwn: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps thinking message when configured", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], {
      ...config,
      showThinking: true,
      deleteThinkingOnComplete: false,
    });
    await bot?.start();

    mockRunAgent.mockImplementationOnce(async (params) => {
      await Promise.all(
        streamHandlers.map((handler) =>
          handler({
            type: "thinking",
            data: "keep this",
            agentId: params.agentId,
            sessionId: "session",
            sessionKey: params.sessionKey,
            source: "slack",
          })
        )
      );
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 1, sessionId: "session" },
      };
    });

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.delete).not.toHaveBeenCalled();
  });

  it("does not stream thinking unless showThinking is true", async () => {
    const { createSlackBot } = await import("./bot.js");
    const bot = createSlackBot([agent], config);
    await bot?.start();

    mockRunAgent.mockImplementationOnce(async (params) => {
      await Promise.all(
        streamHandlers.map((handler) =>
          handler({
            type: "thinking",
            data: "hidden",
            agentId: params.agentId,
            sessionId: "session",
            sessionKey: params.sessionKey,
            source: "slack",
          })
        )
      );
      return {
        payloads: [{ text: "ok" }],
        meta: { durationMs: 1, sessionId: "session" },
      };
    });

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(apps[0].client.chat.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Thinking") })
    );
  });

  describe("bang commands", () => {
    it("handles !new by clearing session and responding ephemeral", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!new",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "slack:C1");
      expect(mockDeleteSession).toHaveBeenCalledWith("main", "session");
      expect(mockInvalidateHistoryCache).toHaveBeenCalledWith(
        "main",
        "session"
      );
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(apps[0].client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C1",
          user: "U1",
          text: "Context cleared, new session started.",
        })
      );
    });

    it("handles !new with custom session key", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!new my-session",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "my-session");
    });

    it("handles !stop by running /stop control command", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!stop",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "/stop",
          sessionKey: "slack:C1",
          slackDelivery: { channel: "C1", threadTs: undefined, eventId: "1.1" },
        })
      );
      expect(mockClearSessionEntry).not.toHaveBeenCalled();
      expect(apps[0].client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C1",
          user: "U1",
          text: "ok",
        })
      );
    });

    it("handles !stop with custom session key", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!stop custom",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ message: "/stop", sessionKey: "custom" })
      );
    });

    it("does not treat mid-message !new as a bang command", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "hey !new stuff",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).not.toHaveBeenCalled();
      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ message: "hey !new stuff" })
      );
    });

    it("handles !new after mention stripping", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], {
        ...config,
        channels: { C1: { agent: "main" } },
      });
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "<@Ubot> !new",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "slack:C1");
      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("responds with error on !new failure", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();
      mockClearSessionEntry.mockRejectedValueOnce(new Error("boom"));

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!new",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(apps[0].client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "Error: boom",
        })
      );
    });

    it("handles !new in DMs", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!new",
          channel: "D1",
          user: "U1",
          channel_type: "im",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "main");
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(apps[0].client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "D1",
          user: "U1",
          text: "Context cleared, new session started.",
        })
      );
    });

    it("handles !new when requireMention is true and no mention present", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], {
        ...config,
        channels: { C1: { agent: "main" } }, // requireMention defaults to true
      });
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!new",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "slack:C1");
      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(apps[0].client.chat.postEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C1",
          user: "U1",
          text: "Context cleared, new session started.",
        })
      );
    });

    it("uses per-thread session key when thread_ts present", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "2.2",
          thread_ts: "1.1",
          text: "<@Ubot> reply",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "slack:C1:1.1" })
      );
    });

    it("isolates sibling threads in the same channel", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "2.2",
          thread_ts: "1.1",
          text: "thread A",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });
      await messageHandler({
        message: {
          ts: "4.4",
          thread_ts: "3.3",
          text: "thread B",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      const keys = mockRunAgent.mock.calls.map(
        ([params]) => (params as { sessionKey: string }).sessionKey
      );
      expect(keys).toEqual(["slack:C1:1.1", "slack:C1:3.3"]);
    });

    it("!new inside a thread clears the thread-scoped session", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "2.2",
          thread_ts: "1.1",
          text: "!new",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).toHaveBeenCalledWith(
        "main",
        "slack:C1:1.1"
      );
    });

    it("!new at top level still clears slack:C1", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!new",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).toHaveBeenCalledWith("main", "slack:C1");
    });

    it("isolates thread history from channel history", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "top",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });
      await messageHandler({
        message: {
          ts: "2.2",
          thread_ts: "1.1",
          text: "in thread",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(getHistory("C1", 10)).toEqual([
        expect.objectContaining({ content: "top" }),
      ]);
      expect(getHistory("C1:1.1", 10)).toEqual([
        expect.objectContaining({ content: "in thread" }),
      ]);
    });

    it("DM threads still use main session key", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "2.2",
          thread_ts: "1.1",
          text: "hello",
          channel: "D1",
          user: "U1",
          channel_type: "im",
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "main" })
      );
    });

    it("clearHistoryAfterReply scopes to the thread", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], {
        ...config,
        clearHistoryAfterReply: true,
      });
      await bot?.start();

      recordMessage(
        "C1",
        { author: "U1", content: "top-level", timestamp: 1 },
        50,
        "top"
      );

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "2.2",
          thread_ts: "1.1",
          text: "in thread",
          channel: "C1",
          user: "U1",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(getHistory("C1", 10)).toEqual([
        expect.objectContaining({ content: "top-level" }),
      ]);
      expect(getHistory("C1:1.1", 10)).toEqual([]);
    });

    it("ignores !new from the bot itself", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], {
        ...config,
        channels: { C1: { agent: "main" } },
      });
      await bot?.start();

      const messageHandler = getMessageHandler(apps[0]);
      await messageHandler({
        message: {
          ts: "1.1",
          text: "!new",
          channel: "C1",
          user: "Ubot",
          channel_type: "channel",
        },
        client: apps[0].client,
      });

      expect(mockClearSessionEntry).not.toHaveBeenCalled();
      expect(mockRunAgent).not.toHaveBeenCalled();
    });
  });

  describe("reactions", () => {
    it("drops added and removed reactions by default", async () => {
      const { createSlackBot } = await import("./bot.js");
      const defaultConfig: SlackComponentConfig = {
        ...config,
        channels: { C1: { agent: "main", requireMention: false } },
      };
      const bot = createSlackBot([agent], defaultConfig);
      await bot?.start();

      for (const name of ["reaction_added", "reaction_removed"] as const) {
        await getEventHandler(
          apps[0],
          name
        )({
          event: {
            reaction: "eyes",
            user: "U1",
            item: { type: "message", channel: "C1", ts: "1.1" },
          },
          client: apps[0].client,
        });
      }

      expect(mockRunAgent).not.toHaveBeenCalled();
      expect(apps[0].client.conversations.history).not.toHaveBeenCalled();
    });

    it("looks up an own-mode reaction message once", async () => {
      const { createSlackBot } = await import("./bot.js");
      const ownConfig: SlackComponentConfig = {
        ...config,
        channels: {
          C1: {
            agent: "main",
            requireMention: false,
            reactionNotifications: "own",
          },
        },
      };
      const bot = createSlackBot([agent], ownConfig);
      await bot?.start();
      apps[0].client.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: "2.2", thread_ts: "1.1", user: "Ubot" }],
      });

      await getEventHandler(
        apps[0],
        "reaction_added"
      )({
        event: {
          reaction: "eyes",
          user: "U1",
          item: { type: "message", channel: "C1", ts: "2.2" },
        },
        client: apps[0].client,
      });

      expect(apps[0].client.conversations.history).toHaveBeenCalledTimes(1);
      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "slack:C1:1.1" })
      );
    });

    it("recognizes a bot_id-only own-mode message", async () => {
      const { createSlackBot } = await import("./bot.js");
      const ownConfig: SlackComponentConfig = {
        ...config,
        channels: {
          C1: { agent: "main", reactionNotifications: "own" },
        },
      };
      const bot = createSlackBot([agent], ownConfig);
      await bot?.start();
      apps[0].client.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: "2.2", bot_id: "Bbot" }],
      });

      await getEventHandler(
        apps[0],
        "reaction_added"
      )({
        event: {
          reaction: "eyes",
          user: "U1",
          item: { type: "message", channel: "C1", ts: "2.2" },
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).toHaveBeenCalledOnce();
    });

    it("drops the bot's own reaction in all mode", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      await getEventHandler(
        apps[0],
        "reaction_added"
      )({
        event: {
          reaction: "thinking",
          user: "Ubot",
          item: { type: "message", channel: "C1", ts: "1.1" },
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).not.toHaveBeenCalled();
    });

    it("scopes reaction session by thread_ts looked up via conversations.history", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      apps[0].client.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: "2.2", thread_ts: "1.1" }],
      });

      const reactionHandler = getEventHandler(apps[0], "reaction_added");
      await reactionHandler({
        event: {
          reaction: "eyes",
          user: "U1",
          item: { type: "message", channel: "C1", ts: "2.2" },
        },
        client: apps[0].client,
      });

      expect(apps[0].client.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C1",
          latest: "2.2",
          inclusive: true,
          limit: 1,
        })
      );
      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "slack:C1:1.1" })
      );
    });

    it("scopes reaction by item.thread_ts when present and skips lookup", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      const reactionHandler = getEventHandler(apps[0], "reaction_added");
      await reactionHandler({
        event: {
          reaction: "eyes",
          user: "U1",
          item: {
            type: "message",
            channel: "C1",
            ts: "2.2",
            thread_ts: "1.1",
          },
        },
        client: apps[0].client,
      });

      expect(apps[0].client.conversations.history).not.toHaveBeenCalled();
      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "slack:C1:1.1",
          slackDelivery: { channel: "C1", threadTs: "1.1", eventId: "2.2" },
        })
      );
    });

    it("scopes reaction on a thread parent by item.ts", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      apps[0].client.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: "1.1", reply_count: 3 }],
      });

      const reactionHandler = getEventHandler(apps[0], "reaction_added");
      await reactionHandler({
        event: {
          reaction: "eyes",
          user: "U1",
          item: { type: "message", channel: "C1", ts: "1.1" },
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "slack:C1:1.1" })
      );
    });

    it("falls back to channel-only session for standalone reactions", async () => {
      const { createSlackBot } = await import("./bot.js");
      const bot = createSlackBot([agent], config);
      await bot?.start();

      apps[0].client.conversations.history.mockResolvedValueOnce({
        messages: [{ ts: "1.1" }],
      });

      const reactionHandler = getEventHandler(apps[0], "reaction_added");
      await reactionHandler({
        event: {
          reaction: "eyes",
          user: "U1",
          item: { type: "message", channel: "C1", ts: "1.1" },
        },
        client: apps[0].client,
      });

      expect(mockRunAgent).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: "slack:C1" })
      );
    });
  });
});

describe("createSlackAgentBot", () => {
  beforeEach(() => {
    apps.length = 0;
    streamHandlers.length = 0;
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

  it("returns null when agent has no slack config", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const localAgent = {
      id: "a1",
      name: "Agent",
      workspace: "~/ws",
      thinkLevel: "off",
    } as AgentConfig;

    expect(createSlackAgentBot(localAgent)).toBeNull();
  });

  it("returns null when token is missing", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const localAgent = {
      id: "a1",
      name: "Agent",
      workspace: "~/ws",
      thinkLevel: "off",
      slack: { appToken: "xapp-test" },
    } as AgentConfig;

    expect(createSlackAgentBot(localAgent)).toBeNull();
  });

  it("returns null when appToken is missing", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const localAgent = {
      id: "a1",
      name: "Agent",
      workspace: "~/ws",
      thinkLevel: "off",
      slack: { token: "xoxb-test" },
    } as AgentConfig;

    expect(createSlackAgentBot(localAgent)).toBeNull();
  });

  it('creates a bot with agent.id as agentId (not "slack")', async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const localAgent = {
      id: "a1",
      name: "Agent",
      workspace: "~/ws",
      thinkLevel: "off",
      slack: { token: "xoxb-test", appToken: "xapp-test" },
    } as AgentConfig;

    const bot = createSlackAgentBot(localAgent);

    expect(bot).not.toBeNull();
    expect(bot?.agentId).toBe("a1");
    expect(apps[0].config).toEqual({
      token: "xoxb-test",
      receiver: receivers[0],
    });
    expect(receivers[0]?.config).toEqual({
      appToken: "xapp-test",
      clientPingTimeout: 20000,
    });
    expect(apps[0].command).toHaveBeenCalledWith("/stop", expect.any(Function));
    expect(apps[0].command).not.toHaveBeenCalledWith(
      "/abort",
      expect.any(Function)
    );
  });

  it("routes all channels to the agent when no channels config", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const localAgent = {
      id: "a1",
      name: "Agent",
      workspace: "~/ws",
      thinkLevel: "off",
      slack: { token: "xoxb-test", appToken: "xapp-test" },
    } as AgentConfig;

    const bot = createSlackAgentBot(localAgent);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "<@Ubot> hello from random channel",
        channel: "C999",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        sessionKey: "slack:C999",
        source: "slack",
      })
    );
  });

  it("creates a bot with channels config for per-agent filtering", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const localAgent = {
      id: "a1",
      name: "Agent",
      workspace: "~/ws",
      model: { provider: "anthropic", model: "claude" },
      thinkLevel: "off" as const,
      queueMode: "queue" as const,
      slack: {
        token: "xoxb-test",
        appToken: "xapp-test",
        channels: {
          C1: {
            agent: "a1",
            requireMention: false,
            reactionNotifications: "off",
          },
        },
      },
    } as AgentConfig;

    const bot = createSlackAgentBot(localAgent);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "ignored",
        channel: "C2",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).not.toHaveBeenCalled();

    await messageHandler({
      message: {
        ts: "2.2",
        text: "handled",
        channel: "C1",
        user: "U1",
        channel_type: "channel",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        sessionKey: "slack:C1",
        source: "slack",
      })
    );
  });

  it("creates a bot with DM config", async () => {
    const { createSlackAgentBot } = await import("./bot.js");
    const localAgent = {
      id: "a1",
      name: "Agent",
      workspace: "~/ws",
      model: { provider: "anthropic", model: "claude" },
      thinkLevel: "off" as const,
      queueMode: "queue" as const,
      slack: {
        token: "xoxb-test",
        appToken: "xapp-test",
        dm: { enabled: true },
      },
    } as AgentConfig;

    const bot = createSlackAgentBot(localAgent);
    await bot?.start();

    const messageHandler = getMessageHandler(apps[0]);
    await messageHandler({
      message: {
        ts: "1.1",
        text: "hello dm",
        channel: "D1",
        user: "U1",
        channel_type: "im",
      },
      client: apps[0].client,
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        sessionKey: "main",
        source: "slack",
      })
    );
  });
});
