import { describe, it, expect } from "vitest";
import { processMessage, type MessageData } from "./message.js";
import type { DiscordConfig } from "@yoplai/shared";

function createMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    id: "msg-1",
    content: "Hello",
    channel_id: "channel-1",
    guild_id: "guild-1",
    author: {
      id: "user-1",
      username: "testuser",
      discriminator: "1234",
      bot: false,
    },
    mentions: [],
    ...overrides,
  };
}

function createConfig(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    token: "test-token",
    groupPolicy: "open",
    historyLimit: 20,
    clearHistoryAfterReply: true,
    replyToMode: "off",
    ...overrides,
  };
}

describe("processMessage", () => {
  describe("bot messages ignored", () => {
    it("rejects messages from bots", () => {
      const msg = createMessage({ author: { id: "bot-1", bot: true } });
      const result = processMessage(msg, createConfig(), "my-bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("author_is_bot");
    });

    it("rejects Discord system messages such as thread-created events", () => {
      const msg = createMessage({ type: 18, content: "New thread title" });
      const result = processMessage(
        msg,
        createConfig({
          guilds: {
            "guild-1": {
              requireMention: false,
              reactionNotifications: "off",
            },
          },
        }),
        "bot-id"
      );
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("unsupported_message_type");
    });

    it("allows Discord reply messages", () => {
      const msg = createMessage({ type: 19, content: "A normal user reply" });
      const result = processMessage(
        msg,
        createConfig({
          guilds: {
            "guild-1": {
              requireMention: false,
              reactionNotifications: "off",
            },
          },
        }),
        "bot-id"
      );
      expect(result.shouldReply).toBe(true);
    });
  });

  describe("DM gating", () => {
    const dmMessage = createMessage({ guild_id: undefined });

    it("allows DMs by default", () => {
      const result = processMessage(dmMessage, createConfig(), "bot-id");
      expect(result.shouldReply).toBe(true);
      expect(result.isDm).toBe(true);
    });

    it("rejects DMs when disabled", () => {
      const config = createConfig({ dm: { enabled: false, groupEnabled: false } });
      const result = processMessage(dmMessage, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("dm_disabled");
    });

    it("allows DMs from users in allowFrom", () => {
      const config = createConfig({ dm: { enabled: true, groupEnabled: false, allowFrom: ["user-1"] } });
      const result = processMessage(dmMessage, config, "bot-id");
      expect(result.shouldReply).toBe(true);
    });

    it("rejects DMs from users not in allowFrom", () => {
      const config = createConfig({ dm: { enabled: true, groupEnabled: false, allowFrom: ["other-user"] } });
      const result = processMessage(dmMessage, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("dm_user_not_allowed");
    });
  });

  describe("guild gating (groupPolicy)", () => {
    it("allows all guilds with open policy (default)", () => {
      const msg = createMessage();
      const config = createConfig({ groupPolicy: "open" });
      const result = processMessage(msg, config, "bot-id");
      // Still needs mention by default
      expect(result.reason).toBe("mention_required");
    });

    it("rejects all guilds with disabled policy", () => {
      const msg = createMessage();
      const config = createConfig({ groupPolicy: "disabled" });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("group_policy_disabled");
    });

    it("rejects guilds not in allowlist with allowlist policy", () => {
      const msg = createMessage({ guild_id: "guild-99" });
      const config = createConfig({
        groupPolicy: "allowlist",
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "off" } },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("guild_not_in_allowlist");
    });

    it("allows guilds in allowlist with allowlist policy", () => {
      const msg = createMessage({ guild_id: "guild-1", channel_id: "channel-1" });
      const config = createConfig({
        groupPolicy: "allowlist",
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "off",
            channels: { "channel-1": { enabled: true } },
          },
        },
      });
      const result = processMessage(msg, config, "bot-id");
      // Proceeds to mention check
      expect(result.reason).toBe("mention_required");
    });

    it("rejects channels not in allowlist with allowlist policy", () => {
      const msg = createMessage({ guild_id: "guild-1", channel_id: "channel-99" });
      const config = createConfig({
        groupPolicy: "allowlist",
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "off",
            channels: { "channel-1": { enabled: true } },
          },
        },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("channel_not_in_allowlist");
    });

    it("allows channels in allowlist with allowlist policy", () => {
      const msg = createMessage({
        guild_id: "guild-1",
        channel_id: "channel-1",
        mentions: [{ id: "bot-id" }],
        content: "<@bot-id> hi",
      });
      const config = createConfig({
        groupPolicy: "allowlist",
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "off",
            channels: { "channel-1": { enabled: true } },
          },
        },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(true);
    });

    it("rejects non-matching guild with legacy guildId config", () => {
      const msg = createMessage({ guild_id: "other-guild" });
      const config = createConfig({ guildId: "guild-1" });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("guild_not_configured");
    });

    it("rejects non-matching channel with legacy channelId config", () => {
      const msg = createMessage({ channel_id: "other-channel" });
      const config = createConfig({ channelId: "channel-1" });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("channel_not_configured");
    });
  });

  describe("mention gating (requireMention)", () => {
    it("requires mention by default", () => {
      const msg = createMessage({ content: "Hello" });
      const result = processMessage(msg, createConfig(), "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("mention_required");
    });

    it("allows message with bot mention", () => {
      const msg = createMessage({
        content: "<@bot-id> Hello",
        mentions: [{ id: "bot-id" }],
      });
      const result = processMessage(msg, createConfig(), "bot-id");
      expect(result.shouldReply).toBe(true);
      expect(result.normalizedContent).toBe("Hello");
    });

    it("allows message with nickname mention", () => {
      const msg = createMessage({
        content: "<@!bot-id> Hello",
        mentions: [{ id: "bot-id" }],
      });
      const result = processMessage(msg, createConfig(), "bot-id");
      expect(result.shouldReply).toBe(true);
      expect(result.normalizedContent).toBe("Hello");
    });

    it("allows message with mentionPatterns match", () => {
      const msg = createMessage({ content: "@mybot please help" });
      const config = createConfig({ mentionPatterns: ["@mybot"] });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(true);
      expect(result.normalizedContent).toBe("please help");
    });

    it("allows all messages when requireMention is false at guild level", () => {
      const msg = createMessage({ guild_id: "guild-1" });
      const config = createConfig({
        guilds: { "guild-1": { requireMention: false, reactionNotifications: "off" } },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(true);
    });

    it("channel requireMention overrides guild", () => {
      const msg = createMessage({ guild_id: "guild-1", channel_id: "channel-1" });
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: false,
            reactionNotifications: "off",
            channels: { "channel-1": { enabled: true, requireMention: true } },
          },
        },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("mention_required");
    });
  });

  describe("user allowlist", () => {
    it("allows users in guild allowlist", () => {
      const msg = createMessage({
        guild_id: "guild-1",
        mentions: [{ id: "bot-id" }],
        content: "<@bot-id> hi",
      });
      const config = createConfig({
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "off", users: ["user-1"] } },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(true);
    });

    it("rejects users not in guild allowlist", () => {
      const msg = createMessage({
        guild_id: "guild-1",
        author: { id: "user-99", username: "other" },
        mentions: [{ id: "bot-id" }],
        content: "<@bot-id> hi",
      });
      const config = createConfig({
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "off", users: ["user-1"] } },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("user_not_in_guild_allowlist");
    });

    it("channel allowlist takes precedence over guild allowlist", () => {
      const msg = createMessage({
        guild_id: "guild-1",
        channel_id: "channel-1",
        author: { id: "user-2", username: "user2" },
        mentions: [{ id: "bot-id" }],
        content: "<@bot-id> hi",
      });
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "off",
            users: ["user-1"],
            channels: { "channel-1": { enabled: true, users: ["user-2"] } },
          },
        },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(true);
    });

    it("rejects users not in channel allowlist", () => {
      const msg = createMessage({
        guild_id: "guild-1",
        channel_id: "channel-1",
        mentions: [{ id: "bot-id" }],
        content: "<@bot-id> hi",
      });
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "off",
            channels: { "channel-1": { enabled: true, users: ["other-user"] } },
          },
        },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("user_not_in_channel_allowlist");
    });
  });

  describe("channel disabled", () => {
    it("rejects messages in disabled channels", () => {
      const msg = createMessage({
        guild_id: "guild-1",
        channel_id: "channel-1",
        mentions: [{ id: "bot-id" }],
        content: "<@bot-id> hi",
      });
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "off",
            channels: { "channel-1": { enabled: false } },
          },
        },
      });
      const result = processMessage(msg, config, "bot-id");
      expect(result.shouldReply).toBe(false);
      expect(result.reason).toBe("channel_disabled");
    });
  });
});
