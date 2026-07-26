import type { SlackComponentConfig } from "@yoplai/shared";
import { describe, expect, it } from "vitest";
import {
  processMessage,
  detectBangCommand,
  type MessageData,
} from "./message.js";

function createMessage(overrides: Partial<MessageData> = {}): MessageData {
  return {
    ts: "1.1",
    text: "hello",
    channel: "C1",
    user: "U1",
    channel_type: "channel",
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
      C1: { agent: "main", requireMention: false },
    },
    ...overrides,
  };
}

describe("processMessage", () => {
  it("ignores bot messages", () => {
    const result = processMessage(
      createMessage({ bot_id: "B1" }),
      createConfig(),
      "Ubot"
    );
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe("author_is_bot");
  });

  it("rejects DMs unless enabled", () => {
    const result = processMessage(
      createMessage({ channel: "D1", channel_type: "im" }),
      createConfig({ dm: undefined }),
      "Ubot"
    );
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe("dm_disabled");
  });

  it("allows enabled DMs from allowed users", () => {
    const result = processMessage(
      createMessage({ channel: "D1", channel_type: "im", user: "U1" }),
      createConfig({ dm: { enabled: true, agent: "main", allowFrom: ["U1"] } }),
      "Ubot"
    );
    expect(result.shouldReply).toBe(true);
    expect(result.isDm).toBe(true);
  });

  it("rejects DMs from users outside allowFrom", () => {
    const result = processMessage(
      createMessage({ channel: "D1", channel_type: "im", user: "U2" }),
      createConfig({ dm: { enabled: true, agent: "main", allowFrom: ["U1"] } }),
      "Ubot"
    );
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe("dm_user_not_allowed");
  });

  it("rejects unconfigured channels when channel routes exist", () => {
    const result = processMessage(
      createMessage({ channel: "C2" }),
      createConfig(),
      "Ubot"
    );
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe("channel_not_configured");
  });

  it("allows channels in single-agent mode when no channel map exists", () => {
    const result = processMessage(
      createMessage({ text: "<@Ubot> hello" }),
      createConfig({ channels: undefined }),
      "Ubot"
    );
    expect(result.shouldReply).toBe(true);
    expect(result.normalizedContent).toBe("hello");
  });

  it("rejects users outside channel allowlist", () => {
    const result = processMessage(
      createMessage({ user: "U2" }),
      createConfig({
        channels: {
          C1: { agent: "main", requireMention: false, users: ["U1"] },
        },
      }),
      "Ubot"
    );
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe("user_not_in_channel_allowlist");
  });

  it("requires mention by default", () => {
    const result = processMessage(
      createMessage(),
      createConfig({ channels: { C1: { agent: "main" } } }),
      "Ubot"
    );
    expect(result.shouldReply).toBe(false);
    expect(result.reason).toBe("mention_required");
  });

  it("allows app_mention events without explicit mention parsing", () => {
    const result = processMessage(
      createMessage({ isAppMention: true }),
      createConfig({ channels: { C1: { agent: "main" } } }),
      "Ubot"
    );
    expect(result.shouldReply).toBe(true);
  });

  it("allows file-only messages after route gating", () => {
    const result = processMessage(
      createMessage({
        text: "",
        files: [{ name: "screen.png", mimetype: "image/png" }],
      }),
      createConfig(),
      "Ubot"
    );

    expect(result.shouldReply).toBe(true);
    expect(result.normalizedContent).toBe("");
  });

  it("removes bot mention and mention patterns", () => {
    const mentionResult = processMessage(
      createMessage({ text: "<@Ubot> help" }),
      createConfig({ channels: { C1: { agent: "main" } } }),
      "Ubot"
    );
    const patternResult = processMessage(
      createMessage({ text: "@hub help" }),
      createConfig({
        channels: { C1: { agent: "main" } },
        mentionPatterns: ["@hub"],
      }),
      "Ubot"
    );

    expect(mentionResult.normalizedContent).toBe("help");
    expect(patternResult.normalizedContent).toBe("help");
  });

  describe("bang commands", () => {
    it("detects !new at start of message", () => {
      expect(detectBangCommand("!new")).toEqual({ command: "new" });
    });

    it("detects !stop at start of message", () => {
      expect(detectBangCommand("!stop")).toEqual({ command: "stop" });
    });

    it("detects !new with session key argument", () => {
      expect(detectBangCommand("!new custom-key")).toEqual({
        command: "new",
        arg: "custom-key",
      });
    });

    it("detects !stop with session key argument", () => {
      expect(detectBangCommand("!stop other-key")).toEqual({
        command: "stop",
        arg: "other-key",
      });
    });

    it("is case-insensitive", () => {
      expect(detectBangCommand("!NEW")?.command).toBe("new");
      expect(detectBangCommand("!Stop")?.command).toBe("stop");
    });

    it("returns undefined for non-bang content", () => {
      expect(detectBangCommand("hello")).toBeUndefined();
    });

    it("does not detect bang in the middle of a message", () => {
      expect(detectBangCommand("hey !new stuff")).toBeUndefined();
    });

    it("does not detect unknown bang commands", () => {
      expect(detectBangCommand("!help")).toBeUndefined();
    });

    it("does not detect !newslater as !new", () => {
      expect(detectBangCommand("!newslater")).toBeUndefined();
    });

    it("detects bang after mention stripping in processMessage", () => {
      const result = processMessage(
        createMessage({ text: "<@Ubot> !new" }),
        createConfig({ channels: { C1: { agent: "main" } } }),
        "Ubot"
      );
      expect(result.shouldReply).toBe(true);
      expect(result.normalizedContent).toBe("!new");
      expect(detectBangCommand(result.normalizedContent)).toEqual({
        command: "new",
      });
    });

    it("preserves !new in DM normalized content for downstream detection", () => {
      const result = processMessage(
        createMessage({ text: "!new", channel: "D1", channel_type: "im" }),
        createConfig({
          dm: { enabled: true, agent: "main", allowFrom: ["U1"] },
        }),
        "Ubot"
      );
      expect(result.shouldReply).toBe(true);
      expect(result.normalizedContent).toBe("!new");
      expect(detectBangCommand(result.normalizedContent)).toEqual({
        command: "new",
      });
    });
  });
});
