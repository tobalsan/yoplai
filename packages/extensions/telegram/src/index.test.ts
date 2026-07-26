import { GatewayConfigSchema, type ExtensionContext } from "@yoplai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const componentStart = vi.fn().mockResolvedValue(undefined);
const componentStop = vi.fn().mockResolvedValue(undefined);
const agentStart = vi.fn().mockResolvedValue(undefined);
const agentStop = vi.fn().mockResolvedValue(undefined);

const createTelegramBot = vi.fn();
const createTelegramAgentBot = vi.fn();

vi.mock("./bot.js", () => ({
  createTelegramBot,
  createTelegramAgentBot,
}));

describe("telegram extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createTelegramBot.mockReturnValue({
      agentId: "telegram",
      bot: {},
      start: componentStart,
      stop: componentStop,
    });
    createTelegramAgentBot.mockReturnValue({
      agentId: "main",
      bot: {},
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

  it("has the expected identity and capabilities", async () => {
    const { telegramExtension } = await import("./index.js");
    expect(telegramExtension.id).toBe("telegram");
    expect(telegramExtension.capabilities()).toEqual(["telegram"]);
  });

  it("exposes the send_message agent tool", async () => {
    const { telegramExtension } = await import("./index.js");
    const agent = { id: "main" } as never;
    const tools = await telegramExtension.getAgentTools?.(agent);
    expect(tools?.map((t) => t.name)).toContain("telegram.send_message");
  });

  it("omits agent tools when the extension is disabled", async () => {
    const { telegramExtension } = await import("./index.js");
    const agent = { id: "main" } as never;
    const tools = await telegramExtension.getAgentTools?.(agent, {
      config: { extensions: { telegram: { enabled: false } } },
    } as never);
    expect(tools).toEqual([]);
  });

  it("starts the component bot from root extensions.telegram", async () => {
    const { telegramExtension } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/main",
          model: { provider: "anthropic", model: "claude" },
        },
      ],
      extensions: {
        telegram: { enabled: true, token: "bot-token" },
      },
    });

    await telegramExtension.start(buildCtx(config));

    expect(createTelegramBot).toHaveBeenCalledWith(
      config.agents,
      expect.objectContaining({ token: "bot-token" })
    );
    expect(componentStart).toHaveBeenCalledOnce();
  });

  it("starts a per-agent bot from agents[n].telegram.token", async () => {
    const { startTelegramBots } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/main",
          model: { provider: "anthropic", model: "claude" },
          telegram: { token: "agent-token" },
        },
      ],
      extensions: {},
    });

    await startTelegramBots(buildCtx(config));

    expect(createTelegramAgentBot).toHaveBeenCalledWith(config.agents[0]);
    expect(agentStart).toHaveBeenCalledOnce();
  });

  it("stops active bots", async () => {
    const { startTelegramBots, stopTelegramBots } = await import("./index.js");
    const config = GatewayConfigSchema.parse({
      version: 2,
      agents: [
        {
          id: "main",
          name: "Main",
          workspace: "~/main",
          model: { provider: "anthropic", model: "claude" },
          telegram: { token: "agent-token" },
        },
      ],
      extensions: {},
    });

    await startTelegramBots(buildCtx(config));
    await stopTelegramBots();

    expect(agentStop).toHaveBeenCalledOnce();
  });
});
