import { readAgentChannelConfig as readMattermost } from "../../../../packages/extensions/mattermost/src/config.js";
import { readAgentChannelConfig as readSlack } from "../../../../packages/extensions/slack/src/config.js";
import { readAgentChannelConfig as readTelegram } from "../../../../packages/extensions/telegram/src/config.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const readers = { mattermost: readMattermost, slack: readSlack, telegram: readTelegram };

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
    options: { includeHealthyAgent?: boolean; agentEnv?: string; root?: Record<string, unknown> } = {}
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
    if (options.agentEnv) await fs.writeFile(path.join(workspace, ".env"), options.agentEnv);
    if (options.includeHealthyAgent) {
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
        ...options.root,
      })
    );
    vi.stubEnv("YOPLAI_HOME", home);
    const { loadConfig } = await import("./index.js");
    return loadConfig().agents[0];
  }

  it("checks workspace authority before loading channel settings on load and plain reload", async () => {
    vi.stubEnv("CANARY_SHARED_CHAT", "canary-shared-chat-value");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await loadAgent({
      telegram: { token: "$env:CANARY_SHARED_CHAT" },
      extensions: {
        slack: {
          token: "$env:CANARY_WORKSPACE_TOKEN",
          appToken: "canary-app-token",
          mentionPatterns: ["$env:CANARY_SHARED_CHAT", "canary-literal-pattern"],
        },
        "canary-nested": { profiles: [{ target: "$env:CANARY_SHARED_CHAT", enabled: true }] },
      },
    }, {
      agentEnv: "CANARY_WORKSPACE_TOKEN=canary-workspace-token-value\n",
      root: { extensions: { "canary-root": { target: "$env:CANARY_SHARED_CHAT" } } },
    });
    const { getConfigPath, loadConfig, reloadConfig } = await import("./index.js");
    const { resolveStartupConfig } = await import("./validate.js");

    expect(agent.extensions?.slack).toMatchObject({
      token: "$env:CANARY_WORKSPACE_TOKEN",
      mentionPatterns: ["canary-literal-pattern"],
    });
    expect(readSlack(agent)?.mentionPatterns).toEqual(["canary-literal-pattern"]);
    expect(agent.extensions?.["canary-nested"]?.profiles).toEqual([{ enabled: true }]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/assistant.*slack.*CANARY_SHARED_CHAT/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/assistant.*canary-nested.*CANARY_SHARED_CHAT/));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("canary-shared-chat-value");

    const config = await resolveStartupConfig(loadConfig());
    expect(config.agents[0]).toMatchObject({
      extensions: {
        slack: { token: "canary-workspace-token-value", mentionPatterns: ["canary-literal-pattern"] },
        telegram: { token: "canary-shared-chat-value" },
      },
    });
    expect(config.extensions?.["canary-root"]).toEqual({ target: "canary-shared-chat-value" });
    reloadConfig();
    expect(readSlack(loadConfig().agents[0])?.mentionPatterns).toEqual(["canary-literal-pattern"]);
    expect(loadConfig().agents[0].extensions?.slack?.mentionPatterns).toEqual(["canary-literal-pattern"]);

    const configFile = getConfigPath();
    const previousRoot = JSON.parse(await fs.readFile(configFile, "utf8"));
    await fs.writeFile(configFile, JSON.stringify({ ...previousRoot, extensionEnvAllowlist: ["CANARY_SHARED_CHAT"] }));
    const allowed = reloadConfig();
    expect(readSlack(allowed.agents[0])?.mentionPatterns).toEqual(["$env:CANARY_SHARED_CHAT", "canary-literal-pattern"]);
    expect(allowed.agents[0].extensions?.slack?.mentionPatterns).toEqual(["$env:CANARY_SHARED_CHAT", "canary-literal-pattern"]);
    expect((await resolveStartupConfig(allowed)).agents[0]).toMatchObject({
      extensions: { slack: { mentionPatterns: ["canary-shared-chat-value", "canary-literal-pattern"] } },
    });
  });

  it("loads nested Mattermost settings into the per-agent channel config", async () => {
    const agent = await loadAgent({
      extensions: {
        mattermost: {
          enabled: true,
          url: "https://chat.example.test",
          token: "$env:CANARY_MATTERMOST_TOKEN",
          channels: { "channel-a": { requireMention: false, agent: "other" } },
          dm: { enabled: true, allowFrom: ["user-a"], agent: "other" },
        },
      },
    }, { agentEnv: "CANARY_MATTERMOST_TOKEN=canary-token\n" });

    expect(readMattermost(agent)).toEqual({
      url: "https://chat.example.test",
      token: "$env:CANARY_MATTERMOST_TOKEN",
      channels: { "channel-a": { requireMention: false } },
      dm: { enabled: true, allowFrom: ["user-a"] },
    });
    expect(agent.extensions?.mattermost).toEqual({
      enabled: true,
      url: "https://chat.example.test",
      token: "$env:CANARY_MATTERMOST_TOKEN",
      channels: { "channel-a": { requireMention: false, agent: "other" } },
      dm: { enabled: true, allowFrom: ["user-a"], agent: "other" },
    });
  });
  it("loads nested Slack settings into the per-agent channel config", async () => {
    const agent = await loadAgent({
      extensions: {
        slack: {
          enabled: true,
          token: "$env:CANARY_SLACK_TOKEN",
          appToken: "$env:CANARY_SLACK_APP_TOKEN",
          channels: { "channel-a": { requireMention: false, agent: "other" } },
          dm: { enabled: true, allowFrom: ["user-a"] },
        },
      },
    }, { agentEnv: "CANARY_SLACK_TOKEN=canary-token\nCANARY_SLACK_APP_TOKEN=canary-app-token\n" });

    expect(readSlack(agent)).toEqual({
      token: "$env:CANARY_SLACK_TOKEN",
      appToken: "$env:CANARY_SLACK_APP_TOKEN",
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
          token: "$env:CANARY_TELEGRAM_TOKEN",
          allowedUsers: [101, "user-a"],
          allowedChats: [-202, "chat-a"],
          showToolCalls: true,
        },
      },
    }, { agentEnv: "CANARY_TELEGRAM_TOKEN=canary-token\n" });

    expect(readTelegram(agent)).toEqual({
      token: "$env:CANARY_TELEGRAM_TOKEN",
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
            token: "canary-token",
            appToken: "canary-app-token",
          },
        },
      });

      expect(readers[channel](agent)).toBeUndefined();
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

      expect(readers[channel](agent)).toEqual(expected);
    }
  );
  it("keeps incomplete Mattermost setup and other agents available without rejecting the agent", async () => {
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
      { includeHealthyAgent: true }
    );
    const { loadConfig } = await import("./index.js");

    expect(readMattermost(agent)).toBeUndefined();
    expect(loadConfig().agents.map((entry) => entry.id)).toEqual([
      "assistant",
      "healthy",
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a toggle-only Mattermost setup safe", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await loadAgent({
      extensions: { mattermost: { enabled: true } },
    });

    expect(readMattermost(agent)).toBeUndefined();
    expect(agent.extensions?.mattermost).toEqual({ enabled: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("leaves invalid nested credentials unusable without logging their values", async () => {
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

    expect(readMattermost(agent)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("loads nested Mattermost settings when enabled is omitted", async () => {
    const agent = await loadAgent({
      extensions: {
        mattermost: {
          url: "https://chat.example.test",
          token: "$env:CANARY_MATTERMOST_TOKEN",
        },
      },
    }, { agentEnv: "CANARY_MATTERMOST_TOKEN=canary-token\n" });

    expect(readMattermost(agent)).toEqual({
      url: "https://chat.example.test",
      token: "$env:CANARY_MATTERMOST_TOKEN",
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

    expect(readMattermost(agent)).toEqual({
      url: "https://legacy.example.test",
      token: "$env:LEGACY_MATTERMOST_TOKEN",
      channels: { "legacy-channel": { requireMention: true } },
      dm: { enabled: false },
    });
    expect(agent.extensions?.mattermost?.token).toBe("$env:LEGACY_MATTERMOST_TOKEN");
  });

  it("leaves agents without channel blocks unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await loadAgent({});

    expect(readMattermost(agent)).toBeUndefined();
    expect(readSlack(agent)).toBeUndefined();
    expect(readTelegram(agent)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["mattermost", "slack", "telegram"] as const)(
    "keeps the legacy %s bot off when explicitly disabled",
    async (channel) => {
      const agent = await loadAgent({
        [channel]: {
          url: "https://legacy.example.test",
          token: "legacy-token",
          appToken: "legacy-app-token",
        },
        extensions: { [channel]: { enabled: false } },
      });

      expect(readers[channel](agent)).toBeUndefined();
      expect(agent.extensions?.[channel]?.token).toBe("legacy-token");
    }
  );
});

it("loads a deprecated channel as an extension and preserves a home env reference", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-legacy-channel-"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    vi.stubEnv("YOPLAI_HOME", home);
    const workspace = path.join(home, "agents", "chat");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(home, "yoplai.json"), JSON.stringify({ version: 3, agents: "agents/*" }));
    await fs.writeFile(path.join(home, ".env"), "LEGACY_CHAT_TOKEN=fixture-home-token\n");
    await fs.writeFile(path.join(workspace, "agent.yaml"), JSON.stringify({
      id: "chat",
      name: "Chat",
      model: { provider: "test", model: "test" },
      mattermost: { url: "https://legacy.example.test", token: "$env:LEGACY_CHAT_TOKEN" },
      extensions: { mattermost: { enabled: false, channelIds: "ignored" } },
    }));
    const { loadConfig, reloadConfig } = await import("./index.js");
    const { resolveStartupConfig } = await import("./validate.js");
    const { agents } = await resolveStartupConfig(loadConfig());
    expect(agents[0].extensions?.mattermost).toEqual({
      enabled: false, url: "https://legacy.example.test", token: "fixture-home-token",
    });
    reloadConfig();
    expect(warn.mock.calls).toEqual([[expect.stringMatching(/chat.*mattermost.*deprecated.*channelIds/)]]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
  }
});
