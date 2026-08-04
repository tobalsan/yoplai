import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import {
  clearDiscordClientCache,
  discordAgentTools,
  sendDiscordDelivery,
} from "./agent-tools.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import type { DiscordBot } from "./bot.js";
import { clearDiscordContext, setDiscordContext } from "./context.js";
import { createThreadSessionBindingStore } from "./thread-session-bindings.js";

type MockRest = {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
};

function agent(id: string, discord?: AgentConfig["discord"]): AgentConfig {
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    workspaceDir: `/tmp/${id}`,
    model: { provider: "test", model: "test" },
    queueMode: "queue",
    discord,
  };
}

function config(extensionsDiscord?: unknown): GatewayConfig {
  return {
    version: 3,
    agents: [],
    extensions: extensionsDiscord
      ? { discord: extensionsDiscord as never }
      : undefined,
    sessions: { idleMinutes: 360 },
    agentFab: false,
  } as unknown as GatewayConfig;
}

function registerMockBot(agentId: string, rest: MockRest): void {
  registerActiveBot(agentId, {
    agentId,
    client: { rest },
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as DiscordBot);
}

function tool(name: string) {
  const found = discordAgentTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe("discord agent tools", () => {
  afterEach(() => {
    clearActiveBots();
    clearDiscordClientCache();
    clearDiscordContext();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("exposes create_forum_thread, send_message, list_channels, and list_users", () => {
    expect(discordAgentTools().map((t) => t.name)).toEqual([
      "discord.create_forum_thread",
      "discord.send_message",
      "discord.list_channels",
      "discord.list_users",
    ]);
  });

  it("create_forum_thread creates the thread and binds it to the current session", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-discord-tool-")
    );
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({
        id: "thread-1",
        message: { id: "message-1", channel_id: "thread-1" },
      }),
    };
    registerMockBot("alpha", rest);
    setDiscordContext({ getDataDir: () => dataDir } as never);

    try {
      const result = await tool("discord.create_forum_thread").execute(
        { channel_id: "forum-1", title: "Build notes", body: "First post" },
        { agent: agent("alpha"), config: config(), sessionId: "session-1" }
      );

      expect(result).toEqual({
        thread_id: "thread-1",
        message_id: "message-1",
      });
      expect(rest.post).toHaveBeenCalledWith("/channels/forum-1/threads", {
        body: {
          name: "Build notes",
          message: { content: "First post" },
        },
      });

      const store = createThreadSessionBindingStore(dataDir);
      try {
        expect(store.getBinding("thread-1")).toMatchObject({
          threadId: "thread-1",
          sessionId: "session-1",
          agentId: "alpha",
          channelId: "forum-1",
        });
      } finally {
        store.close();
      }
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("create_forum_thread bubbles Discord API errors", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new Error("Missing Permissions")),
    };
    registerMockBot("alpha", rest);
    setDiscordContext({ getDataDir: () => os.tmpdir() } as never);

    await expect(
      tool("discord.create_forum_thread").execute(
        { channel_id: "forum-1", title: "Build notes", body: "First post" },
        { agent: agent("alpha"), config: config(), sessionId: "session-1" }
      )
    ).rejects.toThrow("Missing Permissions");
  });

  it("create_forum_thread rejects component channels routed to another agent", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn(),
    };
    registerMockBot("discord", rest);
    setDiscordContext({ getDataDir: () => os.tmpdir() } as never);

    await expect(
      tool("discord.create_forum_thread").execute(
        { channel_id: "forum-2", title: "Build notes", body: "First post" },
        {
          agent: agent("alpha"),
          config: config({
            token: "bot-token",
            channels: {
              "forum-1": { agent: "alpha" },
              "forum-2": { agent: "beta" },
            },
          }),
          sessionId: "session-1",
        }
      )
    ).rejects.toThrow("Discord channel is routed to a different agent.");
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("send_message posts to a channel via the active bot client", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ id: "m1", channel_id: "c1" }),
    };
    registerMockBot("alpha", rest);

    const result = await tool("discord.send_message").execute(
      { channel: "c1", text: "hello **world**" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: true, channel: "c1", messageId: "m1" });
    expect(rest.post).toHaveBeenCalledWith("/channels/c1/messages", {
      body: { content: "hello **world**" },
    });
  });

  it("send_message opens a DM when targeting a user ID", async () => {
    const rest = {
      get: vi.fn(),
      post: vi
        .fn()
        .mockResolvedValueOnce({ id: "dm1" })
        .mockResolvedValueOnce({ id: "m2", channel_id: "dm1" }),
    };
    registerMockBot("alpha", rest);

    const result = await tool("discord.send_message").execute(
      { user: "u1", text: "hi" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: true, channel: "dm1", messageId: "m2" });
    expect(rest.post).toHaveBeenNthCalledWith(1, "/users/@me/channels", {
      body: { recipient_id: "u1" },
    });
    expect(rest.post).toHaveBeenNthCalledWith(2, "/channels/dm1/messages", {
      body: { content: "hi" },
    });
  });

  it("send_message rejects component channels routed to another agent", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn(),
    };
    registerMockBot("discord", rest);

    const result = await tool("discord.send_message").execute(
      { channel: "c2", text: "wrong route" },
      {
        agent: agent("alpha"),
        config: config({
          token: "bot-token",
          channels: {
            c1: { agent: "alpha" },
            c2: { agent: "beta" },
          },
        }),
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "Discord channel is routed to a different agent.",
    });
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("send_message allows component DMs only for the configured DM agent", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn(),
    };
    registerMockBot("discord", rest);

    const result = await tool("discord.send_message").execute(
      { user: "u1", text: "nope" },
      {
        agent: agent("alpha"),
        config: config({
          token: "bot-token",
          dm: { enabled: true, agent: "beta" },
        }),
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "Discord direct messaging is not configured for this agent.",
    });
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("send_message rejects component DMs when DMs are disabled", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn(),
    };
    registerMockBot("discord", rest);

    const result = await tool("discord.send_message").execute(
      { user: "u1", text: "disabled" },
      {
        agent: agent("alpha"),
        config: config({
          token: "bot-token",
          dm: { enabled: false, agent: "alpha" },
        }),
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "Discord direct messaging is not configured for this agent.",
    });
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("send_message errors when no token is configured and no bot is active", async () => {
    const result = await tool("discord.send_message").execute(
      { channel: "c1", text: "x" },
      { agent: agent("alpha"), config: config() }
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("send_message returns useful Discord API errors", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new Error("Missing Permissions")),
    };
    registerMockBot("alpha", rest);

    const result = await tool("discord.send_message").execute(
      { channel: "c1", text: "x" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: false, error: "Missing Permissions" });
  });

  it("list_channels filters text channels by query and returns ids + names", async () => {
    const rest = {
      post: vi.fn(),
      get: vi
        .fn()
        .mockResolvedValueOnce([{ id: "g1", name: "Guild" }])
        .mockResolvedValueOnce([
          { id: "c1", name: "general", type: 0, guild_id: "g1" },
          { id: "c2", name: "voice", type: 2, guild_id: "g1" },
          { id: "c3", name: "general-news", type: 5, guild_id: "g1" },
        ]),
    };
    registerMockBot("alpha", rest);

    const result = (await tool("discord.list_channels").execute(
      { query: "general" },
      { agent: agent("alpha"), config: config() }
    )) as {
      ok: boolean;
      channels: Array<{ id: string; name: string; guildId?: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.channels).toEqual([
      { id: "c1", name: "general", guildId: "g1", type: 0 },
      { id: "c3", name: "general-news", guildId: "g1", type: 5 },
    ]);
  });

  it("list_channels uses configured component channels for the agent", async () => {
    const rest = {
      post: vi.fn(),
      get: vi.fn().mockResolvedValue({
        id: "c1",
        name: "ops",
        type: 0,
        guild_id: "g1",
      }),
    };
    registerMockBot("discord", rest);

    const result = (await tool("discord.list_channels").execute(
      {},
      {
        agent: agent("alpha"),
        config: config({
          token: "bot-token",
          channels: {
            c1: { agent: "alpha" },
            c2: { agent: "beta" },
          },
        }),
      }
    )) as {
      ok: boolean;
      channels: Array<{ id: string; name: string; guildId?: string }>;
    };

    expect(result.ok).toBe(true);
    expect(result.channels).toEqual([
      { id: "c1", name: "ops", guildId: "g1", type: 0 },
    ]);
    expect(rest.get).toHaveBeenCalledOnce();
    expect(rest.get).toHaveBeenCalledWith("/channels/c1");
  });

  it("list_users resolves display names and deduplicates users across guilds", async () => {
    const rest = {
      post: vi.fn(),
      get: vi
        .fn()
        .mockResolvedValueOnce([
          { id: "g1", name: "One" },
          { id: "g2", name: "Two" },
        ])
        .mockResolvedValueOnce([
          { user: { id: "u1", username: "alice" }, nick: "Alice A" },
          { user: { id: "u2", username: "bob", global_name: "Bob B" } },
          { user: { id: "u4", username: "buildbot", bot: true } },
        ])
        .mockResolvedValueOnce([
          { user: { id: "u1", username: "alice" }, nick: "Alice A" },
          { user: { id: "u3", username: "cara" } },
        ]),
    };
    registerMockBot("alpha", rest);

    const result = (await tool("discord.list_users").execute(
      {},
      { agent: agent("alpha"), config: config() }
    )) as { ok: boolean; users: Array<{ id: string; name: string }> };

    expect(result.ok).toBe(true);
    expect(result.users).toEqual([
      { id: "u1", name: "Alice A", guildId: "g1" },
      { id: "u2", name: "Bob B", guildId: "g1" },
      { id: "u3", name: "cara", guildId: "g2" },
    ]);
  });

  it("falls back to component bot client when agent-specific bot is absent", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ id: "m3", channel_id: "c5" }),
    };
    registerMockBot("discord", rest);

    const result = await tool("discord.send_message").execute(
      { channel: "c5", text: "hey" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toMatchObject({ ok: true, messageId: "m3" });
  });

  it("falls back to a token-backed REST client when no bot is active", async () => {
    const fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: "m4", channel_id: "c9" }),
    });
    vi.stubGlobal("fetch", fetch);

    const result = await tool("discord.send_message").execute(
      { channel: "c9", text: "from token" },
      {
        agent: agent("alpha"),
        config: config({
          token: "bot-token",
          channels: { c9: { agent: "alpha" } },
        }),
      }
    );

    expect(result).toEqual({ ok: true, channel: "c9", messageId: "m4" });
    expect(fetch).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/c9/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bot bot-token" }),
        body: JSON.stringify({ content: "from token" }),
      })
    );
  });
});

describe("sendDiscordDelivery (deliver sink)", () => {
  afterEach(() => {
    clearActiveBots();
    clearDiscordClientCache();
  });

  it("sends to a channel destination", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ id: "m1", channel_id: "c1" }),
    };
    registerMockBot("alpha", rest);

    await sendDiscordDelivery(
      agent("alpha"),
      config(),
      { channel: "c1" },
      "cron result"
    );

    expect(rest.post).toHaveBeenCalledWith("/channels/c1/messages", {
      body: { content: "cron result" },
    });
  });

  it("opens a DM for a user destination", async () => {
    const rest = {
      get: vi.fn(),
      post: vi
        .fn()
        .mockResolvedValueOnce({ id: "dm1" })
        .mockResolvedValueOnce({ id: "m2", channel_id: "dm1" }),
    };
    registerMockBot("alpha", rest);

    await sendDiscordDelivery(
      agent("alpha"),
      config(),
      { user: "u1" },
      "cron result"
    );

    expect(rest.post).toHaveBeenNthCalledWith(1, "/users/@me/channels", {
      body: { recipient_id: "u1" },
    });
    expect(rest.post).toHaveBeenNthCalledWith(2, "/channels/dm1/messages", {
      body: { content: "cron result" },
    });
  });

  it("refuses a component-bot channel routed to another agent", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ id: "m1", channel_id: "c2" }),
    };
    registerMockBot("discord", rest);

    await expect(
      sendDiscordDelivery(
        agent("alpha"),
        config({ channels: { c1: { agent: "alpha" }, c2: { agent: "beta" } } }),
        { channel: "c2" },
        "cron result"
      )
    ).rejects.toThrow("Discord channel is routed to a different agent.");
    expect(rest.post).not.toHaveBeenCalled();
  });

  it("throws when no Discord client is configured for the agent", async () => {
    await expect(
      sendDiscordDelivery(agent("alpha"), config(), { channel: "c1" }, "hi")
    ).rejects.toThrow("No Discord token is configured for this agent.");
  });

  it("throws when the Discord API call fails", async () => {
    const rest = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new Error("Missing Permissions")),
    };
    registerMockBot("alpha", rest);

    await expect(
      sendDiscordDelivery(agent("alpha"), config(), { channel: "c1" }, "hi")
    ).rejects.toThrow("Missing Permissions");
  });
});
