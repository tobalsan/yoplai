import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramAgentTools } from "./agent-tools.js";
import { clearActiveBots, registerActiveBot } from "./bot-registry.js";
import type { TelegramBot } from "./bot.js";

type MockApi = { sendMessage: ReturnType<typeof vi.fn> };

function agent(id: string, telegram?: AgentConfig["telegram"]): AgentConfig {
  return {
    id,
    name: id,
    workspace: `/tmp/${id}`,
    workspaceDir: `/tmp/${id}`,
    model: { provider: "test", model: "test" },
    queueMode: "queue",
    telegram,
  } as unknown as AgentConfig;
}

function config(extensionsTelegram?: unknown): GatewayConfig {
  return {
    version: 3,
    agents: [],
    extensions: extensionsTelegram
      ? { telegram: extensionsTelegram as never }
      : undefined,
    sessions: { idleMinutes: 360 },
    agentFab: false,
  } as unknown as GatewayConfig;
}

function registerMockBot(agentId: string, api: MockApi): void {
  registerActiveBot(agentId, {
    agentId,
    bot: { api },
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as TelegramBot);
}

function tool(name: string) {
  const found = telegramAgentTools().find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

describe("telegram agent tools", () => {
  afterEach(() => {
    clearActiveBots();
    vi.clearAllMocks();
  });

  it("exposes send_message", () => {
    expect(telegramAgentTools().map((t) => t.name)).toEqual([
      "telegram.send_message",
    ]);
  });

  it("send_message renders markdown and posts via the active bot", async () => {
    const api: MockApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }),
    };
    registerMockBot("alpha", api);

    const result = await tool("telegram.send_message").execute(
      { chatId: "123", text: "hello **world**" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: true, chatId: "123" });
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, html, opts] = api.sendMessage.mock.calls[0];
    expect(chatId).toBe("123");
    expect(html).toContain("<b>world</b>");
    expect(opts).toMatchObject({ parse_mode: "HTML" });
  });

  it("send_message chunks long output and threads replies", async () => {
    const api: MockApi = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({ message_id: 1 })
        .mockResolvedValueOnce({ message_id: 2 }),
    };
    registerMockBot("alpha", api);

    const longText = "a".repeat(5000);
    const result = await tool("telegram.send_message").execute(
      { chatId: 456, text: longText },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: true, chatId: 456 });
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // First chunk has no reply target; second replies to the first message.
    expect(api.sendMessage.mock.calls[0][2]).toMatchObject({
      reply_parameters: undefined,
    });
    expect(api.sendMessage.mock.calls[1][2]).toMatchObject({
      reply_parameters: { message_id: 1 },
    });
  });

  it("send_message falls back to the component bot when no agent bot exists", async () => {
    const api: MockApi = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 7 }),
    };
    registerMockBot("telegram", api);

    const result = await tool("telegram.send_message").execute(
      { chatId: "789", text: "hi" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: true, chatId: "789" });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("send_message errors when no bot is active and no token is configured", async () => {
    const result = await tool("telegram.send_message").execute(
      { chatId: "1", text: "x" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toMatchObject({ ok: false });
  });

  it("send_message reports no active bot when a token is configured but no bot runs", async () => {
    const result = await tool("telegram.send_message").execute(
      { chatId: "1", text: "x" },
      {
        agent: agent("alpha"),
        config: config({ token: "bot-token" }),
      }
    );

    expect(result).toEqual({
      ok: false,
      error: "No active Telegram bot is running for this agent.",
    });
  });

  it("send_message surfaces Telegram API errors", async () => {
    const api: MockApi = {
      sendMessage: vi.fn().mockRejectedValue(new Error("chat not found")),
    };
    registerMockBot("alpha", api);

    const result = await tool("telegram.send_message").execute(
      { chatId: "1", text: "x" },
      { agent: agent("alpha"), config: config() }
    );

    expect(result).toEqual({ ok: false, error: "chat not found" });
  });
});
