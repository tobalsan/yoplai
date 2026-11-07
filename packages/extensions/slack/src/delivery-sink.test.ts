import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ExtensionContext, GatewayConfig } from "@yoplai/shared";
import { clearSlackClientCache, createSlackDeliverySink, getSlackDeliveryOffer } from "./agent-tools.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import { clearSlackContext, setSlackContext } from "./context.js";
import { createProactiveDmNoteStore } from "./proactive-dm-notes.js";
import type { SlackBot } from "./bot.js";
import type { SlackWebClient } from "./types.js";
import { SlackPairingService, setSlackPairingService } from "./pairing.js";
import { getSlackWorkspace } from "./requester.js";

vi.mock("./proactive-dm-notes.js", () => ({
  createProactiveDmNoteStore: vi.fn(() => ({
    addNote: vi.fn(),
    close: vi.fn(),
  })),
}));

function agent(id: string): AgentConfig {
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    workspaceDir: `/tmp/${id}`,
    model: { provider: "test", model: "test" },
    queueMode: "queue",
  };
}

function config(): GatewayConfig {
  return {
    version: 3,
    agents: [],
    extensions: undefined,
    sessions: { idleMinutes: 360 },
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

function ctx(): ExtensionContext {
  return { getConfig: () => config() } as unknown as ExtensionContext;
}

describe("slack delivery sink", () => {
  afterEach(() => {
    clearActiveBots();
    clearSlackClientCache();
    clearSlackContext();
    vi.clearAllMocks();
  });

  it("offers channel delivery only with an active bot or configured token, excluding env-only tokens", async () => {
    vi.stubEnv("SLACK_TOKEN", "fake-env-token");
    try {
      expect(await getSlackDeliveryOffer(agent("alpha"), config())).toBeUndefined();
      expect(await getSlackDeliveryOffer({ ...agent("alpha"), slack: { token: "fake-agent-token", appToken: "fake-app-token" } }, config())).toEqual({ label: "Slack", channel: true });
      expect(await getSlackDeliveryOffer(agent("alpha"), { ...config(), extensions: { slack: { token: "fake-component-token", appToken: "fake-app-token" } } })).toEqual({ label: "Slack", channel: true });
      registerMockBot("slack", {});
      expect(await getSlackDeliveryOffer(agent("alpha"), config())).toEqual({ label: "Slack", channel: true });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("offers only the requester's paired Slack ID in the client's known workspace", async () => {
    const dataDir = await fs.mkdtemp(path.join(process.cwd(), ".slack-offer-test-"));
    const pairing = new SlackPairingService(dataDir, "https://gateway.example.test");
    const client = {
      auth: { test: async () => ({ team_id: "T-agent" }) },
      users: { info: async ({ user }: { user: string }) => ({ ok: true, user: { id: user, profile: { email: "requester@example.test" } } }) },
    } as SlackWebClient;
    const pair = async (workspace: string, slackUser: string, userId: string) => {
      const link = await pairing.issue(workspace, slackUser, client);
      await pairing.redeem(new URL(link).pathname.split("/").at(-1)!, { id: userId, email: "requester@example.test" });
    };
    setSlackPairingService(pairing);
    try {
      await pair("T-other", "U-wrong-workspace", "requester");
      await pair("T-agent", "U-own", "requester");
      await pair("T-agent", "U-other-requester", "someone-else");
      await pair("T-other", "U-mismatched-only", "mismatched");
      await getSlackWorkspace(client);
      registerMockBot("alpha", client);

      expect(await getSlackDeliveryOffer(agent("alpha"), config(), "requester")).toEqual({ label: "Slack", channel: true, dm: { user: "U-own" } });
      expect(await getSlackDeliveryOffer(agent("alpha"), config(), "unpaired")).toEqual({ label: "Slack", channel: true });
      expect(await getSlackDeliveryOffer(agent("alpha"), config(), "mismatched")).toEqual({ label: "Slack", channel: true });
      expect(await getSlackDeliveryOffer(agent("alpha"), config())).toEqual({ label: "Slack", channel: true });
      registerMockBot("alpha", { auth: { test: () => new Promise(() => {}) } });
      expect(await getSlackDeliveryOffer(agent("alpha"), config(), "requester")).toEqual({ label: "Slack", channel: true });
      registerMockBot("alpha", client);
      setSlackPairingService(undefined);
      expect(await getSlackDeliveryOffer(agent("alpha"), config(), "requester")).toEqual({ label: "Slack", channel: true });
    } finally {
      setSlackPairingService(undefined);
      pairing.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }, 1000);

  it("sends to the channel ID for a channel destination", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "1.1" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    const sink = createSlackDeliverySink(ctx());

    await sink({
      agent: agent("alpha"),
      destination: { channel: "C0123456789" },
      text: "cron result",
    });

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "C0123456789",
      mrkdwn: true,
    });
  });

  it("sends to the user ID via the channel param for a user destination", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "2.2" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    const sink = createSlackDeliverySink(ctx());

    await sink({
      agent: agent("alpha"),
      destination: { user: "U0123456789" },
      text: "cron result",
    });

    expect(postMessage.mock.calls[0][0]).toMatchObject({
      channel: "U0123456789",
      mrkdwn: true,
    });
  });

  it("stays successful when the proactive-DM note write fails after the post", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "3.3" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    const close = vi.fn();
    vi.mocked(createProactiveDmNoteStore).mockReturnValueOnce({
      addNote: vi.fn(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }),
      close,
    } as never);
    const warn = vi.fn();
    setSlackContext({
      getConfig: () => config(),
      getDataDir: () => "/tmp/slack-data",
      logger: { info: vi.fn(), warn, error: vi.fn() },
    } as unknown as ExtensionContext);
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({
        agent: agent("alpha"),
        destination: { user: "U0123456789" },
        text: "digest",
      })
    ).resolves.toBeUndefined();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("SQLITE_BUSY: database is locked")
    );
  });

  it("rejects when the proactive-DM store cannot be opened", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "3.3" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    vi.mocked(createProactiveDmNoteStore).mockImplementationOnce(() => {
      throw new Error("EEXIST: data dir is a file");
    });
    setSlackContext({
      getConfig: () => config(),
      getDataDir: () => "/tmp/slack-data",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ExtensionContext);
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({ agent: agent("alpha"), destination: { user: "U0123456789" }, text: "digest" })
    ).rejects.toThrow("EEXIST");
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("rejects when the proactive-DM store fails to close", async () => {
    const postMessage = vi.fn().mockResolvedValue({ ts: "3.3" });
    registerMockBot("alpha", { chat: { postMessage } as never });
    vi.mocked(createProactiveDmNoteStore).mockReturnValueOnce({
      addNote: vi.fn(),
      close: vi.fn(() => {
        throw new Error("close failed");
      }),
    } as never);
    setSlackContext({
      getConfig: () => config(),
      getDataDir: () => "/tmp/slack-data",
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as ExtensionContext);
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({ agent: agent("alpha"), destination: { user: "U0123456789" }, text: "digest" })
    ).rejects.toThrow("close failed");
  });

  it("throws when the destination has neither channel nor user", async () => {
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({ agent: agent("alpha"), destination: {}, text: "cron result" })
    ).rejects.toThrow("Slack delivery requires a channel or user destination.");
  });

  it("throws when no Slack client can be resolved for the agent", async () => {
    const sink = createSlackDeliverySink(ctx());

    await expect(
      sink({
        agent: agent("alpha"),
        destination: { channel: "C1" },
        text: "cron result",
      })
    ).rejects.toThrow("No Slack token is configured for this agent.");
  });
});
