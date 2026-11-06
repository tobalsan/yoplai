import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, notify } from "@yoplai/shared";
import { Command } from "commander";
import { registerNotifyCommand, runNotifyCommand } from "./notify.js";

describe("notify CLI", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.YOPLAI_AGENT_ID;
  });

  it("registers a top-level notify command", () => {
    const program = new Command();
    registerNotifyCommand(program);

    const notifyCommand = program.commands.find(
      (command) => command.name() === "notify"
    );

    expect(notifyCommand).toBeDefined();
    expect(notifyCommand?.helpInformation()).toContain("--channel <channel>");
    expect(notifyCommand?.helpInformation()).toContain("--message <text>");
    expect(notifyCommand?.helpInformation()).toContain("--from <agentId>");
    expect(notifyCommand?.helpInformation()).toContain("Send a Discord, Slack or Mattermost notification");
    expect(notifyCommand?.helpInformation()).toContain("discord, slack, mattermost, or all (both is an alias)");
    expect(notifyCommand?.helpInformation()).toContain('(default: "all")');
    expect(notifyCommand?.helpInformation().replace(/\s+/g, " ")).toContain("Discord/Slack user id; Mattermost username");
  });

  it("passes invalid surfaces through runtime validation before adapters run", async () => {
    const discord = vi.fn().mockResolvedValue(undefined);
    const slack = vi.fn().mockResolvedValue(undefined);
    const config = GatewayConfigSchema.parse({
      agents: [],
      extensions: {
        discord: { token: "discord-token" },
        slack: { token: "slack-token", appToken: "slack-app-token" },
      },
      notifications: {
        channels: {
          default: { discord: "discord-channel", slack: "slack-channel" },
        },
      },
    });

    await expect(
      runNotifyCommand(
        {
          channel: "default",
          message: "hi",
          surface: "bogus",
        },
        {
          loadConfig: () => config,
          resolveConfig: async (value) => value,
          notifyImpl: async (options) => {
            return notify({
              ...options,
              adapters: { discord, slack },
            });
          },
        }
      )
    ).rejects.toThrow(/Invalid notify surface "bogus"/);
    expect(discord).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
  });

  it("resolves bot tokens from the explicit notify agent", async () => {
    const notifyImpl = vi.fn().mockResolvedValue({ ok: true, results: [] });
    const config = GatewayConfigSchema.parse({
      agents: [
        {
          id: "pom",
          name: "Pom",
          workspace: "~/pom",
          model: { provider: "anthropic", model: "claude" },
          discord: { token: "agent-discord-token" },
          slack: {
            token: "agent-slack-token",
            appToken: "agent-slack-app-token",
          },
        },
      ],
      extensions: {
        discord: { token: "gateway-discord-token" },
        slack: {
          token: "gateway-slack-token",
          appToken: "gateway-slack-app-token",
        },
      },
      notifications: {
        channels: {
          default: { discord: "discord-channel", slack: "slack-channel" },
        },
      },
    });

    await runNotifyCommand(
      {
        from: "pom",
        channel: "default",
        message: "hi",
      },
      {
        loadConfig: () => config,
        resolveConfig: async (value) => value,
        notifyImpl,
      }
    );

    expect(notifyImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        discordToken: "agent-discord-token",
        slackToken: "agent-slack-token",
      })
    );
  });

  it("uses YOPLAI_AGENT_ID as an implicit notify agent", async () => {
    process.env.YOPLAI_AGENT_ID = "pom";
    const notifyImpl = vi.fn().mockResolvedValue({ ok: true, results: [] });
    const config = GatewayConfigSchema.parse({
      agents: [
        {
          id: "pom",
          name: "Pom",
          workspace: "~/pom",
          model: { provider: "anthropic", model: "claude" },
          discord: { token: "agent-discord-token" },
        },
      ],
      extensions: {
        discord: { token: "gateway-discord-token" },
      },
      notifications: {
        channels: {
          default: { discord: "discord-channel" },
        },
      },
    });

    await runNotifyCommand(
      {
        channel: "default",
        message: "hi",
      },
      {
        loadConfig: () => config,
        resolveConfig: async (value) => value,
        notifyImpl,
      }
    );

    expect(notifyImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        discordToken: "agent-discord-token",
      })
    );
  });

  it("prefers --from over YOPLAI_AGENT_ID", async () => {
    process.env.YOPLAI_AGENT_ID = "pom";
    const notifyImpl = vi.fn().mockResolvedValue({ ok: true, results: [] });
    const config = GatewayConfigSchema.parse({
      agents: [
        {
          id: "casey",
          name: "Casey",
          workspace: "~/casey",
          model: { provider: "anthropic", model: "claude" },
          discord: { token: "explicit-agent-token" },
        },
        {
          id: "pom",
          name: "Pom",
          workspace: "~/pom",
          model: { provider: "anthropic", model: "claude" },
          discord: { token: "env-agent-token" },
        },
      ],
      notifications: {
        channels: {
          default: { discord: "discord-channel" },
        },
      },
    });

    await runNotifyCommand(
      {
        from: "casey",
        channel: "default",
        message: "hi",
      },
      {
        loadConfig: () => config,
        resolveConfig: async (value) => value,
        notifyImpl,
      }
    );

    expect(notifyImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        discordToken: "explicit-agent-token",
      })
    );
  });

  it("falls back to gateway tokens when the notify agent lacks a token", async () => {
    const notifyImpl = vi.fn().mockResolvedValue({ ok: true, results: [] });
    const config = GatewayConfigSchema.parse({
      agents: [
        {
          id: "pom",
          name: "Pom",
          workspace: "~/pom",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        discord: { token: "gateway-discord-token" },
        slack: {
          token: "gateway-slack-token",
          appToken: "gateway-slack-app-token",
        },
      },
      notifications: {
        channels: {
          default: { discord: "discord-channel", slack: "slack-channel" },
        },
      },
    });

    await runNotifyCommand(
      {
        from: "pom",
        channel: "default",
        message: "hi",
      },
      {
        loadConfig: () => config,
        resolveConfig: async (value) => value,
        notifyImpl,
      }
    );

    expect(notifyImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        discordToken: "gateway-discord-token",
        slackToken: "gateway-slack-token",
      })
    );
  });

  it("rejects unknown notify agents", async () => {
    const notifyImpl = vi.fn();
    const config = GatewayConfigSchema.parse({
      agents: [],
      notifications: {
        channels: {
          default: { discord: "discord-channel" },
        },
      },
    });

    await expect(
      runNotifyCommand(
        {
          from: "pom",
          channel: "default",
          message: "hi",
        },
        {
          loadConfig: () => config,
          resolveConfig: async (value) => value,
          notifyImpl,
        }
      )
    ).rejects.toThrow(/Unknown notify agent "pom"/);
    expect(notifyImpl).not.toHaveBeenCalled();
  });

  it("uses the notify agent's Mattermost url and token together", async () => {
    const notifyImpl = vi.fn().mockResolvedValue({ ok: true, results: [] });
    const config = GatewayConfigSchema.parse({
      agents: [{
        id: "notifier",
        name: "Notifier",
        workspace: "/nonexistent/notify-test-agent",
        model: { provider: "anthropic", model: "claude" },
        mattermost: {
          url: "https://agent.mattermost.example.com",
          token: "fake-agent-mattermost-token",
        },
      }],
      extensions: {
        mattermost: {
          url: "https://root.mattermost.example.com",
          token: "fake-root-mattermost-token",
        },
      },
      notifications: { channels: { default: { mattermost: "fake-channel-id" } } },
    });

    await runNotifyCommand(
      { from: "notifier", channel: "default", message: "hello", surface: "mattermost" },
      { loadConfig: () => config, resolveConfig: async (value) => value, notifyImpl }
    );

    expect(notifyImpl).toHaveBeenCalledWith(expect.objectContaining({
      mattermostUrl: "https://agent.mattermost.example.com",
      mattermostToken: "fake-agent-mattermost-token",
    }));
  });

  it.each([undefined, "notifier"])("uses the root Mattermost pair without an agent block (%s)", async (from) => {
    const notifyImpl = vi.fn().mockResolvedValue({ ok: true, results: [] });
    const config = GatewayConfigSchema.parse({
      agents: [{
        id: "notifier",
        name: "Notifier",
        workspace: "/nonexistent/notify-test-agent",
        model: { provider: "anthropic", model: "claude" },
      }],
      extensions: {
        mattermost: {
          url: "https://root.mattermost.example.com",
          token: "fake-root-mattermost-token",
        },
      },
      notifications: { channels: { default: { mattermost: "fake-channel-id" } } },
    });

    await runNotifyCommand(
      { from, channel: "default", message: "hello" },
      { loadConfig: () => config, resolveConfig: async (value) => value, notifyImpl }
    );

    expect(notifyImpl).toHaveBeenCalledWith(expect.objectContaining({
      mattermostUrl: "https://root.mattermost.example.com",
      mattermostToken: "fake-root-mattermost-token",
    }));
  });

  it.each([
    { from: undefined, url: "https://root.mattermost.example.com", token: "fake-root-env-token" },
    { from: "notifier", url: "https://agent.mattermost.example.com", token: "fake-agent-env-token" },
  ])("resolves Mattermost env references through startup config ($from)", async ({ from, url, token }) => {
    vi.stubEnv("HOME", "/nonexistent/notify-test-home");
    vi.stubEnv("TEST_NOTIFY_MM_URL", "https://root.mattermost.example.com");
    vi.stubEnv("TEST_NOTIFY_MM_TOKEN", "fake-root-env-token");
    const notifyImpl = vi.fn().mockResolvedValue({ ok: true, results: [] });
    const config = GatewayConfigSchema.parse({
      agents: [{
        id: "notifier",
        name: "Notifier",
        workspace: "/nonexistent/notify-test-agent",
        model: { provider: "anthropic", model: "claude" },
        mattermost: { url: "$env:TEST_NOTIFY_MM_URL", token: "$env:TEST_NOTIFY_MM_TOKEN" },
      }],
      env: {
        TEST_NOTIFY_MM_URL: "https://agent.mattermost.example.com",
        TEST_NOTIFY_MM_TOKEN: "fake-agent-env-token",
      },
      extensions: {
        mattermost: { url: "$env:TEST_NOTIFY_MM_URL", token: "$env:TEST_NOTIFY_MM_TOKEN" },
      },
      notifications: { channels: { default: { mattermost: "fake-channel-id" } } },
    });

    await runNotifyCommand(
      { from, channel: "default", message: "hello" },
      { loadConfig: () => config, notifyImpl }
    );

    expect(notifyImpl).toHaveBeenCalledWith(expect.objectContaining({
      mattermostUrl: url,
      mattermostToken: token,
    }));
  });
});
