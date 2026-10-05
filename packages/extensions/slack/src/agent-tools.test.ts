import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { clearSlackClientCache, slackAgentTools } from "./agent-tools.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import { clearSlackContext, setSlackContext } from "./context.js";
import { createSlackThreadSessionBindingStore } from "./thread-session-bindings.js";
import type { SlackBot } from "./bot.js";
import type { SlackWebClient } from "./types.js";

function agent(id: string, slack?: AgentConfig["slack"]): AgentConfig {
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    workspaceDir: `/tmp/${id}`,
    model: { provider: "test", model: "test" },
    queueMode: "queue",
    slack,
  };
}

function config(extensionsSlack?: unknown): GatewayConfig {
  return {
    version: 3,
    agents: [],
    extensions: extensionsSlack
      ? { slack: extensionsSlack as never }
      : undefined,
    sessions: { idleMinutes: 360 },
    agentFab: false,
  } as unknown as GatewayConfig;
}

function registerMockBot(agentId: string, client: Partial<SlackWebClient>): void {
  registerActiveBot(agentId, {
    agentId,
    app: { client },
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as SlackBot);
}

function tool(name: string) {
  const found = slackAgentTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe("slack agent tools", () => {
  afterEach(() => {
    clearActiveBots();
    clearSlackClientCache();
    clearSlackContext();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes the Slack agent tools", () => {
    expect(slackAgentTools().map((t) => t.name)).toEqual([
      "slack.create_thread",
      "slack.pair",
      "slack.send_message",
      "slack.list_channels",
      "slack.list_users",
      "slack.get_channel_history",
      "slack.get_thread_replies",
      "slack.canvas_list",
      "slack.canvas_create",
      "slack.canvas_read",
      "slack.canvas_find_sections",
      "slack.canvas_edit",
      "slack.canvas_share",
      "slack.canvas_delete",
      "slack.list_lists",
      "slack.list_read",
      "slack.list_update_cells",
      "slack.list_item_create",
      "slack.list_item_delete",
    ]);
  });

  it("create_thread posts a parent and binds it to the current session", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-tools-"));
    const postMessage = vi.fn().mockResolvedValue({ channel: "D123", ts: "1.2" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    setSlackContext({ getDataDir: () => dataDir } as never);

    const result = await tool("slack.create_thread").execute(
      { channel: "U123", text: "hello **world**" },
      { agent: agent("alpha"), config: config(), sessionId: "session-1" }
    );

    expect(result).toEqual({ ok: true, channel: "D123", ts: "1.2" });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "U123", mrkdwn: true, unfurl_links: false })
    );
    const store = createSlackThreadSessionBindingStore(dataDir);
    expect(store.getBinding("D123", "1.2", "alpha")).toMatchObject({
      sessionId: "session-1",
      agentId: "alpha",
    });
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("create_thread does not bind when no token is configured", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-tools-"));
    setSlackContext({ getDataDir: () => dataDir } as never);

    const result = await tool("slack.create_thread").execute(
      { channel: "C123", text: "hello" },
      { agent: agent("alpha"), config: config(), sessionId: "session-1" }
    );

    expect(result).toEqual({
      ok: false,
      error: "No Slack token is configured for this agent.",
    });
    const store = createSlackThreadSessionBindingStore(dataDir);
    expect(store.getBinding("C123", "1.2", "alpha")).toBeUndefined();
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("create_thread does not bind when Slack rejects the post", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-tools-"));
    const postMessage = vi.fn().mockRejectedValue(new Error("channel_not_found"));
    registerMockBot("alpha", { chat: { postMessage } as never });
    setSlackContext({ getDataDir: () => dataDir } as never);

    const result = await tool("slack.create_thread").execute(
      { channel: "C404", text: "hello" },
      { agent: agent("alpha"), config: config(), sessionId: "session-1" }
    );

    expect(result).toEqual({ ok: false, error: "channel_not_found" });
    const store = createSlackThreadSessionBindingStore(dataDir);
    expect(store.getBinding("C404", "1.2", "alpha")).toBeUndefined();
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("send_message posts to a channel via the active bot client", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "1.2" });
    registerMockBot("alpha", { chat: { postMessage } as never });

    const result = await tool("slack.send_message").execute(
      { channel: "C123", text: "hello **world**" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: true, channel: "C123", ts: "1.2" });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C123",
      mrkdwn: true,
      unfurl_links: false,
    });
  });

  it("send_message does not create a thread binding", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-slack-tools-"));
    const postMessage = vi.fn().mockResolvedValue({ ts: "1.2" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    setSlackContext({ getDataDir: () => dataDir } as never);

    await tool("slack.send_message").execute(
      { channel: "C123", text: "hello" },
      { agent: agent("alpha"), config: config(), sessionId: "session-1" }
    );

    const store = createSlackThreadSessionBindingStore(dataDir);
    expect(store.getBinding("C123", "1.2", "alpha")).toBeUndefined();
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("send_message passes threadTs and targets a user ID for DMs", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "9.9" });
    registerMockBot("alpha", { chat: { postMessage } as never });

    await tool("slack.send_message").execute(
      { channel: "U999", text: "hi", threadTs: "1.0" },
      { agent: agent("alpha"), config: config() }
    );

    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "U999",
      thread_ts: "1.0",
    });
  });

  it("send_message errors when no token is configured and no bot is active", async () => {
    const result = await tool("slack.send_message").execute(
      { channel: "C1", text: "x" },
      { agent: agent("alpha"), config: config() }
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("list_channels filters by query and returns ids + names", async () => {
    const list = vi.fn().mockResolvedValue({
      channels: [
        { id: "C1", name: "general" },
        { id: "C2", name: "random" },
        { id: "C3", name: "general-news" },
      ],
      response_metadata: { next_cursor: "" },
    });
    registerMockBot("alpha", { conversations: { list } as never });

    const result = (await tool("slack.list_channels").execute(
      { query: "general" },
      { agent: agent("alpha"), config: config() }
    )) as { ok: boolean; channels: Array<{ id: string; name: string }> };

    expect(result.ok).toBe(true);
    expect(result.channels).toEqual([
      { id: "C1", name: "general" },
      { id: "C3", name: "general-news" },
    ]);
  });

  it("list_users skips bots/deleted and resolves display names", async () => {
    const list = vi.fn().mockResolvedValue({
      members: [
        { id: "U1", name: "alice", profile: { display_name: "Alice" } },
        { id: "U2", name: "bot", is_bot: true },
        { id: "U3", name: "gone", deleted: true },
        { id: "U4", name: "bob", profile: { real_name: "Bob R" } },
      ],
      response_metadata: { next_cursor: "" },
    });
    registerMockBot("alpha", { users: { list } as never });

    const result = (await tool("slack.list_users").execute(
      {},
      { agent: agent("alpha"), config: config() }
    )) as { ok: boolean; users: Array<{ id: string; name: string }> };

    expect(result.ok).toBe(true);
    expect(result.users).toEqual([
      { id: "U1", name: "Alice" },
      { id: "U4", name: "Bob R" },
    ]);
  });

  it("get_channel_history maps compact messages and skips entries without timestamps", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [
        {
          ts: "3.0",
          user: "U1",
          username: "alice",
          text: "parent",
          thread_ts: "3.0",
          reply_count: 2,
        },
        { ts: "2.0", bot_id: "B1", text: "bot reply" },
        { ts: "1.0", user: "U2" },
        { user: "U3", text: "missing timestamp" },
      ],
    });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = await tool("slack.get_channel_history").execute(
      { channel: "C123" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toStrictEqual({
      ok: true,
      channel: "C123",
      messages: [
        {
          ts: "3.0",
          user: "U1",
          username: "alice",
          text: "parent",
          threadTs: "3.0",
          replyCount: 2,
        },
        { ts: "2.0", botId: "B1", text: "bot reply" },
        { ts: "1.0", user: "U2" },
      ],
      hasMore: false,
    });
  });

  it("get_channel_history paginates to the default limit", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      ts: `${100 - index}.0`,
      text: `first-${index}`,
    }));
    const secondPage = Array.from({ length: 30 }, (_, index) => ({
      ts: `${80 - index}.0`,
      text: `second-${index}`,
    }));
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        messages: firstPage,
        response_metadata: { next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({ messages: secondPage, has_more: true });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = (await tool("slack.get_channel_history").execute(
      { channel: "C123" },
      { agent: agent("alpha"), config: config() }
    )) as { messages: unknown[]; hasMore: boolean };

    expect(result.messages).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(history).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ channel: "C123", limit: 50 })
    );
    expect(history).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ channel: "C123", cursor: "page-2", limit: 30 })
    );
  });

  it("get_channel_history reports more history when an exact-cap page has a cursor", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: Array.from({ length: 5 }, (_, index) => ({ ts: `${index}.0` })),
      response_metadata: { next_cursor: "next" },
    });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = await tool("slack.get_channel_history").execute(
      { channel: "C123", limit: 5 },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toMatchObject({ ok: true, hasMore: true });
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("get_channel_history reports no more history when an exact-cap page is exhausted", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: Array.from({ length: 5 }, (_, index) => ({ ts: `${index}.0` })),
    });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = await tool("slack.get_channel_history").execute(
      { channel: "C123", limit: 5 },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toMatchObject({ ok: true, hasMore: false });
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("get_channel_history trims an oversized page and reports more history", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: Array.from({ length: 8 }, (_, index) => ({ ts: `${index}.0` })),
    });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = (await tool("slack.get_channel_history").execute(
      { channel: "C123", limit: 5 },
      { agent: agent("alpha"), config: config() }
    )) as { messages: Array<{ ts: string }>; hasMore: boolean };

    expect(result.messages.map((message) => message.ts)).toEqual([
      "0.0",
      "1.0",
      "2.0",
      "3.0",
      "4.0",
    ]);
    expect(result.hasMore).toBe(true);
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("get_channel_history honors has_more without a cursor", async () => {
    const history = vi.fn().mockResolvedValue({
      messages: [{ ts: "1.0" }],
      has_more: true,
    });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = await tool("slack.get_channel_history").execute(
      { channel: "C123" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toMatchObject({ ok: true, hasMore: true });
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("get_channel_history follows a cursor after an empty page", async () => {
    const history = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [],
        response_metadata: { next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({ messages: [{ ts: "1.0", text: "found" }] });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = await tool("slack.get_channel_history").execute(
      { channel: "C123" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toMatchObject({
      ok: true,
      messages: [{ ts: "1.0", text: "found" }],
      hasMore: false,
    });
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("get_channel_history returns an empty completed history", async () => {
    const history = vi.fn().mockResolvedValue({ messages: [] });
    registerMockBot("alpha", { conversations: { history } as never });

    const result = await tool("slack.get_channel_history").execute(
      { channel: "C123" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({
      ok: true,
      channel: "C123",
      messages: [],
      hasMore: false,
    });
  });

  it.each([0, 201, 1.5])(
    "get_channel_history rejects invalid limit %s",
    async (limit) => {
      const history = vi.fn();
      registerMockBot("alpha", { conversations: { history } as never });

      const result = await tool("slack.get_channel_history").execute(
        { channel: "C123", limit },
        { agent: agent("alpha"), config: config() }
      );

      expect(result).toMatchObject({ ok: false });
      expect(history).not.toHaveBeenCalled();
    }
  );

  it("get_channel_history forwards time-window parameters", async () => {
    const history = vi.fn().mockResolvedValue({ messages: [] });
    registerMockBot("alpha", { conversations: { history } as never });

    await tool("slack.get_channel_history").execute(
      {
        channel: "C123",
        oldest: "100.0",
        latest: "200.0",
        inclusive: true,
      },
      { agent: agent("alpha"), config: config() }
    );

    expect(history).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        oldest: "100.0",
        latest: "200.0",
        inclusive: true,
      })
    );
  });

  it("get_channel_history errors when no token is configured", async () => {
    const result = await tool("slack.get_channel_history").execute(
      { channel: "C123" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({
      ok: false,
      error: "No Slack token is configured for this agent.",
    });
  });

  it("get_channel_history reports Slack API failures", async () => {
    const history = vi.fn().mockRejectedValue(new Error("channel_not_found"));
    registerMockBot("alpha", { conversations: { history } as never });

    const result = await tool("slack.get_channel_history").execute(
      { channel: "C404" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: false, error: "channel_not_found" });
  });

  it("get_thread_replies includes the parent and pages through replies", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [
          { ts: "1.0", user: "U1", text: "parent", reply_count: 2 },
          { ts: "2.0", bot_id: "B1", text: "reply", thread_ts: "1.0" },
          { user: "U2", text: "missing timestamp" },
        ],
        has_more: true,
        response_metadata: { next_cursor: "page-2" },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: "3.0", user: "U2", text: "last", thread_ts: "1.0" }],
        has_more: false,
      });
    registerMockBot("alpha", { conversations: { replies } as never });

    const first = await tool("slack.get_thread_replies").execute(
      { channel: "C123", threadTs: "1.0", limit: 2 },
      { agent: agent("alpha"), config: config() }
    );
    const second = await tool("slack.get_thread_replies").execute(
      { channel: "C123", threadTs: "1.0", limit: 2, cursor: "page-2" },
      { agent: agent("alpha"), config: config() }
    );

    expect(first).toStrictEqual({
      ok: true,
      channel: "C123",
      threadTs: "1.0",
      messages: [
        { ts: "1.0", user: "U1", text: "parent", replyCount: 2 },
        { ts: "2.0", botId: "B1", text: "reply", threadTs: "1.0" },
      ],
      nextCursor: "page-2",
      hasMore: true,
    });
    expect(second).toStrictEqual({
      ok: true,
      channel: "C123",
      threadTs: "1.0",
      messages: [{ ts: "3.0", user: "U2", text: "last", threadTs: "1.0" }],
      nextCursor: undefined,
      hasMore: false,
    });
    expect(replies).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        channel: "C123",
        ts: "1.0",
        limit: 2,
        cursor: undefined,
      })
    );
    expect(replies).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        channel: "C123",
        ts: "1.0",
        limit: 2,
        cursor: "page-2",
      })
    );
  });

  it("get_thread_replies forwards the time window and defaults to 50 messages", async () => {
    const replies = vi.fn().mockResolvedValue({ messages: [] });
    registerMockBot("alpha", { conversations: { replies } as never });

    await tool("slack.get_thread_replies").execute(
      {
        channel: "G123",
        threadTs: "1.0",
        oldest: "2.0",
        latest: "3.0",
        inclusive: true,
      },
      { agent: agent("alpha"), config: config() }
    );

    expect(replies).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "G123",
        ts: "1.0",
        limit: 50,
        oldest: "2.0",
        latest: "3.0",
        inclusive: true,
      })
    );
  });

  it.each([0, 201, 1.5])(
    "get_thread_replies rejects invalid limit %s",
    async (limit) => {
      const replies = vi.fn();
      registerMockBot("alpha", { conversations: { replies } as never });

      const result = await tool("slack.get_thread_replies").execute(
        { channel: "C123", threadTs: "1.0", limit },
        { agent: agent("alpha"), config: config() }
      );

      expect(result).toMatchObject({ ok: false });
      expect(replies).not.toHaveBeenCalled();
    }
  );

  it("get_thread_replies reports Slack API failures", async () => {
    const replies = vi.fn().mockRejectedValue(new Error("thread_not_found"));
    registerMockBot("alpha", { conversations: { replies } as never });

    const result = await tool("slack.get_thread_replies").execute(
      { channel: "C123", threadTs: "1.0" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: false, error: "thread_not_found" });
  });

  it("falls back to component bot client when agent-specific bot is absent", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "3.3" });
    registerMockBot("slack", { chat: { postMessage } as never });

    const result = await tool("slack.send_message").execute(
      { channel: "C5", text: "hey" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toMatchObject({ ok: true, ts: "3.3" });
  });

  it("maps canvas create arguments and normalizes its result", async () => {
    const create = vi.fn().mockResolvedValue({ canvas_id: "F123ABC" });
    registerMockBot("alpha", { canvases: { create } as never });

    const result = await tool("slack.canvas_create").execute(
      { title: "Plan", markdown: "# Plan", channel: "C123" },
      { agent: agent("alpha"), config: config() }
    );

    expect(create).toHaveBeenCalledWith({
      title: "Plan",
      document_content: { type: "markdown", markdown: "# Plan" },
      channel_id: "C123",
    });
    expect(result).toEqual({ ok: true, canvasId: "F123ABC" });
  });

  it("reads and truncates canvas HTML using an id extracted from a URL", async () => {
    const info = vi
      .fn()
      .mockResolvedValue({
        file: {
          id: "F123ABC",
          title: "Plan",
          permalink: "https://slack.test/doc",
          url_private_download: "https://files.test/doc",
        },
      });
    registerMockBot("alpha", { token: "xoxb-test", files: { info } as never });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>hello</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await tool("slack.canvas_read").execute(
      { canvas: "https://workspace.slack.com/docs/T06TQF57079/F123ABC", maxChars: 6 },
      { agent: agent("alpha"), config: config() }
    );

    expect(info).toHaveBeenCalledWith({ file: "F123ABC" });
    expect(fetchMock).toHaveBeenCalledWith("https://files.test/doc", {
      headers: { Authorization: "Bearer xoxb-test" },
    });
    expect(result).toEqual({
      ok: true,
      canvasId: "F123ABC",
      title: "Plan",
      permalink: "https://slack.test/doc",
      html: "<html>",
      truncated: true,
    });
  });

  it("reports non-success canvas downloads", async () => {
    const info = vi
      .fn()
      .mockResolvedValue({ file: { url_private: "https://files.test/doc" } });
    registerMockBot("alpha", { token: "xoxb-test", files: { info } as never });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("no", {
            status: 403,
            headers: { "content-type": "text/html" },
          })
        )
    );

    const result = await tool("slack.canvas_read").execute(
      { canvas: "F123" },
      { agent: agent("alpha"), config: config() }
    );
    expect(result).toEqual({
      ok: false,
      error: "Slack canvas download failed with HTTP 403.",
    });
  });

  it("finds canvas sections and maps URL ids", async () => {
    const lookup = vi.fn().mockResolvedValue({ sections: [{ id: "s1" }, {}] });
    registerMockBot("alpha", { canvases: { sections: { lookup } } as never });
    const result = await tool("slack.canvas_find_sections").execute(
      {
        canvas: "https://slack.com/docs/FABC123",
        sectionTypes: ["h1"],
        containsText: "Roadmap",
      },
      { agent: agent("alpha"), config: config() }
    );
    expect(lookup).toHaveBeenCalledWith({
      canvas_id: "FABC123",
      criteria: { section_types: ["h1"], contains_text: "Roadmap" },
    });
    expect(result).toEqual({ ok: true, sections: [{ id: "s1" }] });
  });

  it("maps canvas edits and normalizes the result", async () => {
    const edit = vi.fn().mockResolvedValue({ ok: true });
    registerMockBot("alpha", { canvases: { edit } as never });
    const result = await tool("slack.canvas_edit").execute(
      {
        canvas: "F123",
        changes: [
          { operation: "insert_after", sectionId: "s1", markdown: "New" },
          { operation: "delete", sectionId: "s2" },
        ],
      },
      { agent: agent("alpha"), config: config() }
    );
    expect(edit).toHaveBeenCalledWith({
      canvas_id: "F123",
      changes: [
        {
          operation: "insert_after",
          section_id: "s1",
          document_content: { type: "markdown", markdown: "New" },
        },
        { operation: "delete", section_id: "s2" },
      ],
    });
    expect(result).toEqual({ ok: true, canvasId: "F123" });
  });

  it.each([
    { operation: "insert_after", markdown: "x" },
    { operation: "insert_at_start", sectionId: "s1", markdown: "x" },
    { operation: "replace", sectionId: "s1" },
    { operation: "delete", sectionId: "s1", markdown: "x" },
  ])("rejects invalid canvas edit change $operation", async (change) => {
    const edit = vi.fn();
    registerMockBot("alpha", { canvases: { edit } as never });
    const result = await tool("slack.canvas_edit").execute(
      { canvas: "F123", changes: [change] },
      { agent: agent("alpha"), config: config() }
    );
    expect(result).toMatchObject({ ok: false });
    expect(edit).not.toHaveBeenCalled();
  });

  it("lists Slack Lists via files.list types=list", async () => {
    const list = vi.fn().mockResolvedValue({
      files: [{ id: "F9", title: "OKRs", permalink: "https://slack.test/F9", created: 1, updated: 2 }],
      paging: { page: 2, pages: 2 },
    });
    registerMockBot("alpha", { files: { list } as never });
    const result = await tool("slack.list_lists").execute(
      { page: 2 },
      { agent: agent("alpha"), config: config() }
    );
    expect(list).toHaveBeenCalledWith({ types: "list", channel: undefined, count: 20, page: 2 });
    expect(result).toEqual({
      ok: true,
      lists: [{ id: "F9", title: "OKRs", permalink: "https://slack.test/F9", created: 1, updated: 2 }],
      hasMore: false,
    });
  });

  it("lists canvases with channel filter and paging", async () => {
    const list = vi.fn().mockResolvedValue({
      files: [{ id: "F1", title: "Plan", permalink: "https://slack.test/F1", created: 1, updated: 2 }],
      paging: { page: 1, pages: 3 },
    });
    registerMockBot("alpha", { files: { list } as never });
    const result = await tool("slack.canvas_list").execute(
      { channel: "C1", limit: 5 },
      { agent: agent("alpha"), config: config() }
    );
    expect(list).toHaveBeenCalledWith({ types: "canvas", channel: "C1", count: 5, page: undefined });
    expect(result).toEqual({
      ok: true,
      canvases: [{ id: "F1", title: "Plan", permalink: "https://slack.test/F1", created: 1, updated: 2 }],
      hasMore: true,
      nextPage: 2,
    });
  });

  it("shares and deletes a canvas with normalized results", async () => {
    const set = vi.fn().mockResolvedValue({ ok: true });
    const remove = vi.fn().mockResolvedValue({ ok: true });
    registerMockBot("alpha", {
      canvases: { access: { set }, delete: remove } as never,
    });
    const context = { agent: agent("alpha"), config: config() };
    expect(
      await tool("slack.canvas_share").execute(
        { canvas: "F123", access: "write", channels: ["C1"], users: ["U1"] },
        context
      )
    ).toEqual({ ok: true, canvasId: "F123" });
    expect(set).toHaveBeenCalledWith({
      canvas_id: "F123",
      access_level: "write",
      channel_ids: ["C1"],
      user_ids: ["U1"],
    });
    expect(
      await tool("slack.canvas_delete").execute({ canvas: "F123" }, context)
    ).toEqual({ ok: true, canvasId: "F123" });
    expect(remove).toHaveBeenCalledWith({ canvas_id: "F123" });
  });

  it("reads Slack List rows and schema using an ID from a URL", async () => {
    const list = vi.fn().mockResolvedValue({
      items: [{ id: "row1", fields: [{ column_id: "col1", key: "title", text: "Ship it", value: "ignored" }] }],
      response_metadata: { next_cursor: "next" },
    });
    const info = vi.fn().mockResolvedValue({
      list: {
        title: "Roadmap",
        permalink: "https://slack.test/list",
        list_metadata: { schema: [{ id: "col1", key: "title", name: "Title", type: "text", options: { choices: [{ value: "v1", label: "One", color: "red" }] } }] },
      },
    });
    registerMockBot("alpha", { slackLists: { items: { list, info } } as never });

    const result = await tool("slack.list_read").execute(
      { list: "https://x.slack.com/lists/T0ABCDEFG/F1234567" },
      { agent: agent("alpha"), config: config() }
    );

    expect(list).toHaveBeenCalledWith({ list_id: "F1234567", limit: 100, cursor: undefined, archived: undefined });
    expect(info).toHaveBeenCalledWith({ list_id: "F1234567", id: "row1" });
    expect(result).toEqual({
      ok: true, listId: "F1234567", title: "Roadmap", permalink: "https://slack.test/list",
      columns: [{ id: "col1", key: "title", name: "Title", type: "text", choices: [{ value: "v1", label: "One" }] }],
      rows: [{ id: "row1", cells: { Title: "Ship it" } }], nextCursor: "next",
    });
  });

  it("skips Slack List schema lookup for an empty list", async () => {
    const list = vi.fn().mockResolvedValue({ items: [] });
    const info = vi.fn();
    registerMockBot("alpha", { slackLists: { items: { list, info } } as never });
    const result = await tool("slack.list_read").execute(
      { list: "F123" }, { agent: agent("alpha"), config: config() }
    );
    expect(info).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, listId: "F123", columns: [], rows: [] });
  });

  it("converts typed values when updating Slack List cells", async () => {
    const update = vi.fn().mockResolvedValue({ ok: true });
    registerMockBot("alpha", { slackLists: { items: { update } } as never });
    await tool("slack.list_update_cells").execute({ list: "F123", cells: [
      { rowId: "r1", columnId: "c1", value: { text: "Hello" } },
      { rowId: "r1", columnId: "c2", value: { select: ["choice"] } },
      { rowId: "r1", columnId: "c3", value: { checkbox: true } },
      { rowId: "r1", columnId: "c4", value: { link: ["https://example.com"] } },
    ] }, { agent: agent("alpha"), config: config() });
    expect(update).toHaveBeenCalledWith({ list_id: "F123", cells: [
      { row_id: "r1", column_id: "c1", rich_text: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Hello" }] }] }] },
      { row_id: "r1", column_id: "c2", select: ["choice"] },
      { row_id: "r1", column_id: "c3", checkbox: true },
      { row_id: "r1", column_id: "c4", link: [{ original_url: "https://example.com", display_as_url: true, display_name: "https://example.com" }] },
    ] });
  });

  it("creates and deletes Slack List rows", async () => {
    const create = vi.fn().mockResolvedValue({ item: { id: "row1" } });
    const remove = vi.fn().mockResolvedValue({ ok: true });
    registerMockBot("alpha", { slackLists: { items: { create, delete: remove } } as never });
    const context = { agent: agent("alpha"), config: config() };
    expect(await tool("slack.list_item_create").execute(
      { list: "F123", cells: [{ columnId: "c1", value: { checkbox: true } }] }, context
    )).toEqual({ ok: true, listId: "F123", rowId: "row1" });
    expect(create).toHaveBeenCalledWith({ list_id: "F123", initial_fields: [{ column_id: "c1", checkbox: true }] });
    expect(await tool("slack.list_item_delete").execute(
      { list: "F123", rowId: "row1" }, context
    )).toEqual({ ok: true, listId: "F123", rowId: "row1" });
    expect(remove).toHaveBeenCalledWith({ list_id: "F123", id: "row1" });
  });

  it.each([{ value: {} }, { value: { text: "x", checkbox: true } }])(
    "rejects Slack List values without exactly one typed key",
    async ({ value }) => {
      const update = vi.fn();
      registerMockBot("alpha", { slackLists: { items: { update } } as never });
      const result = await tool("slack.list_update_cells").execute(
        { list: "F123", cells: [{ rowId: "r1", columnId: "c1", value }] },
        { agent: agent("alpha"), config: config() }
      );
      expect(result).toMatchObject({ ok: false });
      expect(update).not.toHaveBeenCalled();
    }
  );
});
