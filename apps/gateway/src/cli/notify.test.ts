import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayConfigSchema, notify } from "@yoplai/shared";
import { Command } from "commander";
import { registerNotifyCommand, runNotifyCommand } from "./notify.js";

describe("notify CLI", () => {
  afterEach(() => {
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
});
