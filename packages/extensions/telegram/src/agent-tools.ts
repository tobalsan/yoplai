import type {
  AgentConfig,
  ExtensionAgentTool,
  GatewayConfig,
  TelegramAgentConfig,
  TelegramComponentConfig,
} from "@yoplai/shared";
import { z } from "zod";
import { getActiveBot } from "./bot-registry.js";
import { splitMessage } from "./utils/chunk.js";
import { renderMarkdown } from "./utils/render.js";
import { withRetry } from "./utils/retry.js";

const sendMessageSchema = z.object({
  chatId: z.union([z.string(), z.number()]),
  text: z.string().min(1),
});

function toolError(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Resolve the Telegram bot token for an agent. Per-agent config wins; otherwise
 * fall back to the component-level extension config.
 */
function resolveTelegramToken(
  agent: AgentConfig,
  config: GatewayConfig,
  env?: Record<string, string>
): string | undefined {
  const agentTelegram = agent.telegram as TelegramAgentConfig | undefined;
  if (agentTelegram?.token) return agentTelegram.token;
  const component = config.extensions?.telegram as
    | TelegramComponentConfig
    | undefined;
  return component?.token ?? env?.TELEGRAM_TOKEN;
}

export function telegramAgentTools(): ExtensionAgentTool[] {
  return [
    {
      name: "telegram.send_message",
      description:
        "Proactively send a Telegram message to a chat. Markdown in `text` is rendered to Telegram-native formatting (bold, code, lists, tables). Provide `chatId` as the numeric chat ID of a user or group the bot can reach.",
      parameters: {
        type: "object",
        properties: {
          chatId: {
            type: "string",
            description: "Numeric Telegram chat ID to send the message to.",
          },
          text: {
            type: "string",
            description: "Message body. Markdown is rendered to Telegram formatting.",
          },
        },
        required: ["chatId", "text"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = sendMessageSchema.parse(args);
          const activeBot =
            getActiveBot(agent.id) ?? getActiveBot("telegram");
          if (!activeBot) {
            const token = resolveTelegramToken(agent, config, env);
            if (!token) {
              return {
                ok: false,
                error: "No Telegram token is configured for this agent.",
              };
            }
            return {
              ok: false,
              error: "No active Telegram bot is running for this agent.",
            };
          }
          const html = renderMarkdown(input.text);
          const logPrefix = `[telegram:${agent.id}]`;
          let replyToMessageId: number | undefined;
          for (const chunk of splitMessage(html)) {
            const sent = await withRetry(
              () =>
                activeBot.bot.api.sendMessage(input.chatId, chunk, {
                  parse_mode: "HTML",
                  reply_parameters: replyToMessageId
                    ? { message_id: replyToMessageId }
                    : undefined,
                }),
              { logPrefix, label: "send_message" }
            );
            replyToMessageId = sent.message_id;
          }
          return { ok: true, chatId: input.chatId };
        } catch (error) {
          return toolError(error);
        }
      },
    },
  ];
}
