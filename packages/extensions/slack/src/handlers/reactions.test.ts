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

  it("allows configured channel reactions", () => {
    const result = processReaction(createReaction(), createConfig());
    expect(result).toEqual({
      shouldProcess: true,
      channel: "C1",
      messageTs: "1.1",
    });
  });

  it("accepts item.thread_ts on the reaction payload", () => {
    const reaction = createReaction({
      item: { channel: "C1", ts: "2.2", thread_ts: "1.1" },
    });
    expect(reaction.item.thread_ts).toBe("1.1");
    const result = processReaction(reaction, createConfig());
    expect(result.shouldProcess).toBe(true);
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
