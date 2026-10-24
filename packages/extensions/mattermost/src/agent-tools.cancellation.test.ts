import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayConfigSchema } from "@yoplai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mattermostAgentTools } from "./agent-tools.js";
import { createMattermostBot, type MattermostBot } from "./bot.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import { clearMattermostContext, setMattermostContext } from "./context.js";
import {
  CHANNEL,
  FakeMattermost,
  FakeSocketFactory,
  buildFakeContext,
  flush,
  TOKEN,
} from "./test-fakes.js";

const config = GatewayConfigSchema.parse({
  version: 2,
  agents: [
    {
      id: "support",
      name: "Support",
      workspace: "~/s",
      model: { provider: "anthropic", model: "claude" },
    },
  ],
  extensions: {
    mattermost: {
      url: "https://chat.example.test",
      token: TOKEN,
      channels: { [CHANNEL]: { agent: "support" } },
      dm: { agent: "support" },
    },
  },
});

describe("Mattermost tool cancellation", () => {
  let dataDir: string;
  let server: FakeMattermost;
  let bot: MattermostBot;
  let controller: AbortController;
  let cancelAfterPath: string | undefined;
  let cancelAfterPosts: number | undefined;
  let blockedPath: string | undefined;
  let pendingSignal: AbortSignal | null | undefined;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-cancel-"));
    server = new FakeMattermost();
    controller = new AbortController();
    cancelAfterPath = undefined;
    cancelAfterPosts = undefined;
    blockedPath = undefined;
    pendingSignal = undefined;
    setMattermostContext(buildFakeContext({ config, dataDir }));
    const sockets = new FakeSocketFactory();
    bot = createMattermostBot(config.agents, config.extensions!.mattermost!, {
      createSocket: sockets.create,
      fetch: async (input, init) => {
        if (blockedPath && new URL(input).pathname.endsWith(blockedPath)) {
          pendingSignal = init?.signal;
          return new Promise<Response>(() => undefined);
        }
        const response = await server.fetch(input, init);
        if (
          cancelAfterPath &&
          new URL(input).pathname.endsWith(cancelAfterPath)
        )
          controller.abort();
        if (cancelAfterPosts && server.created().length === cancelAfterPosts)
          controller.abort();
        return response;
      },
    })!;
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
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function call(name: string, args: unknown) {
    return mattermostAgentTools()
      .find((tool) => tool.name === name)!
      .execute(args, {
        agent: config.agents[0],
        config,
        sessionId: "session",
        signal: controller.signal,
      });
  }

  it("makes no request when send_message is already cancelled", async () => {
    controller.abort();
    const before = server.requests.length;
    await expect(
      call("mattermost.send_message", { user: "alice", text: "cancelled" })
    ).resolves.toMatchObject({ ok: false });
    expect(server.requests).toHaveLength(before);
  });

  it("stops send_message before posting another chunk after cancellation", async () => {
    cancelAfterPath = "/posts";
    await expect(
      call("mattermost.send_message", {
        channel: CHANNEL,
        text: "x".repeat(30_000),
      })
    ).resolves.toMatchObject({ ok: false });
    expect(server.created()).toHaveLength(1);
  });

  it("makes no request when create_thread is already cancelled", async () => {
    controller.abort();
    const before = server.requests.length;
    await expect(
      call("mattermost.create_thread", { channel: CHANNEL, text: "cancelled" })
    ).resolves.toMatchObject({ ok: false });
    expect(server.requests).toHaveLength(before);
  });

  it("stops create_thread during its reply chunks without posting the remaining text", async () => {
    cancelAfterPosts = 2;
    await expect(
      call("mattermost.create_thread", {
        channel: CHANNEL,
        text: "x".repeat(45_000),
      })
    ).resolves.toMatchObject({ ok: false });
    expect(server.created()).toHaveLength(2);
  });

  it.each([
    {
      name: "mattermost.send_message",
      args: { user: "alice", text: "cancelled" },
      path: "/users/username/alice",
    },
    {
      name: "mattermost.send_message",
      args: { user: "a".repeat(26), text: "cancelled" },
      path: "/channels/direct",
    },
    {
      name: "mattermost.send_message",
      args: { channel: CHANNEL, rootId: "root", text: "cancelled" },
      path: "/posts/root",
    },
    {
      name: "mattermost.send_message",
      args: { channel: CHANNEL, text: "cancelled" },
      path: "/posts",
    },
    {
      name: "mattermost.create_thread",
      args: { channel: CHANNEL, text: "cancelled" },
      path: "/posts",
    },
  ])(
    "aborts an in-flight $name request at $path",
    async ({ name, args, path: requestPath }) => {
      blockedPath = requestPath;
      const pending = call(name, args);
      await flush();
      expect(pendingSignal?.aborted).toBe(false);
      controller.abort();
      await expect(pending).resolves.toMatchObject({ ok: false });
      expect(pendingSignal?.aborted).toBe(true);
      expect(server.created()).toHaveLength(0);
    }
  );
});
