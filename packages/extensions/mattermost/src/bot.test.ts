import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayConfigSchema, type RunAgentResult } from "@yoplai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMattermostAgentBot,
  createMattermostBot,
  type MattermostBot,
} from "./bot.js";
import { clearMattermostContext, setMattermostContext } from "./context.js";
import { withThreadBindings } from "./thread-session-bindings.js";
import {
  ALICE,
  BOT,
  CHANNEL,
  DM_CHANNEL,
  FakeMattermost,
  FakeSocketFactory,
  OTHER_CHANNEL,
  TOKEN,
  buildFakeContext,
  flush,
} from "./test-fakes.js";

const URL_ = "https://chat.example.test";

function gatewayConfig(
  mattermost: Record<string, unknown> | undefined,
  agentExtra: Record<string, unknown> = {}
) {
  return GatewayConfigSchema.parse({
    version: 2,
    agents: [
      {
        id: "support",
        name: "Support",
        workspace: "~/support",
        model: { provider: "anthropic", model: "claude" },
        ...agentExtra,
      },
      {
        id: "sales",
        name: "Sales",
        workspace: "~/sales",
        model: { provider: "anthropic", model: "claude" },
      },
    ],
    extensions: mattermost ? { mattermost } : {},
  });
}

describe("Mattermost bot", () => {
  let dataDir: string;
  let server: FakeMattermost;
  let sockets: FakeSocketFactory;
  let bot: MattermostBot | null;
  let logs: string[];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-mattermost-bot-")
    );
    server = new FakeMattermost();
    sockets = new FakeSocketFactory();
    bot = null;
    logs = [];
    for (const level of ["log", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logs.push(
          args
            .map((a) =>
              a instanceof Error ? `${a.message} ${a.stack}` : String(a)
            )
            .join(" ")
        );
      });
    }
  });

  afterEach(async () => {
    await bot?.stop();
    clearMattermostContext();
    vi.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  async function startComponent(
    channels: Record<string, unknown> = { [CHANNEL]: { agent: "support" } },
    extra: Record<string, unknown> = {},
    run?: Parameters<typeof buildFakeContext>[0]["run"]
  ) {
    const config = gatewayConfig({
      enabled: true,
      url: URL_,
      token: TOKEN,
      channels,
      dm: { agent: "sales" },
      ...extra,
    });
    const ctx = buildFakeContext({ config, dataDir, run });
    setMattermostContext(ctx);
    bot = createMattermostBot(config.agents, config.extensions!.mattermost!, {
      fetch: server.fetch,
      createSocket: sockets.create,
    });
    const started = bot!.start();
    await flush();
    sockets.last().open();
    sockets.last().hello("conn-1");
    await started;
    return ctx;
  }

  function userPost(message: string, extra: Record<string, unknown> = {}) {
    return server.addPost({
      channel_id: CHANNEL,
      user_id: ALICE.id,
      message,
      ...extra,
    });
  }

  async function reconnect(connectionId = "conn-2"): Promise<void> {
    await vi.advanceTimersByTimeAsync(1_200);
    sockets.last().open();
    sockets.last().hello(connectionId);
    await vi.advanceTimersByTimeAsync(0);
  }

  it("answers a mention in a configured channel, in a thread under the post", async () => {
    const ctx = await startComponent();
    const post = userPost("@yoplai summarize the week");
    sockets.last().posted(post, 1, { mentions: JSON.stringify([BOT.id]) });
    await flush();

    expect(ctx.runs).toHaveLength(1);
    expect(ctx.runs[0]).toMatchObject({
      agentId: "support",
      message: "summarize the week",
      source: "mattermost",
      sessionKey: `mattermost:${CHANNEL}:${post.id}`,
      sessionId: expect.stringContaining(post.id),
    });
    expect(ctx.runs[0].context).toMatchObject({ kind: "mattermost" });
    expect(server.created()).toEqual([
      { channel_id: CHANNEL, message: "agent-ok", root_id: post.id },
    ]);
    const reactions = server.requests
      .filter((r) => r.path.includes("reactions"))
      .map(
        (r) =>
          `${r.method} ${r.method === "POST" ? (r.body as { emoji_name: string }).emoji_name : r.path.split("/").pop()}`
      );
    expect(reactions).toEqual([
      "POST eyes",
      "DELETE eyes",
      "POST white_check_mark",
    ]);
    expect(
      server.requests.some((r) => r.path === `/users/${BOT.id}/typing`)
    ).toBe(true);
  });

  it("ignores unconfigured channels, missing mentions, bots and itself", async () => {
    const ctx = await startComponent();
    sockets
      .last()
      .posted(
        server.addPost({
          channel_id: OTHER_CHANNEL,
          user_id: ALICE.id,
          message: "@yoplai hi",
        }),
        1
      );
    sockets.last().posted(userPost("no mention here"), 2);
    sockets
      .last()
      .posted(
        userPost("@yoplai from a bot", {
          user_id: "otherbot000000000000000001",
          props: { from_bot: "true" },
        }),
        3
      );
    sockets.last().posted(userPost("@yoplai my own", { user_id: BOT.id }), 4);
    sockets.last().message({ event: "typing", seq: 5, data: {} });
    await flush();
    expect(ctx.runs).toHaveLength(0);
    expect(server.created()).toHaveLength(0);
  });

  it("answers every post when requireMention is false", async () => {
    const ctx = await startComponent({
      [CHANNEL]: { agent: "support", requireMention: false },
    });
    sockets.last().posted(userPost("no mention needed"), 1);
    await flush();
    expect(ctx.runs.map((r) => r.message)).toEqual(["no mention needed"]);
  });

  it("keeps one durable session per thread", async () => {
    const ctx = await startComponent();
    const root = userPost("@yoplai start");
    sockets.last().posted(root, 1);
    await flush();
    const reply = userPost("@yoplai and then?", { root_id: root.id });
    sockets.last().posted(reply, 2);
    await flush();

    expect(ctx.runs).toHaveLength(2);
    expect(ctx.runs[1].sessionKey).toBe(ctx.runs[0].sessionKey);
    expect(ctx.runs[1].sessionId).toBe(ctx.runs[0].sessionId);
    expect(server.created().map((p) => p.root_id)).toEqual([root.id, root.id]);
    const binding = withThreadBindings(dataDir, (store) =>
      store.getBinding(root.id, "support")
    );
    expect(binding).toMatchObject({
      channelId: CHANNEL,
      sessionId: ctx.runs[0].sessionId,
      source: "inbound",
    });
  });

  it("rebinds a thread whose session has disappeared", async () => {
    const ctx = await startComponent();
    withThreadBindings(dataDir, (store) =>
      store.setBinding({
        channelId: CHANNEL,
        rootId: "gone0000000000000000000001",
        agentId: "support",
        sessionId: "deleted",
        source: "inbound",
      })
    );
    sockets
      .last()
      .posted(
        userPost("@yoplai again", { root_id: "gone0000000000000000000001" }),
        1
      );
    await flush();
    expect(ctx.runs[0].sessionId).not.toBe("deleted");
    expect(
      withThreadBindings(dataDir, (s) =>
        s.getBinding("gone0000000000000000000001", "support")
      )?.sessionId
    ).toBe(ctx.runs[0].sessionId);
  });

  it("lifts the mention requirement in a thread the agent started or unlocked", async () => {
    const ctx = await startComponent({
      [CHANNEL]: { agent: "support", threadUnlock: true },
    });
    const root = userPost("@yoplai start");
    sockets.last().posted(root, 1);
    await flush();
    sockets
      .last()
      .posted(userPost("follow-up without mention", { root_id: root.id }), 2);
    await flush();
    expect(ctx.runs.map((r) => r.message)).toEqual([
      "start",
      "follow-up without mention",
    ]);

    withThreadBindings(dataDir, (store) =>
      store.setBinding({
        channelId: CHANNEL,
        rootId: "agentroot00000000000000001",
        agentId: "support",
        sessionId: "s-agent",
        source: "agent",
      })
    );
    sockets
      .last()
      .posted(
        userPost("reply to the agent's thread", {
          root_id: "agentroot00000000000000001",
        }),
        3
      );
    await flush();
    expect(ctx.runs).toHaveLength(3);
  });

  it("routes DMs to the dm agent's main session and replies flat", async () => {
    const ctx = await startComponent();
    const dm = server.addPost({
      channel_id: DM_CHANNEL,
      user_id: ALICE.id,
      message: "hello there",
    });
    sockets.last().posted(dm, 1, { channel_type: "D" });
    await flush();
    expect(ctx.runs[0]).toMatchObject({
      agentId: "sales",
      sessionKey: "main",
      message: "hello there",
    });
    expect(ctx.runs[0].sessionId).toBeUndefined();
    expect(server.created()).toEqual([
      { channel_id: DM_CHANNEL, message: "agent-ok" },
    ]);
  });

  it("splits a long answer into several posts in the same thread", async () => {
    const long = "paragraph ".repeat(4_000);
    await startComponent(undefined, {}, () => ({
      payloads: [{ text: long }],
      meta: { durationMs: 1, sessionId: "s" },
    }));
    const post = userPost("@yoplai long please");
    sockets.last().posted(post, 1);
    await flush();
    const created = server.created();
    expect(created.length).toBeGreaterThan(2);
    expect(
      created.every((p) => p.root_id === post.id && p.message.length <= 15_000)
    ).toBe(true);
  });

  it("reports a failed run with ❌ and a message", async () => {
    await startComponent(undefined, {}, () => {
      throw new Error("provider exploded");
    });
    const post = userPost("@yoplai fail");
    sockets.last().posted(post, 1);
    await flush();
    expect(server.created()).toHaveLength(1);
    expect(server.created()[0].root_id).toBe(post.id);
    const lastReaction = server.requests
      .filter((r) => r.method === "POST" && r.path === "/reactions")
      .at(-1);
    expect((lastReaction?.body as { emoji_name: string }).emoji_name).toBe("x");
  });

  it("delivers a queued turn's answer when it comes back", async () => {
    let deferred:
      | ((outcome: { result: RunAgentResult }) => Promise<void> | void)
      | undefined;
    const ctx = await startComponent(undefined, {}, (params) => {
      deferred = params.onDeferredResult as typeof deferred;
      return {
        payloads: [{ text: "queued" }],
        meta: { durationMs: 0, sessionId: "s", queued: true },
      };
    });
    sockets.last().posted(userPost("@yoplai busy?"), 1);
    await flush();
    expect(ctx.runs).toHaveLength(1);
    expect(server.created()).toHaveLength(0);
    await deferred!({
      result: {
        payloads: [{ text: "late answer" }],
        meta: { durationMs: 1, sessionId: "s" },
      },
    });
    expect(server.created().map((p) => p.message)).toEqual(["late answer"]);
  });

  it("clears the thread's session on !new", async () => {
    const ctx = await startComponent();
    const root = userPost("@yoplai start");
    sockets.last().posted(root, 1);
    await flush();
    sockets.last().posted(userPost("@yoplai !new", { root_id: root.id }), 2);
    await flush();
    expect(ctx.runs).toHaveLength(1);
    expect(server.created().at(-1)?.message).toBe(
      "Context cleared, new session started."
    );
    expect(
      withThreadBindings(dataDir, (s) => s.getBinding(root.id, "support"))
    ).toMatchObject({ owner: null, source: "inbound" });
    expect(
      withThreadBindings(dataDir, (s) => s.getBinding(root.id, "support"))?.sessionId
    ).not.toBe(ctx.runs[0].sessionId);
  });

  it("hands inbound files to the agent and uploads files it produces", async () => {
    const ctx = await startComponent(undefined, {}, (params) => {
      params.onEvent?.({
        type: "file_output",
        fileId: "report",
        filename: "report.txt",
        mimeType: "text/plain",
        size: 3,
      });
      return {
        payloads: [{ text: "here it is" }],
        meta: { durationMs: 1, sessionId: "s" },
      };
    });
    const post = userPost("@yoplai read this", {
      file_ids: ["file00000000000000000000001", "file00000000000000000000002"],
      metadata: {
        files: [
          {
            id: "file00000000000000000000001",
            name: "notes.txt",
            extension: "txt",
            size: 2,
          },
          {
            id: "file00000000000000000000002",
            name: "tool.exe",
            extension: "exe",
            size: 2,
          },
        ],
      },
    });
    sockets.last().posted(post, 1);
    await flush();

    expect(ctx.runs[0].attachments).toEqual([
      {
        path: "/media/notes.txt",
        mimeType: "text/plain",
        filename: "notes.txt",
      },
    ]);
    const messages = server.created().map((p) => p.message);
    expect(messages).toContain(
      "Could not process tool.exe: Unsupported file type exe"
    );
    expect(
      server.requests.some((r) => r.method === "POST" && r.path === "/files")
    ).toBe(true);
    expect(
      server
        .created()
        .some((p) => p.file_ids?.length === 1 && p.root_id === post.id)
    ).toBe(true);
    expect(messages).toContain("here it is");
  });

  it("runs a post replayed after a resume only once", async () => {
    const ctx = await startComponent();
    const post = userPost("@yoplai once");
    sockets.last().posted(post, 1);
    sockets.last().posted(post, 1);
    await flush();
    expect(ctx.runs).toHaveLength(1);
  });

  it("catches up missed posts over REST after a reconnect the server could not resume", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent();
      const seenBefore = userPost("@yoplai before the drop");
      sockets.last().posted(seenBefore, 1);
      await vi.advanceTimersByTimeAsync(0);
      sockets.last().drop();

      // Posted while disconnected: only REST can see it.
      const missed = userPost("@yoplai while you were away", {
        create_at: Date.now() + 500,
      });
      await reconnect();
      await vi.runOnlyPendingTimersAsync();

      expect(
        server.requests.some((r) =>
          r.path.startsWith(`/channels/${CHANNEL}/posts?since=`)
        )
      ).toBe(true);
      expect(ctx.runs.map((r) => r.message)).toEqual([
        "before the drop",
        "while you were away",
      ]);
      expect(ctx.runs[1].sessionKey).toBe(`mattermost:${CHANNEL}:${missed.id}`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers recovered channel posts allowed by canonical username", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent({
        [CHANNEL]: { agent: "support", users: ["alice"] },
      });
      sockets.last().drop();
      userPost("@yoplai recovered by username");
      await reconnect();
      expect(ctx.runs.map((run) => run.message)).toEqual([
        "recovered by username",
      ]);
      expect(server.created().map((post) => post.message)).toEqual(["agent-ok"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers recovered DMs allowed by username", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent(undefined, {
        dm: { agent: "sales", allowFrom: ["alice"] },
      });
      sockets.last().posted(userPost("live dm", { channel_id: DM_CHANNEL }), 1, {
        channel_type: "D",
      });
      await vi.advanceTimersByTimeAsync(0);
      sockets.last().drop();
      userPost("recovered dm", { channel_id: DM_CHANNEL });
      await reconnect();
      expect(ctx.runs.map((run) => run.message)).toEqual([
        "live dm",
        "recovered dm",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a rejected recovered post available after username lookup recovers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent({
        [CHANNEL]: { agent: "support", users: ["alice"] },
      });
      sockets.last().drop();
      userPost("@yoplai retry the sender lookup");
      server.overrides.push({
        match: (method, path) => method === "GET" && path === `/users/${ALICE.id}`,
        reply: { status: 404 },
      });
      await reconnect();
      expect(ctx.runs).toHaveLength(0);
      expect(
        logs.some((line) => line.includes("Could not resolve sender username"))
      ).toBe(true);

      sockets.last().drop();
      await reconnect("conn-3");
      expect(ctx.runs.map((run) => run.message)).toEqual([
        "retry the sender lookup",
      ]);
      expect(server.created().map((post) => post.message)).toEqual(["agent-ok"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still accepts recovered id-authorized posts when username lookup fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent({
        [CHANNEL]: { agent: "support", users: [ALICE.id] },
      });
      sockets.last().drop();
      userPost("@yoplai allowed by id");
      server.overrides.push({
        match: (method, path) => method === "GET" && path === `/users/${ALICE.id}`,
        reply: { status: 404 },
      });
      await reconnect();
      expect(ctx.runs.map((run) => run.message)).toEqual(["allowed by id"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores recovered posts from a username outside the allowlist", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent({
        [CHANNEL]: { agent: "support", users: ["bob"] },
      });
      sockets.last().drop();
      userPost("@yoplai Alice is not Bob");
      await reconnect();
      expect(ctx.runs).toHaveLength(0);
      expect(server.created()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs overlapping live and recovered delivery only once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent({
        [CHANNEL]: { agent: "support", users: ["alice"] },
      });
      sockets.last().drop();
      const missed = userPost("@yoplai delivered both ways");
      await vi.advanceTimersByTimeAsync(1_200);
      sockets.last().open();
      sockets.last().hello("conn-2");
      sockets.last().posted(missed, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.runs.map((run) => run.message)).toEqual(["delivered both ways"]);
      expect(server.created().map((post) => post.message)).toEqual(["agent-ok"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a post from the silent gap once after failed reconnect attempts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    vi.setSystemTime(1_000_000);
    try {
      const ctx = await startComponent();
      await vi.advanceTimersByTimeAsync(5_000);
      sockets.last().message({ event: "typing", seq: 1, data: {} });
      const missed = userPost("@yoplai during the silent gap", {
        create_at: 1_010_000,
      });
      await vi.advanceTimersByTimeAsync(85_000);
      expect(sockets.last().terminated).toBe(true);
      await vi.advanceTimersByTimeAsync(1_200);
      sockets.last().open();
      sockets.last().drop();
      await vi.advanceTimersByTimeAsync(2_400);
      sockets.last().open();
      sockets.last().hello("conn-2");
      await vi.advanceTimersByTimeAsync(0);

      expect(
        server.requests
          .filter((request) => request.path.includes("/posts?since="))
          .map((request) => request.path)
      ).toEqual([`/channels/${CHANNEL}/posts?since=1000000`]);
      sockets.last().posted(missed, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.runs.map((run) => run.message)).toEqual(["during the silent gap"]);
      expect(server.created().map((post) => post.message)).toEqual(["agent-ok"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps silent-gap catch-up to ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    vi.setSystemTime(1_000_000);
    try {
      const ctx = await startComponent();
      await vi.advanceTimersByTimeAsync(5_000);
      sockets.last().message({ event: "typing", seq: 1, data: {} });
      userPost("@yoplai too old", { create_at: 1_010_000 });
      userPost("@yoplai still fresh", { create_at: 1_704_000 });
      await vi.advanceTimersByTimeAsync(700_000);
      sockets.last().open();
      sockets.last().hello("conn-2");
      await vi.advanceTimersByTimeAsync(0);

      expect(
        server.requests
          .filter((request) => request.path.includes("/posts?since="))
          .map((request) => request.path)
      ).toEqual([`/channels/${CHANNEL}/posts?since=1105000`]);
      expect(ctx.runs.map((run) => run.message)).toEqual(["still fresh"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips REST catch-up after a successful socket resume", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
    try {
      const ctx = await startComponent();
      sockets.last().drop();
      const missed = userPost("@yoplai replayed by the server");
      await reconnect("conn-1");
      expect(
        server.requests.some((request) => request.path.includes("/posts?since="))
      ).toBe(false);
      expect(ctx.runs).toHaveLength(0);
      sockets.last().posted(missed, 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.runs.map((run) => run.message)).toEqual(["replayed by the server"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never writes the token to the logs, even when everything fails", async () => {
    server.overrides.push({
      match: () => true,
      reply: { status: 401, body: { message: "Invalid or expired session" } },
    });
    const config = gatewayConfig({
      enabled: true,
      url: URL_,
      token: TOKEN,
      channels: { [CHANNEL]: { agent: "support" } },
    });
    setMattermostContext(buildFakeContext({ config, dataDir }));
    bot = createMattermostBot(config.agents, config.extensions!.mattermost!, {
      fetch: server.fetch,
      createSocket: sockets.create,
    });
    await expect(bot!.start()).rejects.toThrow("401");

    // Now a run that fails after startup, with an error carrying the request.
    const ctx = await startComponent(undefined, {}, () => {
      throw new Error("upstream said no");
    });
    sockets.last().fail("Unexpected server response: 401");
    sockets.last().posted(userPost("@yoplai x"), 1);
    await flush();
    expect(ctx.runs.length).toBeLessThanOrEqual(1);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("serves only the agent's own channels with a per-agent bot", async () => {
    const config = gatewayConfig(undefined, {
      mattermost: {
        url: URL_,
        token: TOKEN,
        channels: { [CHANNEL]: { requireMention: false } },
      },
    });
    const ctx = buildFakeContext({ config, dataDir });
    setMattermostContext(ctx);
    bot = createMattermostAgentBot(config.agents[0], {
      fetch: server.fetch,
      createSocket: sockets.create,
    });
    const started = bot!.start();
    await flush();
    sockets.last().open();
    sockets.last().hello("conn-1");
    await started;

    sockets.last().posted(userPost("hello support"), 1);
    sockets
      .last()
      .posted(
        server.addPost({
          channel_id: OTHER_CHANNEL,
          user_id: ALICE.id,
          message: "@yoplai elsewhere",
        }),
        2
      );
    sockets
      .last()
      .posted(
        server.addPost({
          channel_id: DM_CHANNEL,
          user_id: ALICE.id,
          message: "dm",
        }),
        3,
        { channel_type: "D" }
      );
    await flush();
    expect(ctx.runs.map((r) => [r.agentId, r.message])).toEqual([
      ["support", "hello support"],
    ]);
  });
});
