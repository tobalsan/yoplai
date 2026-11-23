import fs from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  ALICE,
  CHANNEL,
  DM_CHANNEL,
  FakeMattermost,
  FakeSocketFactory,
  TOKEN,
  buildFakeContext,
} from "../../../../packages/extensions/mattermost/src/test-fakes.js";
import { writeTestV3Config, type TestAgentConfig } from "../test-utils/v3-config.js";

const mattermost = new FakeMattermost();
const sockets = new FakeSocketFactory();

const slackApps: FakeSlackApp[] = [];

class FakeSlackApp {
  readonly client = {
    auth: { test: async () => ({ user_id: "UBOT", bot_id: "BBOT" }) },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: "reply" }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    conversations: { info: vi.fn().mockResolvedValue({ channel: { name: "dm" } }) },
  };
  readonly message = vi.fn();
  readonly event = vi.fn();
  readonly command = vi.fn();
  readonly start = vi.fn();
  readonly init = vi.fn().mockResolvedValue(undefined);
  readonly stop = vi.fn();

  constructor(options: { token: string }) {
    if (options.token === "fixture-stalled-slack-bot") {
      this.client.auth.test = () => new Promise(() => {});
    }
    slackApps.push(this);
  }
}

vi.mock("../../../../packages/extensions/slack/node_modules/@slack/bolt", () => ({
  App: FakeSlackApp, SocketModeReceiver: class {},
}));

let home: string | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.unstubAllEnvs();
  vi.doUnmock("../../../../packages/extensions/mattermost/src/bot.js");
  vi.resetModules();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

async function setup(agents: TestAgentConfig[], extensions?: Record<string, unknown>) {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-save-to-reply-"));
  home = tempHome;
  vi.stubEnv("YOPLAI_HOME", tempHome);
  await writeTestV3Config(tempHome, {
    agents, extensions,
    extraConfig: { oauth: { encryptionKey: "fixture-channel-settings-key" } },
  });
  vi.doMock("../../../../packages/extensions/mattermost/src/bot.js", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../../../packages/extensions/mattermost/src/bot.js")>();
    const rotated = "fixture-rotated-mattermost-token";
    const transport: NonNullable<Parameters<typeof real.createMattermostAgentBot>[1]> = {
      fetch(input, init) {
        const headers = { ...init?.headers as Record<string, string> | undefined };
        if (headers.Authorization === `Bearer ${rotated}`) headers.Authorization = `Bearer ${TOKEN}`;
        return mattermost.fetch(input, { ...init, headers });
      },
      createSocket(url, headers) {
        const socket = sockets.create(url, headers);
        if (!url.includes("stalled.example.test")) {
          queueMicrotask(() => {
            socket.open();
            socket.hello("fixture-connection");
          });
        }
        return socket;
      },
    };
    return {
      ...real,
      createMattermostAgentBot: (agent: Parameters<typeof real.createMattermostAgentBot>[0]) =>
        real.createMattermostAgentBot(agent, transport),
      createMattermostBot: (...[agents, config]: Parameters<typeof real.createMattermostBot>) =>
        real.createMattermostBot(agents, config, transport),
    };
  });
  const { loadConfig } = await import("../config/index.js");
  const { setExtensionActivator, stopCurrentExtensions } = await import("./registry.js");
  const { api } = await import("../server/api.core.js");
  const ctx = buildFakeContext({ config: loadConfig(), dataDir: tempHome });
  ctx.getConfig = loadConfig;
  ctx.registerUserNotifier = () => () => undefined;
  ctx.getAgents = () => loadConfig().agents;
  ctx.getAgent = (id) => loadConfig().agents.find((agent) => agent.id === id);
  setExtensionActivator((extension) => extension.start(ctx));
  stop = async () => {
    await stopCurrentExtensions();
  };

  const patch = (channel: string, body: unknown) => api.request(`/agents/sales/extensions/${channel}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ctx, patch, tempHome, loadConfig, api };
}

it("saves Mattermost credentials and accepts a DM through the newly started bot", async () => {
  const { ctx, patch: patchChannel, tempHome, loadConfig } = await setup([
    { id: "sales" },
    { id: "support", extraYaml: `extensions:
  mattermost:
    url: https://support.example.test
    token: ${TOKEN}
    dmEnabled: true` },
  ], {
    mattermost: { url: "https://shared.example.test", token: TOKEN, dm: { agent: "support" } },
  });
  const patch = (body: unknown) => patchChannel("mattermost", body);
  const response = await patch({
    enabled: true,
    config: { url: "https://chat.example.test", dmEnabled: true },
    secrets: { token: TOKEN },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    extensions: expect.arrayContaining([expect.objectContaining({
      id: "mattermost", enabled: true, configured: true, tier: "auto-form",
      configValues: { url: "https://chat.example.test", dmEnabled: true, token: "********" },
    })]),
  });
  const workspace = path.join(tempHome, "agents", "sales");
  const yaml = await fs.readFile(path.join(workspace, "agent.yaml"), "utf8");
  expect(parse(yaml).extensions.mattermost).toEqual({
    enabled: true, url: "https://chat.example.test", dmEnabled: true, token: "$env:MATTERMOST_TOKEN",
  });
  expect(yaml).not.toContain(TOKEN);
  expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toBe(`MATTERMOST_TOKEN=${TOKEN}\n`);

  const firstSocket = sockets.sockets.find((socket) => socket.url.includes("chat.example.test"))!;
  const supportSocket = sockets.sockets.find((socket) => socket.url.includes("support.example.test"))!;
  const sharedSocket = sockets.sockets.find((socket) => socket.url.includes("shared.example.test"))!;
  const dm = mattermost.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Can you help?" });
  firstSocket.posted(dm, 1, { channel_type: "D" });
  await vi.waitFor(() => expect(ctx.runs).toHaveLength(1));

  expect((await patch({ enabled: false })).status).toBe(200);
  expect(firstSocket.closed || firstSocket.terminated).toBe(true);
  expect(supportSocket.closed || supportSocket.terminated).toBe(false);
  expect(sharedSocket.closed || sharedSocket.terminated).toBe(false);
  expect((await patch({ enabled: true })).status).toBe(200);
  expect(sockets.last()).not.toBe(firstSocket);
  const nextDm = mattermost.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Still there?" });
  sockets.last().posted(nextDm, 1, { channel_type: "D" });
  await vi.waitFor(() => expect(ctx.runs).toHaveLength(2));

  const reenabledSocket = sockets.last();
  expect((await patch({ secrets: { token: "fixture-rotated-mattermost-token" } })).status).toBe(200);
  expect(reenabledSocket.closed || reenabledSocket.terminated).toBe(true);
  expect(sockets.last().headers.Authorization).toBe("Bearer fixture-rotated-mattermost-token");
  expect(supportSocket.closed || supportSocket.terminated).toBe(false);
  expect(sharedSocket.closed || sharedSocket.terminated).toBe(false);

  expect((await patch({ config: { dmEnabled: false } })).status).toBe(200);
  const afterRevocation = sockets.last();
  const revokedDm = mattermost.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Route revoked" });
  afterRevocation.posted(revokedDm, 1, { channel_type: "D" });
  const sink = ctx.sinks.get("mattermost")!;
  await sink({
    agent: loadConfig().agents.find((agent) => agent.id === "sales")!,
    destination: { channel: CHANNEL },
    text: "Scheduled report",
  });
  expect(ctx.runs).toHaveLength(2);
  expect(mattermost.created()).toContainEqual({ channel_id: CHANNEL, message: "Scheduled report" });
});

it("saves both Slack tokens and accepts a DM through the newly started bot", async () => {
  const { ctx, patch, tempHome } = await setup([{ id: "sales" }]);
  const response = await patch("slack", {
    enabled: true, config: { dmEnabled: true, channelIds: "C1, C2" },
    secrets: { token: "fixture-slack-bot", appToken: "fixture-slack-app" },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const workspace = path.join(tempHome, "agents", "sales");
  expect(parse(await fs.readFile(path.join(workspace, "agent.yaml"), "utf8")).extensions.slack).toMatchObject({
    token: "$env:SLACK_TOKEN", appToken: "$env:SLACK_APP_TOKEN",
  });
  expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toContain("SLACK_APP_TOKEN=fixture-slack-app");
  const app = slackApps.at(-1)!;
  expect(app.start).toHaveBeenCalledOnce();
  const [onMessage] = app.message.mock.calls[0];
  await onMessage({ client: app.client, message: { channel: "D123", channel_type: "im", user: "U123", ts: "1.1", text: "Hello Slack" } });
  await vi.waitFor(() => expect(ctx.runs).toHaveLength(1));
});

const telegramBots: FakeTelegramBot[] = [];
class FakeTelegramBot {
  readonly api = { config: { use: vi.fn() } };
  readonly on = vi.fn();
  readonly catch = vi.fn();
  readonly init = vi.fn().mockResolvedValue(undefined);
  readonly start = vi.fn().mockResolvedValue(undefined);
  readonly stop = vi.fn().mockResolvedValue(undefined);

  constructor() {
    telegramBots.push(this);
  }
}

vi.mock("../../../../packages/extensions/telegram/node_modules/grammy", async (importOriginal) => ({
  ...await importOriginal<object>(),
  Bot: FakeTelegramBot,
}));

it.each([false, true])("accepts a Telegram DM from a saved or legacy setup (legacy: %s)", async (legacy) => {
  const { ctx, patch, tempHome } = await setup([{ id: "sales", extraYaml: legacy ? `
telegram:
  token: fixture-telegram-token
  allowedUsers: [101, alice]
  allowedChats: [101]
` : undefined }]);
  const workspace = path.join(tempHome, "agents", "sales");
  if (legacy) {
    const { reloadAfterExtensionWrite } = await import("./reload.js");
    await reloadAfterExtensionWrite();
  } else {
    const response = await patch("telegram", {
      enabled: true, config: { allowedUsers: "101, alice", allowedChats: "101" },
      secrets: { token: "fixture-telegram-token" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(parse(await fs.readFile(path.join(workspace, "agent.yaml"), "utf8")).extensions.telegram.token).toBe("$env:TELEGRAM_TOKEN");
    expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toBe("TELEGRAM_TOKEN=fixture-telegram-token\n");
  }
  const bot = telegramBots.at(-1)!;
  expect(bot.start).toHaveBeenCalledOnce();
  const onMessage = bot.on.mock.calls.find(([event]) => event === "message:text")?.[1];
  const dm = {
    chat: { id: 101, type: "private" }, from: { id: 101, first_name: "Alice" },
    message: { text: "Hello Telegram" },
    reply: vi.fn().mockResolvedValue({ message_id: 1 }),
    replyWithChatAction: vi.fn().mockResolvedValue(undefined),
  };
  await onMessage(dm);
  await vi.waitFor(() => expect(ctx.runs).toHaveLength(1));
  expect(ctx.sinks.has("telegram")).toBe(true);
  if (legacy) return;
  const cleared = await patch("telegram", { config: { allowedChats: "" } });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ extensions: expect.arrayContaining([
    expect.objectContaining({ id: "telegram", configured: false, missingConfig: ["allowedChats"] }),
  ]) });
  expect(parse(await fs.readFile(path.join(workspace, "agent.yaml"), "utf8")).extensions.telegram.allowedChats).toBeUndefined();
  expect(bot.stop).toHaveBeenCalledOnce();
  const reloaded = telegramBots.at(-1)!;
  expect(reloaded).not.toBe(bot);
  const afterClear = reloaded.on.mock.calls.find(([event]) => event === "message:text")?.[1];
  await afterClear(dm);
  await onMessage(dm);
  expect(ctx.runs).toHaveLength(1);
});

const discordClient = {
  rest: {
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({ id: "reply" }),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
};
const startDiscord = vi.fn().mockReturnValue(discordClient);
const disconnectDiscord = vi.fn();

vi.mock("../../../../packages/extensions/discord/src/client.js", () => ({
  createCarbonClient: startDiscord,
  getGatewayPlugin: () => ({ isConnected: false, disconnect: disconnectDiscord }),
}));

it.each([false, true])("accepts a Discord DM with a token only (legacy: %s)", async (legacy) => {
  const { ctx, patch, tempHome } = await setup([{ id: "sales", extraYaml: legacy
    ? "discord:\n  token: fixture-discord-token" : undefined }]);
  const fetch = vi.fn(async () => Response.json({ id: "discord-fixture-app" }));
  startDiscord.mockClear();
  disconnectDiscord.mockClear();
  vi.stubGlobal("fetch", fetch);
  try {
    if (legacy) {
      const { reloadAfterExtensionWrite } = await import("./reload.js");
      await reloadAfterExtensionWrite();
    } else {
      const response = await patch("discord", { enabled: true, secrets: { token: "fixture-discord-token" } });
      expect(response.status, await response.clone().text()).toBe(200);
      const workspace = path.join(tempHome, "agents", "sales");
      expect(parse(await fs.readFile(path.join(workspace, "agent.yaml"), "utf8")).extensions.discord.token).toBe("$env:DISCORD_TOKEN");
      expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toBe("DISCORD_TOKEN=fixture-discord-token\n");
    }
    expect(startDiscord).toHaveBeenCalledOnce();
    const [{ onReady, onMessage }] = startDiscord.mock.calls[0];
    await onReady({ user: { id: "bot", username: "Bot" } }, discordClient);
    await onMessage({ id: "dm1", channel_id: "dm", content: "Hello Discord", author: { id: "alice", username: "Alice" }, mentions: [] }, discordClient);
    expect(ctx.runs).toHaveLength(1);
    expect(ctx.sinks.has("discord")).toBe(true);
    expect((await patch("discord", { enabled: false })).status).toBe(200);
    expect(disconnectDiscord).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([false, true])("replies to an IRC PRIVMSG through the started service (legacy: %s)", async (legacy) => {
  const peers = new Set<net.Socket>();
  let lines = "";
  const server = net.createServer((peer) => {
    peers.add(peer);
    peer.setEncoding("utf8").on("data", (chunk: string) => { lines += chunk; });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as net.AddressInfo;
    const password = 'fixture-"irc"\\password';
    const { ctx, patch, tempHome } = await setup([{ id: "sales", extraYaml: legacy ? `
irc:
  host: ${address.address}
  port: ${address.port}
  tls: false
  nick: salesbot
  password: $env:LEGACY_IRC_PASSWORD
  dm: { enabled: true }
` : undefined }]);
    if (legacy) {
      await fs.writeFile(path.join(tempHome, ".env"), `LEGACY_IRC_PASSWORD='${password}'\n`);
      const { reloadAfterExtensionWrite } = await import("./reload.js");
      await reloadAfterExtensionWrite();
    } else {
      const response = await patch("irc", {
        enabled: true,
        config: { host: address.address, port: address.port, tls: false, nick: "salesbot", dmEnabled: true },
        secrets: { password },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const workspace = path.join(tempHome, "agents", "sales");
      expect(parse(await fs.readFile(path.join(workspace, "agent.yaml"), "utf8")).extensions.irc).toMatchObject({
        password: "$env:IRC_PASSWORD", tls: false,
      });
      expect(parseEnv(await fs.readFile(path.join(workspace, ".env"), "utf8")).IRC_PASSWORD).toBe(password);
    }
    await vi.waitFor(() => expect(lines).toContain("NICK salesbot"));
    expect(lines).toContain(`PASS ${password}\r\n`);
    for (const peer of peers) peer.write(":irc.test 001 salesbot :Welcome\r\n:alice!alice@irc.test PRIVMSG salesbot :Hello IRC\r\n");
    await vi.waitFor(() => expect(lines).toContain("PRIVMSG alice :agent-ok"));
    expect(ctx.runs).toMatchObject([{ agentId: "sales", message: "Hello IRC" }]);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("saves Threadit credentials and handles a board mention through the new poller", async () => {
  const { ctx, patch, tempHome } = await setup([{ id: "sales" }]);
  const agent = { id: 7, username: "bot", account_type: "agent" };
  const mention = {
    id: 12, thread_id: 40, body: "@bot Hello Threadit", created_at: "2026-01-01T00:00:00Z",
    author: { id: 1, username: "alice", account_type: "human" }, attachments: [], agent_sessions: [],
  };
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    expect(url.hostname).toBe("board.example.test");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-threadit-token");
    if (url.pathname === "/api/me") return Response.json(agent);
    if (url.pathname === "/api/users") return Response.json({ users: [mention.author] });
    if (url.pathname === "/api/attention") {
      return Response.json({ items: url.searchParams.get("status") === "processing" ? [] : [mention], has_more: false });
    }
    if (url.pathname.endsWith("/context")) {
      return Response.json({ area: { name: "Fixture" }, thread: { title: "Example" }, top_level: [mention], chain: [mention] });
    }
    if (url.pathname.endsWith("/agent-activities")) {
      return Response.json({ agent, stop_requested: null, state: "working", reply_id: null });
    }
    if (url.pathname.endsWith("/reactions")) return Response.json({});
    if (url.pathname === "/api/messages/12") return Response.json(mention);
    if (url.pathname === "/api/threads/40/messages") return Response.json({ id: 90 });
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const response = await patch("threadit", {
      enabled: true, config: { baseUrl: "https://board.example.test" },
      secrets: { token: "fixture-threadit-token" },
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const workspace = path.join(tempHome, "agents", "sales");
    expect(parse(await fs.readFile(path.join(workspace, "agent.yaml"), "utf8")).extensions.threadit.token).toBe("$env:THREADIT_TOKEN");
    expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toBe("THREADIT_TOKEN=fixture-threadit-token\n");
    await vi.waitFor(() => expect(ctx.runs).toHaveLength(1));
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url, init]) =>
      new URL(url).pathname === "/api/threads/40/messages" && String(init?.body).includes("agent-ok")
    )).toBe(true));
  } finally {
    await stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
  }
});

it("accepts incomplete channel settings, rejects bad formats and personal scope, and clears old routes", async () => {
  const { patch, tempHome } = await setup([{ id: "sales", extraYaml: `extensions:
  mattermost:
    enabled: true
    dm: { allowFrom: [alice], enabled: false }
    channels: { team: { requireMention: false } }` }]);
  const yamlPath = path.join(tempHome, "agents", "sales", "agent.yaml");
  const original = await fs.readFile(yamlPath, "utf8");
  const invalid = await patch("mattermost", { config: { url: "ftp://chat.example.test" } });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({ fields: ["url"] });
  expect(await fs.readFile(yamlPath, "utf8")).toBe(original);
  expect((await patch("mattermost", { credentialScope: "personal", secrets: { token: TOKEN } })).status).toBe(400);

  const incomplete = await patch("mattermost", { config: { url: "https://chat.example.test" }, secrets: { token: "" } });
  expect(incomplete.status).toBe(200);
  expect(await incomplete.json()).toMatchObject({ extensions: expect.arrayContaining([
    expect.objectContaining({ id: "mattermost", configured: false, missingConfig: ["token"] }),
  ]) });
  expect(parse(await fs.readFile(yamlPath, "utf8")).extensions.mattermost).toMatchObject({
    channels: { team: { requireMention: false } }, dm: { allowFrom: ["alice"] },
  });

  expect((await patch("mattermost", { config: { channelIds: "replacement" } })).status).toBe(200);
  expect((await patch("mattermost", { config: { channelIds: "" } })).status).toBe(200);
  const block = parse(await fs.readFile(yamlPath, "utf8")).extensions.mattermost;
  expect(block.channels).toBeUndefined();
  expect(block.channelIds).toBeUndefined();
  expect(block.dm).toEqual({ allowFrom: ["alice"], enabled: false });
});

it.each([
  ["mattermost", false], ["mattermost", true], ["slack", false], ["slack", true],
] as const)("hot-reloads a hand-written %s block (another agent already running: %s)", async (channel, withSupport) => {
  const settings = channel === "mattermost"
    ? `url: https://chat.example.test\n    token: ${TOKEN}`
    : "token: fixture-slack-bot\n    appToken: fixture-slack-app";
  const { ctx, tempHome, loadConfig } = await setup([
    { id: "sales" },
    ...(withSupport ? [{ id: "support", extraYaml: `extensions:\n  ${channel}:\n    ${settings}` }] : []),
  ]);
  const { reconcileExternal } = await import("./registry.js");
  const { startGatewayHotReload } = await import("../config/hot-reload.js");
  await reconcileExternal(loadConfig());
  const before = channel === "mattermost" ? sockets.sockets.length : slackApps.length;
  const salesYaml = path.join(tempHome, "agents", "sales", "agent.yaml");
  const initial = await fs.readFile(salesYaml, "utf8");
  const timer = startGatewayHotReload(loadConfig(), { intervalMs: 30 });
  try {
    const legacySettings = settings.replaceAll("\n    ", "\n  ");
    await fs.writeFile(salesYaml, `${initial}\n${channel}:\n  ${legacySettings}\n  dm: { enabled: true }\n`);
    await vi.waitFor(() => {
      if (channel === "mattermost") expect(sockets.sockets).toHaveLength(before + 1);
      else expect(slackApps).toHaveLength(before + 1);
    });
    if (channel === "mattermost") {
      const dm = mattermost.addPost({ channel_id: DM_CHANNEL, user_id: ALICE.id, message: "Reloaded Mattermost" });
      sockets.last().posted(dm, 1, { channel_type: "D" });
    } else {
      const app = slackApps.at(-1)!;
      const [onMessage] = app.message.mock.calls[0];
      await onMessage({ client: app.client, message: { channel: "D123", channel_type: "im", user: "U123", ts: "2.1", text: "Reloaded Slack" } });
    }
    await vi.waitFor(() => expect(ctx.runs).toMatchObject([{ agentId: "sales" }]));
    expect(ctx.sinks.has(channel)).toBe(true);
  } finally {
    clearInterval(timer);
  }
});

it("keeps a legacy channel YAML-managed while allowing the enable toggle", async () => {
  const { patch, tempHome } = await setup([{ id: "sales", extraYaml: `
discord:
  dm: { enabled: false }
extensions:
  discord:
    enabled: false
` }]);
  const yamlPath = path.join(tempHome, "agents", "sales", "agent.yaml");
  const original = await fs.readFile(yamlPath, "utf8");
  expect((await patch("discord", { secrets: { token: "fixture" } })).status).toBe(409);
  expect(await fs.readFile(yamlPath, "utf8")).toBe(original);
  const enabled = await patch("discord", { enabled: true });
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toMatchObject({ extensions: expect.arrayContaining([
    expect.objectContaining({ id: "discord", enabled: true, managedAtRoot: true, missingConfig: ["token"] }),
  ]) });
  expect(parse(await fs.readFile(yamlPath, "utf8"))).toMatchObject({
    discord: { dm: { enabled: false } }, extensions: { discord: { enabled: true } },
  });
});

it("dispatches threadit.register before the agent has a token", async () => {
  const { ctx, patch, tempHome, loadConfig } = await setup([{ id: "sales" }]);
  const { createExtensionContext } = await import("./context.js");
  const { getExtensionRuntime } = await import("./registry.js");
  ctx.updateAgentExtensionConfig = createExtensionContext(loadConfig()).updateAgentExtensionConfig;
  const board = vi.fn(async (input: string, init?: RequestInit) => {
    if (new URL(input).pathname === "/api/register" && init?.method === "POST") {
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return Response.json({ username: "salesbot", token: "fixture-registered-token", status: "pending" });
    }
    return Response.json({ code: "account_pending" }, { status: 403 });
  });
  vi.stubGlobal("fetch", board);
  try {
    const response = await patch("threadit", { enabled: true, config: { baseUrl: "https://board.example.test" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ extensions: expect.arrayContaining([
      expect.objectContaining({ id: "threadit", configured: false, missingConfig: ["token"] }),
    ]) });
    const config = loadConfig();
    const result = await getExtensionRuntime().executeTool(config.agents[0], "threadit.register", {
      username: "salesbot", description: "Sales assistant",
    }, config);
    expect(result).toMatchObject({ found: true, result: { ok: true, status: "pending" } });
    expect(await fs.readFile(path.join(tempHome, "agents", "sales", ".env"), "utf8")).toBe("THREADIT_TOKEN=fixture-registered-token\n");
  } finally {
    await stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
  }
});

it("finishes saving after a stalled Mattermost handshake and applies the next save", async () => {
  const { patch } = await setup([{ id: "sales" }]);
  const stalled = await patch("mattermost", {
    enabled: true, config: { url: "https://stalled.example.test", dmEnabled: true }, secrets: { token: TOKEN },
  });
  expect(stalled.status).toBe(200);
  const stalledSocket = sockets.last();
  expect(stalledSocket.closed || stalledSocket.terminated).toBe(true);

  expect((await patch("mattermost", { config: { url: "https://healthy.example.test" } })).status).toBe(200);
  expect(sockets.last().url).toContain("healthy.example.test");
  expect(sockets.last().closed).toBe(false);
}, 12_000);

it("keeps personal and root tokens out of a team-only agent's tool-time settings", async () => {
  const { loadConfig } = await setup([{ id: "sales", extraYaml: "extensions:\n  slack: {}" }], {
    slack: { token: "fixture-root-token", appToken: "fixture-root-app" },
  });
  const { getExtensionRuntime } = await import("./registry.js");
  const { slackExtension } = await import("@yoplai/extension-slack");
  const { storePersonalExtensionTokens } = await import("../credentials/extension-tokens.js");
  const { CredentialStore } = await import("../credentials/store.js");
  const config = loadConfig();
  const runtime = getExtensionRuntime();
  const store = new CredentialStore();
  storePersonalExtensionTokens(store, "fixture-user", "slack", { token: "fixture-personal-token" });
  runtime.load([{
    ...slackExtension,
    getAgentTools: () => [{
      name: "fixture_channel_config",
      description: "Observe the dispatched channel settings",
      parameters: { type: "object" },
      execute: (_args, context) => ({
        agentToken: context.agent.extensions?.slack?.token,
        sharedToken: context.config.extensions?.slack?.token,
      }),
    }],
  }]);
  expect(await runtime.executeTool(config.agents[0], "fixture_channel_config", {}, config, undefined, "fixture-user")).toEqual({
    found: true, result: { agentToken: undefined, sharedToken: "fixture-root-token" },
  });
});

it("reports malformed nested routing as incomplete in the catalog", async () => {
  const { api } = await setup([{ id: "sales", extraYaml: `
extensions:
  mattermost:
    url: https://chat.example.test
    token: fixture-token
    channels: { team: { requireMention: invalid } }
  slack:
    token: fixture-bot
    appToken: fixture-app
    dm: { enabled: invalid }
` }]);
  const response = await api.request("/agents/sales/extensions");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ extensions: expect.arrayContaining([
    expect.objectContaining({ id: "mattermost", enabled: true, configured: false, missingConfig: ["config"] }),
    expect.objectContaining({ id: "slack", enabled: true, configured: false, missingConfig: ["config"] }),
  ]) });
  expect((await api.request("/agents/sales/extensions/mattermost", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  })).status).toBe(200);
});

it("lets a Slack save and disable finish even when provider startup stalls", async () => {
  const { patch } = await setup([{ id: "sales" }]);
  const save = patch("slack", {
    enabled: true, secrets: { token: "fixture-stalled-slack-bot", appToken: "fixture-slack-app" },
  });
  await vi.waitFor(() => expect(slackApps.at(-1)).toBeDefined());
  expect((await save).status).toBe(200);
  expect(slackApps.at(-1)?.stop).toHaveBeenCalledOnce();
  expect((await patch("slack", { enabled: false })).status).toBe(200);
}, 10_000);

it.each([
  ["mattermost", { url: "https://chat.example.test", token: "fixture-token", dm: { enabled: true } }, ["url", "token"]],
  ["slack", { token: "fixture-token", appToken: "fixture-app" }, ["token", "appToken"]],
  ["telegram", { token: "fixture-token", allowedUsers: "101", allowedChats: "101" }, ["token", "allowedUsers", "allowedChats"]],
  ["discord", { token: "fixture-token" }, ["token"]],
  ["irc", { host: "irc.example.test", nick: "fixturebot", channels: { "#fixture": {} } }, ["host", "nick"]],
  ["threadit", { baseUrl: "https://board.example.test", token: "fixture-token" }, ["baseUrl", "token"]],
] as const)("reports each missing %s connection setting by name", async (id, completeBlock, requiredFields) => {
  const { api, tempHome } = await setup([{ id: "sales" }]);
  const { reloadConfig } = await import("../config/index.js");
  const file = path.join(tempHome, "agents", "sales", "agent.yaml");
  const original = parse(await fs.readFile(file, "utf8"));
  for (const field of [undefined, ...requiredFields]) {
    const block: Record<string, unknown> = { ...completeBlock };
    if (field) delete block[field];
    await fs.writeFile(file, JSON.stringify({ ...original, extensions: { [id]: block } }));
    reloadConfig();
    const response = await api.request("/agents/sales/extensions");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ extensions: expect.arrayContaining([
      expect.objectContaining({ id, enabled: true, configured: !field, missingConfig: field ? [field] : [] }),
    ]) });
  }
});
