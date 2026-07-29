import type { SlackComponentConfig } from "@yoplai/shared";
import { describe, expect, it } from "vitest";
import {
  formatReactionMessage,
  processReaction,
  type ReactionData,
} from "./reactions.js";

function createReaction(overrides: Partial<ReactionData> = {}): ReactionData {
  return {
    reaction: "eyes",
    user: "U1",
    item: { channel: "C1", ts: "1.1" },
    ...overrides,
  };
}

function createConfig(
  overrides: Partial<SlackComponentConfig> = {}
): SlackComponentConfig {
  return {
    token: "xoxb-test",
    appToken: "xapp-test",
    channels: {
      C1: { agent: "main" },
    },
    ...overrides,
  };
}

describe("processReaction", () => {
  it("rejects reactions without message item details", () => {
    const result = processReaction(
      createReaction({ item: {} }),
      createConfig()
    );
    expect(result.shouldProcess).toBe(false);
    expect(result.reason).toBe("missing_item");
  });

  it("rejects unconfigured channels", () => {
    const result = processReaction(
      createReaction({ item: { channel: "C2", ts: "1.1" } }),
      createConfig()
    );
    expect(result.shouldProcess).toBe(false);
    expect(result.reason).toBe("channel_not_configured");
  });

  it("rejects users outside channel allowlist", () => {
    const result = processReaction(
      createReaction({ user: "U2" }),
      createConfig({ channels: { C1: { agent: "main", users: ["U1"] } } })
    );
    expect(result.shouldProcess).toBe(false);
    expect(result.reason).toBe("user_not_in_channel_allowlist");
  });

  it("drops configured channel reactions by default", () => {
    const result = processReaction(createReaction(), createConfig());
    expect(result).toEqual({
      shouldProcess: false,
      reason: "reactions_off",
    });
  });

  it("allows all reactions when enabled", () => {
    const result = processReaction(
      createReaction(),
      createConfig({
        channels: { C1: { agent: "main", reactionNotifications: "all" } },
      })
    );
    expect(result.shouldProcess).toBe(true);
  });

  it("allows allowlisted reactions", () => {
    const result = processReaction(
      createReaction(),
      createConfig({
        channels: {
          C1: {
            agent: "main",
            reactionNotifications: "allowlist",
            reactionAllowlist: ["U1"],
          },
        },
      })
    );
    expect(result.shouldProcess).toBe(true);
  });

  it("drops reactions outside the reaction allowlist", () => {
    const result = processReaction(
      createReaction({ user: "U2" }),
      createConfig({
        channels: {
          C1: {
            agent: "main",
            reactionNotifications: "allowlist",
            reactionAllowlist: ["U1"],
          },
        },
      })
    );
    expect(result.reason).toBe("user_not_in_allowlist");
  });

  it("drops allowlist mode with no configured users", () => {
    const result = processReaction(
      createReaction(),
      createConfig({
        channels: { C1: { agent: "main", reactionNotifications: "allowlist" } },
      })
    );
    expect(result.reason).toBe("empty_allowlist");
  });

  it("allows reactions on the bot's messages in own mode", () => {
    const result = processReaction(
      createReaction(),
      createConfig({
        channels: { C1: { agent: "main", reactionNotifications: "own" } },
      }),
      "Ubot",
      "Ubot"
    );
    expect(result.shouldProcess).toBe(true);
  });

  it("drops reactions on another user's messages in own mode", () => {
    const result = processReaction(
      createReaction(),
      createConfig({
        channels: { C1: { agent: "main", reactionNotifications: "own" } },
      }),
      "U2",
      "Ubot"
    );
    expect(result.reason).toBe("not_own_message");
  });

  it("drops the bot's own reaction even in all mode", () => {
    const result = processReaction(
      createReaction({ user: "Ubot" }),
      createConfig({
        channels: { C1: { agent: "main", reactionNotifications: "all" } },
      }),
      undefined,
      "Ubot"
    );
    expect(result.reason).toBe("self_reaction");
  });
});

describe("formatReactionMessage", () => {
  it("formats added reactions", () => {
    expect(formatReactionMessage(createReaction(), "add")).toBe(
      "[SYSTEM] User U1 reacted with eyes on message 1.1"
    );
  });

  it("formats removed reactions", () => {
    expect(formatReactionMessage(createReaction(), "remove")).toBe(
      "[SYSTEM] User U1 removed reaction eyes on message 1.1"
    );
  });
});
