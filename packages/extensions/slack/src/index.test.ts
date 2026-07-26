import { GatewayConfigSchema, type ExtensionContext } from "@yoplai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const componentStart = vi.fn().mockResolvedValue(undefined);
const componentStop = vi.fn().mockResolvedValue(undefined);
const agentStart = vi.fn().mockResolvedValue(undefined);
const agentStop = vi.fn().mockResolvedValue(undefined);

const createSlackBot = vi.fn();
const createSlackAgentBot = vi.fn();

vi.mock("./bot.js", () => ({
  createSlackBot,
  createSlackAgentBot,
}));

describe("slack extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSlackBot.mockReturnValue({
      agentId: "slack",
      app: {},
      start: componentStart,
      stop: componentStop,
    });
    createSlackAgentBot.mockReturnValue({
      agentId: "main",
      app: {},
      start: agentStart,
      stop: agentStop,
    });
  });

  function buildCtx(config: ReturnType<typeof GatewayConfigSchema.parse>) {
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

  it("starts component bot and per-agent bots", async () => {
    const { slackExtension } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/main",
          model: { provider: "anthropic", model: "claude" },
          slack: {
            token: "xoxb-agent",
            appToken: "xapp-agent",
          },
        },
      ],
      extensions: {
        slack: {
          enabled: true,
          token: "xoxb-test",
          appToken: "xapp-test",
          channels: {
            C1: { agent: "main", requireMention: false },
          },
          dm: { enabled: true, agent: "main" },
        },
      },
    });

    await slackExtension.start(buildCtx(config));

    expect(createSlackBot).toHaveBeenCalledWith(
      config.agents,
      expect.objectContaining({ token: "xoxb-test", appToken: "xapp-test" })
    );
    expect(componentStart).toHaveBeenCalledOnce();
    expect(createSlackAgentBot).toHaveBeenCalledWith(config.agents[0]);
    expect(agentStart).toHaveBeenCalledOnce();
  });

  it("stops active bots", async () => {
    const { startSlackBots, stopSlackBots } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/main",
          model: { provider: "anthropic", model: "claude" },
          slack: { token: "xoxb-agent", appToken: "xapp-agent" },
        },
      ],
      extensions: {},
    });

    await startSlackBots(buildCtx(config));
    await stopSlackBots();

    expect(agentStop).toHaveBeenCalledOnce();
  });
});
