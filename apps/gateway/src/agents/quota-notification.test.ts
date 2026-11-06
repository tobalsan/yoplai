import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, NotifyOptions, NotifySummary } from "@yoplai/shared";

const { notify, loadConfig, resolveAgentEnv } = vi.hoisted(() => ({
  notify: vi.fn<(options: NotifyOptions) => Promise<NotifySummary>>(async () => ({ ok: true, results: [] })),
  loadConfig: vi.fn(),
  resolveAgentEnv: vi.fn((): Record<string, string> => ({ DUMMY_SLACK_TOKEN: "dummy-test-token" })),
}));
vi.mock("@yoplai/shared", async (original) => ({
  ...await original<typeof import("@yoplai/shared")>(), notify,
}));
vi.mock("../config/index.js", () => ({ loadConfig, resolveAgentEnv }));
vi.mock("../logging.js", () => ({ logError: vi.fn() }));

describe("quota administrator notifications", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resolveAgentEnv.mockReturnValue({ DUMMY_SLACK_TOKEN: "dummy-test-token" });
    loadConfig.mockReturnValue({
      notifications: { adminChannel: "admin", channels: { admin: { slack: "dummy-channel" } } },
      extensions: { slack: { token: "$env:DUMMY_SLACK_TOKEN" } },
    });
  });

  const agent = { id: "alpha", model: { provider: "test", model: "primary" } } as AgentConfig;

  it("notifies once per provider/model/hour and resolves token references", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const { notifyProviderQuota } = await import("./quota-notification.js");
    await notifyProviderQuota(agent);
    await notifyProviderQuota({ ...agent, id: "beta" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      channel: "admin", slackToken: "dummy-test-token",
      message: "Provider quota exhausted for test/primary (agent alpha)",
    }));
    now.mockReturnValue(1000 + 60 * 60 * 1000);
    await notifyProviderQuota(agent);
    expect(notify).toHaveBeenCalledTimes(2);
    await notifyProviderQuota(agent, { provider: "test", model: "other" });
    expect(notify).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });

  it("does not notify without an admin channel", async () => {
    loadConfig.mockReturnValue({ extensions: {} });
    const { notifyProviderQuota } = await import("./quota-notification.js");
    await notifyProviderQuota(agent);
    expect(notify).not.toHaveBeenCalled();
  });

  it("resolves the root Mattermost url and token for an admin channel", async () => {
    loadConfig.mockReturnValue({
      notifications: { adminChannel: "admin", channels: { admin: { mattermost: "fake-admin-channel" } } },
      extensions: { mattermost: { url: "$env:DUMMY_MM_URL", token: "$env:DUMMY_MM_TOKEN" } },
    });
    resolveAgentEnv.mockReturnValue({
      DUMMY_SLACK_TOKEN: "dummy-test-token",
      DUMMY_MM_URL: "https://mattermost.example.com",
      DUMMY_MM_TOKEN: "fake-mattermost-token",
    });
    const { notifyProviderQuota } = await import("./quota-notification.js");
    await notifyProviderQuota(agent);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      channel: "admin",
      mattermostUrl: "https://mattermost.example.com",
      mattermostToken: "fake-mattermost-token",
    }));
  });

  it("uses the agent Mattermost pair instead of the root pair", async () => {
    loadConfig.mockReturnValue({
      notifications: { adminChannel: "admin", channels: { admin: { mattermost: "fake-admin-channel" } } },
      extensions: { mattermost: { url: "https://root.example.com", token: "fake-root-token" } },
    });
    resolveAgentEnv.mockReturnValue({
      DUMMY_MM_URL: "https://agent.example.com",
      DUMMY_MM_TOKEN: "fake-agent-token",
    });
    const { notifyProviderQuota } = await import("./quota-notification.js");
    await notifyProviderQuota({
      ...agent,
      mattermost: { url: "$env:DUMMY_MM_URL", token: "$env:DUMMY_MM_TOKEN", channels: {} },
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      mattermostUrl: "https://agent.example.com",
      mattermostToken: "fake-agent-token",
    }));
  });

  it("does not resolve unused Mattermost env refs for a Slack-only admin channel", async () => {
    loadConfig.mockReturnValue({
      notifications: { adminChannel: "admin", channels: { admin: { slack: "dummy-channel" } } },
      extensions: {
        slack: { token: "$env:DUMMY_SLACK_TOKEN" },
        mattermost: { url: "$env:UNSET_MM_URL", token: "$env:UNSET_MM_TOKEN" },
      },
    });
    const { notifyProviderQuota } = await import("./quota-notification.js");
    await notifyProviderQuota(agent);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      slackToken: "dummy-test-token",
      mattermostUrl: undefined,
      mattermostToken: undefined,
    }));
  });

  it("times out a hung fetch after 10 seconds and permits a later model notification", async () => {
    const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected notification timeout signal");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", hangingFetch);
    notify.mockImplementationOnce(async ({ fetchImpl }) => {
      if (!fetchImpl) throw new Error("Expected notification fetch implementation");
      await expect(fetchImpl("https://mattermost.example.com/api/v4/posts"))
        .rejects.toMatchObject({ name: "TimeoutError" });
      return { ok: false, results: [] };
    });
    try {
      const { notifyProviderQuota } = await import("./quota-notification.js");
      const startedAt = Date.now();
      await notifyProviderQuota(agent);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9500);
      await notifyProviderQuota(agent, { provider: "test", model: "after-timeout" });
      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({
        message: "Provider quota exhausted for test/after-timeout (agent alpha)",
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  }, 15_000);
});
