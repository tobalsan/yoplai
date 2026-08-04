import type {
  AgentConfig,
  DeliveryDestination,
  DiscordComponentConfig,
  ExtensionAgentTool,
  GatewayConfig,
} from "@yoplai/shared";
import { z } from "zod";
import { getActiveBot } from "./bot-registry.js";
import { getDiscordContext } from "./context.js";
import { createThreadSessionBindingStore } from "./thread-session-bindings.js";
import { splitMessage } from "./utils/chunk.js";

type DiscordRestClient = {
  get(path: string): Promise<unknown>;
  post(path: string, options: { body: unknown }): Promise<unknown>;
};

type DiscordChannel = {
  id?: string;
  name?: string;
  type?: number;
  guild_id?: string;
};

type DiscordGuild = {
  id?: string;
  name?: string;
};

type DiscordUser = {
  id?: string;
  username?: string;
  global_name?: string | null;
  bot?: boolean;
};

type DiscordMember = {
  user?: DiscordUser;
  nick?: string | null;
};

type DiscordMessage = {
  id?: string;
  channel_id?: string;
};

type DiscordDmChannel = {
  id?: string;
};

type DiscordForumThread = {
  id?: string;
  message?: DiscordMessage;
};

const sendMessageSchema = z
  .object({
    channel: z.string().min(1).optional(),
    user: z.string().min(1).optional(),
    text: z.string().min(1),
  })
  .refine((input) => Boolean(input.channel) !== Boolean(input.user), {
    message: "Provide exactly one of `channel` or `user`.",
  });

const listChannelsSchema = z.object({
  guildId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const listUsersSchema = z.object({
  guildId: z.string().min(1).optional(),
  query: z.string().min(1).optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const createForumThreadSchema = z.object({
  channel_id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
});

function toolError(error: unknown) {
  return {
    ok: false as const,
    error: error instanceof Error ? error.message : String(error),
  };
}

function resolveDiscordToken(
  agent: AgentConfig,
  config: GatewayConfig
): string | undefined {
  if (agent.discord?.token) return agent.discord.token;
  const component = config.extensions?.discord as
    | DiscordComponentConfig
    | undefined;
  return component?.token;
}

function getComponentDiscord(
  config: GatewayConfig
): DiscordComponentConfig | undefined {
  return config.extensions?.discord as DiscordComponentConfig | undefined;
}

function configuredChannelIds(
  agent: AgentConfig,
  config: GatewayConfig
): string[] {
  const ids = new Set<string>();
  if (agent.discord?.channelId) ids.add(agent.discord.channelId);
  if (agent.discord?.broadcastToChannel)
    ids.add(agent.discord.broadcastToChannel);
  for (const guild of Object.values(agent.discord?.guilds ?? {})) {
    for (const channelId of Object.keys(guild.channels ?? {})) {
      ids.add(channelId);
    }
  }

  const component = getComponentDiscord(config);
  let hasComponentRoute = false;
  for (const [channelId, route] of Object.entries(component?.channels ?? {})) {
    if (route.agent !== agent.id) continue;
    ids.add(channelId);
    hasComponentRoute = true;
  }
  if (component?.dm?.agent === agent.id) {
    hasComponentRoute = true;
  }
  if (hasComponentRoute && component?.broadcastToChannel) {
    ids.add(component.broadcastToChannel);
  }

  return [...ids];
}

function configuredGuildIds(
  agent: AgentConfig,
  config: GatewayConfig
): string[] {
  const ids = new Set<string>();
  if (agent.discord?.guildId) ids.add(agent.discord.guildId);
  for (const guildId of Object.keys(agent.discord?.guilds ?? {})) {
    ids.add(guildId);
  }

  const component = getComponentDiscord(config);
  for (const guildId of Object.keys(component?.guilds ?? {})) {
    ids.add(guildId);
  }
  return [...ids];
}

const clientCache = new Map<string, DiscordRestClient>();

type ResolvedDiscordClient = {
  rest: DiscordRestClient;
  source: "agent" | "component";
};

async function parseDiscordError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; code?: number };
    if (data.message) {
      return `Discord API error ${res.status}: ${data.message}`;
    }
  } catch {
    // Fall back to status text below.
  }
  return `Discord API error ${res.status}: ${res.statusText}`;
}

function createTokenRestClient(token: string): DiscordRestClient {
  const request = async (
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<unknown> => {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(await parseDiscordError(res));
    }
    if (res.status === 204) return undefined;
    return res.json();
  };

  return {
    get(path) {
      return request("GET", path);
    },
    post(path, options) {
      return request("POST", path, options.body);
    },
  };
}

function resolveDiscordClient(
  agent: AgentConfig,
  config: GatewayConfig
): ResolvedDiscordClient | undefined {
  const agentBot = getActiveBot(agent.id);
  if (agentBot) {
    return {
      rest: agentBot.client.rest as DiscordRestClient,
      source: "agent",
    };
  }

  const componentBot = getActiveBot("discord");
  if (componentBot) {
    return {
      rest: componentBot.client.rest as DiscordRestClient,
      source: "component",
    };
  }

  const token = resolveDiscordToken(agent, config);
  if (!token) return undefined;

  let client = clientCache.get(token);
  if (!client) {
    client = createTokenRestClient(token);
    clientCache.set(token, client);
  }
  return {
    rest: client,
    source: agent.discord?.token ? "agent" : "component",
  };
}

export function clearDiscordClientCache(): void {
  clientCache.clear();
}

function isMessageChannel(type: number | undefined): boolean {
  return type === 0 || type === 5 || type === 10 || type === 11 || type === 12;
}

async function listGuilds(
  client: DiscordRestClient,
  agent: AgentConfig,
  config: GatewayConfig,
  guildId?: string
): Promise<DiscordGuild[]> {
  if (guildId) return [{ id: guildId }];
  const configured = configuredGuildIds(agent, config);
  if (configured.length > 0) {
    return configured.map((id) => ({ id }));
  }
  const guilds = (await client.get("/users/@me/guilds")) as DiscordGuild[];
  return guilds.filter((guild) => guild.id);
}

function withQuery(
  path: string,
  params: Record<string, string | number>
): string {
  const query = new URLSearchParams(
    Object.entries(params).map(([key, value]) => [key, String(value)])
  );
  return `${path}?${query.toString()}`;
}

async function sendToChannel(
  client: DiscordRestClient,
  channelId: string,
  text: string
): Promise<{ channelId: string; messageId?: string }> {
  let firstMessageId: string | undefined;
  for (const chunk of splitMessage(text, 2000)) {
    const message = (await client.post(`/channels/${channelId}/messages`, {
      body: { content: chunk },
    })) as DiscordMessage;
    firstMessageId ??= message.id;
  }
  return { channelId, messageId: firstMessageId };
}

async function resolveSendChannelId(
  client: DiscordRestClient,
  destination: DeliveryDestination
): Promise<string> {
  if (destination.channel) return destination.channel;
  const dm = (await client.post("/users/@me/channels", {
    body: { recipient_id: destination.user },
  })) as DiscordDmChannel;
  if (!dm.id) {
    throw new Error("Discord did not return a DM channel ID.");
  }
  return dm.id;
}

async function sendDiscordMessage(
  client: DiscordRestClient,
  destination: DeliveryDestination,
  text: string
): Promise<{ channelId: string; messageId?: string }> {
  const channelId = await resolveSendChannelId(client, destination);
  return sendToChannel(client, channelId, text);
}

/**
 * Runtime delivery path used by the scheduler's `deliver` fan-out (never an
 * LLM tool call). Shares `resolveDiscordClient` / `sendDiscordMessage` with
 * `discord.send_message` but throws on failure instead of returning
 * `{ ok: false }` — the scheduler turns a thrown sink into a recorded
 * warning on the run.
 */
export async function sendDiscordDelivery(
  agent: AgentConfig,
  config: GatewayConfig,
  destination: DeliveryDestination,
  text: string
): Promise<void> {
  const resolved = resolveDiscordClient(agent, config);
  if (!resolved) {
    throw new Error("No Discord token is configured for this agent.");
  }
  if (resolved.source === "component") {
    // The shared component bot can reach every routed channel, so the same
    // per-agent routing check the tool applies has to gate delivery too —
    // otherwise a `deliver` target bypasses it.
    const error = validateComponentSendTarget(agent, config, {
      channel: destination.channel,
      user: destination.user,
      text,
    });
    if (error) throw new Error(error);
  }
  await sendDiscordMessage(resolved.rest, destination, text);
}

async function createForumThread(
  client: DiscordRestClient,
  channelId: string,
  title: string,
  body: string
): Promise<{ threadId: string; messageId: string }> {
  const thread = (await client.post(`/channels/${channelId}/threads`, {
    body: {
      name: title,
      message: {
        content: body,
      },
    },
  })) as DiscordForumThread;
  if (!thread.id) {
    throw new Error("Discord did not return a thread ID.");
  }
  const messageId = thread.message?.id;
  if (!messageId) {
    throw new Error("Discord did not return a forum starter message ID.");
  }
  return { threadId: thread.id, messageId };
}

function displayUser(member: DiscordMember): string | undefined {
  return (
    member.nick?.trim() ||
    member.user?.global_name?.trim() ||
    member.user?.username?.trim()
  );
}

function validateComponentSendTarget(
  agent: AgentConfig,
  config: GatewayConfig,
  input: z.infer<typeof sendMessageSchema>
): string | undefined {
  const component = getComponentDiscord(config);
  if (!component) return undefined;

  if (input.user) {
    if (component.dm?.enabled !== false && component.dm?.agent === agent.id) {
      return undefined;
    }
    return "Discord direct messaging is not configured for this agent.";
  }

  if (!input.channel) return undefined;
  const route = component.channels?.[input.channel];
  if (route) {
    return route.agent === agent.id
      ? undefined
      : "Discord channel is routed to a different agent.";
  }
  if (configuredChannelIds(agent, config).includes(input.channel)) {
    return undefined;
  }
  return "Discord channel is not configured for this agent.";
}

function validateComponentChannelTarget(
  agent: AgentConfig,
  config: GatewayConfig,
  channelId: string
): string | undefined {
  const component = getComponentDiscord(config);
  if (!component) return undefined;
  const route = component.channels?.[channelId];
  if (route) {
    return route.agent === agent.id
      ? undefined
      : "Discord channel is routed to a different agent.";
  }
  if (configuredChannelIds(agent, config).includes(channelId)) {
    return undefined;
  }
  return "Discord channel is not configured for this agent.";
}

export function discordAgentTools(): ExtensionAgentTool[] {
  return [
    {
      name: "discord.create_forum_thread",
      description:
        "Create a new Discord forum thread in a forum channel and bind it to the current agent session. Provide channel_id as the forum channel ID, title as the thread title, and body as the starter post content.",
      parameters: {
        type: "object",
        properties: {
          channel_id: {
            type: "string",
            description:
              "Discord forum channel ID where the thread is created.",
          },
          title: {
            type: "string",
            description: "Thread title.",
          },
          body: {
            type: "string",
            description: "Starter post body. Discord markdown is sent as-is.",
          },
        },
        required: ["channel_id", "title", "body"],
        additionalProperties: false,
      },
      async execute(args, { agent, config, sessionId }) {
        const input = createForumThreadSchema.parse(args);
        if (!sessionId) {
          throw new Error("No active session ID is available for binding.");
        }
        const resolved = resolveDiscordClient(agent, config);
        if (!resolved) {
          throw new Error("No Discord token is configured for this agent.");
        }
        if (resolved.source === "component") {
          const error = validateComponentChannelTarget(
            agent,
            config,
            input.channel_id
          );
          if (error) {
            throw new Error(error);
          }
        }
        const result = await createForumThread(
          resolved.rest,
          input.channel_id,
          input.title,
          input.body
        );
        const store = createThreadSessionBindingStore(
          getDiscordContext().getDataDir()
        );
        try {
          store.setBinding({
            threadId: result.threadId,
            sessionId,
            agentId: agent.id,
            channelId: input.channel_id,
          });
        } finally {
          store.close();
        }
        return {
          thread_id: result.threadId,
          message_id: result.messageId,
        };
      },
    },
    {
      name: "discord.send_message",
      description:
        "Proactively send a Discord message to a channel/DM channel or to a user. Provide `channel` as a channel ID, thread ID, or DM channel ID. Provide `user` to open a DM and message that user. Use discord.list_channels / discord.list_users to look up IDs.",
      parameters: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description:
              "Discord channel, thread, or DM channel ID to send to. Mutually exclusive with user.",
          },
          user: {
            type: "string",
            description:
              "Discord user ID to DM. Mutually exclusive with channel.",
          },
          text: {
            type: "string",
            description: "Message body. Discord markdown is sent as-is.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      async execute(args, { agent, config }) {
        try {
          const input = sendMessageSchema.parse(args);
          const resolved = resolveDiscordClient(agent, config);
          if (!resolved) {
            return {
              ok: false,
              error: "No Discord token is configured for this agent.",
            };
          }
          if (resolved.source === "component") {
            const error = validateComponentSendTarget(agent, config, input);
            if (error) {
              return { ok: false, error };
            }
          }
          const result = await sendDiscordMessage(
            resolved.rest,
            { channel: input.channel, user: input.user },
            input.text
          );
          return {
            ok: true,
            channel: result.channelId,
            messageId: result.messageId,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "discord.list_channels",
      description:
        "List Discord text channels and threads the bot can see, returning IDs, names, and guild IDs. Optionally filter by a name substring or a single guild ID.",
      parameters: {
        type: "object",
        properties: {
          guildId: {
            type: "string",
            description:
              "Optional Discord guild/server ID to list channels for.",
          },
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
      async execute(args, { agent, config }) {
        try {
          const input = listChannelsSchema.parse(args);
          const resolved = resolveDiscordClient(agent, config);
          if (!resolved) {
            return {
              ok: false,
              error: "No Discord token is configured for this agent.",
            };
          }
          const client = resolved.rest;
          const limit = input.limit ?? 100;
          const query = input.query?.toLowerCase();
          const channels: Array<{
            id: string;
            name: string;
            guildId?: string;
            type?: number;
          }> = [];

          const seen = new Set<string>();
          const configuredIds = input.guildId
            ? []
            : configuredChannelIds(agent, config);
          if (configuredIds.length > 0) {
            for (const channelId of configuredIds) {
              const channel = (await client.get(
                `/channels/${channelId}`
              )) as DiscordChannel;
              if (
                !channel.id ||
                !channel.name ||
                !isMessageChannel(channel.type) ||
                seen.has(channel.id)
              ) {
                continue;
              }
              if (query && !channel.name.toLowerCase().includes(query))
                continue;
              seen.add(channel.id);
              channels.push({
                id: channel.id,
                name: channel.name,
                guildId: channel.guild_id,
                type: channel.type,
              });
              if (channels.length >= limit) break;
            }
          }

          const configuredGuilds = configuredGuildIds(agent, config);
          const guilds =
            input.guildId ||
            configuredGuilds.length > 0 ||
            configuredIds.length === 0
              ? await listGuilds(client, agent, config, input.guildId)
              : [];

          for (const guild of guilds) {
            if (!guild.id) continue;
            const page = (await client.get(
              `/guilds/${guild.id}/channels`
            )) as DiscordChannel[];
            for (const channel of page) {
              if (
                !channel.id ||
                !channel.name ||
                !isMessageChannel(channel.type) ||
                seen.has(channel.id)
              ) {
                continue;
              }
              if (query && !channel.name.toLowerCase().includes(query))
                continue;
              seen.add(channel.id);
              channels.push({
                id: channel.id,
                name: channel.name,
                guildId: channel.guild_id ?? guild.id,
                type: channel.type,
              });
              if (channels.length >= limit) break;
            }
            if (channels.length >= limit) break;
          }

          return { ok: true, channels };
        } catch (error) {
          return toolError(error);
        }
      },
    },
    {
      name: "discord.list_users",
      description:
        "List Discord guild members the bot can see, returning user IDs and display names for direct messaging. Optionally filter by name or a single guild ID.",
      parameters: {
        type: "object",
        properties: {
          guildId: {
            type: "string",
            description: "Optional Discord guild/server ID to list users for.",
          },
          query: {
            type: "string",
            description:
              "Case-insensitive substring to match nickname, global name, or username.",
          },
          limit: {
            type: "number",
            description: "Maximum users to return (default 100, max 200).",
          },
        },
        additionalProperties: false,
      },
      async execute(args, { agent, config }) {
        try {
          const input = listUsersSchema.parse(args);
          const resolved = resolveDiscordClient(agent, config);
          if (!resolved) {
            return {
              ok: false,
              error: "No Discord token is configured for this agent.",
            };
          }
          const client = resolved.rest;
          const limit = input.limit ?? 100;
          const query = input.query?.toLowerCase();
          const users: Array<{ id: string; name: string; guildId?: string }> =
            [];
          const seen = new Set<string>();

          const guilds =
            input.guildId !== undefined ||
            configuredGuildIds(agent, config).length > 0
              ? await listGuilds(client, agent, config, input.guildId)
              : await (async () => {
                  const guildIds = new Set<string>();
                  for (const channelId of configuredChannelIds(agent, config)) {
                    const channel = (await client.get(
                      `/channels/${channelId}`
                    )) as DiscordChannel;
                    if (channel.guild_id) guildIds.add(channel.guild_id);
                  }
                  if (guildIds.size > 0) {
                    return [...guildIds].map((id) => ({ id }));
                  }
                  return listGuilds(client, agent, config, input.guildId);
                })();

          for (const guild of guilds) {
            if (!guild.id) continue;
            let after = "0";
            do {
              const members = (await client.get(
                withQuery(`/guilds/${guild.id}/members`, {
                  limit: 1000,
                  after,
                })
              )) as DiscordMember[];
              for (const member of members) {
                const id = member.user?.id;
                const name = displayUser(member);
                if (!id || !name || member.user?.bot || seen.has(id)) continue;
                if (query && !name.toLowerCase().includes(query)) continue;
                seen.add(id);
                users.push({ id, name, guildId: guild.id });
                if (users.length >= limit) break;
              }
              const lastId = members.at(-1)?.user?.id;
              after = lastId ?? "";
              if (users.length >= limit) break;
              if (members.length < 1000) break;
            } while (after);
            if (users.length >= limit) break;
          }

          return { ok: true, users };
        } catch (error) {
          return toolError(error);
        }
      },
    },
  ];
}
