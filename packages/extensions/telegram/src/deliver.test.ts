import type {
  AgentConfig,
  DeliverySink,
  ExtensionContext,
  GatewayConfig,
} from "@yoplai/shared";
import { GatewayConfigSchema } from "@yoplai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import type { TelegramBot } from "./bot.js";

type MockApi = { sendMessage: ReturnType<typeof vi.fn> };

function agent(id: string): AgentConfig {
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    model: { provider: "test", model: "test" },
  } as unknown as AgentConfig;
}

function config(): GatewayConfig {
  return GatewayConfigSchema.parse({
    version: 2,
    agents: [
      {
        id: "main",
        name: "Main",
        workspace: "~/main",
        model: { provider: "anthropic", model: "claude" },
      },
    ],
    extensions: {},
  });
}

function registerMockBot(agentId: string, api: MockApi): void {
  registerActiveBot(agentId, {
    agentId,
    bot: { api },
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as TelegramBot);
}

function buildCtx() {
  const deliverySinks = new Map<string, DeliverySink>();
  return {
    getConfig: () => config(),
    getDataDir: () => "/tmp",
    reloadConfig: () => undefined,
    getAgent: () => undefined,
    getAgents: () => config().agents,
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
    registerDeliverySink: (id: string, sink: DeliverySink) => {
      deliverySinks.set(id, sink);
      return () => {
        deliverySinks.delete(id);
      };
    },
    getDeliverySink: (id: string) => deliverySinks.get(id),
    subscribe: () => () => undefined,
    emit: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  } satisfies ExtensionContext;
}

describe("telegram delivery sink", () => {
  afterEach(() => {
    clearActiveBots();
    vi.clearAllMocks();
  });

  it("registers under id 'telegram' on start and unregisters on stop", async () => {
    const { telegramExtension } = await import("./index.js");
    const ctx = buildCtx();

    await telegramExtension.start(ctx);
    expect(ctx.getDeliverySink("telegram")).toBeTypeOf("function");

    await telegramExtension.stop();
    expect(ctx.getDeliverySink("telegram")).toBeUndefined();
  });

  it("prefers destination.user over destination.channel as the chat ID", async () => {
    const { telegramExtension } = await import("./index.js");
    const ctx = buildCtx();
    await telegramExtension.start(ctx);
    const sink = ctx.getDeliverySink("telegram")!;

    const api: MockApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    };
    registerMockBot("main", api);

    await sink({
      agent: agent("main"),
      destination: { channel: "chan-1", user: "user-1" },
      text: "hello",
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      "user-1",
      expect.any(String),
      expect.objectContaining({ parse_mode: "HTML" })
    );
  });

  it("falls back to destination.channel when no user is given", async () => {
    const { telegramExtension } = await import("./index.js");
    const ctx = buildCtx();
    await telegramExtension.start(ctx);
    const sink = ctx.getDeliverySink("telegram")!;

    const api: MockApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    };
    registerMockBot("main", api);

    await sink({
      agent: agent("main"),
      destination: { channel: "chan-1" },
      text: "hello",
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      "chan-1",
      expect.any(String),
      expect.objectContaining({ parse_mode: "HTML" })
    );
  });

  it("throws when the destination has neither channel nor user", async () => {
    const { telegramExtension } = await import("./index.js");
    const ctx = buildCtx();
    await telegramExtension.start(ctx);
    const sink = ctx.getDeliverySink("telegram")!;

    await expect(
      sink({ agent: agent("main"), destination: {}, text: "hello" })
    ).rejects.toThrow(
      "telegram delivery requires a channel or user destination"
    );
  });

  it("throws (rather than returning ok: false) when no bot is active", async () => {
    const { telegramExtension } = await import("./index.js");
    const ctx = buildCtx();
    await telegramExtension.start(ctx);
    const sink = ctx.getDeliverySink("telegram")!;

    await expect(
      sink({ agent: agent("main"), destination: { user: "1" }, text: "hi" })
    ).rejects.toThrow("No Telegram token is configured for this agent.");
  });
});
