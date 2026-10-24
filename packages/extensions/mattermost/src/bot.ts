import type {
  AgentConfig,
  MattermostAgentConfig,
  MattermostComponentConfig,
} from "@yoplai/shared";
import {
  MattermostRestClient,
  type FetchLike,
  type MattermostPost,
} from "./client.js";
import { getMattermostContext } from "./context.js";
import {
  handleMattermostPost,
  processPost,
  type BotIdentity,
  type InboundPost,
  type MattermostRoute,
  type MattermostTurnDeps,
} from "./handlers/message.js";
import { withThreadBindings } from "./thread-session-bindings.js";
import { RecentIds } from "./utils/dedupe.js";
import {
  MattermostSocket,
  type MattermostSocketEvent,
  type SocketFactory,
} from "./websocket.js";

export type MattermostBot = {
  /** "mattermost" for the shared bot, the agent ID for a per-agent bot. */
  agentId: string;
  rest: MattermostRestClient;
  /** Known once started. */
  identity: () => BotIdentity | undefined;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** Feed one WebSocket event (exposed for tests). */
  handleEvent: (event: MattermostSocketEvent) => Promise<void>;
};

type RouteSettings = Pick<
  MattermostRoute,
  "acknowledgeMessages" | "attachmentsEnabled" | "allowBots"
>;

/** Resolves the route of a post, or null when the bot must ignore it. */
type RouteResolver = (
  post: MattermostPost,
  channelType: string
) => MattermostRoute | null;

export type CreateBotOptions = {
  fetch?: FetchLike;
  createSocket?: SocketFactory;
  /** Longest gap re-read over REST after a reconnect without resume. */
  maxCatchUpMs?: number;
};

const DEFAULT_MAX_CATCH_UP_MS = 10 * 60 * 1000;

function settingsFrom(
  config: Pick<
    MattermostComponentConfig,
    "acknowledgeMessages" | "attachmentsEnabled" | "allowBots"
  >
): RouteSettings {
  return {
    acknowledgeMessages: config.acknowledgeMessages !== false,
    attachmentsEnabled: config.attachmentsEnabled !== false,
    allowBots: config.allowBots ?? false,
  };
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** Unpack a `posted` event; anything else (or a malformed one) gives null. */
export function toInboundPost(
  event: MattermostSocketEvent
): InboundPost | null {
  if (event.event !== "posted" || !event.data) return null;
  const post = parseJson<MattermostPost>(event.data.post);
  if (!post?.id || !post.channel_id) return null;
  return {
    post,
    channelType: String(event.data.channel_type ?? ""),
    channelDisplayName:
      typeof event.data.channel_display_name === "string"
        ? event.data.channel_display_name
        : undefined,
    senderName:
      typeof event.data.sender_name === "string"
        ? event.data.sender_name
        : undefined,
    mentions: parseJson<string[]>(event.data.mentions) ?? [],
  };
}

function createBot(params: {
  id: string;
  url: string;
  token: string;
  resolveRoute: RouteResolver;
  /** Channels re-read after a gap: the configured ones plus DMs seen. */
  watchedChannels: () => string[];
  options?: CreateBotOptions;
}): MattermostBot {
  const logPrefix = `[mattermost:${params.id}]`;
  const rest = new MattermostRestClient(
    params.url,
    params.token,
    params.options?.fetch
  );
  const seen = new RecentIds();
  const dmChannels = new Set<string>();
  const userNames = new Map<string, string>();
  let identity: BotIdentity | undefined;
  let socket: MattermostSocket | undefined;

  // A bound thread needs no mention when threadUnlock is on, or when the agent
  // started it (mattermost.create_thread): replies there are meant for it.
  const threadUnlocked = (
    route: MattermostRoute,
    post: MattermostPost
  ): boolean => {
    if (route.isDm || !post.root_id) return false;
    const binding = withThreadBindings(
      getMattermostContext().getDataDir(),
      (store) => store.getBinding(post.root_id!, route.agent.id)
    );
    if (!binding) return false;
    return route.threadUnlock || binding.source === "agent";
  };

  const handleInbound = async (inbound: InboundPost): Promise<void> => {
    if (!identity) return;
    const { post } = inbound;
    if (post.user_id === identity.id) return;

    const route = params.resolveRoute(post, inbound.channelType);
    if (!route) return;
    if (route.isDm) dmChannels.add(post.channel_id);

    if (!inbound.senderName) {
      const cached = userNames.get(post.user_id);
      if (cached?.startsWith("@")) {
        inbound.senderName = cached;
      } else {
        try {
          const user = await rest.getUser(post.user_id);
          if (user.username) {
            inbound.senderName = `@${user.username}`;
            userNames.set(post.user_id, inbound.senderName);
          }
        } catch {
          console.debug(`${route.logPrefix} Could not resolve sender username`);
        }
      }
    }

    const gate = processPost(inbound, route, identity, {
      threadUnlocked: threadUnlocked(route, post),
    });
    if (!gate.shouldReply) {
      if (gate.reason !== "author_is_bot" && gate.reason !== "own_post") {
        console.debug(`${route.logPrefix} Ignored: ${gate.reason}`);
      }
      return;
    }
    if (!seen.claim(post.id)) return;
    const deps: MattermostTurnDeps = { rest, bot: identity, userNames };
    await handleMattermostPost(inbound, route, deps, gate.text);
  };

  const handleEvent = async (event: MattermostSocketEvent): Promise<void> => {
    const inbound = toInboundPost(event);
    if (!inbound) return;
    await handleInbound(inbound);
  };

  /**
   * After a reconnect the server could not resume, re-read the watched
   * channels since the drop. Posts already handled are skipped by `seen`; the
   * window is capped so a long outage does not answer stale questions.
   */
  const catchUp = async (disconnectedAt: number): Promise<void> => {
    const maxCatchUp = params.options?.maxCatchUpMs ?? DEFAULT_MAX_CATCH_UP_MS;
    // A few seconds of overlap: posts are deduplicated anyway.
    const since = Math.max(disconnectedAt - 5_000, Date.now() - maxCatchUp);
    const channels = new Set([...params.watchedChannels(), ...dmChannels]);
    for (const channelId of channels) {
      let posts: MattermostPost[];
      try {
        posts = await rest.getChannelPostsSince(channelId, since);
      } catch (err) {
        console.warn(
          `${logPrefix} Catch-up skipped for channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      for (const post of posts) {
        if (post.delete_at || post.create_at < since) continue;
        const channelType = dmChannels.has(channelId) ? "D" : "O";
        await handleInbound({ post, channelType, mentions: [] }).catch((err) =>
          console.error(`${logPrefix} Catch-up post failed:`, err)
        );
      }
    }
  };

  return {
    agentId: params.id,
    rest,
    identity: () => identity,
    handleEvent,
    start: async () => {
      const me = await rest.getMe();
      identity = { id: me.id, username: me.username };
      socket = new MattermostSocket({
        baseUrl: rest.baseUrl,
        token: params.token,
        logPrefix,
        createSocket: params.options?.createSocket,
        // Each post runs on its own; the socket loop never waits for a turn.
        onEvent: (event) => {
          void handleEvent(event).catch((err) =>
            console.error(`${logPrefix} Post handling failed:`, err)
          );
        },
        onReconnect: ({ resumed, disconnectedAt }) => {
          if (resumed) return;
          void catchUp(disconnectedAt).catch((err) =>
            console.error(`${logPrefix} Catch-up failed:`, err)
          );
        },
      });
      await socket.start();
      console.log(`${logPrefix} Connected as @${me.username}`);
    },
    stop: async () => {
      socket?.stop();
      socket = undefined;
    },
  };
}

/** One bot shared by several agents: each configured channel names its agent. */
export function createMattermostBot(
  agents: AgentConfig[],
  config: MattermostComponentConfig,
  options?: CreateBotOptions
): MattermostBot | null {
  if (!config.token || !config.url) return null;
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const settings = settingsFrom(config);

  const resolveRoute: RouteResolver = (post, channelType) => {
    if (channelType === "D") {
      if (config.dm?.enabled === false || !config.dm?.agent) return null;
      const agent = agentsById.get(config.dm.agent);
      if (!agent) return null;
      return {
        agent,
        isDm: true,
        requireMention: false,
        threadUnlock: false,
        allowFrom: config.dm.allowFrom,
        ...settings,
        logPrefix: `[mattermost:${agent.id}]`,
      };
    }
    const channel = config.channels?.[post.channel_id];
    if (!channel) return null;
    const agent = agentsById.get(channel.agent);
    if (!agent) return null;
    return {
      agent,
      isDm: false,
      requireMention: channel.requireMention ?? true,
      threadUnlock: channel.threadUnlock === true,
      users: channel.users,
      ...settings,
      logPrefix: `[mattermost:${agent.id}]`,
    };
  };

  return createBot({
    id: "mattermost",
    url: config.url,
    token: config.token,
    resolveRoute,
    watchedChannels: () => Object.keys(config.channels ?? {}),
    options,
  });
}

/** A bot account dedicated to one agent (`mattermost:` block in agent.yaml). */
export function createMattermostAgentBot(
  agent: AgentConfig,
  options?: CreateBotOptions
): MattermostBot | null {
  const config = agent.mattermost as MattermostAgentConfig | undefined;
  if (!config?.token || !config.url) return null;
  const settings = settingsFrom(config);

  const resolveRoute: RouteResolver = (post, channelType) => {
    if (channelType === "D") {
      // A per-agent bot answers DMs only when `dm` is configured.
      if (!config.dm || config.dm.enabled === false) return null;
      return {
        agent,
        isDm: true,
        requireMention: false,
        threadUnlock: false,
        allowFrom: config.dm.allowFrom,
        ...settings,
        logPrefix: `[mattermost:${agent.id}]`,
      };
    }
    const channel = config.channels?.[post.channel_id];
    if (!channel) return null;
    return {
      agent,
      isDm: false,
      requireMention: channel.requireMention ?? true,
      threadUnlock: channel.threadUnlock === true,
      users: channel.users,
      ...settings,
      logPrefix: `[mattermost:${agent.id}]`,
    };
  };

  return createBot({
    id: agent.id,
    url: config.url,
    token: config.token,
    resolveRoute,
    watchedChannels: () => Object.keys(config.channels ?? {}),
    options,
  });
}
