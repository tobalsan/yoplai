import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GatewayConfigSchema,
  type AgentConfig,
  type GatewayConfig,
  type RunAgentResult,
} from "@yoplai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkTarget,
  createMattermostDeliverySink,
  mattermostAgentTools,
  parseDestination,
} from "./agent-tools.js";
import { createMattermostBot, type MattermostBot } from "./bot.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import { clearMattermostContext, setMattermostContext } from "./context.js";
import { withThreadBindings } from "./thread-session-bindings.js";
import {
  ALICE,
  CHANNEL,
  DM_CHANNEL,
  FakeMattermost,
  FakeSocketFactory,
  OTHER_CHANNEL,
  TOKEN,
  buildFakeContext,
  flush,
} from "./test-fakes.js";

function makeConfig(): GatewayConfig {
  return GatewayConfigSchema.parse({
    version: 2,
    agents: [
      {
        id: "support",
        name: "Support",
        workspace: "~/s",
        model: { provider: "anthropic", model: "claude" },
      },
      {
        id: "sales",
        name: "Sales",
        workspace: "~/t",
        model: { provider: "anthropic", model: "claude" },
      },
    ],
    extensions: {
      mattermost: {
        url: "https://chat.example.test",
        token: TOKEN,
        channels: {
          [CHANNEL]: { agent: "support" },
          [OTHER_CHANNEL]: { agent: "sales" },
        },
        dm: { agent: "support" },
      },
    },
  });
}

describe("checkTarget", () => {
  const config = makeConfig();
  const support = config.agents[0];
  const sales = config.agents[1];

  it("lets a shared-bot agent post only in its own channels and routed DMs", () => {
    expect(
      checkTarget(support, config, "component", { channel: CHANNEL })
    ).toBeUndefined();
    expect(
      checkTarget(support, config, "component", { channel: OTHER_CHANNEL })
    ).toBe("Mattermost channel is routed to a different agent.");
    expect(
      checkTarget(support, config, "component", {
        channel: "unknown0000000000000000001",
      })
    ).toBe("Mattermost channel is not configured for this agent.");
    expect(
      checkTarget(support, config, "component", { user: "alice" })
    ).toBeUndefined();
    expect(checkTarget(sales, config, "component", { user: "alice" })).toBe(
      "Mattermost direct messages are not routed to this agent."
    );
  });

  it("limits a per-agent bot to its configured channels", () => {
    const agent = {
      id: "a",
      mattermost: {
        url: "https://x.test",
        token: "t",
        channels: { [CHANNEL]: {} },
      },
    } as unknown as AgentConfig;
    expect(
      checkTarget(agent, config, "agent", { channel: CHANNEL })
    ).toBeUndefined();
    expect(
      checkTarget(agent, config, "agent", { channel: OTHER_CHANNEL })
    ).toBe("Mattermost channel is not configured for this agent.");
    expect(checkTarget(agent, config, "agent", { user: "alice" })).toBe(
      "Mattermost direct messages are not enabled for this agent."
    );
  });
});

describe("parseDestination", () => {
  it("reads a channel, a channel thread, or a user", () => {
    expect(parseDestination({ channel: CHANNEL })).toEqual({
      channel: CHANNEL,
    });
    expect(parseDestination({ channel: `${CHANNEL}:root1` })).toEqual({
      channel: CHANNEL,
      rootId: "root1",
    });
    expect(parseDestination({ user: "alice" })).toEqual({ user: "alice" });
    expect(() => parseDestination({})).toThrow("requires a channel or user");
  });
});

describe("Mattermost agent tools and delivery sink", () => {
  let dataDir: string;
  let server: FakeMattermost;
  let ctx: ReturnType<typeof buildFakeContext>;
  let sockets: FakeSocketFactory;
  let bot: MattermostBot;
  const config = makeConfig();

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "yoplai-mattermost-tools-")
    );
    server = new FakeMattermost();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    ctx = buildFakeContext({ config, dataDir });
    setMattermostContext(ctx);
    sockets = new FakeSocketFactory();
    bot = createMattermostBot(
      config.agents,
      config.extensions!.mattermost!,
      { fetch: server.fetch, createSocket: sockets.create }
    )!;
    const started = bot.start();
    await flush();
    sockets.last().open();
    sockets.last().hello("conn-1");
    await started;
    registerActiveBot("mattermost", bot);
  });

  afterEach(async () => {
    await bot.stop();
    clearActiveBots();
    clearMattermostContext();
    vi.restoreAllMocks();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function tool(name: string) {
    const found = mattermostAgentTools().find((t) => t.name === name);
    if (!found) throw new Error(name);
    return found;
  }

  const call = (
    name: string,
    args: unknown,
    extra: Record<string, unknown> = {}
  ) =>
    tool(name).execute(args, {
      agent: config.agents[0],
      config,
      ...extra,
    } as never) as Promise<Record<string, unknown>>;

  it("posts to an allowed channel and refuses the others", async () => {
    await expect(
      call("mattermost.send_message", { channel: CHANNEL, text: "hello" })
    ).resolves.toMatchObject({ ok: true, channelId: CHANNEL });
    await expect(
      call("mattermost.send_message", { channel: OTHER_CHANNEL, text: "hello" })
    ).resolves.toMatchObject({ ok: false });
    await expect(
      call("mattermost.send_message", { text: "nowhere" })
    ).resolves.toMatchObject({ ok: false });
    expect(server.created()).toEqual([
      { channel_id: CHANNEL, message: "hello" },
    ]);
  });

  it("replies in a thread only if the root belongs to the channel", async () => {
    const root = server.addPost({
      channel_id: CHANNEL,
      user_id: ALICE.id,
      message: "root",
    });
    const foreign = server.addPost({
      channel_id: OTHER_CHANNEL,
      user_id: ALICE.id,
      message: "elsewhere",
    });
    await expect(
      call("mattermost.send_message", {
        channel: CHANNEL,
        text: "in thread",
        rootId: root.id,
      })
    ).resolves.toMatchObject({ ok: true, rootId: root.id });
    await expect(
      call("mattermost.send_message", {
        channel: CHANNEL,
        text: "sneaky",
        rootId: foreign.id,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: "rootId does not belong to this channel.",
    });
    expect(server.created()).toEqual([
      { channel_id: CHANNEL, message: "in thread", root_id: root.id },
    ]);
  });

  it("opens a DM by username", async () => {
    await expect(
      call("mattermost.send_message", { user: "@alice", text: "psst" })
    ).resolves.toMatchObject({ ok: true, channelId: DM_CHANNEL });
    expect(
      server.requests.find((r) => r.path === "/channels/direct")?.body
    ).toEqual([expect.any(String), ALICE.id]);
  });

  it("creates a thread bound to the calling session", async () => {
    const result = await call(
      "mattermost.create_thread",
      { channel: CHANNEL, text: "Weekly report" },
      { sessionId: "sess-42" }
    );
    expect(result).toMatchObject({ ok: true, channelId: CHANNEL });
    const binding = withThreadBindings(dataDir, (store) =>
      store.getBinding(result.rootId as string, "support")
    );
    expect(binding).toMatchObject({ sessionId: "sess-42", source: "agent" });
    await expect(
      call(
        "mattermost.create_thread",
        { channel: OTHER_CHANNEL, text: "x" },
        { sessionId: "s" }
      )
    ).resolves.toMatchObject({ ok: false });
  });

  it("continues a settled owned session from a tool-created thread without granting requester credentials", async () => {
    const session = await ctx.ensureSession("support", "web-chat", "owner-alice");
    expect(await ctx.hasSession("support", session.sessionId)).toBe(false);
    const result = await call(
      "mattermost.create_thread",
      { channel: CHANNEL, text: "Owned report" },
      { sessionId: session.sessionId, userId: "owner-alice" }
    );
    expect(result.ok).toBe(true);
    const rootId = result.rootId as string;
    const post = server.addPost({
      channel_id: CHANNEL,
      root_id: rootId,
      user_id: ALICE.id,
      message: "What happened next?",
    });
    sockets.last().posted(post, 1);
    await flush();
    expect(ctx.runs).toHaveLength(1);
    expect(ctx.runs[0]).toMatchObject({
      sessionId: session.sessionId,
      sessionOwnerId: "owner-alice",
      message: "What happened next?",
    });
    expect(ctx.runs[0].userId).toBeUndefined();
    expect(withThreadBindings(dataDir, (store) => store.getBinding(rootId, "support")))
      .toMatchObject({ owner: "owner-alice", source: "agent", sessionId: session.sessionId });
  });

  it.each([false, true])("resets an owned thread and keeps its binding (first reply already received: %s)", async (replyFirst) => {
    const session = await ctx.ensureSession("support", "web-chat", "owner-alice");
    const other = await ctx.ensureSession("support", "web-chat", "owner-bob");
    const result = await call(
      "mattermost.create_thread",
      { channel: CHANNEL, text: "Owned report" },
      { sessionId: session.sessionId, sessionOwnerId: "owner-alice", userId: "different-requester" }
    );
    const rootId = result.rootId as string;
    const send = async (message: string, seq: number) => {
      sockets.last().posted(server.addPost({
        channel_id: CHANNEL,
        root_id: rootId,
        user_id: ALICE.id,
        message,
      }), seq);
      await flush();
    };
    if (replyFirst) await send("Before reset", 1);
    await send("!new", 2);
    const binding = withThreadBindings(dataDir, (store) => store.getBinding(rootId, "support"));
    expect(binding).toMatchObject({ owner: "owner-alice", source: "agent" });
    expect(binding?.sessionId).not.toBe(session.sessionId);
    expect(await ctx.hasSession("support", session.sessionId, "owner-alice")).toBe(false);
    expect(await ctx.getSessionEntry("support", "web-chat", "owner-alice")).toBeUndefined();
    expect(await ctx.hasSession("support", other.sessionId, "owner-bob")).toBe(true);
    expect(await ctx.hasSession("support", binding!.sessionId, "owner-alice")).toBe(true);
    expect(await ctx.hasSession("support", binding!.sessionId)).toBe(false);
    await send("After reset without mention", 3);
    expect(ctx.runs.at(-1)).toMatchObject({
      sessionId: binding!.sessionId,
      sessionOwnerId: "owner-alice",
      message: "After reset without mention",
    });
    expect(ctx.runs.at(-1)?.userId).toBeUndefined();
  });

  it.each([
    { context: { sessionOwnerId: "job-owner", userId: "requester" }, owner: "job-owner" },
    { context: { sessionOwnerId: null, userId: "requester" }, owner: null },
    { context: {}, owner: null },
  ])("uses the calling session owner $owner for a thread", async ({ context, owner }) => {
    const session = await ctx.ensureSession("support", "origin", owner ?? undefined);
    const result = await call("mattermost.create_thread", { channel: CHANNEL, text: "Report" }, {
      sessionId: session.sessionId, ...context,
    });
    const rootId = result.rootId as string;
    sockets.last().posted(server.addPost({
      channel_id: CHANNEL, root_id: rootId, user_id: ALICE.id, message: "Continue",
    }), 1);
    await flush();
    expect(ctx.runs[0]).toMatchObject({ sessionId: session.sessionId, sessionOwnerId: owner });
    expect(ctx.runs[0].userId).toBeUndefined();
    expect(withThreadBindings(dataDir, (store) => store.getBinding(rootId, "support")))
      .toMatchObject({ owner, source: "agent" });
  });

  it("continues the owned session after the bot and binding store reopen", async () => {
    const session = await ctx.ensureSession("support", "owned-chat", "owner-alice");
    const result = await call("mattermost.create_thread", { channel: CHANNEL, text: "Report" }, {
      sessionId: session.sessionId, userId: "owner-alice",
    });
    await bot.stop();
    clearActiveBots();
    clearMattermostContext();
    setMattermostContext(ctx);
    sockets = new FakeSocketFactory();
    bot = createMattermostBot(config.agents, config.extensions!.mattermost!, {
      fetch: server.fetch, createSocket: sockets.create,
    })!;
    const started = bot.start();
    await flush();
    sockets.last().open();
    sockets.last().hello("after-restart");
    await started;
    registerActiveBot("mattermost", bot);
    sockets.last().posted(server.addPost({
      channel_id: CHANNEL, root_id: result.rootId as string, user_id: ALICE.id,
      message: "Still the same conversation?",
    }), 1);
    await flush();
    expect(ctx.runs[0]).toMatchObject({ sessionId: session.sessionId, sessionOwnerId: "owner-alice" });
    expect(ctx.runs[0].userId).toBeUndefined();
  });

  it("recreates a deleted owned session and preserves its thread source", async () => {
    const session = await ctx.ensureSession("support", "owned-chat", "owner-alice");
    const result = await call("mattermost.create_thread", { channel: CHANNEL, text: "Report" }, {
      sessionId: session.sessionId, sessionOwnerId: "owner-alice",
    });
    await ctx.resetSession("support", session.sessionId, "owner-alice");
    const rootId = result.rootId as string;
    sockets.last().posted(server.addPost({
      channel_id: CHANNEL, root_id: rootId, user_id: ALICE.id, message: "Recover this thread",
    }), 1);
    await flush();
    const run = ctx.runs[0];
    expect(run.sessionId).not.toBe(session.sessionId);
    expect(run.sessionOwnerId).toBe("owner-alice");
    expect(run.userId).toBeUndefined();
    expect(await ctx.hasSession("support", run.sessionId!, "owner-alice")).toBe(true);
    expect(await ctx.hasSession("support", run.sessionId!)).toBe(false);
    expect(withThreadBindings(dataDir, (store) => store.getBinding(rootId, "support")))
      .toMatchObject({ owner: "owner-alice", source: "agent", sessionId: run.sessionId });
  });

  it("keeps the owned session while an inbound reply is queued for deferred delivery", async () => {
    let deferred: ((outcome: { result: RunAgentResult }) => Promise<void> | void) | undefined;
    ctx = buildFakeContext({ config, dataDir, run: (params) => {
      deferred = params.onDeferredResult;
      return { payloads: [], meta: { durationMs: 0, sessionId: session.sessionId, queued: true } };
    } });
    setMattermostContext(ctx);
    const session = await ctx.ensureSession("support", "scheduled-job", "job-owner");
    const result = await call("mattermost.create_thread", { channel: CHANNEL, text: "Job result" }, {
      sessionId: session.sessionId, userId: "job-owner",
    });
    const rootId = result.rootId as string;
    sockets.last().posted(server.addPost({
      channel_id: CHANNEL, root_id: rootId, user_id: ALICE.id, message: "Follow up on the job",
    }), 1);
    await flush();
    expect(ctx.runs).toHaveLength(1);
    expect(ctx.runs[0]).toMatchObject({ sessionId: session.sessionId, sessionOwnerId: "job-owner" });
    expect(ctx.runs[0].userId).toBeUndefined();
    expect(server.created().map((post) => post.message)).toEqual(["Job result"]);
    await deferred!({ result: {
      payloads: [{ text: "Deferred owned answer" }], meta: { durationMs: 1, sessionId: session.sessionId },
    } });
    expect(server.created().at(-1)).toMatchObject({ root_id: rootId, message: "Deferred owned answer" });
    expect(withThreadBindings(dataDir, (store) => store.getBinding(rootId, "support")))
      .toMatchObject({ sessionId: session.sessionId, owner: "job-owner", source: "agent" });
  });

  it("delivers scheduled results to a channel thread and throws when refused", async () => {
    const sink = createMattermostDeliverySink(
      buildFakeContext({ config, dataDir })
    );
    const root = server.addPost({
      channel_id: CHANNEL,
      user_id: ALICE.id,
      message: "root",
    });
    await sink({
      agent: config.agents[0],
      destination: { channel: `${CHANNEL}:${root.id}` },
      text: "done",
    });
    expect(server.created().at(-1)).toEqual({
      channel_id: CHANNEL,
      message: "done",
      root_id: root.id,
    });
    await expect(
      sink({
        agent: config.agents[0],
        destination: { channel: OTHER_CHANNEL },
        text: "no",
      })
    ).rejects.toThrow("routed to a different agent");
  });

  it("fails clearly when no bot runs", async () => {
    clearActiveBots();
    await expect(
      call("mattermost.send_message", { channel: CHANNEL, text: "x" })
    ).resolves.toMatchObject({
      ok: false,
      error: "No active Mattermost bot is running for this agent.",
    });
  });
});
