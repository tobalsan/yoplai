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

const channelHistorySchema = z.object({
  channel: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
  oldest: z.string().min(1).optional(),
  latest: z.string().min(1).optional(),
  inclusive: z.boolean().optional(),
});

const threadRepliesSchema = channelHistorySchema.extend({
  threadTs: z.string().min(1),
  cursor: z.string().min(1).optional(),
});

const canvasIdSchema = z.string().transform((value, ctx) => {
  const id = value.match(/(?:^|[/-])(F[A-Z0-9]+)(?=$|[/?#])/)?.[1];
  if (!id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Expected a Slack file ID or URL.",
    });
    return z.NEVER;
  }
  return id;
});
const canvasCreateSchema = z.object({
  title: z.string().min(1).optional(),
  markdown: z.string().optional(),
  channel: z.string().min(1).optional(),
});
const canvasReadSchema = z.object({
  canvas: canvasIdSchema,
  maxChars: z.number().int().positive().default(100_000),
});
const canvasFindSectionsSchema = z
  .object({
    canvas: canvasIdSchema,
    sectionTypes: z
      .array(z.enum(["h1", "h2", "h3", "any_header"]))
      .min(1)
      .max(3)
      .optional(),
    containsText: z.string().min(1).optional(),
  })
  .refine((value) => value.sectionTypes || value.containsText, {
    message: "sectionTypes or containsText is required.",
  });
const canvasChangeSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.enum(["insert_after", "insert_before"]),
    sectionId: z.string().min(1),
    markdown: z.string().min(1),
  }),
  z.object({
    operation: z.enum(["insert_at_start", "insert_at_end"]),
    markdown: z.string().min(1),
    sectionId: z.never().optional(),
  }),
  z.object({
    operation: z.literal("replace"),
    sectionId: z.string().min(1).optional(),
    markdown: z.string().min(1),
  }),
  z.object({
    operation: z.literal("delete"),
    sectionId: z.string().min(1),
    markdown: z.never().optional(),
  }),
]);
const canvasEditSchema = z.object({
  canvas: canvasIdSchema,
  changes: z.array(canvasChangeSchema).min(1),
});
const canvasShareSchema = z
  .object({
    canvas: canvasIdSchema,
    access: z.enum(["read", "write"]),
    channels: z.array(z.string().min(1)).min(1).optional(),
    users: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((value) => value.channels || value.users, {
    message: "channels or users is required.",
  });
const canvasDeleteSchema = z.object({ canvas: canvasIdSchema });
async function listSlackFiles(
  list: NonNullable<NonNullable<SlackWebClient["files"]>["list"]>,
  types: "canvas" | "list",
  input: { channel?: string; limit: number; page?: number }
) {
  const result = await list({
    types,
    channel: input.channel,
    count: input.limit,
    page: input.page,
  });
  const page = result.paging?.page ?? input.page ?? 1;
  const hasMore = page < (result.paging?.pages ?? page);
  return {
    files: (result.files ?? []).map((file) => ({
      id: file.id,
      title: file.title,
      permalink: file.permalink,
      created: file.created,
      updated: file.updated,
    })),
    hasMore,
    ...(hasMore ? { nextPage: page + 1 } : {}),
  };
}

const canvasListSchema = z.object({
  channel: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).default(20),
  page: z.number().int().positive().optional(),
});

const listValueSchema = z.union([
  z.object({ text: z.string() }).strict(),
  z.object({ select: z.array(z.string()) }).strict(),
  z.object({ user: z.array(z.string()) }).strict(),
  z.object({ channel: z.array(z.string()) }).strict(),
  z.object({ date: z.array(z.string()) }).strict(),
  z.object({ email: z.array(z.string()) }).strict(),
  z.object({ phone: z.array(z.string()) }).strict(),
  z.object({ number: z.array(z.number()) }).strict(),
  z.object({ rating: z.array(z.number()) }).strict(),
  z.object({ checkbox: z.boolean() }).strict(),
  z.object({ link: z.array(z.string()) }).strict(),
]);
const listReadSchema = z.object({
  list: canvasIdSchema,
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().min(1).optional(),
  archived: z.boolean().optional(),
});
const listUpdateCellsSchema = z.object({
  list: canvasIdSchema,
  cells: z.array(z.object({
    rowId: z.string().min(1),
    columnId: z.string().min(1),
    value: listValueSchema,
  })).min(1).max(100),
});
const listItemCreateSchema = z.object({
  list: canvasIdSchema,
  cells: z.array(z.object({
    columnId: z.string().min(1),
    value: listValueSchema,
  })).min(1),
});
const listItemDeleteSchema = z.object({
  list: canvasIdSchema,
  rowId: z.string().min(1),
});

type ListValue = z.infer<typeof listValueSchema>;

const listValueParameters = {
  type: "object",
  properties: {
    text: { type: "string" },
    select: { type: "array", items: { type: "string" } },
    user: { type: "array", items: { type: "string" } },
    channel: { type: "array", items: { type: "string" } },
    date: { type: "array", items: { type: "string" } },
    email: { type: "array", items: { type: "string" } },
    phone: { type: "array", items: { type: "string" } },
    number: { type: "array", items: { type: "number" } },
    rating: { type: "array", items: { type: "number" } },
    checkbox: { type: "boolean" },
    link: { type: "array", items: { type: "string" } },
  },
  minProperties: 1,
  maxProperties: 1,
  additionalProperties: false,
} as const;

function toListField(columnId: string, value: ListValue) {
  if ("text" in value) {
    return {
      column_id: columnId,
      rich_text: [{
        type: "rich_text" as const,
        elements: [{
          type: "rich_text_section" as const,
          elements: [{ type: "text" as const, text: value.text }],
        }],
      }],
    };
  }
  if ("link" in value) {
    return {
      column_id: columnId,
      link: value.link.map((url) => ({
        original_url: url,
        display_as_url: true,
        display_name: url,
      })),
    };
  }
  return { column_id: columnId, ...value };
}

type SlackHistoryMessage = NonNullable<
  Awaited<ReturnType<SlackWebClient["conversations"]["history"]>>["messages"]
>[number];

function compactMessages(messages: SlackHistoryMessage[]) {
  return messages.flatMap((message) => {
    if (!message.ts) return [];
    return [
      {
        ts: message.ts,
        ...(message.user !== undefined ? { user: message.user } : {}),
        ...(message.username !== undefined
          ? { username: message.username }
          : {}),
        ...(message.bot_id !== undefined ? { botId: message.bot_id } : {}),
        ...(message.text !== undefined ? { text: message.text } : {}),
        ...(message.thread_ts !== undefined
          ? { threadTs: message.thread_ts }
          : {}),
        ...(message.reply_count !== undefined
          ? { replyCount: message.reply_count }
          : {}),
      },
    ];
  });
}

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
        "Proactively send a Slack message to a channel or user. Use only when the user, your instructions, or a scheduled job explicitly tell you to post somewhere. Never use it to answer an incoming Slack message: your final text answer is delivered there automatically. Provide `channel` as a channel ID (e.g. C0123456789) or a user ID (e.g. U0123456789) for a direct message. Use slack.list_channels / slack.list_users to look up IDs.",
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
    {
      name: "slack.get_channel_history",
      description:
        "Retrieve a channel's recent message history via conversations.history. Provide channel as a conversation ID (C..., D..., or G...); use slack.list_channels to resolve channel IDs. Messages are returned newest-first. To page backward, pass the oldest ts from the previous result as latest. threadTs and replyCount identify reply threads; use slack.get_thread_replies to read their messages.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Conversation ID (C..., D..., or G...), not a user ID.",
          },
          limit: {
            type: "number",
            description: "Maximum messages to return (default 50, max 200).",
          },
          oldest: {
            type: "string",
            description: "Optional exclusive lower-bound Slack timestamp.",
          },
          latest: {
            type: "string",
            description: "Optional exclusive upper-bound Slack timestamp.",
          },
          inclusive: {
            type: "boolean",
            description: "Include messages exactly at oldest/latest boundaries.",
          },
        },
        required: ["channel"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = channelHistorySchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client) {
            return toolError("No Slack token is configured for this agent.");
          }
          if (!client.conversations?.history) {
            return {
              ok: false,
              error: "Slack channel history is not available for this agent.",
            };
          }

          const limit = input.limit ?? 50;
          const messages: Array<{
            ts: string;
            user?: string;
            username?: string;
            botId?: string;
            text?: string;
            threadTs?: string;
            replyCount?: number;
          }> = [];
          let cursor: string | undefined;
          let hasMore = false;

          do {
            const remaining = limit - messages.length;
            const page = await client.conversations.history({
              channel: input.channel,
              latest: input.latest,
              oldest: input.oldest,
              inclusive: input.inclusive,
              cursor,
              limit: remaining,
            });
            const mapped = compactMessages(page.messages ?? []);
            const accepted = mapped.slice(0, remaining);
            messages.push(...accepted);
            const overflow = mapped.length > accepted.length;
            cursor = page.response_metadata?.next_cursor || undefined;
            hasMore = overflow || Boolean(cursor) || Boolean(page.has_more);
          } while (cursor && messages.length < limit);

          return { ok: true, channel: input.channel, messages, hasMore };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.get_thread_replies",
      description:
        "Read a Slack thread, including its parent message, via conversations.replies. Provide a conversation ID and the parent's threadTs. Messages are returned oldest-first. Pass nextCursor as cursor to read more replies until hasMore is false.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description:
              "Conversation ID (C..., D..., or G...), not a user ID.",
          },
          threadTs: {
            type: "string",
            description: "Parent message timestamp identifying the thread.",
          },
          limit: {
            type: "number",
            description: "Maximum messages per page (default 50, max 200).",
          },
          oldest: {
            type: "string",
            description: "Optional exclusive lower-bound Slack timestamp.",
          },
          latest: {
            type: "string",
            description: "Optional exclusive upper-bound Slack timestamp.",
          },
          inclusive: {
            type: "boolean",
            description:
              "Include messages exactly at oldest/latest boundaries.",
          },
          cursor: {
            type: "string",
            description:
              "nextCursor from a previous result to fetch the next page.",
          },
        },
        required: ["channel", "threadTs"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = threadRepliesSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client) {
            return toolError("No Slack token is configured for this agent.");
          }
          if (!client.conversations?.replies) {
            return toolError(
              "Slack thread replies are not available for this agent."
            );
          }

          const page = await client.conversations.replies({
            channel: input.channel,
            ts: input.threadTs,
            limit: input.limit ?? 50,
            oldest: input.oldest,
            latest: input.latest,
            inclusive: input.inclusive,
            cursor: input.cursor,
          });
          const nextCursor = page.response_metadata?.next_cursor || undefined;
          return {
            ok: true,
            channel: input.channel,
            threadTs: input.threadTs,
            messages: compactMessages(page.messages ?? []),
            nextCursor,
            hasMore: Boolean(nextCursor) || Boolean(page.has_more),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.canvas_list",
      description:
        "List Slack canvases visible to the bot (files.list types=canvas). Optionally filter by channel ID. Pass nextPage as page while hasMore is true.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel ID (C...) to list canvases shared there.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Canvases per page (default 20, max 100).",
          },
          page: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasListSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.files?.list)
            return toolError("Slack Canvas is not available for this agent.");
          const { files, ...paging } = await listSlackFiles(client.files.list, "canvas", input);
          return { ok: true, canvases: files, ...paging };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.canvas_create",
      description:
        "Create a Slack canvas. Without channel it is private to the bot; use slack.canvas_share (or pass channel) so humans can see it.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          markdown: {
            type: "string",
            description:
              "Canvas body. Standard markdown (headers, lists, checklists, tables up to 300 cells); mention users as ![](@U123), channels as ![](#C123).",
          },
          channel: {
            type: "string",
            description: "Channel ID to attach the canvas to as a tab.",
          },
        },
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasCreateSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.canvases)
            return toolError("Slack Canvas is not available for this agent.");
          const result = await client.canvases.create({
            title: input.title,
            document_content:
              input.markdown === undefined
                ? undefined
                : { type: "markdown", markdown: input.markdown },
            channel_id: input.channel,
          });
          return { ok: true, canvasId: result.canvas_id };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.canvas_read",
      description:
        "Read Slack's canvas HTML. Element ids are section ids usable with slack.canvas_edit.",
      parameters: {
        type: "object",
        properties: {
          canvas: {
            type: "string",
            description: "Canvas ID (F...) or Slack canvas URL.",
          },
          maxChars: { type: "number", default: 100000 },
        },
        required: ["canvas"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasReadSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          const token = client?.token ?? resolveSlackToken(agent, config, env);
          if (!client?.files?.info || !token)
            return toolError(
              "Slack Canvas reading is not available for this agent."
            );
          const result = await client.files.info({ file: input.canvas });
          const file = result.file;
          const url = file?.url_private_download ?? file?.url_private;
          if (!url)
            return toolError("Slack did not return a canvas download URL.");
          const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!response.ok)
            return toolError(
              `Slack canvas download failed with HTTP ${response.status}.`
            );
          const fullHtml = await response.text();
          return {
            ok: true,
            canvasId: file?.id ?? input.canvas,
            title: file?.title,
            permalink: file?.permalink,
            html: fullHtml.slice(0, input.maxChars),
            truncated: fullHtml.length > input.maxChars,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.canvas_find_sections",
      description:
        "Find Slack canvas section ids by header type or contained text.",
      parameters: {
        type: "object",
        properties: {
          canvas: { type: "string" },
          sectionTypes: {
            type: "array",
            items: { type: "string", enum: ["h1", "h2", "h3", "any_header"] },
            minItems: 1,
            maxItems: 3,
          },
          containsText: { type: "string" },
        },
        required: ["canvas"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasFindSectionsSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.canvases)
            return toolError("Slack Canvas is not available for this agent.");
          const result = await client.canvases.sections.lookup({
            canvas_id: input.canvas,
            criteria: {
              section_types: input.sectionTypes as
                | [
                    "h1" | "h2" | "h3" | "any_header",
                    ...Array<"h1" | "h2" | "h3" | "any_header">,
                  ]
                | undefined,
              contains_text: input.containsText,
            },
          });
          return {
            ok: true,
            sections: (result.sections ?? []).flatMap((section) =>
              section.id ? [{ id: section.id }] : []
            ),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.canvas_edit",
      description:
        "Edit Slack canvas content. Get section ids from slack.canvas_find_sections or slack.canvas_read. insert_after/insert_before need sectionId+markdown; insert_at_start/insert_at_end need markdown; replace needs markdown (omit sectionId to replace whole canvas); delete needs sectionId.",
      parameters: {
        type: "object",
        properties: {
          canvas: { type: "string" },
          changes: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                operation: {
                  type: "string",
                  enum: [
                    "insert_after",
                    "insert_before",
                    "insert_at_start",
                    "insert_at_end",
                    "replace",
                    "delete",
                  ],
                },
                sectionId: { type: "string" },
                markdown: { type: "string" },
              },
              required: ["operation"],
              additionalProperties: false,
            },
          },
        },
        required: ["canvas", "changes"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasEditSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.canvases)
            return toolError("Slack Canvas is not available for this agent.");
          const changes = input.changes.map((change) => ({
            operation: change.operation,
            ...(change.sectionId ? { section_id: change.sectionId } : {}),
            ...(change.markdown !== undefined
              ? {
                  document_content: {
                    type: "markdown" as const,
                    markdown: change.markdown,
                  },
                }
              : {}),
          })) as Parameters<
            NonNullable<SlackWebClient["canvases"]>["edit"]
          >[0]["changes"];
          await client.canvases.edit({ canvas_id: input.canvas, changes });
          return { ok: true, canvasId: input.canvas };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.canvas_share",
      description:
        "Grant Slack channels or users read or write access to a canvas.",
      parameters: {
        type: "object",
        properties: {
          canvas: { type: "string" },
          access: { type: "string", enum: ["read", "write"] },
          channels: { type: "array", items: { type: "string" } },
          users: { type: "array", items: { type: "string" } },
        },
        required: ["canvas", "access"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasShareSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.canvases)
            return toolError("Slack Canvas is not available for this agent.");
          await client.canvases.access.set({
            canvas_id: input.canvas,
            access_level: input.access,
            channel_ids: input.channels,
            user_ids: input.users,
          });
          return { ok: true, canvasId: input.canvas };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.canvas_delete",
      description: "Delete a Slack canvas.",
      parameters: {
        type: "object",
        properties: { canvas: { type: "string" } },
        required: ["canvas"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasDeleteSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.canvases)
            return toolError("Slack Canvas is not available for this agent.");
          await client.canvases.delete({ canvas_id: input.canvas });
          return { ok: true, canvasId: input.canvas };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.list_lists",
      description:
        "List Slack Lists visible to the bot (files.list types=list). Optionally filter by channel ID. Pass nextPage as page while hasMore is true. Use slack.list_read with the returned id.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel ID (C...) to list Slack Lists shared there.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Lists per page (default 20, max 100).",
          },
          page: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = canvasListSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.files?.list)
            return toolError("Slack Lists is not available for this agent.");
          const { files, ...paging } = await listSlackFiles(client.files.list, "list", input);
          return { ok: true, lists: files, ...paging };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.list_read",
      description:
        "Read rows from a Slack List. Columns include columnId and select choice values needed for updates; columns are unknown when the list is empty.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string", description: "List ID (F...) or Slack List URL." },
          limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
          cursor: { type: "string" },
          archived: { type: "boolean" },
        },
        required: ["list"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = listReadSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.slackLists?.items)
            return toolError("Slack Lists is not available for this agent.");
          const result = await client.slackLists.items.list({
            list_id: input.list,
            limit: input.limit,
            cursor: input.cursor,
            archived: input.archived,
          });
          const items = result.items ?? [];
          const info = items.length
            ? await client.slackLists.items.info({ list_id: input.list, id: items[0].id })
            : undefined;
          const schema = info?.list?.list_metadata?.schema ?? [];
          const names = new Map(schema.map((column) => [column.id, column.name || column.key]));
          const nextCursor = result.response_metadata?.next_cursor || undefined;
          return {
            ok: true,
            listId: input.list,
            ...(info?.list?.title ? { title: info.list.title } : {}),
            ...(info?.list?.permalink ? { permalink: info.list.permalink } : {}),
            columns: schema.map((column) => ({
              id: column.id,
              key: column.key,
              name: column.name,
              type: column.type,
              ...(column.options?.choices
                ? { choices: column.options.choices.map(({ value, label }) => ({ value, label })) }
                : {}),
            })),
            rows: items.map((item) => ({
              id: item.id,
              cells: Object.fromEntries(item.fields.map((field) => [
                names.get(field.column_id) ?? field.key ?? field.column_id,
                field.text ?? field.value,
              ])),
            })),
            ...(nextCursor ? { nextCursor } : {}),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.list_update_cells",
      description: "Update up to 100 cells in a Slack List using row and column IDs.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string" },
          cells: {
            type: "array", minItems: 1, maxItems: 100,
            items: { type: "object", properties: { rowId: { type: "string" }, columnId: { type: "string" }, value: listValueParameters }, required: ["rowId", "columnId", "value"], additionalProperties: false },
          },
        },
        required: ["list", "cells"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = listUpdateCellsSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.slackLists?.items)
            return toolError("Slack Lists is not available for this agent.");
          await client.slackLists.items.update({
            list_id: input.list,
            cells: input.cells.map((cell) => ({ row_id: cell.rowId, ...toListField(cell.columnId, cell.value) })),
          });
          return { ok: true, listId: input.list };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.list_item_create",
      description: "Create a row in a Slack List using column IDs and typed values.",
      parameters: {
        type: "object",
        properties: {
          list: { type: "string" },
          cells: { type: "array", minItems: 1, items: { type: "object", properties: { columnId: { type: "string" }, value: listValueParameters }, required: ["columnId", "value"], additionalProperties: false } },
        },
        required: ["list", "cells"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = listItemCreateSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.slackLists?.items)
            return toolError("Slack Lists is not available for this agent.");
          const result = await client.slackLists.items.create({
            list_id: input.list,
            initial_fields: input.cells.map((cell) => toListField(cell.columnId, cell.value)),
          });
          return { ok: true, listId: input.list, rowId: result.item?.id };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "slack.list_item_delete",
      description: "Delete a row from a Slack List.",
      parameters: {
        type: "object",
        properties: { list: { type: "string" }, rowId: { type: "string" } },
        required: ["list", "rowId"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, env }) {
        try {
          const input = listItemDeleteSchema.parse(args);
          const client = resolveSlackClient(agent, config, env);
          if (!client?.slackLists?.items)
            return toolError("Slack Lists is not available for this agent.");
          await client.slackLists.items.delete({ list_id: input.list, id: input.rowId });
          return { ok: true, listId: input.list, rowId: input.rowId };
        } catch (error) {
          return toolError(error);
        }
      },
    },
  ];
}
