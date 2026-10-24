import {
  DEFAULT_MAIN_KEY,
  buildMattermostContext,
  classifyRunFailure,
  runFailureMessage,
  type AgentConfig,
  type ChannelConversationType,
  type FileAttachment,
  type FileOutputEvent,
  type RunAgentResult,
} from "@yoplai/shared";
import type {
  MattermostFileInfo,
  MattermostPost,
  MattermostRestClient,
} from "../client.js";
import { getMattermostContext } from "../context.js";
import { withThreadBindings } from "../thread-session-bindings.js";
import { matchesUserAllowlist } from "../utils/allowlist.js";
import { collectMattermostAttachments } from "../utils/attachments.js";
import { splitMessage } from "../utils/chunk.js";
import { StatusReaction } from "../utils/status-reaction.js";
import { TypingKeepAlive } from "../utils/typing.js";

/** Where an accepted post goes, resolved from config by the bot layer. */
export type MattermostRoute = {
  agent: AgentConfig;
  isDm: boolean;
  /** Channels: answer only when mentioned (default true). Ignored for DMs. */
  requireMention: boolean;
  /** Channels: once bound, a thread no longer needs a mention. */
  threadUnlock: boolean;
  /** Channels: only these senders (IDs or usernames); empty = everyone. */
  users?: string[];
  /** DMs: only these senders (IDs or usernames); empty = everyone. */
  allowFrom?: string[];
  acknowledgeMessages: boolean;
  attachmentsEnabled: boolean;
  allowBots: boolean | string[];
  logPrefix: string;
};

/** One `posted` event, unpacked by the bot layer. */
export type InboundPost = {
  post: MattermostPost;
  /** O, P, D or G. */
  channelType: string;
  channelDisplayName?: string;
  /** `sender_name` from the event, e.g. "@alice". */
  senderName?: string;
  /** User IDs Mattermost resolved as mentioned in the post. */
  mentions: string[];
};

export type BotIdentity = { id: string; username: string };

export type GateResult = {
  shouldReply: boolean;
  reason?: string;
  /** The post text without the bot mention. */
  text: string;
};

function propFlag(post: MattermostPost, key: string): boolean {
  const value = post.props?.[key];
  return value === true || value === "true";
}

/** Posts written by bot accounts, incoming webhooks or plugins. */
export function isBotPost(post: MattermostPost): boolean {
  return (
    propFlag(post, "from_bot") ||
    propFlag(post, "from_webhook") ||
    propFlag(post, "from_plugin")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionPattern(username: string): RegExp {
  // Mattermost usernames are [a-z0-9._-]; a mention ends at any other char.
  return new RegExp(
    `(^|[^a-z0-9._-])@${escapeRegExp(username)}(?![a-z0-9_-]|\\.[a-z0-9_-])`,
    "gi"
  );
}

export function mentionsBot(
  post: MattermostPost,
  mentions: string[],
  bot: BotIdentity
): boolean {
  if (mentions.includes(bot.id)) return true;
  return mentionPattern(bot.username).test(post.message ?? "");
}

export function stripBotMention(text: string, bot: BotIdentity): string {
  return text
    .replace(mentionPattern(bot.username), "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function senderUsername(inbound: InboundPost): string | undefined {
  return inbound.senderName?.replace(/^@/, "") || undefined;
}

/**
 * Decide whether a post runs the agent. Order:
 * 1. own posts, system posts, then other bots (unless `allowBots`);
 * 2. sender allowlist (`dm.allowFrom` or the channel's `users`);
 * 3. in channels, the mention requirement, lifted in unlocked threads. Bots
 *    must always mention, so two agents never answer each other forever;
 * 4. nothing to say (no text, no file).
 * Channel routing (unconfigured channels are ignored) happens before, in the
 * bot layer, which only calls this for a resolved route.
 */
export function processPost(
  inbound: InboundPost,
  route: MattermostRoute,
  bot: BotIdentity,
  options: { threadUnlocked?: boolean } = {}
): GateResult {
  const { post } = inbound;
  const raw = (post.message ?? "").trim();
  const fromBot = isBotPost(post);

  if (post.user_id === bot.id) {
    return { shouldReply: false, reason: "own_post", text: raw };
  }
  if (post.type) {
    return { shouldReply: false, reason: "system_post", text: raw };
  }
  if (fromBot) {
    const allowed =
      route.allowBots === true ||
      (Array.isArray(route.allowBots) &&
        route.allowBots.includes(post.user_id));
    if (!allowed)
      return { shouldReply: false, reason: "author_is_bot", text: raw };
  }

  const sender = { id: post.user_id, username: senderUsername(inbound) };
  const allowlist = route.isDm ? route.allowFrom : route.users;
  if (
    allowlist &&
    allowlist.length > 0 &&
    !matchesUserAllowlist(sender, allowlist)
  ) {
    return {
      shouldReply: false,
      reason: route.isDm ? "dm_user_not_allowed" : "user_not_allowed",
      text: raw,
    };
  }

  const mentioned = mentionsBot(post, inbound.mentions, bot);
  const text = mentioned ? stripBotMention(raw, bot) : raw;
  if (!route.isDm) {
    const mentionNeeded =
      fromBot || (route.requireMention && !options.threadUnlocked);
    if (mentionNeeded && !mentioned) {
      return { shouldReply: false, reason: "mention_required", text };
    }
  }

  const hasFiles = (post.file_ids?.length ?? 0) > 0;
  if (!text && !hasFiles) {
    return { shouldReply: false, reason: "empty_message", text };
  }
  return { shouldReply: true, text };
}

/**
 * The thread a reply goes to. In channels every exchange is threaded: on the
 * thread of the post, or under the post itself when it starts one. DMs reply
 * flat unless the user wrote in a thread.
 */
export function replyRootId(
  post: MattermostPost,
  isDm: boolean
): string | undefined {
  if (post.root_id) return post.root_id;
  return isDm ? undefined : post.id;
}

/**
 * DMs share the agent's main session, as on Discord, Slack and Telegram. In
 * channels each thread is its own session, keyed by its root post.
 */
export function sessionKeyFor(post: MattermostPost, isDm: boolean): string {
  if (isDm) return DEFAULT_MAIN_KEY;
  return `mattermost:${post.channel_id}:${post.root_id || post.id}`;
}

const RESET_COMMANDS = ["!new", "!reset"];

export function isResetCommand(text: string): boolean {
  const command = text.trim().split(/\s+/)[0]?.toLowerCase();
  return command !== undefined && RESET_COMMANDS.includes(command);
}

export type MattermostTurnDeps = {
  rest: MattermostRestClient;
  bot: BotIdentity;
  /** Display names by user ID, shared by every turn of one bot. */
  userNames: Map<string, string>;
};

async function displayName(
  deps: MattermostTurnDeps,
  userId: string
): Promise<string> {
  const cached = deps.userNames.get(userId);
  if (cached) return cached;
  try {
    const user = await deps.rest.getUser(userId);
    const name = user.username ? `@${user.username}` : userId;
    deps.userNames.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

async function post(
  deps: MattermostTurnDeps,
  channelId: string,
  rootId: string | undefined,
  message: string,
  fileIds?: string[],
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted();
  await deps.rest.createPost({
    channel_id: channelId,
    message,
    ...(rootId ? { root_id: rootId } : {}),
    ...(fileIds && fileIds.length > 0 ? { file_ids: fileIds } : {}),
  }, signal);
}

/** Post a reply as one or more posts, all in the same thread. */
export async function postReply(
  deps: MattermostTurnDeps,
  channelId: string,
  rootId: string | undefined,
  text: string,
  signal?: AbortSignal
): Promise<number> {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await post(deps, channelId, rootId, chunk, undefined, signal);
  }
  return chunks.length;
}

/**
 * Resolve the session of a channel thread: reuse its binding while the session
 * exists, otherwise open the thread's session and (re)bind it.
 */
async function resolveThreadSession(
  agentId: string,
  channelId: string,
  rootId: string,
  sessionKey: string
): Promise<{ sessionId: string; owner: string | null }> {
  const ctx = getMattermostContext();
  const binding = withThreadBindings(ctx.getDataDir(), (store) =>
    store.getBinding(rootId, agentId)
  );
  const owner = binding?.owner ?? null;
  if (binding && (await ctx.hasSession(agentId, binding.sessionId, owner ?? undefined))) {
    return { sessionId: binding.sessionId, owner };
  }
  if (binding) await ctx.clearSessionEntry(agentId, sessionKey, owner ?? undefined);
  const entry = await ctx.ensureSession(agentId, sessionKey, owner ?? undefined);
  withThreadBindings(ctx.getDataDir(), (store) =>
    store.setBinding({
      channelId,
      rootId,
      agentId,
      sessionId: entry.sessionId,
      owner,
      source: binding?.source ?? "inbound",
    })
  );
  return { sessionId: entry.sessionId, owner };
}

async function handleReset(
  inbound: InboundPost,
  route: MattermostRoute,
  deps: MattermostTurnDeps
): Promise<void> {
  const ctx = getMattermostContext();
  const { post: p } = inbound;
  const rootId = replyRootId(p, route.isDm);
  try {
    const binding = route.isDm ? undefined : withThreadBindings(ctx.getDataDir(), (store) =>
      store.getBinding(p.root_id || p.id, route.agent.id)
    );
    const sessionKey = sessionKeyFor(p, route.isDm);
    if (binding) {
      const userId = binding.owner ?? undefined;
      await ctx.resetSession(route.agent.id, binding.sessionId, userId);
      const entry = await ctx.ensureSession(route.agent.id, sessionKey, userId);
      withThreadBindings(ctx.getDataDir(), (store) =>
        store.setBinding({ ...binding, sessionId: entry.sessionId })
      );
    } else {
      const cleared = await ctx.clearSessionEntry(route.agent.id, sessionKey);
      if (cleared) {
        ctx.deleteSession(route.agent.id, cleared.sessionId);
        await ctx.invalidateHistoryCache(route.agent.id, cleared.sessionId);
      }
    }
  } catch (err) {
    console.error(`${route.logPrefix} Session reset failed:`, err);
    await post(
      deps,
      p.channel_id,
      rootId,
      "Sorry, I couldn't start a new session. Please try again."
    );
    return;
  }
  await post(
    deps,
    p.channel_id,
    rootId,
    "Context cleared, new session started."
  );
}

async function buildContext(
  inbound: InboundPost,
  route: MattermostRoute,
  deps: MattermostTurnDeps
) {
  const { post: p } = inbound;
  const sender = inbound.senderName || (await displayName(deps, p.user_id));
  const conversationType: ChannelConversationType = route.isDm
    ? "direct_message"
    : inbound.channelType === "G"
      ? "group_direct_message"
      : p.root_id
        ? "thread_reply"
        : "channel_message";

  let channelName = inbound.channelDisplayName;
  let channelTopic: string | undefined;
  if (!route.isDm) {
    try {
      const channel = await deps.rest.getChannel(p.channel_id);
      channelName = channel.display_name || channel.name || channelName;
      channelTopic = channel.header || channel.purpose || undefined;
    } catch {
      // Context only.
    }
  }

  let threadStarter:
    | { author: string; content: string; timestamp: number }
    | undefined;
  if (p.root_id) {
    try {
      const root = await deps.rest.getPost(p.root_id);
      threadStarter = {
        author: await displayName(deps, root.user_id),
        content: root.message,
        timestamp: root.create_at,
      };
    } catch {
      // Context only.
    }
  }

  const place = route.isDm
    ? `direct message / ${sender}`
    : p.root_id
      ? `#${channelName ?? p.channel_id} / thread ${p.root_id}`
      : `#${channelName ?? p.channel_id}`;

  return buildMattermostContext({
    metadata: {
      channel: "mattermost",
      place,
      conversationType,
      sender,
      conversationId: p.root_id || p.id,
    },
    channelName: route.isDm ? undefined : channelName,
    channelTopic,
    threadStarter,
  });
}

function postFiles(p: MattermostPost): MattermostFileInfo[] {
  const infos = p.metadata?.files ?? [];
  if (infos.length > 0) return infos;
  // Older servers may send only IDs; names are then unknown.
  return (p.file_ids ?? []).map((id) => ({ id, name: id }));
}

/**
 * Run one agent turn for an accepted post and deliver the answer in the post's
 * thread: 👀 then ✅/❌ on the post, "typing" while the agent works, files the
 * agent produces uploaded to the same thread.
 */
export async function handleMattermostPost(
  inbound: InboundPost,
  route: MattermostRoute,
  deps: MattermostTurnDeps,
  text: string
): Promise<void> {
  const ctx = getMattermostContext();
  const { post: p } = inbound;
  const agent = route.agent;
  const language = agent.language ?? "en";

  if (isResetCommand(text) && (p.file_ids?.length ?? 0) === 0) {
    await handleReset(inbound, route, deps);
    return;
  }

  const rootId = replyRootId(p, route.isDm);
  const sessionKey = sessionKeyFor(p, route.isDm);
  const status = route.acknowledgeMessages
    ? new StatusReaction(deps.rest, deps.bot.id, p.id)
    : null;
  const typing = new TypingKeepAlive(() =>
    deps.rest.sendTyping(deps.bot.id, p.channel_id, rootId)
  );

  const fail = async (
    err: unknown,
    kind?: Parameters<typeof runFailureMessage>[0]
  ) => {
    typing.stop();
    try {
      await post(
        deps,
        p.channel_id,
        rootId,
        runFailureMessage(kind ?? classifyRunFailure(err), language)
      );
    } catch (sendErr) {
      console.error(`${route.logPrefix} Error reply failed:`, sendErr);
    }
    await status?.finish("failed");
  };

  void status?.start();
  void typing.start();

  let sessionId: string | undefined;
  let sessionOwnerId: string | null = null;
  let context;
  let attachments: FileAttachment[] = [];
  try {
    if (!route.isDm) {
      const session = await resolveThreadSession(
        agent.id,
        p.channel_id,
        p.root_id || p.id,
        sessionKey
      );
      sessionId = session.sessionId;
      sessionOwnerId = session.owner;
    }
    context = await buildContext(inbound, route, deps);

    const files = route.attachmentsEnabled ? postFiles(p) : [];
    if (files.length > 0 && ctx.saveMediaFile) {
      const collected = await collectMattermostAttachments(
        files,
        deps.rest,
        (data, mimeType, filename) =>
          ctx.saveMediaFile!(data, mimeType, filename)
      );
      attachments = collected.attachments;
      for (const error of collected.errors) {
        await post(deps, p.channel_id, rootId, error).catch(() => {});
      }
    }
  } catch (err) {
    console.error(`${route.logPrefix} Error:`, err);
    await fail(err);
    return;
  }

  if (!text && attachments.length === 0) {
    typing.stop();
    await status?.clear();
    return;
  }

  // Files the agent writes for the user arrive as events during the run.
  const uploads: Promise<void>[] = [];
  const uploadFile = (event: FileOutputEvent) => {
    uploads.push(
      (async () => {
        try {
          if (!ctx.readMediaFile)
            throw new Error("Media download is not available");
          const media = await ctx.readMediaFile(event.fileId);
          const info = await deps.rest.uploadFile(
            p.channel_id,
            media.data,
            media.filename || event.filename,
            media.mimeType || event.mimeType
          );
          await post(deps, p.channel_id, rootId, "", [info.id]);
        } catch (err) {
          const reason = err instanceof Error ? err.message : "Upload failed";
          await post(
            deps,
            p.channel_id,
            rootId,
            `Could not upload ${event.filename} to Mattermost: ${reason}`
          ).catch(() => {});
        }
      })()
    );
  };

  let failureKind: Parameters<typeof runFailureMessage>[0] | undefined;
  const deliver = async (result: RunAgentResult) => {
    let posted = 0;
    if (!result.meta.silent && !result.meta.aborted) {
      for (const payload of result.payloads) {
        if (payload.text)
          posted += await postReply(deps, p.channel_id, rootId, payload.text);
      }
    }
    await Promise.all(uploads);
    typing.stop();
    await status?.finish("done");
    return posted;
  };

  try {
    const result = await ctx.runAgent({
      agentId: agent.id,
      message: text,
      attachments: attachments.length > 0 ? attachments : undefined,
      sessionKey,
      ...(sessionId ? { sessionId } : {}),
      sessionOwnerId,
      background: Boolean(sessionId),
      source: "mattermost",
      context,
      requesterId: `mattermost:${p.user_id}`,
      ...(isBotPost(p)
        ? {
            sender: {
              kind: "agent" as const,
              agentId: `mattermost:${p.user_id}`,
            },
          }
        : {}),
      onEvent: (event) => {
        if (event.type === "file_output") uploadFile(event);
        if (event.type === "error")
          failureKind = event.kind ?? classifyRunFailure(event.message);
      },
      // A post sent while the session is busy is queued behind the running
      // turn; its own answer comes back here once that turn has finished.
      onDeferredResult: async (outcome) => {
        if ("error" in outcome) {
          await fail(outcome.error, failureKind);
          return;
        }
        await deliver(outcome.result);
      },
    });

    if (result.meta.queued) {
      // Keep 👀 and typing off until the deferred answer arrives.
      typing.stop();
      await status?.clear();
      return;
    }
    await deliver(result);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      typing.stop();
      await status?.clear();
      return;
    }
    console.error(`${route.logPrefix} Error:`, err);
    await fail(err, failureKind);
  }
}
