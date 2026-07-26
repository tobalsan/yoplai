import { describe, expect, it, vi, beforeEach } from "vitest";
import { GatewayConfigSchema, type ExtensionContext } from "@yoplai/shared";

const start = vi.fn(async () => undefined);
const stop = vi.fn(async () => undefined);
const createDiscordComponentBot = vi.fn(async () => ({
  agentId: "discord",
  client: {} as never,
  start,
  stop,
}));

vi.mock("./bot.js", () => ({
  createDiscordBot: vi.fn(),
  createDiscordComponentBot,
}));

describe("discord extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeContext(config: ReturnType<typeof GatewayConfigSchema.parse>) {
    return {
      getConfig: () => config,
      getDataDir: () => "/tmp",
      reloadConfig: () => undefined,
      getAgent: (id: string) => config.agents.find((agent) => agent.id === id),
      getAgents: () => config.agents,
      isAgentActive: () => true,
      isAgentStreaming: () => false,
      resolveWorkspaceDir: () => "/tmp",
      runAgent: vi.fn(),
      getSubagentTemplates: () => [],
      resolveSessionId: async () => undefined,
      getSessionEntry: async () => undefined,
      clearSessionEntry: async () => undefined,
      restoreSessionUpdatedAt: () => undefined,
      deleteSession: () => undefined,
      invalidateHistoryCache: async () => undefined,
      getSessionHistory: async () => [],
      subscribe: () => () => undefined,
      emit: () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    } satisfies ExtensionContext;
  }

  it("starts component bot with extension config", async () => {
    const { discordExtension } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        discord: {
          enabled: true,
          token: "secret-token",
          channels: {
            "123": { agent: "main", requireMention: false },
          },
          dm: { enabled: true, agent: "main" },
        },
      },
    });

    const ctx = makeContext(config);
    await discordExtension.start(ctx);

    expect(createDiscordComponentBot).toHaveBeenCalledWith(
      config.agents,
      expect.objectContaining({ token: "secret-token" })
    );
    expect(start).toHaveBeenCalledOnce();
  });

  it("stops active bots", async () => {
    const { discordExtension } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/agents/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        discord: {
          enabled: true,
          token: "secret-token",
          channels: { "123": { agent: "main" } },
        },
      },
    });

    await discordExtension.start(makeContext(config));
    await discordExtension.stop();

    expect(stop).toHaveBeenCalledOnce();
  });
});
