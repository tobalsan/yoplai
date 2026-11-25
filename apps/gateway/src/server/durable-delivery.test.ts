import fs from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ChannelInput, ChannelOwnerResolver, ExtensionContext, FeedWindow } from "@yoplai/shared";
import { expect, it, vi } from "vitest";
import { startDurableTestGateway } from "../test-utils/durable-gateway.js";
import type { MattermostBot } from "../../../../packages/extensions/mattermost/src/bot.js";
import { ALICE, DM_CHANNEL, FakeMattermost, FakeSocketFactory, TOKEN } from "../../../../packages/extensions/mattermost/src/test-fakes.js";
import { getMessageHandler, type MockSlackApp } from "../../../../packages/extensions/slack/src/test-fakes.js";

const slackApps: MockSlackApp[] = [];
vi.mock("../../../../packages/extensions/slack/node_modules/@slack/bolt/dist/index.js", async () =>
  (await import("../../../../packages/extensions/slack/src/test-fakes.js")).fakeSlackBolt(slackApps));

const feed = "/api/agents/pilot/feed";
const metrics = "/api/admin/durable/delivery";
const baseUrl = "https://garden-chat.example.test";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}
const slackDm: ChannelInput = {
  agentId: "pilot", owner: "local", surface: "slack", requestId: "slack:T-garden:D-orchard:Ev-1",
  actor: { surface: "slack", team: "T-garden", id: "U-gardener", name: "Morgan" },
  route: { sink: "slack", destination: { channel: "D-orchard" }, ingress: {
    surface: "slack", team: "T-garden", botKey: "pilot", channel: "D-orchard",
  } },
  text: "Check the seedlings.",
};

async function startDeliveryFixture(
  options: Parameters<typeof startDurableTestGateway>[0] = {},
  resolveOwner: ChannelOwnerResolver = () => "local",
) {
  let ctx!: ExtensionContext;
  let postFile!: string;
  const gateway = await startDurableTestGateway({
    ...options,
    startChannels(context, home) {
      ctx = context;
      postFile = path.join(home, "posts.jsonl");
      ctx.registerChannelOwnerResolver!("slack", resolveOwner);
      ctx.registerDeliverySink("slack", async ({ durable, text }) => {
        await fs.appendFile(postFile, JSON.stringify({ ingress: durable?.ingress, text }) + "\n");
        return { receipt: "123.456" };
      });
    },
  });
  return {
    ...gateway,
    submit: (input: ChannelInput = slackDm) => ctx.submitChannelInput!(input),
    async posts() {
      const text = await fs.readFile(postFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    async window(user: "local" | "alice" | "bob" = "local"): Promise<FeedWindow> {
      return (await gateway.request(user, feed)).json();
    },
  };
}

it("delivers the public Main answer once and keeps the original reply destination on replay", async () => {
  let ctx!: ExtensionContext;
  let posts!: string;
  const gateway = await startDurableTestGateway({
    startChannels(context, home) {
      ctx = context;
      posts = path.join(home, "posts.jsonl");
      ctx.registerChannelOwnerResolver?.("slack", () => "local");
      ctx.registerDeliverySink("slack", async ({ destination, text }) => {
        await fs.appendFile(posts, JSON.stringify({ destination, text }) + "\n");
        return { receipt: "123.456" };
      });
    },
  });
  try {
    expect(await ctx.submitChannelInput?.(slackDm)).toEqual({ status: "admitted", duplicate: false });
    await vi.waitFor(async () => {
      expect(await fs.readFile(posts, "utf8")).toBe('{"destination":{"channel":"D-orchard"},"text":"The seedlings are ready."}\n');
    }, 3500);
    await gateway.restart();
    const replay = { ...slackDm, route: {
      ...slackDm.route, destination: { channel: "D-nursery" }, ingress: { ...slackDm.route.ingress, channel: "D-nursery" },
    } };
    expect(await ctx.submitChannelInput?.(replay)).toEqual({ status: "admitted", duplicate: true });
    const window = await (await gateway.request("local", feed)).json();
    expect(window.items).toMatchObject([
      { role: "user", sender: "Morgan", surface: "slack", text: "Check the seedlings." },
      { role: "assistant", text: "The seedlings are ready." },
    ]);
    expect(gateway.callCount()).toBe(1);
    expect((await fs.readFile(posts, "utf8")).trim().split("\n")).toHaveLength(1);
  } finally {
    await gateway.close();
  }
});

it("publishes an uncertain delivery to a connected feed and never reposts after restart", async () => {
  let ctx!: ExtensionContext;
  let posts!: string;
  const reply = latch();
  const gateway = await startDurableTestGateway({
    startChannels(context, home) {
      ctx = context;
      posts = path.join(home, "posts.jsonl");
      ctx.registerChannelOwnerResolver?.("slack", () => "local");
      ctx.registerDeliverySink("slack", async ({ text }) => {
        await fs.appendFile(posts, text + "\n");
        await reply.promise;
      });
    },
  });
  try {
    const observer = await gateway.socket();
    observer.send({ type: "subscribeFeed", agentId: "pilot" });
    await vi.waitFor(() => expect(observer.events).toContainEqual(expect.objectContaining({ type: "feed_snapshot" })));
    await ctx.submitChannelInput!(slackDm);
    const sawDelivery = (state: string) => observer.events.some((event) => {
      const items = event.type === "feed_snapshot" ? event.items : event.type === "feed_delta" ? event.upsert : [];
      return items.some((item) => item.role === "assistant" && item.deliveries?.some(
        (delivery) => delivery.surface === "slack" && delivery.state === state,
      ));
    });
    await vi.waitFor(() => expect(sawDelivery("pending")).toBe(true));
    reply.resolve();
    await vi.waitFor(() => expect(sawDelivery("uncertain")).toBe(true));
    await gateway.restart();
    expect(await (await gateway.request("local", metrics)).json()).toEqual({ queueAgeSeconds: 0, pending: 0, uncertain: 1 });
    const { items } = await (await gateway.request("local", feed)).json();
    expect(items[1]).toMatchObject({ deliveries: [{ surface: "slack", state: "uncertain" }] });
    expect(await fs.readFile(posts, "utf8")).toBe("The seedlings are ready.\n");
  } finally {
    reply.resolve();
    await gateway.close();
  }
});

it("recovers a queued answer after closing before send, even with wakes suppressed", async () => {
  let ctx!: ExtensionContext;
  let posts!: string;
  let pause = true;
  const reached = vi.fn();
  const gateway = await startDurableTestGateway({
    deliveryFixture: {
      suppressWake: true,
      async beforeSend(signal: AbortSignal) {
        if (!pause) return;
        reached();
        if (!signal.aborted) await once(signal, "abort");
      },
    },
    startChannels(context, home) {
      ctx = context;
      posts = path.join(home, "posts.jsonl");
      ctx.registerChannelOwnerResolver!("slack", () => "local");
      ctx.registerDeliverySink("slack", async ({ text }) => {
        await fs.appendFile(posts, text + "\n");
        return { receipt: "123.456" };
      });
    },
  });
  try {
    await ctx.submitChannelInput!(slackDm);
    await vi.waitFor(async () => {
      const { items } = await (await gateway.request("local", feed)).json();
      expect(items[1]).toMatchObject({ deliveries: [{ surface: "slack", state: "pending" }] });
    });
    await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
    await expect(fs.readFile(posts)).rejects.toMatchObject({ code: "ENOENT" });
    const counts = await (await gateway.request("local", metrics)).json();
    expect(counts).toMatchObject({ pending: 1, uncertain: 0 });
    expect(counts.queueAgeSeconds).toBeGreaterThan(0);
    pause = false;
    await gateway.restart();
    // No other request opens the store after restarting.
    await vi.waitFor(async () => expect(await fs.readFile(posts, "utf8")).toBe("The seedlings are ready.\n"));
    expect(gateway.callCount()).toBe(1);
    await vi.waitFor(async () => {
      const { items } = await (await gateway.request("local", feed)).json();
      expect(items[1]).toMatchObject({ deliveries: [{ surface: "slack", state: "sent" }] });
    });
  } finally {
    await gateway.close();
  }
});

it("recovers a committed send without an outcome as uncertain even if the sink acknowledged it", async () => {
  let ctx!: ExtensionContext;
  let posts!: string;
  const reached = vi.fn();
  const gateway = await startDurableTestGateway({
    deliveryFixture: {
      async afterSend(signal) {
        reached();
        if (!signal.aborted) await once(signal, "abort");
      },
    },
    startChannels(context, home) {
      ctx = context;
      posts = path.join(home, "posts.jsonl");
      ctx.registerChannelOwnerResolver!("slack", () => "local");
      ctx.registerDeliverySink("slack", async ({ text }) => {
        await fs.appendFile(posts, text + "\n");
        return { receipt: "123.456" };
      });
    },
  });
  try {
    await ctx.submitChannelInput!(slackDm);
    await vi.waitFor(() => expect(reached).toHaveBeenCalledOnce());
    await gateway.restart();
    await vi.waitFor(async () => {
      const counts = await (await gateway.request("local", metrics)).json();
      expect(counts).toEqual({ queueAgeSeconds: 0, pending: 0, uncertain: 1 });
    });
    expect(await fs.readFile(posts, "utf8")).toBe("The seedlings are ready.\n");
    expect(reached).toHaveBeenCalledOnce();
  } finally {
    await gateway.close();
  }
});

it("deduplicates real Mattermost post events before and after restart and accepts identical text with a new id", async () => {
  const server = new FakeMattermost();
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const headers = Object.fromEntries(
      Object.entries(req.headers).flatMap(([key, value]) => typeof value === "string" ? [[key, value]] : []),
    );
    const response = await server.fetch("http://localhost" + req.url, {
      method: req.method, headers, body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  }).listen(0, "127.0.0.1");
  await once(http, "listening");
  const listenUrl = "http://127.0.0.1:" + (http.address() as AddressInfo).port;
  const sockets = new FakeSocketFactory();
  let bot!: MattermostBot;
  const requestIds: string[] = [];
  const gateway = await startDurableTestGateway({
    legacyAnswer: "Legacy reply",
    extraConfig: { server: { baseUrl } },
    async startChannels(ctx) {
      const { createMattermostBot } = await import("@yoplai/extension-mattermost");
      const registry = await import("../../../../packages/extensions/mattermost/src/bot-registry.js");
      const { createMattermostDeliverySink } = await import("../../../../packages/extensions/mattermost/src/agent-tools.js");
      const { setMattermostContext, clearMattermostContext } = await import("../../../../packages/extensions/mattermost/src/context.js");
      const submit = ctx.submitChannelInput!;
      ctx.submitChannelInput = (input) => { requestIds.push(input.requestId); return submit(input); };
      setMattermostContext(ctx);
      bot = createMattermostBot(ctx.getAgents(), {
        token: TOKEN, url: listenUrl + "/", dm: { agent: "pilot", allowFrom: [ALICE.id] },
      }, { createSocket: sockets.create })!;
      const previousSockets = sockets.sockets.length;
      const started = bot.start();
      await vi.waitFor(() => expect(sockets.sockets).toHaveLength(previousSockets + 1));
      sockets.last().open();
      sockets.last().hello("garden-connection");
      await started;
      registry.registerComponentBot(bot);
      ctx.registerChannelOwnerResolver!("mattermost", registry.resolveMattermostDmOwner);
      ctx.registerDeliverySink("mattermost", createMattermostDeliverySink(ctx));
      return async () => {
        await bot.stop();
        registry.clearActiveBots();
        clearMattermostContext();
      };
    },
  });
  try {
    const post = server.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Water the ferns." });
    const event = (post: { id: string }) => ({
      event: "posted", data: { post: JSON.stringify(post), channel_type: "D", sender_name: "@alice" },
    });
    await bot.handleEvent(event(post));
    await bot.handleEvent(event(post));
    await vi.waitFor(() => expect(server.created()).toEqual([{ channel_id: DM_CHANNEL, message: "The seedlings are ready." }]));
    await gateway.restart();
    await bot.handleEvent(event(post));
    expect(gateway.callCount()).toBe(1);
    gateway.script("The ferns have been watered.");
    const repeat = server.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Water the ferns." });
    await bot.handleEvent(event(repeat));
    await vi.waitFor(() => expect(server.created()).toEqual([
      { channel_id: DM_CHANNEL, message: "The seedlings are ready." },
      { channel_id: DM_CHANNEL, message: "The ferns have been watered." },
    ]));
    const { items } = await (await gateway.request("local", feed)).json();
    expect(items.filter((item: { role: string }) => item.role === "user")).toMatchObject([
      { sender: "alice", surface: "mattermost", text: "Water the ferns." },
      { sender: "alice", surface: "mattermost", text: "Water the ferns." },
    ]);
    expect(gateway.callCount()).toBe(2);
    expect(requestIds).toEqual([
      `mm:${listenUrl}:${post.id}`, `mm:${listenUrl}:${post.id}`, `mm:${listenUrl}:${repeat.id}`,
    ]);

    server.overrides.push({ match: (method, endpoint) => method === "POST" && endpoint === "/posts", reply: { status: 503 } });
    gateway.script("Mattermost receipt probe.", "fern ".repeat(3050));
    const failed = server.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Check the first plot." });
    await bot.handleEvent(event(failed));
    await vi.waitFor(async () => expect(await (await gateway.request("local", metrics)).json()).toMatchObject({ uncertain: 1 }));
    expect(server.created().filter(({ message }) => message === "Mattermost receipt probe.")).toHaveLength(1);
    await gateway.restart();
    await bot.handleEvent(event(failed));
    const next = server.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Check the second plot." });
    await bot.handleEvent(event(next));
    await vi.waitFor(() => expect(server.created()).toHaveLength(4));
    const longReply = server.created().at(-1)!.message;
    expect(longReply.length).toBeLessThanOrEqual(15000);
    expect(longReply.endsWith(`[Read in web chat](${baseUrl}/chat/pilot)`)).toBe(true);
    expect(server.created().filter(({ message }) => message === "Mattermost receipt probe.")).toHaveLength(1);
  } finally {
    await gateway.close();
    http.close();
  }
}, 10_000);

it("deduplicates real Slack events across restarts and sends through the ingress bot", async () => {
  const posts: Array<{ channel: string | null; text: string | null; component: boolean }> = [];
  let channelInfoUnavailable = false;
  let componentAllowFrom = ["U-gardener"];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const fields = new URLSearchParams(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (req.url === "/conversations.info") {
      if (channelInfoUnavailable) return res.writeHead(503).end("{}");
      const id = fields.get("channel");
      return res.end(JSON.stringify({ ok: true, channel: { id, is_im: true, user: id === "D-nursery" ? "U-nursery" : "U-gardener" } }));
    }
    if (req.url === "/users.info") return res.end(JSON.stringify({ ok: true, user: { name: "Morgan" } }));
    if (req.url === "/chat.postMessage") {
      posts.push({ channel: fields.get("channel"), text: fields.get("text"), component: req.headers.authorization === "Bearer xoxb-garden-fixture" });
      if (fields.get("text") === "Slack HTTP failure.") return res.writeHead(503).end("{}");
      if (fields.get("text") === "Slack rate limit.") return res.writeHead(429, { "Retry-After": "120" }).end("{}");
      return res.end(JSON.stringify({ ok: true, ts: "321.654" }));
    }
    res.writeHead(404).end();
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const requestIds: string[] = [];
  const gateway = await startDurableTestGateway({
    legacyAnswer: "Legacy reply",
    extraConfig: { server: { baseUrl } },
    async startChannels(ctx) {
      const { createSlackBot, createSlackAgentBot } = await import("@yoplai/extension-slack");
      const registry = await import("../../../../packages/extensions/slack/src/bot-registry.js");
      const { createSlackDeliverySink } = await import("../../../../packages/extensions/slack/src/agent-tools.js");
      const { setSlackContext, clearSlackContext } = await import("../../../../packages/extensions/slack/src/context.js");
      const submit = ctx.submitChannelInput!;
      ctx.submitChannelInput = (input) => { requestIds.push(input.requestId); return submit(input); };
      setSlackContext(ctx);
      slackApps.length = 0;
      const bot = createSlackBot(ctx.getAgents(), {
        token: "xoxb-garden-fixture", appToken: "xapp-garden-fixture", dm: { agent: "pilot", allowFrom: componentAllowFrom },
      })!;
      const agent = ctx.getAgents()[0];
      const dedicated = createSlackAgentBot({
        ...agent, extensions: { ...agent.extensions, slack: {
          token: "xoxb-dedicated-fixture", appToken: "xapp-dedicated-fixture", dm: { allowFrom: ["U-nursery"] },
        } },
      })!;
      for (const app of slackApps) {
        app.client.slackApiUrl = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
        app.client.auth.test.mockResolvedValue({ user_id: "U-bot", team_id: "T-garden" });
      }
      await bot.start();
      await dedicated.start();
      registry.registerComponentBot(bot);
      registry.registerActiveBot(agent.id, dedicated);
      ctx.registerChannelOwnerResolver!("slack", registry.resolveSlackDmOwner);
      ctx.registerDeliverySink("slack", createSlackDeliverySink(ctx));
      return async () => {
        await bot.stop();
        await dedicated.stop();
        registry.clearActiveBots();
        clearSlackContext();
      };
    },
  });
  try {
    const deliver = async (ts: string, eventId?: string, botIndex = 0, user = "U-gardener") => {
      const app = slackApps[botIndex];
      await getMessageHandler(app)({
        message: { ts, text: "Water the ferns.", channel: user === "U-nursery" ? "D-nursery" : "D-orchard", user, channel_type: "im" },
        body: { team_id: "T-garden", event_id: eventId },
        client: app.client,
      });
    };
    await deliver("1.0", "Ev-garden");
    await deliver("1.0", "Ev-garden");
    await vi.waitFor(() => expect(posts).toEqual([{ channel: "D-orchard", text: "The seedlings are ready.", component: true }]));
    await gateway.restart();
    channelInfoUnavailable = true;
    await deliver("1.1", "Ev-garden");
    channelInfoUnavailable = false;
    expect(gateway.callCount()).toBe(1);
    gateway.script("The ferns have been watered.");
    await deliver("2.0");
    await vi.waitFor(() => expect(posts).toEqual([
      { channel: "D-orchard", text: "The seedlings are ready.", component: true },
      { channel: "D-orchard", text: "The ferns have been watered.", component: true },
    ]));
    const { items } = await (await gateway.request("local", feed)).json();
    expect(items.filter((item: { role: string }) => item.role === "user")).toMatchObject([
      { sender: "Morgan", surface: "slack", text: "Water the ferns." },
      { sender: "Morgan", surface: "slack", text: "Water the ferns." },
    ]);
    expect(gateway.callCount()).toBe(2);
    expect(slackApps.flatMap((app) => app.client.chat.postMessage.mock.calls)).toHaveLength(0);
    expect(requestIds).toEqual(["slack:T-garden:D-orchard:Ev-garden", "slack:T-garden:D-orchard:Ev-garden", "slack:T-garden:D-orchard:2.0"]);

    const table = "| Long cultivar name | Seed packet count |\n| --- | --- |\n" + "| fern | 2 |\n".repeat(120);
    expect(table.length).toBeLessThan(4000);
    gateway.script("Slack HTTP failure.", "Slack rate limit.", table);
    for (const [ts, uncertain] of [["3.0", 1], ["4.0", 2]] as const) {
      await deliver(ts);
      await vi.waitFor(async () => expect(await (await gateway.request("local", metrics)).json()).toMatchObject({ uncertain }));
    }
    await deliver("5.0");
    await vi.waitFor(() => expect(posts).toHaveLength(5));
    const truncated = posts.at(-1)!.text!;
    expect(truncated.length).toBeLessThanOrEqual(4000);
    expect(truncated.startsWith("- Long cultivar name: fern")).toBe(true);
    expect(truncated.endsWith(`<${baseUrl}/chat/pilot|Read in web chat>`)).toBe(true);

    await gateway.restart();
    await deliver("3.0");
    await deliver("4.0");
    await deliver("6.0", undefined, 1);
    expect(posts).toHaveLength(5);
    gateway.script("The nursery is ready.");
    await deliver("7.0", undefined, 1, "U-nursery");
    await vi.waitFor(() => expect(posts.at(-1)).toEqual({ channel: "D-nursery", text: "The nursery is ready.", component: false }));
    expect(posts).toHaveLength(6);
    expect(posts.filter(({ text }) => text === "Slack HTTP failure.")).toHaveLength(1);
    expect(posts.filter(({ text }) => text === "Slack rate limit.")).toHaveLength(1);

    for (const allowFrom of [[], ["U-gardener", "U-nursery"]]) {
      componentAllowFrom = allowFrom;
      await gateway.restart();
      await deliver("8.0");
      expect(slackApps[0].client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Legacy reply" }));
    }
    expect(posts).toHaveLength(6);
    const latestFeed: FeedWindow = await (await gateway.request("local", feed)).json();
    expect(latestFeed.items.filter((item) => item.role === "user")).toHaveLength(6);
  } finally {
    await gateway.close();
    server.close();
  }
}, 10_000);

it("shares one reply for steers in the same destination and separates identical channel ids across workspaces", async () => {
  const working = latch();
  const resume = latch();
  const gateway = await startDeliveryFixture({
    fixture: { extension: defineExtension({
      name: "garden-survey",
      tools: [defineTool({
        name: "survey", description: "Finish the garden survey.", parameters: { type: "object" },
        async execute() {
          working.resolve();
          await resume.promise;
          return { output: [{ type: "text", text: "The survey is complete." }] };
        },
      })],
    }) },
  });
  try {
    gateway.script({ tool: "survey" }, "Both gardens are healthy.");
    await gateway.submit(slackDm);
    await working.promise;
    await gateway.submit({ ...slackDm, requestId: "slack:T-garden:D-orchard:Ev-2", text: "Include the north garden." });
    await gateway.submit({
      ...slackDm, requestId: "slack:T-nursery:D-orchard:Ev-3", text: "Include the nursery.",
      actor: { surface: "slack", team: "T-nursery", id: "U-nursery", name: "[Taylor]\n" },
      route: { ...slackDm.route, ingress: { ...slackDm.route.ingress, surface: "slack", team: "T-nursery" } },
    });
    resume.resolve();
    await vi.waitFor(async () => {
      expect(await gateway.posts()).toEqual([
        { ingress: expect.objectContaining({ team: "T-garden", channel: "D-orchard" }), text: "Both gardens are healthy." },
        { ingress: expect.objectContaining({ team: "T-nursery", channel: "D-orchard" }), text: "Both gardens are healthy." },
      ]);
    });
    expect(gateway.callCount()).toBe(2);
    expect(gateway.requests[1].messages.filter(({ role }) => role === "user").map(({ content }) => content)).toEqual([
      "[from Morgan via slack]\nCheck the seedlings.",
      "[from Morgan via slack]\nInclude the north garden.",
      "[from  Taylor   via slack]\nInclude the nursery.",
    ]);
    await vi.waitFor(async () => {
      const { items } = await gateway.window();
      expect(items.filter((item) => item.role === "user")).toHaveLength(3);
      expect(items.find((item) => item.role === "assistant" && item.text === "Both gardens are healthy.")).toMatchObject({
        deliveries: [{ surface: "slack", state: "sent" }, { surface: "slack", state: "sent" }],
      });
    });
  } finally {
    resume.resolve();
    await gateway.close();
  }
});

it("drops a queued delivery when the binding is removed before send", async () => {
  let owner: string | undefined = "local";
  const beforeSend = latch();
  const send = latch();
  const gateway = await startDeliveryFixture({
    deliveryFixture: { beforeSend: async () => { beforeSend.resolve(); await send.promise; } },
  }, () => owner);
  try {
    await gateway.submit();
    await beforeSend.promise;
    owner = undefined;
    send.resolve();
    await vi.waitFor(async () => {
      expect(await (await gateway.request("local", metrics)).json()).toEqual({ pending: 0, uncertain: 0, queueAgeSeconds: 0 });
    });
    owner = "local";
    await gateway.restart();
    const { items } = await gateway.window();
    expect(items[1]).toMatchObject({ role: "assistant", text: "The seedlings are ready." });
    expect(items[1]).not.toHaveProperty("deliveries");
    expect(await gateway.posts()).toEqual([]);
  } finally {
    send.resolve();
    await gateway.close();
  }
});

it("recovers the pending fallback after restarting between the primary failure and the public answer", async () => {
  const fallbackStarted = latch();
  const gateway = await startDeliveryFixture({
    extraYaml: "retryMaxAttempts: 1\nfallback_model: { provider: faux, model: fixture-alternate }",
  });
  try {
    gateway.script({ errorMessage: "503 Model unavailable." }, async (_model, signal) => {
      if (!signal) throw new Error("Expected the model request to carry an abort signal.");
      fallbackStarted.resolve();
      if (!signal.aborted) await once(signal, "abort");
      signal.throwIfAborted();
      return "Abandoned response.";
    }, (model) => "Answered by " + model);
    await gateway.submit();
    await fallbackStarted.promise;
    expect(await gateway.posts()).toEqual([]);
    expect(await (await gateway.request("local", metrics)).json()).toMatchObject({ pending: 1, uncertain: 0 });
    await gateway.restart();
    await vi.waitFor(async () => expect(await gateway.posts()).toMatchObject([{ text: "Answered by fixture-alternate" }]));
    expect(gateway.callCount()).toBe(3);
    expect((await gateway.window()).items).toMatchObject([
      { role: "user", text: "Check the seedlings." },
      { role: "assistant", text: "Answered by fixture-alternate" },
    ]);
  } finally {
    await gateway.close();
  }
});

it("publishes failure notices and suppresses rejected drafts without a channel post", async () => {
  const gateway = await startDeliveryFixture({
    extraYaml: "retryMaxAttempts: 1",
    reviewer: { begin() {}, end() {}, async review() { return { ok: false, rewriteHint: "" }; } },
  });
  try {
    gateway.script({ errorMessage: "403 Fixture failure." }, "Held draft.", "Rejected rewrite.");
    await gateway.submit();
    await vi.waitFor(async () => expect((await gateway.window()).items).toMatchObject([
      { role: "user", text: "Check the seedlings." }, { role: "failure" },
    ]));
    await gateway.submit({ ...slackDm, requestId: "slack:T-garden:D-orchard:Ev-2", text: "Check the nursery." });
    await vi.waitFor(async () => {
      expect(await (await gateway.request("local", metrics)).json()).toEqual({ pending: 0, uncertain: 0, queueAgeSeconds: 0 });
    });
    expect((await gateway.window()).items).toMatchObject([
      { role: "user", text: "Check the seedlings." }, { role: "failure" },
      { role: "user", text: "Check the nursery." },
    ]);
    expect(await gateway.posts()).toEqual([]);
  } finally {
    await gateway.close();
  }
});

it("keeps an unbound Mattermost DM on legacy and exposes a paired sender only in their own Main", async () => {
  const server = new FakeMattermost();
  const alice = { ...ALICE, email: "alice@example.test" };
  server.users.set(ALICE.id, alice);
  const sockets = new FakeSocketFactory();
  const checkingDm = latch();
  const finishCheck = latch();
  let holdNextDelivery = false;
  let holdChannelRequest = false;
  let bot!: MattermostBot;
  const gateway = await startDurableTestGateway({
    multiUser: true,
    legacyAnswer: "Legacy reply",
    deliveryFixture: { async beforeSend() { holdChannelRequest = holdNextDelivery; } },
    async startChannels(ctx) {
      const { createMattermostBot } = await import("@yoplai/extension-mattermost");
      const registry = await import("../../../../packages/extensions/mattermost/src/bot-registry.js");
      const { createMattermostDeliverySink } = await import("../../../../packages/extensions/mattermost/src/agent-tools.js");
      const { setMattermostContext, clearMattermostContext } = await import("../../../../packages/extensions/mattermost/src/context.js");
      setMattermostContext(ctx);
      bot = createMattermostBot(ctx.getAgents(), {
        token: TOKEN, url: "https://garden.example.test", dm: { agent: "pilot", allowFrom: [ALICE.id] },
      }, {
        fetch: async (url, init) => {
          if (holdChannelRequest && url.endsWith("/channels/" + DM_CHANNEL)) {
            holdChannelRequest = false;
            checkingDm.resolve();
            await finishCheck.promise;
          }
          return server.fetch(url, init);
        },
        createSocket: (...args) => {
          const socket = sockets.create(...args);
          queueMicrotask(() => { socket.open(); socket.hello("garden-connection"); });
          return socket;
        },
      })!;
      await bot.start();
      registry.registerComponentBot(bot);
      ctx.registerChannelOwnerResolver!("mattermost", registry.resolveMattermostDmOwner);
      ctx.registerDeliverySink("mattermost", createMattermostDeliverySink(ctx));
      return async () => {
        await bot.stop();
        registry.clearActiveBots();
        clearMattermostContext();
      };
    },
  });
  try {
    const deliver = async (text: string, user = ALICE.id) => {
      const post = server.addPost({ channel_id: DM_CHANNEL, user_id: user, message: text });
      await bot.handleEvent({ event: "posted", data: {
        post: JSON.stringify(post), channel_type: "D", sender_name: "@alice",
      } });
    };
    await deliver("Is the shed open?", "disallowed");
    expect(server.created()).toHaveLength(0);
    await deliver("Is the shed open?");
    expect(server.created()).toEqual([{ channel_id: DM_CHANNEL, message: "Legacy reply" }]);
    for (const user of ["alice", "bob"] as const) {
      const response = await gateway.request(user, feed);
      expect(response.status).toBe(200);
      expect((await response.json()).items).toEqual([]);
    }
    expect((await gateway.request("alice", metrics)).status).toBe(200);
    expect((await gateway.request("bob", metrics)).status).toBe(403);
    await deliver("!pair");
    const link = server.created().at(-1)?.message.match(/http:\/\/localhost:3000\/api\/surface-links\/pair\/[^ ]+/)?.[0];
    expect(link).toBeDefined();
    const redeem = await gateway.request("alice", new URL(link!).pathname, {
      method: "POST", headers: { Origin: "http://localhost:3000" },
    });
    expect(redeem.status).toBe(200);
    await deliver("Please check the seedlings.");
    await vi.waitFor(() => expect(server.created().at(-1)).toEqual({ channel_id: DM_CHANNEL, message: "The seedlings are ready." }));
    const { items } = await (await gateway.request("alice", feed)).json();
    expect(items).toMatchObject([
      { role: "user", surface: "mattermost", sender: "alice", text: "Please check the seedlings." },
      { role: "assistant", text: "The seedlings are ready." },
    ]);
    expect((await (await gateway.request("bob", feed)).json()).items).toEqual([]);
    expect(gateway.callCount()).toBe(1);

    gateway.script("The answer to the private check.");
    holdNextDelivery = true;
    await deliver("Check the private plot.");
    await checkingDm.promise;
    const { links } = await (await gateway.request("alice", "/api/surface-links")).json();
    const unlink = await gateway.request("alice", "/api/surface-links/" + links[0].id, {
      method: "DELETE", headers: { Origin: "http://localhost:3000" },
    });
    expect(unlink.status).toBe(200);
    finishCheck.resolve();
    await vi.waitFor(async () => {
      const aliceFeed: FeedWindow = await (await gateway.request("alice", feed)).json();
      const answer = aliceFeed.items.find((item) => item.text === "The answer to the private check.");
      expect(answer).toBeDefined();
      expect(answer).not.toHaveProperty("deliveries");
    });
    expect(server.created().filter(({ message }) => message === "The answer to the private check.")).toHaveLength(0);
  } finally {
    finishCheck.resolve();
    await gateway.close();
  }
}, 10_000);

it("rechecks ownership for a DM waiting behind a reviewed turn", async () => {
  const reviewing = latch();
  const finishReview = latch();
  const checked = latch();
  let bound = true;
  const gateway = await startDeliveryFixture({
    reviewer: {
      begin() {}, end() {},
      async review(text) {
        if (text === "The first plot is ready.") {
          reviewing.resolve();
          await finishReview.promise;
        }
        return { ok: true };
      },
    },
  }, ({ actor, verifyDestination }) => {
    const owner = bound ? "local" : undefined;
    if (actor.name === "Taylor" && !verifyDestination) checked.resolve();
    return owner;
  });
  try {
    gateway.script("The first plot is ready.", "The second plot is ready.");
    await gateway.submit();
    await reviewing.promise;
    const second = gateway.submit({
      ...slackDm, text: "Check the second plot.", requestId: "slack:T-garden:D-orchard:Ev-2",
      actor: { ...slackDm.actor, name: "Taylor" },
    });
    await checked.promise;
    bound = false;
    finishReview.resolve();
    expect(await second).toEqual({ status: "not_durable" });
    expect((await gateway.window()).items).toMatchObject([
      { role: "user", text: "Check the seedlings." },
      { role: "assistant", text: "The first plot is ready." },
    ]);
    expect(gateway.callCount()).toBe(1);
  } finally {
    finishReview.resolve();
    await gateway.close();
  }
});
