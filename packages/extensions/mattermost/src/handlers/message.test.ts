import { describe, expect, it } from "vitest";
import type { MattermostPost } from "../client.js";
import { ALICE, BOT, CHANNEL } from "../test-fakes.js";
import {
  isBotPost,
  isResetCommand,
  mentionsBot,
  processPost,
  replyRootId,
  sessionKeyFor,
  stripBotMention,
  type InboundPost,
  type MattermostRoute,
} from "./message.js";

const route: MattermostRoute = {
  agent: { id: "support" } as MattermostRoute["agent"],
  isDm: false,
  requireMention: true,
  threadUnlock: false,
  acknowledgeMessages: true,
  attachmentsEnabled: true,
  allowBots: false,
  logPrefix: "[test]",
};

function inbound(
  message: string,
  post: Partial<MattermostPost> = {},
  extra: Partial<InboundPost> = {}
): InboundPost {
  return {
    post: {
      id: "post00000000000000000000001",
      create_at: 1,
      user_id: ALICE.id,
      channel_id: CHANNEL,
      root_id: "",
      message,
      type: "",
      props: {},
      ...post,
    },
    channelType: "O",
    senderName: "@alice",
    mentions: [],
    ...extra,
  };
}

describe("processPost", () => {
  it("ignores the bot's own posts and system posts", () => {
    expect(
      processPost(inbound("@yoplai hi", { user_id: BOT.id }), route, BOT).reason
    ).toBe("own_post");
    expect(
      processPost(
        inbound("alice joined", { type: "system_join_channel" }),
        route,
        BOT
      ).reason
    ).toBe("system_post");
  });

  it("ignores other bots, webhooks and plugins unless allowed", () => {
    for (const flag of ["from_bot", "from_webhook", "from_plugin"]) {
      const post = inbound("@yoplai hi", {
        user_id: "otherbot",
        props: { [flag]: "true" },
      });
      expect(processPost(post, route, BOT).reason).toBe("author_is_bot");
    }
    const fromBot = inbound("@yoplai hi", {
      user_id: "otherbot",
      props: { from_bot: "true" },
    });
    expect(
      processPost(fromBot, { ...route, allowBots: ["otherbot"] }, BOT)
        .shouldReply
    ).toBe(true);
    // An allowed bot must still mention, even where mentions are optional.
    const unmentioned = inbound("hi", {
      user_id: "otherbot",
      props: { from_bot: "true" },
    });
    expect(
      processPost(
        unmentioned,
        { ...route, allowBots: true, requireMention: false },
        BOT
      ).reason
    ).toBe("mention_required");
  });

  it("requires a mention in channels by default", () => {
    expect(processPost(inbound("hello"), route, BOT)).toMatchObject({
      shouldReply: false,
      reason: "mention_required",
    });
    expect(processPost(inbound("@yoplai hello"), route, BOT)).toEqual({
      shouldReply: true,
      text: "hello",
    });
    expect(
      processPost(inbound("hey", {}, { mentions: [BOT.id] }), route, BOT)
        .shouldReply
    ).toBe(true);
  });

  it("does not take a longer username for a mention", () => {
    expect(processPost(inbound("@yoplai-dev hello"), route, BOT).reason).toBe(
      "mention_required"
    );
    expect(processPost(inbound("mail me@yoplai.fr"), route, BOT).reason).toBe(
      "mention_required"
    );
    expect(
      processPost(inbound("thanks @yoplai."), route, BOT).shouldReply
    ).toBe(true);
  });

  it("answers every post when requireMention is false, and in unlocked threads", () => {
    expect(
      processPost(inbound("hello"), { ...route, requireMention: false }, BOT)
        .shouldReply
    ).toBe(true);
    expect(
      processPost(inbound("follow-up", { root_id: "root" }), route, BOT, {
        threadUnlocked: true,
      }).shouldReply
    ).toBe(true);
  });

  it("answers DMs without a mention, filtered by allowFrom", () => {
    const dm = { ...route, isDm: true };
    expect(
      processPost(inbound("hello", {}, { channelType: "D" }), dm, BOT)
        .shouldReply
    ).toBe(true);
    expect(
      processPost(inbound("hello"), { ...dm, allowFrom: ["bob"] }, BOT).reason
    ).toBe("dm_user_not_allowed");
    expect(
      processPost(inbound("hello"), { ...dm, allowFrom: ["@Alice"] }, BOT)
        .shouldReply
    ).toBe(true);
    expect(
      processPost(inbound("hello"), { ...dm, allowFrom: [ALICE.id] }, BOT)
        .shouldReply
    ).toBe(true);
  });

  it("applies a channel's user allowlist", () => {
    expect(
      processPost(inbound("@yoplai hi"), { ...route, users: ["bob"] }, BOT)
        .reason
    ).toBe("user_not_allowed");
    expect(
      processPost(inbound("@yoplai hi"), { ...route, users: ["alice"] }, BOT)
        .shouldReply
    ).toBe(true);
  });

  it("drops a bare mention but keeps a file-only post", () => {
    expect(processPost(inbound("@yoplai"), route, BOT).reason).toBe(
      "empty_message"
    );
    expect(
      processPost(inbound("@yoplai", { file_ids: ["f1"] }), route, BOT)
        .shouldReply
    ).toBe(true);
  });
});

describe("thread and session helpers", () => {
  const post = inbound("x").post;

  it("threads channel replies under the post or its root, DMs flat", () => {
    expect(replyRootId(post, false)).toBe(post.id);
    expect(replyRootId({ ...post, root_id: "root1" }, false)).toBe("root1");
    expect(replyRootId(post, true)).toBeUndefined();
    expect(replyRootId({ ...post, root_id: "root1" }, true)).toBe("root1");
  });

  it("keys a channel session by its thread and DMs by the main session", () => {
    expect(sessionKeyFor(post, false)).toBe(`mattermost:${CHANNEL}:${post.id}`);
    expect(sessionKeyFor({ ...post, root_id: "root1" }, false)).toBe(
      `mattermost:${CHANNEL}:root1`
    );
    expect(sessionKeyFor(post, true)).toBe("main");
  });

  it("recognizes mentions, resets and bot posts", () => {
    expect(mentionsBot(post, [BOT.id], BOT)).toBe(true);
    expect(stripBotMention("@yoplai  summarize  this", BOT)).toBe(
      "summarize this"
    );
    expect(stripBotMention("please @YOPLAI do it", BOT)).toBe("please do it");
    expect(isResetCommand("!new")).toBe(true);
    expect(isResetCommand("!reset now")).toBe(true);
    expect(isResetCommand("/new")).toBe(false);
    expect(isBotPost({ ...post, props: { from_bot: true } })).toBe(true);
  });
});
