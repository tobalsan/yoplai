import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@yoplai/shared";

const { notify, loadConfig, resolveAgentEnv } = vi.hoisted(() => ({
  notify: vi.fn(async () => ({ ok: true, results: [] })),
  loadConfig: vi.fn(),
  resolveAgentEnv: vi.fn(() => ({ DUMMY_SLACK_TOKEN: "dummy-test-token" })),
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
});
