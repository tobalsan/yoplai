import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayConfigSchema, registerSurfaceLinkService } from "@yoplai/shared";
import { createSurfaceLinkService, initializeMultiUserDatabase } from "@yoplai/extension-multi-user";
import { MattermostRestClient, type MattermostPost } from "../client.js";
import { setMattermostContext, clearMattermostContext } from "../context.js";
import { createMattermostBot, type MattermostBot } from "../bot.js";
import { ALICE, BOT, CHANNEL, DM_CHANNEL, FakeMattermost, FakeSocketFactory, TOKEN, buildFakeContext, flush } from "../test-fakes.js";
import {
  handleMattermostPost,
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


describe("Mattermost account linking", () => {
  let dataDir: string;
  let db: ReturnType<typeof initializeMultiUserDatabase> | undefined;
  let unregister: (() => void) | undefined;
  let bot: MattermostBot | null = null;

  beforeEach(async () => { dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-linking-")); });
  afterEach(async () => {
    await bot?.stop();
    bot = null;
    clearMattermostContext();
    unregister?.();
    db?.close();
    db = undefined;
    unregister = undefined;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function setup(withLinks = true) {
    const config = GatewayConfigSchema.parse({ version: 2, agents: [{ id: "support", name: "Support", workspace: "~/support", model: { provider: "anthropic", model: "claude" } }] });
    const ctx = buildFakeContext({ config, dataDir });
    setMattermostContext(ctx);
    const server = new FakeMattermost();
    const alice = { ...ALICE, email: "alice@example.test" };
    server.users.set(ALICE.id, alice);
    const rest = new MattermostRestClient("https://chat.example.test", TOKEN, server.fetch);
    let links: ReturnType<typeof createSurfaceLinkService> | undefined;
    if (withLinks) {
      db = initializeMultiUserDatabase(dataDir);
      db.exec("CREATE TABLE user (id TEXT PRIMARY KEY); INSERT INTO user VALUES ('gateway-alice')");
      links = createSurfaceLinkService(db, "https://gateway.example.test");
      unregister = registerSurfaceLinkService(links);
    }
    return { ctx, server, rest, links, config, deps: { rest, bot: BOT, userNames: new Map<string, string>() } };
  }

  it("passes a linked human identity into the run and unregisters the server on stop", async () => {
    const { ctx, server, config, links, deps } = setup();
    const sockets = new FakeSocketFactory();
    bot = createMattermostBot(config.agents, { enabled: true, url: "https://chat.example.test", token: TOKEN, channels: { [CHANNEL]: { agent: "support" } } }, { fetch: server.fetch, createSocket: sockets.create });
    const started = bot!.start();
    await flush();
    sockets.last().open();
    sockets.last().hello("pairing-connection");
    await started;
    await handleMattermostPost(inbound("@yoplai !pair"), route, deps, "!pair");
    const link = server.created()[0].message.match(/https:\/\/gateway\.example\.test\/api\/surface-links\/pair\/[A-Za-z0-9_-]+/)![0];
    await links!.redeem(new URL(link).pathname.split("/").at(-1)!, { id: "gateway-alice", email: "alice@example.test" });
    await handleMattermostPost(inbound("hello", { id: "next-post" }), route, deps, "hello");
    expect(ctx.runs).toHaveLength(1);
    expect(ctx.runs[0]).toMatchObject({ userId: "gateway-alice", requesterId: "mattermost:alice0000000000000000000001", sessionOwnerId: null });
    for (const flag of ["from_bot", "from_webhook", "from_plugin"]) {
      const item = inbound("@yoplai !pair", { id: flag, props: { [flag]: true } });
      const botRoute = { ...route, allowBots: true };
      const gate = processPost(item, botRoute, BOT);
      expect(gate.shouldReply).toBe(true);
      await handleMattermostPost(item, botRoute, deps, gate.text);
      const run = ctx.runs.at(-1)!;
      expect(run.userId).toBeUndefined();
      expect(run.sender).toEqual({ kind: "agent", agentId: "mattermost:alice0000000000000000000001" });
      expect(run.message).toBe("!pair");
    }
    links!.unlink("gateway-alice", links!.list("gateway-alice")[0].id);
    await handleMattermostPost(inbound("after unlink", { id: "after-unlink" }), route, deps, "after unlink");
    expect(ctx.runs.at(-1)!.userId).toBeUndefined();
    const retry = await links!.issue({ surface: "mattermost", scope: "https://chat.example.test", externalId: ALICE.id, username: "alice" });
    await bot!.stop();
    await expect(links!.redeem(new URL(retry).pathname.split("/").at(-1)!, { id: "gateway-alice", email: "alice@example.test" })).rejects.toThrow("unavailable");
  });

  it("sends a pairing link privately and confirms its delivery in the channel thread", async () => {
    const { ctx, server, deps, links } = setup();
    const item = inbound("@yoplai !pair");
    await handleMattermostPost(item, route, deps, "!pair");
    expect(ctx.runs).toHaveLength(0);
    const sent = server.created();
    expect(sent).toHaveLength(2);
    expect(sent[0].channel_id).toBe(DM_CHANNEL);
    expect(sent[0].root_id).toBeUndefined();
    const link = sent[0].message.match(/https:\/\/gateway\.example\.test\/api\/surface-links\/pair\/[A-Za-z0-9_-]+/)![0];
    expect(links!.inspect(new URL(link).pathname.split("/").at(-1)!)).toMatchObject({ surface: "mattermost", scope: "https://chat.example.test", externalId: ALICE.id, username: "alice" });
    expect(sent[1]).toEqual({ channel_id: CHANNEL, root_id: item.post.id, message: "I sent you a link by DM." });
    expect(JSON.stringify(sent)).not.toContain("alice@example.test");
  });

  it("replies with a pairing link in the existing direct-message thread", async () => {
    const { ctx, server, deps } = setup();
    const item = inbound("!pair", { channel_id: DM_CHANNEL, root_id: "dm-root" }, { channelType: "D" });
    await handleMattermostPost(item, { ...route, isDm: true }, deps, "!pair");
    expect(ctx.runs).toHaveLength(0);
    expect(server.created()).toHaveLength(1);
    expect(server.created()[0]).toMatchObject({ channel_id: DM_CHANNEL, root_id: "dm-root" });
    expect(server.created()[0].message).toContain("https://gateway.example.test/api/surface-links/pair/");
    expect(server.requests.some((request) => request.path === "/channels/direct")).toBe(false);
  });

  it("explains when the server does not expose the human's email", async () => {
    const { ctx, server, deps } = setup();
    server.users.set(ALICE.id, ALICE);
    const item = inbound("@yoplai !pair");
    await handleMattermostPost(item, route, deps, "!pair");
    expect(ctx.runs).toHaveLength(0);
    expect(server.created()).toEqual([{ channel_id: CHANNEL, root_id: item.post.id, message: "Mattermost email is unavailable. Ask your administrator." }]);
    expect(server.requests.some((request) => request.path === "/channels/direct")).toBe(false);
  });

  it("explains that linking needs sign-in while ordinary unlinked messages still run", async () => {
    const { ctx, server, deps } = setup(false);
    const item = inbound("@yoplai !pair");
    await handleMattermostPost(item, route, deps, "!pair");
    expect(ctx.runs).toHaveLength(0);
    expect(server.created()).toEqual([{ channel_id: CHANNEL, root_id: item.post.id, message: "Account linking needs multi-user sign-in." }]);
    await handleMattermostPost(inbound("hello", { id: "ordinary-post" }), route, deps, "hello");
    expect(ctx.runs).toHaveLength(1);
    expect(ctx.runs[0].userId).toBeUndefined();
    expect(ctx.runs[0].requesterId).toBe("mattermost:alice0000000000000000000001");
  });
});
