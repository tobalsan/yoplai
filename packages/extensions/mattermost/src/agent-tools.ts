import type {
  AgentConfig,
  DeliveryDestination,
  DeliverySink,
  ExtensionAgentTool,
  ExtensionContext,
  GatewayConfig,
  MattermostAgentConfig,
  MattermostComponentConfig,
} from "@yoplai/shared";
import { z } from "zod";
import type { MattermostBot } from "./bot.js";
import { getActiveBot } from "./bot-registry.js";
import { getMattermostContextIfInitialized } from "./context.js";
import { postReply } from "./handlers/message.js";
import { withThreadBindings } from "./thread-session-bindings.js";
import { splitMessage } from "./utils/chunk.js";

const sendMessageSchema = z
  .object({
    channel: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    text: z.string().min(1),
    rootId: z.string().min(1).optional(),
  })
  .refine((input) => Boolean(input.channel) !== Boolean(input.user), {
    message: "Provide exactly one of channel or user.",
  });

const createThreadSchema = z.object({
  channel: z.string().min(1),
  text: z.string().min(1),
});

type SendInput = z.infer<typeof sendMessageSchema>;

function toolError(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  };
}

type ResolvedBot = { bot: MattermostBot; source: "agent" | "component" };

/** The agent's own bot, else the shared one. Both must be running. */
function resolveBot(agent: AgentConfig): ResolvedBot {
  const own = getActiveBot(agent.id);
  if (own) return { bot: own, source: "agent" };
  const shared = getActiveBot("mattermost");
  if (shared) return { bot: shared, source: "component" };
  throw new Error("No active Mattermost bot is running for this agent.");
}

function componentConfig(
  config: GatewayConfig
): MattermostComponentConfig | undefined {
  return config.extensions?.mattermost as MattermostComponentConfig | undefined;
}

/**
 * Proactive posts obey the same allowlist as inbound ones: a channel must be
 * configured for this agent, a DM needs DMs enabled for it. Without this a
 * shared bot would let any agent post anywhere the bot account can reach.
 */
export function checkTarget(
  agent: AgentConfig,
  config: GatewayConfig,
  source: "agent" | "component",
  target: { channel?: string; user?: string }
): string | undefined {
  if (source === "agent") {
    const own = agent.mattermost as MattermostAgentConfig | undefined;
    if (target.user) {
      return own?.dm && own.dm.enabled !== false
        ? undefined
        : "Mattermost direct messages are not enabled for this agent.";
    }
    return target.channel && own?.channels?.[target.channel]
      ? undefined
      : "Mattermost channel is not configured for this agent.";
  }

  const shared = componentConfig(config);
  if (target.user) {
    return shared?.dm?.enabled !== false && shared?.dm?.agent === agent.id
      ? undefined
      : "Mattermost direct messages are not routed to this agent.";
  }
  const route = target.channel ? shared?.channels?.[target.channel] : undefined;
  if (!route) return "Mattermost channel is not configured for this agent.";
  return route.agent === agent.id
    ? undefined
    : "Mattermost channel is routed to a different agent.";
}

const MATTERMOST_ID = /^[a-z0-9]{26}$/;

async function resolveDmChannel(
  bot: MattermostBot,
  user: string,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const identity = bot.identity();
  if (!identity) throw new Error("The Mattermost bot is not connected yet.");
  const userId = MATTERMOST_ID.test(user)
    ? user
    : (await bot.rest.getUserByUsername(user, signal)).id;
  signal?.throwIfAborted();
  const channel = await bot.rest.createDirectChannel(identity.id, userId, signal);
  return channel.id;
}

/**
 * Post to a channel, a thread of it, or a user's DM. Shared by the
 * `mattermost.send_message` tool and the delivery sink; throws on failure.
 */
export async function sendMattermostMessage(
  agent: AgentConfig,
  config: GatewayConfig,
  input: SendInput,
  signal?: AbortSignal
): Promise<{ channelId: string; postId: string; rootId?: string }> {
  signal?.throwIfAborted();
  const { bot, source } = resolveBot(agent);
  const denied = checkTarget(agent, config, source, input);
  if (denied) throw new Error(denied);

  const channelId = input.user
    ? await resolveDmChannel(bot, input.user, signal)
    : input.channel!;
  if (input.rootId) {
    // A root post from another channel would move the reply out of the
    // allowlisted channel; refuse it rather than rely on the server.
    signal?.throwIfAborted();
    const root = await bot.rest.getPost(input.rootId, signal);
    if (root.channel_id !== channelId) {
      throw new Error("rootId does not belong to this channel.");
    }
  }

  let first: { id: string } | undefined;
  for (const chunk of splitMessage(input.text)) {
    signal?.throwIfAborted();
    const created = await bot.rest.createPost({
      channel_id: channelId,
      message: chunk,
      ...(input.rootId ? { root_id: input.rootId } : {}),
    }, signal);
    first ??= created;
  }
  if (!first) throw new Error("Nothing to send.");
  return {
    channelId,
    postId: first.id,
    ...(input.rootId ? { rootId: input.rootId } : {}),
  };
}

/**
 * Delivery destinations: `channel` is a channel ID, or `CHANNEL_ID:ROOT_POST_ID`
 * to reply in a thread; `user` is a user ID or username, sent as a DM.
 */
export function parseDestination(destination: DeliveryDestination): {
  channel?: string;
  user?: string;
  rootId?: string;
} {
  if (destination.channel) {
    const [channel, rootId] = destination.channel.split(":");
    return { channel, ...(rootId ? { rootId } : {}) };
  }
  if (destination.user) return { user: destination.user };
  throw new Error(
    "Mattermost delivery requires a channel or user destination."
  );
}

export function createMattermostDeliverySink(
  ctx: ExtensionContext
): DeliverySink {
  return async ({ agent, destination, text }) => {
    await sendMattermostMessage(agent, ctx.getConfig(), {
      ...parseDestination(destination),
      text,
    });
  };
}

export function mattermostAgentTools(): ExtensionAgentTool[] {
  return [
    {
      name: "mattermost.send_message",
      description:
        "Proactively post a Mattermost message to a channel, a thread, or a user's direct messages. Use only when the user, your instructions, or a scheduled job explicitly tell you to post somewhere. Never use it to answer an incoming Mattermost message: your final text answer is delivered there automatically. Only channels configured for you are allowed. Markdown is rendered by Mattermost.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description:
              "Channel ID (26 characters). Give either channel or user.",
          },
          user: {
            type: "string",
            description:
              "User ID or username, for a direct message. Give either channel or user.",
          },
          text: { type: "string", description: "Message body (Markdown)." },
          rootId: {
            type: "string",
            description: "Optional root post ID, to reply in that thread.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, signal }) {
        try {
          const input = sendMessageSchema.parse(args);
          return {
            ok: true,
            ...(await sendMattermostMessage(agent, config, input, signal)),
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "mattermost.create_thread",
      description:
        "Start a Mattermost thread in a channel configured for you and bind it to this session: replies posted in that thread continue this conversation. Returns the channel and the root post ID, usable with mattermost.send_message's rootId.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel ID (26 characters).",
          },
          text: {
            type: "string",
            description: "First post of the thread (Markdown).",
          },
        },
        required: ["channel", "text"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, sessionId, sessionOwnerId, userId, signal }) {
        try {
          signal?.throwIfAborted();
          const input = createThreadSchema.parse(args);
          if (!sessionId)
            return toolError("No active session ID is available for binding.");
          const context = getMattermostContextIfInitialized();
          if (!context)
            return toolError(
              "Mattermost context is not initialized for binding."
            );
          const { bot, source } = resolveBot(agent);
          const denied = checkTarget(agent, config, source, {
            channel: input.channel,
          });
          if (denied) return toolError(denied);
          const [head, ...rest] = splitMessage(input.text);
          const root = await bot.rest.createPost({
            channel_id: input.channel,
            message: head!,
          }, signal);
          const identity = bot.identity();
          if (rest.length > 0 && identity) {
            await postReply(
              { rest: bot.rest, bot: identity, userNames: new Map() },
              input.channel,
              root.id,
              rest.join("\n\n"),
              signal
            );
          }
          withThreadBindings(context.getDataDir(), (store) =>
            store.setBinding({
              channelId: input.channel,
              rootId: root.id,
              agentId: agent.id,
              sessionId,
              owner: sessionOwnerId === undefined ? userId ?? null : sessionOwnerId,
              source: "agent",
            })
          );
          return { ok: true, channelId: input.channel, rootId: root.id };
        } catch (error) {
          return toolError(error);
        }
      },
    },
  ];
}
