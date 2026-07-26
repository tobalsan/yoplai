import { describe, expect, it } from "vitest";
import type { MessageEntity } from "grammy/types";
import { isBotAddressed, type AddressableMessage } from "./addressing.js";

const BOT = { id: 999, username: "yoplai_bot" };

function mention(text: string, type: MessageEntity["type"]): MessageEntity {
  return { type, offset: 0, length: text.length } as MessageEntity;
}

describe("isBotAddressed", () => {
  it("matches a reply to one of the bot's own messages", () => {
    const msg: AddressableMessage = {
      text: "thanks",
      reply_to_message: { from: { id: 999 } as never },
    };
    expect(isBotAddressed(msg, BOT)).toBe(true);
  });

  it("ignores a reply to another user's message", () => {
    const msg: AddressableMessage = {
      text: "thanks",
      reply_to_message: { from: { id: 1 } as never },
    };
    expect(isBotAddressed(msg, BOT)).toBe(false);
  });

  it("matches an @mention of the bot's username", () => {
    const text = "@yoplai_bot what's up";
    const msg: AddressableMessage = {
      text,
      entities: [{ type: "mention", offset: 0, length: "@yoplai_bot".length }],
    };
    expect(isBotAddressed(msg, BOT)).toBe(true);
  });

  it("ignores an @mention of a different user", () => {
    const text = "@someone_else hi";
    const msg: AddressableMessage = {
      text,
      entities: [{ type: "mention", offset: 0, length: 13 }],
    };
    expect(isBotAddressed(msg, BOT)).toBe(false);
  });

  it("matches a bare command", () => {
    const msg: AddressableMessage = {
      text: "/help",
      entities: [mention("/help", "bot_command")],
    };
    expect(isBotAddressed(msg, BOT)).toBe(true);
  });

  it("matches a command targeting this bot", () => {
    const text = "/help@yoplai_bot";
    const msg: AddressableMessage = {
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    };
    expect(isBotAddressed(msg, BOT)).toBe(true);
  });

  it("ignores a command targeting a different bot", () => {
    const text = "/help@other_bot";
    const msg: AddressableMessage = {
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    };
    expect(isBotAddressed(msg, BOT)).toBe(false);
  });

  it("ignores a command that is not at the start of the message", () => {
    const text = "hey /help";
    const msg: AddressableMessage = {
      text,
      entities: [{ type: "bot_command", offset: 4, length: 5 }],
    };
    expect(isBotAddressed(msg, BOT)).toBe(false);
  });

  it("matches a text_mention of the bot user (no username needed)", () => {
    const msg: AddressableMessage = {
      text: "Bot please help",
      entities: [
        { type: "text_mention", offset: 0, length: 3, user: { id: 999 } } as never,
      ],
    };
    expect(isBotAddressed(msg, { id: 999 })).toBe(true);
  });

  it("matches a mention carried in a media caption", () => {
    const text = "@yoplai_bot look";
    const msg: AddressableMessage = {
      caption: text,
      caption_entities: [
        { type: "mention", offset: 0, length: "@yoplai_bot".length },
      ],
    };
    expect(isBotAddressed(msg, BOT)).toBe(true);
  });

  it("ignores an ordinary group message", () => {
    const msg: AddressableMessage = { text: "just chatting" };
    expect(isBotAddressed(msg, BOT)).toBe(false);
  });
});
