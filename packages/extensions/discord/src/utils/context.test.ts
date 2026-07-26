import type { AgentContext } from "@yoplai/shared";
import { describe, it, expect } from "vitest";
import { renderDiscordContext, buildDiscordContext, renderAgentContext } from "./context.js";

describe("buildDiscordContext", () => {
  it("builds empty context when no options provided", () => {
    const ctx = buildDiscordContext({});
    expect(ctx.kind).toBe("discord");
    expect(ctx.blocks).toEqual([]);
  });

  it("adds channel_name block", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#general",
        conversationType: "channel_message",
        sender: "alice",
      },
      channelName: "general",
    });
    expect(ctx.blocks[0]).toEqual({
      type: "metadata",
      channel: "discord",
      place: "#general",
      conversationType: "channel_message",
      sender: "alice",
    });
    expect(ctx.blocks).toHaveLength(2);
    expect(ctx.blocks[1]).toEqual({ type: "channel_name", name: "general" });
  });

  it("adds channel_topic block", () => {
    const ctx = buildDiscordContext({ channelTopic: "Discussion channel" });
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]).toEqual({ type: "channel_topic", topic: "Discussion channel" });
  });

  it("adds thread_starter block", () => {
    const starter = { author: "user", content: "First post", timestamp: 1700000000000 };
    const ctx = buildDiscordContext({ threadStarter: starter });
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]).toEqual({ type: "thread_starter", ...starter });
  });

  it("adds history block", () => {
    const history = [
      { author: "alice", content: "Hello", timestamp: 1700000000000 },
      { author: "bob", content: "Hi", timestamp: 1700000001000 },
    ];
    const ctx = buildDiscordContext({ history });
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]).toEqual({ type: "history", messages: history });
  });

  it("does not add empty history", () => {
    const ctx = buildDiscordContext({ history: [] });
    expect(ctx.blocks).toHaveLength(0);
  });

  it("adds reaction block", () => {
    const reaction = { emoji: "thumbsup", user: "alice", messageId: "123", action: "add" as const };
    const ctx = buildDiscordContext({ reaction });
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks[0]).toEqual({ type: "reaction", ...reaction });
  });

  it("combines multiple blocks in order", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#dev",
        conversationType: "channel_message",
        sender: "alice",
      },
      channelName: "dev",
      channelTopic: "Development",
      history: [{ author: "x", content: "y", timestamp: 1 }],
    });
    expect(ctx.blocks).toHaveLength(4);
    expect(ctx.blocks[0].type).toBe("metadata");
    expect(ctx.blocks[1].type).toBe("channel_name");
    expect(ctx.blocks[2].type).toBe("channel_topic");
    expect(ctx.blocks[3].type).toBe("history");
  });
});

describe("renderDiscordContext", () => {
  it("returns empty string for empty context", () => {
    const ctx = buildDiscordContext({});
    expect(renderDiscordContext(ctx)).toBe("");
  });

  it("renders channel_name block", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#general",
        conversationType: "channel_message",
        sender: "alice",
      },
      channelName: "general",
    });
    const result = renderDiscordContext(ctx);
    expect(result).toContain("channel: discord");
    expect(result).toContain("place: #general");
    expect(result).toContain("channel_name: #general");
  });

  it("renders channel_topic block", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#general",
        conversationType: "channel_message",
        sender: "alice",
      },
      channelTopic: "Talk about stuff",
    });
    const result = renderDiscordContext(ctx);
    expect(result).toContain("channel_topic: Talk about stuff");
  });

  it("renders thread_starter block", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#projects / thread:123",
        conversationType: "thread_reply",
        sender: "alice",
      },
      threadName: "thread:123",
      threadStarter: { author: "alice", content: "Hello world", timestamp: 1700000000000 },
    });
    const result = renderDiscordContext(ctx);
    expect(result).toContain("thread_name: thread:123");
    expect(result).toContain("thread_starter: alice");
    expect(result).toContain("Hello world");
  });

  it("renders history block with messages", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#general",
        conversationType: "channel_message",
        sender: "alice",
      },
      history: [
        { author: "bob", content: "Message 1", timestamp: 1700000000000 },
        { author: "carol", content: "Message 2", timestamp: 1700000001000 },
      ],
    });
    const result = renderDiscordContext(ctx);
    expect(result).toContain("recent_history:");
    expect(result).toContain("bob: Message 1");
    expect(result).toContain("carol: Message 2");
  });

  it("renders empty string when metadata is missing", () => {
    const ctx = {
      kind: "discord" as const,
      blocks: [{ type: "history" as const, messages: [] }],
    };
    const result = renderDiscordContext(ctx);
    expect(result).toBe("");
  });

  it("renders reaction block - add action", () => {
    const ctx = buildDiscordContext({
      reaction: { emoji: "heart", user: "dave", messageId: "456", action: "add" },
    });
    const result = renderDiscordContext(ctx);
    expect(result).toBe("");
  });

  it("renders reaction block - remove action", () => {
    const ctx = buildDiscordContext({
      reaction: { emoji: "fire", user: "eve", messageId: "789", action: "remove" },
    });
    const result = renderDiscordContext(ctx);
    expect(result).toBe("");
  });

  it("wraps output with context markers", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#test",
        conversationType: "channel_message",
        sender: "alice",
      },
      channelName: "test",
    });
    const result = renderDiscordContext(ctx);
    expect(result).toContain("[CHANNEL CONTEXT]");
    expect(result).toContain("[END CHANNEL CONTEXT]");
  });
});

describe("renderAgentContext", () => {
  it("renders discord context", () => {
    const ctx = buildDiscordContext({
      metadata: {
        channel: "discord",
        place: "#lobby",
        conversationType: "channel_message",
        sender: "alice",
      },
      channelName: "lobby",
    });
    const result = renderAgentContext(ctx);
    expect(result).toContain("channel_name: #lobby");
  });

  it("returns empty string for unknown context kind", () => {
    const ctx = { kind: "unknown", blocks: [] } as unknown as AgentContext;
    const result = renderAgentContext(ctx);
    expect(result).toBe("");
  });
});
