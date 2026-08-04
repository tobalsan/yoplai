import { WebClient } from "@slack/web-api";
import type {
  AgentConfig,
  DeliverySink,
  ExtensionAgentTool,
  ExtensionContext,
  GatewayConfig,
  SlackAgentConfig,
  SlackComponentConfig,
} from "@yoplai/shared";
import { z } from "zod";
import { getActiveBot } from "./bot-registry.js";
import { getSlackContextIfInitialized } from "./context.js";
import { createProactiveDmNoteStore } from "./proactive-dm-notes.js";
import { createSlackThreadSessionBindingStore } from "./thread-session-bindings.js";
import { markdownToMrkdwn } from "./utils/mrkdwn.js";
import { splitMessage } from "./utils/chunk.js";
import type { SlackWebClient } from "./types.js";

const sendMessageSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
  threadTs: z.string().min(1).optional(),
});

const createThreadSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
});

const listChannelsSchema = z.object({
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const listUsersSchema = z.object({
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

function toolError(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Resolve the Slack bot token for an agent. Per-agent config wins; otherwise
 * fall back to the component-level extension config. Returns undefined when no
 * Slack token is configured for this agent.
 */
function resolveSlackToken(
  agent: AgentConfig,
  config: GatewayConfig,
  env?: Record<string, string>
): string | undefined {
  const agentSlack = agent.slack as SlackAgentConfig | undefined;
  if (agentSlack?.token) return agentSlack.token;
  const component = config.extensions?.slack as
    | SlackComponentConfig
    | undefined;
  return component?.token ?? env?.SLACK_TOKEN;
}

const clientCache = new Map<string, WebClient>();

/**
 * Obtain a Slack Web API client capable of posting. Prefer the live bot client
 * when a Socket Mode bot is running for this agent (or the shared component
 * bot); otherwise construct a token-only WebClient. This lets proactive senders
 * such as scheduled jobs post even when no bot is actively listening.
 */
function resolveSlackClient(
  agent: AgentConfig,
  config: GatewayConfig,
  env?: Record<string, string>
): SlackWebClient | undefined {
  const activeBot = getActiveBot(agent.id) ?? getActiveBot("slack");
  if (activeBot) {
    return activeBot.app.client as unknown as SlackWebClient;
  }

  const token = resolveSlackToken(agent, config, env);
  if (!token) return undefined;

  let client = clientCache.get(token);
  if (!client) {
    client = new WebClient(token);
    clientCache.set(token, client);
  }
  return client as unknown as SlackWebClient;
}

export function clearSlackClientCache(): void {
  clientCache.clear();
}

/**
 * Send a Slack message to a channel or user, chunking long text and recording
 * a proactive-DM note when the recipient is a DM. Shared by slack.send_message
 * and the scheduler delivery sink. Throws on failure.
 */
async function sendSlackMessage(
  agent: AgentConfig,
  config: GatewayConfig,
  env: Record<string, string> | undefined,
  input: { channel: string; text: string; threadTs?: string }
): Promise<{ channel: string; ts?: string }> {
  const client = resolveSlackClient(agent, config, env);
  if (!client) {
    throw new Error("No Slack token is configured for this agent.");
  }
  const chunks = splitMessage(markdownToMrkdwn(input.text));
  let firstTs: string | undefined;
  for (const chunk of chunks) {
    const result = await client.chat.postMessage({
      channel: input.channel,
      text: chunk,
      mrkdwn: true,
      thread_ts: input.threadTs,
      unfurl_links: false,
      unfurl_media: false,
    });
    firstTs ??= result.ts;
  }
  const recipientType = input.channel.startsWith("U")
    ? "user"
    : input.channel.startsWith("D")
      ? "channel"
      : undefined;
  if (recipientType) {
    const context = getSlackContextIfInitialized();
    if (context) {
      const store = createProactiveDmNoteStore(context.getDataDir());
      try {
        store.addNote(agent.id, recipientType, input.channel, input.text);
      } catch (error) {
        // The message is already in Slack; a bookkeeping failure must not be
        // reported back as a failed send (a scheduler delivery would record a
        // warning for a message the user actually received).
        context.logger.warn(
          `[slack] Failed to record proactive DM note: ${error instanceof Error ? error.message : String(error)}`
        );
      } finally {
        store.close();
      }
    }
  }
  return { channel: input.channel, ts: firstTs };
}

/**
 * Register the "slack" delivery sink used by the scheduler to push cron
 * results. `channel` maps to a channel ID; `user` maps to a Slack user ID,
 * which Slack DMs when passed as the `channel` param on chat.postMessage.
 * Shares sendSlackMessage with slack.send_message, so a delivered result also
 * leaves the same proactive-DM note a manual send would.
 */
export function createSlackDeliverySink(ctx: ExtensionContext): DeliverySink {
  return async ({ agent, destination, text }) => {
    const channel = destination.channel ?? destination.user;
    if (!channel) {
      throw new Error("Slack delivery requires a channel or user destination.");
    }
    await sendSlackMessage(agent, ctx.getConfig(), undefined, { channel, text });
  };
}

export function slackAgentTools(): ExtensionAgentTool[] {
  return [
    {
      name: "slack.create_thread",
      description:
        "Post a Slack thread parent message and bind the thread to this agent session. Provide channel as a channel ID (C...) or user ID (U...) for a direct message. The returned channel and ts can be used with slack.send_message to post replies.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description:
              "Channel ID (C...) or user ID (U...). User IDs are delivered as a direct message.",
          },
          text: {
            type: "string",
            description: "Thread parent message body. Markdown is converted to Slack mrkdwn.",
          },
        },
        required: ["channel", "text"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env, sessionId }) {
        try {
          const input = createThreadSchema.parse(args);
          if (!sessionId) {
            return toolError("No active session ID is available for binding.");
          }
          const context = getSlackContextIfInitialized();
          if (!context) {
            return toolError("Slack context is not initialized for binding.");
          }
          const client = resolveSlackClient(agent, config, env);
          if (!client) {
            return toolError("No Slack token is configured for this agent.");
          }
          const result = await client.chat.postMessage({
            channel: input.channel,
            text: markdownToMrkdwn(input.text),
            mrkdwn: true,
            unfurl_links: false,
            unfurl_media: false,
          });
          if (!result.ts) {
            return toolError("Slack did not return a message timestamp.");
          }
          const channel = result.channel ?? input.channel;
          const store = createSlackThreadSessionBindingStore(context.getDataDir());
          try {
            store.setBinding({
              channelId: channel,
              threadTs: result.ts,
              sessionId,
              agentId: agent.id,
            });
          } finally {
            store.close();
          }
          return { ok: true, channel, ts: result.ts };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.send_message",
      description:
        "Proactively send a Slack message to a channel or user. Provide `channel` as a channel ID (e.g. C0123456789) or a user ID (e.g. U0123456789) for a direct message. Use slack.list_channels / slack.list_users to look up IDs.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description:
              "Channel ID (C...) or user ID (U...). User IDs are delivered as a direct message.",
          },
          text: {
            type: "string",
            description: "Message body. Markdown is converted to Slack mrkdwn.",
          },
          threadTs: {
            type: "string",
            description:
              "Optional parent message timestamp to reply in a thread.",
          },
        },
        required: ["channel", "text"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = sendMessageSchema.parse(args);
          const result = await sendSlackMessage(agent, config, env, input);
          return { ok: true, ...result };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.list_channels",
      description:
        "List Slack channels the bot can post to, returning their IDs and names. Optionally filter by a name substring.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Case-insensitive substring to match channel names.",
          },
          limit: {
            type: "number",
            description: "Maximum channels to return (default 100, max 200).",
          },
        },
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = listChannelsSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.conversations?.list) {
            return {
              ok: false,
              error: "Slack channel listing is not available for this agent.",
            };
          }
          const limit = input.limit ?? 100;
          const query = input.query?.toLowerCase();
          const channels: Array<{ id: string; name: string }> = [];
          let cursor: string | undefined;
          do {
            const page = await client.conversations.list({
              limit: 200,
              cursor,
              exclude_archived: true,
              types: "public_channel,private_channel",
            });
            for (const channel of page.channels ?? []) {
              if (!channel.id || !channel.name) continue;
              if (query && !channel.name.toLowerCase().includes(query))
                continue;
              channels.push({ id: channel.id, name: channel.name });
              if (channels.length >= limit) break;
            }
            cursor = page.response_metadata?.next_cursor || undefined;
          } while (cursor && channels.length < limit);
          return { ok: true, channels };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.list_users",
      description:
        "List Slack workspace users, returning their IDs and display names for direct messaging. Optionally filter by a name substring.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Case-insensitive substring to match display, real, or user names.",
          },
          limit: {
            type: "number",
            description: "Maximum users to return (default 100, max 200).",
          },
        },
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = listUsersSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.users?.list) {
            return {
              ok: false,
              error: "Slack user listing is not available for this agent.",
            };
          }
          const limit = input.limit ?? 100;
          const query = input.query?.toLowerCase();
          const users: Array<{ id: string; name: string }> = [];
          let cursor: string | undefined;
          do {
            const page = await client.users.list({ limit: 200, cursor });
            for (const member of page.members ?? []) {
              if (!member.id || member.deleted || member.is_bot) continue;
              const name =
                member.profile?.display_name?.trim() ||
                member.profile?.real_name?.trim() ||
                member.real_name?.trim() ||
                member.name?.trim();
              if (!name) continue;
              if (query && !name.toLowerCase().includes(query)) continue;
              users.push({ id: member.id, name });
              if (users.length >= limit) break;
            }
            cursor = page.response_metadata?.next_cursor || undefined;
          } while (cursor && users.length < limit);
          return { ok: true, users };
        } catch (error) {
          return toolError(error);
        }
      },
    },
  ];
}
