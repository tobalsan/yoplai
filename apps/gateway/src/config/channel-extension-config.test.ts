import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("channel extension config loading", () => {
  let home: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    if (home) await fs.rm(home, { recursive: true, force: true });
    home = undefined;
  });

  async function loadAgent(
    fields: Record<string, unknown>,
    includeHealthyAgent = false
  ) {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-channel-config-"));
    const workspace = path.join(home, "agents", "assistant");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "agent.yaml"),
      JSON.stringify({
        id: "assistant",
        name: "Assistant",
        model: { provider: "test", model: "test" },
        ...fields,
      })
    );
    if (includeHealthyAgent) {
      const healthyWorkspace = path.join(home, "agents", "healthy");
      await fs.mkdir(healthyWorkspace, { recursive: true });
      await fs.writeFile(
        path.join(healthyWorkspace, "agent.yaml"),
        JSON.stringify({
          id: "healthy",
          name: "Healthy",
          model: { provider: "test", model: "test" },
        })
      );
    }
    await fs.writeFile(
      path.join(home, "yoplai.json"),
      JSON.stringify({
        version: 3,
        agents: "agents/*",
      })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    return loadConfig().agents[0];
  }

  it("loads nested Mattermost settings into the per-agent channel config", async () => {
    const agent = await loadAgent({
      extensions: {
        mattermost: {
          enabled: true,
          url: "https://chat.example.test",
          token: "$env:MATTERMOST_TOKEN",
          channels: { "channel-a": { requireMention: false, agent: "other" } },
          dm: { enabled: true, allowFrom: ["user-a"], agent: "other" },
        },
      },
    });

    expect(agent.mattermost).toEqual({
      url: "https://chat.example.test",
      token: "$env:MATTERMOST_TOKEN",
      channels: { "channel-a": { requireMention: false } },
      dm: { enabled: true, allowFrom: ["user-a"] },
    });
    expect(agent.extensions?.mattermost).toEqual({
      enabled: true,
      url: "https://chat.example.test",
      token: "$env:MATTERMOST_TOKEN",
      channels: { "channel-a": { requireMention: false, agent: "other" } },
      dm: { enabled: true, allowFrom: ["user-a"], agent: "other" },
    });
  });
  it("loads nested Slack settings into the per-agent channel config", async () => {
    const agent = await loadAgent({
      extensions: {
        slack: {
          enabled: true,
          token: "$env:SLACK_TOKEN",
          appToken: "$env:SLACK_APP_TOKEN",
          channels: { "channel-a": { requireMention: false, agent: "other" } },
          dm: { enabled: true, allowFrom: ["user-a"] },
        },
      },
    });

    expect(agent.slack).toEqual({
      token: "$env:SLACK_TOKEN",
      appToken: "$env:SLACK_APP_TOKEN",
      channels: {
        "channel-a": { requireMention: false, reactionNotifications: "off" },
      },
      dm: { enabled: true, allowFrom: ["user-a"] },
    });
  });
  it("loads nested Telegram settings into the per-agent channel config", async () => {
    const agent = await loadAgent({
      extensions: {
        telegram: {
          enabled: true,
          token: "$env:TELEGRAM_TOKEN",
          allowedUsers: [101, "user-a"],
          allowedChats: [-202, "chat-a"],
          showToolCalls: true,
        },
      },
    });

    expect(agent.telegram).toEqual({
      token: "$env:TELEGRAM_TOKEN",
      allowedUsers: [101, "user-a"],
      allowedChats: [-202, "chat-a"],
      showToolCalls: true,
    });
  });
  it.each(["mattermost", "slack", "telegram"] as const)(
    "keeps a disabled nested %s bot off",
    async (channel) => {
      const agent = await loadAgent({
        extensions: {
          [channel]: {
            enabled: false,
            url: "https://chat.example.test",
            token: "$env:CHANNEL_TOKEN",
            appToken: "$env:CHANNEL_APP_TOKEN",
          },
        },
      });

      expect(agent[channel]).toBeUndefined();
      expect(agent.extensions?.[channel]?.enabled).toBe(false);
    }
  );
  it.each([
    [
      "mattermost",
      { url: "https://legacy.example.test", token: "legacy-token" },
    ],
    ["slack", { token: "legacy-token", appToken: "legacy-app-token" }],
    ["telegram", { token: "legacy-token" }],
  ] as const)(
    "keeps top-level %s settings authoritative",
    async (channel, expected) => {
      const agent = await loadAgent({
        [channel]: {
          url: "https://legacy.example.test",
          token: "legacy-token",
          appToken: "legacy-app-token",
        },
        extensions: {
          [channel]: {
            enabled: true,
            url: "https://nested.example.test",
            token: "nested-token",
            appToken: "nested-app-token",
          },
        },
      });

      expect(agent[channel]).toEqual(expected);
    }
  );
  it("keeps incomplete Mattermost setup and other agents available with a value-free warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await loadAgent(
      {
        extensions: {
          mattermost: {
            enabled: true,
            url: "https://private.example.test",
          },
        },
      },
      true
    );
    const { loadConfig } = await import("./index.js");

    expect(agent.mattermost).toBeUndefined();
    expect(loadConfig().agents.map((entry) => entry.id)).toEqual([
      "assistant",
      "healthy",
    ]);
    expect(warn.mock.calls).toEqual([
      [
        '[config] agent "assistant" cannot project extension "mattermost": token',
      ],
    ]);
  });

  it("keeps a toggle-only Mattermost setup safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await loadAgent({
      extensions: { mattermost: { enabled: true } },
    });

    expect(agent.mattermost).toBeUndefined();
    expect(agent.extensions?.mattermost).toEqual({ enabled: true });
    expect(warn.mock.calls).toEqual([
      [
        '[config] agent "assistant" cannot project extension "mattermost": url, token',
      ],
    ]);
  });

  it("never includes an invalid credential value in projection warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await loadAgent({
      extensions: {
        mattermost: {
          enabled: true,
          url: "https://chat.example.test",
          token: { unexpected: "fake-token-never-log" },
        },
      },
    });

    expect(agent.mattermost).toBeUndefined();
    expect(warn.mock.calls).toEqual([
      [
        '[config] agent "assistant" cannot project extension "mattermost": token',
      ],
    ]);
  });

  it("loads nested Mattermost settings when enabled is omitted", async () => {
    const agent = await loadAgent({
      extensions: {
        mattermost: {
          url: "https://chat.example.test",
          token: "$env:MATTERMOST_TOKEN",
        },
      },
    });

    expect(agent.mattermost).toEqual({
      url: "https://chat.example.test",
      token: "$env:MATTERMOST_TOKEN",
    });
  });

  it("keeps an existing top-level-only Mattermost config unchanged", async () => {
    const agent = await loadAgent({
      mattermost: {
        url: "https://legacy.example.test",
        token: "$env:LEGACY_MATTERMOST_TOKEN",
        channels: { "legacy-channel": { requireMention: true } },
        dm: { enabled: false },
      },
    });

    expect(agent.mattermost).toEqual({
      url: "https://legacy.example.test",
      token: "$env:LEGACY_MATTERMOST_TOKEN",
      channels: { "legacy-channel": { requireMention: true } },
      dm: { enabled: false },
    });
    expect(agent.extensions?.mattermost).toBeUndefined();
  });

  it("leaves agents without channel blocks unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await loadAgent({});

    expect(agent.mattermost).toBeUndefined();
    expect(agent.slack).toBeUndefined();
    expect(agent.telegram).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["mattermost", "slack", "telegram"] as const)(
    "does not let the nested disable toggle override top-level %s settings",
    async (channel) => {
      const agent = await loadAgent({
        [channel]: {
          url: "https://legacy.example.test",
          token: "legacy-token",
          appToken: "legacy-app-token",
        },
        extensions: { [channel]: { enabled: false } },
      });

      expect(agent[channel]?.token).toBe("legacy-token");
    }
  );
});
