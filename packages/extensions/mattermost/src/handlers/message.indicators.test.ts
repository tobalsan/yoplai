import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GatewayConfigSchema } from "@yoplai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MattermostRestClient } from "../client.js";
import { clearMattermostContext, setMattermostContext } from "../context.js";
import {
  ALICE,
  BOT,
  CHANNEL,
  FakeMattermost,
  buildFakeContext,
  flush,
  TOKEN,
} from "../test-fakes.js";
import { handleMattermostPost, type MattermostRoute } from "./message.js";

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
});
const route: MattermostRoute = {
  agent: config.agents[0],
  isDm: false,
  requireMention: true,
  threadUnlock: false,
  acknowledgeMessages: true,
  attachmentsEnabled: false,
  allowBots: false,
  logPrefix: "[test]",
};

function lastEyesRemoval(server: FakeMattermost): number {
  const removal = server.requests
    .slice()
    .reverse()
    .find(
      (request) =>
        request.method === "DELETE" && request.path.endsWith("/reactions/eyes")
    );
  return removal ? server.requests.indexOf(removal) : -1;
}

describe("Mattermost turn indicators", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-indicators-"));
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
  });
  afterEach(async () => {
    clearMattermostContext();
    vi.useRealTimers();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("runs and posts its answer while reaction and typing starts are delayed, then cleans them up", async () => {
    const server = new FakeMattermost();
    const delayed: Array<() => Promise<void>> = [];
    const rest = new MattermostRestClient(
      "https://chat.example.test",
      TOKEN,
      (input, init) => {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (
          input.endsWith("/typing") ||
          (input.endsWith("/reactions") && body?.emoji_name === "eyes")
        ) {
          return new Promise<Response>((resolve) => {
            delayed.push(async () => resolve(await server.fetch(input, init)));
          });
        }
        return server.fetch(input, init);
      }
    );
    const ctx = buildFakeContext({ config, dataDir });
    setMattermostContext(ctx);
    const post = server.addPost({
      channel_id: CHANNEL,
      user_id: ALICE.id,
      message: "question",
    });
    const handled = handleMattermostPost(
      { post, channelType: "O", senderName: "@alice", mentions: [] },
      route,
      { rest, bot: BOT, userNames: new Map() },
      "question"
    );
    await flush();
    expect(ctx.runs).toHaveLength(1);
    expect(server.created()).toEqual([
      { channel_id: CHANNEL, root_id: post.id, message: "agent-ok" },
    ]);
    for (const release of delayed) await release();
    await handled;
    await flush();
    const eyes = server.requests.filter(
      (request) =>
        request.path === "/reactions" &&
        (request.body as { emoji_name: string }).emoji_name === "eyes"
    );
    expect(eyes).toHaveLength(1);
    expect(lastEyesRemoval(server)).toBeGreaterThan(
      server.requests.indexOf(eyes[0])
    );
    const typingCount = server.requests.filter((request) =>
      request.path.endsWith("/typing")
    ).length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(
      server.requests.filter((request) => request.path.endsWith("/typing"))
    ).toHaveLength(typingCount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears a delayed working reaction for a queued turn and delivers its deferred answer", async () => {
    const server = new FakeMattermost();
    let release: (() => Promise<void>) | undefined;
    const rest = new MattermostRestClient(
      "https://chat.example.test",
      TOKEN,
      (input, init) => {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (input.endsWith("/reactions") && body?.emoji_name === "eyes") {
          return new Promise<Response>((resolve) => {
            release = async () => resolve(await server.fetch(input, init));
          });
        }
        return server.fetch(input, init);
      }
    );
    const ctx = buildFakeContext({
      config,
      dataDir,
      run: () => ({
        payloads: [],
        meta: { durationMs: 0, sessionId: "queued", queued: true },
      }),
    });
    setMattermostContext(ctx);
    const post = server.addPost({
      channel_id: CHANNEL,
      user_id: ALICE.id,
      message: "queued",
    });
    await handleMattermostPost(
      { post, channelType: "O", senderName: "@alice", mentions: [] },
      route,
      { rest, bot: BOT, userNames: new Map() },
      "queued"
    );
    await release!();
    await flush();
    expect(server.created()).toHaveLength(0);
    const eyesIndex = server.requests.findIndex(
      (request) =>
        request.path === "/reactions" &&
        (request.body as { emoji_name: string }).emoji_name === "eyes"
    );
    expect(eyesIndex).toBeGreaterThanOrEqual(0);
    expect(lastEyesRemoval(server)).toBeGreaterThan(eyesIndex);
    await ctx.runs[0].onDeferredResult!({
      result: {
        payloads: [{ text: "deferred answer" }],
        meta: { durationMs: 1, sessionId: "queued" },
      },
    });
    expect(server.created()).toEqual([
      { channel_id: CHANNEL, root_id: post.id, message: "deferred answer" },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("posts the error text before waiting for a delayed failure reaction", async () => {
    const server = new FakeMattermost();
    let release: (() => Promise<void>) | undefined;
    const rest = new MattermostRestClient(
      "https://chat.example.test",
      TOKEN,
      (input, init) => {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (input.endsWith("/reactions") && body?.emoji_name === "x") {
          return new Promise<Response>((resolve) => {
            release = async () => resolve(await server.fetch(input, init));
          });
        }
        return server.fetch(input, init);
      }
    );
    const ctx = buildFakeContext({
      config,
      dataDir,
      run: () => {
        throw new Error("offline failure");
      },
    });
    setMattermostContext(ctx);
    const post = server.addPost({
      channel_id: CHANNEL,
      user_id: ALICE.id,
      message: "fails",
    });
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      const handled = handleMattermostPost(
        { post, channelType: "O", senderName: "@alice", mentions: [] },
        route,
        { rest, bot: BOT, userNames: new Map() },
        "fails"
      );
      await flush();
      expect(ctx.runs).toHaveLength(1);
      expect(server.created()).toHaveLength(1);
      expect(server.created()[0].message).toBe(
        "Something went wrong, please try again."
      );
      await release!();
      await handled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      logged.mockRestore();
    }
  });

  it("answers and removes accepted eyes even when indicator responses never arrive", async () => {
    const server = new FakeMattermost();
    const rest = new MattermostRestClient(
      "https://chat.example.test",
      TOKEN,
      async (input, init) => {
        const response = await server.fetch(input, init);
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        if (
          input.endsWith("/typing") ||
          (input.endsWith("/reactions") && body?.emoji_name === "eyes")
        ) {
          return new Promise<Response>(() => undefined);
        }
        return response;
      },
      1,
      { requestTimeoutMs: 30 }
    );
    const ctx = buildFakeContext({ config, dataDir });
    setMattermostContext(ctx);
    const post = server.addPost({
      channel_id: CHANNEL,
      user_id: ALICE.id,
      message: "question",
    });
    const handled = handleMattermostPost(
      { post, channelType: "O", senderName: "@alice", mentions: [] },
      route,
      { rest, bot: BOT, userNames: new Map() },
      "question"
    );
    await flush();
    expect(ctx.runs).toHaveLength(1);
    expect(server.created()[0].message).toBe("agent-ok");
    await vi.advanceTimersByTimeAsync(30);
    await handled;
    expect(
      server.requests.some(
        (request) =>
          request.method === "DELETE" &&
          request.path.endsWith("/reactions/eyes")
      )
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(
      server.requests.filter((request) => request.path.endsWith("/typing"))
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rejection", "timeout"])(
    "removes eyes accepted after completion even when the response ends with %s",
    async (mode) => {
      const server = new FakeMattermost();
      let release: (() => Promise<void>) | undefined;
      const rest = new MattermostRestClient(
        "https://chat.example.test",
        TOKEN,
        (input, init) => {
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          if (input.endsWith("/reactions") && body?.emoji_name === "eyes") {
            return new Promise<Response>((_resolve, reject) => {
              release = async () => {
                await server.fetch(input, init);
                if (mode === "rejection") reject(new Error("Lost response"));
              };
            });
          }
          return server.fetch(input, init);
        },
        1,
        { requestTimeoutMs: 30 }
      );
      setMattermostContext(buildFakeContext({ config, dataDir }));
      const post = server.addPost({
        channel_id: CHANNEL,
        user_id: ALICE.id,
        message: "question",
      });
      await handleMattermostPost(
        { post, channelType: "O", senderName: "@alice", mentions: [] },
        route,
        { rest, bot: BOT, userNames: new Map() },
        "question"
      );
      expect(server.created()[0].message).toBe("agent-ok");
      await release!();
      await vi.advanceTimersByTimeAsync(30);
      await flush();
      const eyesIndex = server.requests.findIndex(
        (request) =>
          request.path === "/reactions" &&
          (request.body as { emoji_name: string }).emoji_name === "eyes"
      );
      expect(eyesIndex).toBeGreaterThanOrEqual(0);
      expect(lastEyesRemoval(server)).toBeGreaterThan(eyesIndex);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it.each(["result", "error"])(
    "cleans delayed indicators after an aborted turn (%s)",
    async (mode) => {
      const server = new FakeMattermost();
      const delayed: Array<() => Promise<void>> = [];
      const rest = new MattermostRestClient(
        "https://chat.example.test",
        TOKEN,
        (input, init) => {
          const body =
            typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
          if (
            input.endsWith("/typing") ||
            (input.endsWith("/reactions") && body?.emoji_name === "eyes")
          ) {
            return new Promise<Response>((resolve) => {
              delayed.push(async () =>
                resolve(await server.fetch(input, init))
              );
            });
          }
          return server.fetch(input, init);
        }
      );
      const ctx = buildFakeContext({
        config,
        dataDir,
        run: () => {
          if (mode === "error")
            throw new DOMException("Cancelled", "AbortError");
          return {
            payloads: [{ text: "must not post" }],
            meta: { durationMs: 0, sessionId: "aborted", aborted: true },
          };
        },
      });
      setMattermostContext(ctx);
      const post = server.addPost({
        channel_id: CHANNEL,
        user_id: ALICE.id,
        message: "aborted",
      });
      await handleMattermostPost(
        { post, channelType: "O", senderName: "@alice", mentions: [] },
        route,
        { rest, bot: BOT, userNames: new Map() },
        "aborted"
      );
      for (const release of delayed) await release();
      await flush();
      expect(ctx.runs).toHaveLength(1);
      expect(server.created()).toHaveLength(0);
      const eyesIndex = server.requests.findIndex(
        (request) =>
          request.path === "/reactions" &&
          (request.body as { emoji_name: string }).emoji_name === "eyes"
      );
      expect(eyesIndex).toBeGreaterThanOrEqual(0);
      expect(lastEyesRemoval(server)).toBeGreaterThan(eyesIndex);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(
        server.requests.filter((request) => request.path.endsWith("/typing"))
      ).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    }
  );
});
