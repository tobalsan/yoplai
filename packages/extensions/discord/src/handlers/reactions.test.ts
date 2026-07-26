import { describe, it, expect } from "vitest";
import { processReaction, formatEmoji, type ReactionData } from "./reactions.js";
import type { DiscordConfig } from "@yoplai/shared";

function createReaction(overrides: Partial<ReactionData> = {}): ReactionData {
  return {
    emoji: { name: "thumbsup" },
    user_id: "user-1",
    channel_id: "channel-1",
    message_id: "msg-1",
    guild_id: "guild-1",
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

describe("processReaction", () => {
  describe("DM reactions", () => {
    it("ignores reactions in DMs", () => {
      const reaction = createReaction({ guild_id: undefined });
      const result = processReaction(reaction, createConfig(), "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("dm_reaction");
    });
  });

  describe("off mode", () => {
    it("ignores all reactions when mode is off (default)", () => {
      const reaction = createReaction();
      const config = createConfig();
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("reactions_off");
    });

    it("ignores all reactions when explicitly off", () => {
      const reaction = createReaction();
      const config = createConfig({
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "off" } },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("reactions_off");
    });
  });

  describe("all mode", () => {
    it("allows all reactions", () => {
      const reaction = createReaction();
      const config = createConfig({
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "all" } },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(true);
    });
  });

  describe("own mode", () => {
    it("allows reactions on bot's own messages", () => {
      const reaction = createReaction({ message_author_id: "bot-id" });
      const config = createConfig({
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "own" } },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(true);
    });

    it("ignores reactions on other users' messages", () => {
      const reaction = createReaction({ message_author_id: "other-user" });
      const config = createConfig({
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "own" } },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("not_own_message");
    });

    it("ignores when message author is unknown", () => {
      const reaction = createReaction({ message_author_id: undefined });
      const config = createConfig({
        guilds: { "guild-1": { requireMention: true, reactionNotifications: "own" } },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("no_message_author");
    });
  });

  describe("allowlist mode", () => {
    it("allows reactions from users in allowlist", () => {
      const reaction = createReaction({ user_id: "user-1" });
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "allowlist",
            reactionAllowlist: ["user-1"],
          },
        },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(true);
    });

    it("ignores reactions from users not in allowlist", () => {
      const reaction = createReaction({ user_id: "user-2" });
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "allowlist",
            reactionAllowlist: ["user-1"],
          },
        },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("user_not_in_allowlist");
    });

    it("ignores all when allowlist is empty", () => {
      const reaction = createReaction();
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "allowlist",
            reactionAllowlist: [],
          },
        },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("empty_allowlist");
    });

    it("ignores all when allowlist is undefined", () => {
      const reaction = createReaction();
      const config = createConfig({
        guilds: {
          "guild-1": { requireMention: true, reactionNotifications: "allowlist" },
        },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("empty_allowlist");
    });
  });

  describe("unknown mode", () => {
    it("rejects unknown modes", () => {
      const reaction = createReaction();
      const config = createConfig({
        guilds: {
          "guild-1": {
            requireMention: true,
            reactionNotifications: "invalid" as never,
          },
        },
      });
      const result = processReaction(reaction, config, "bot-id");
      expect(result.shouldProcess).toBe(false);
      expect(result.reason).toBe("unknown_mode");
    });
  });
});

describe("formatEmoji", () => {
  it("formats unicode emoji", () => {
    expect(formatEmoji({ name: "thumbsup" })).toBe("thumbsup");
  });

  it("formats custom emoji", () => {
    expect(formatEmoji({ name: "pepe", id: "123456" })).toBe("<:pepe:123456>");
  });

  it("handles null name", () => {
    expect(formatEmoji({ name: null })).toBe("emoji");
  });
});
