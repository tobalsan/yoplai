import type {
  AgentContext,
  ChannelContextMetadata,
  DiscordContext,
  DiscordContextBlock,
  SlackContext,
  SlackContextBlock,
  TelegramContext,
  TelegramContextBlock,
  UserContext,
  IrcContext,
} from "./types.js";

export const SLACK_FORMATTING = [
  "[FORMATTING]",
  "This conversation is in Slack. Use Slack mrkdwn syntax:",
  "- Bold: *text* (not **text**)",
  "- Italic: _text_ (not *text*)",
  "- Links: <url|text> (not [text](url))",
  "- No markdown tables; use bullet lists instead",
  "- No HTML",
  "- Code blocks: use triple backticks",
  "[END FORMATTING]",
].join("\n");

export const SLACK_REPLY_DELIVERY = [
  "[REPLY]",
  "Your final text answer is posted to this Slack conversation automatically. Do not call slack.send_message to reply here; use it only when the user or your instructions explicitly tell you to post somewhere else.",
  "[END REPLY]",
].join("\n");

function renderThreadStarter(
  starter: { author: string; content: string; timestamp: number } | undefined,
  fallback: string
): string {
  if (!starter) return fallback;
  const time = new Date(starter.timestamp).toISOString();
  const content = starter.content.trim() || "(empty)";
  return `${starter.author} at ${time} - ${content}`;
}

function renderHistory(
  history:
    | Array<{ author: string; content: string; timestamp: number }>
    | undefined
): string {
  if (!history || history.length === 0) return "- none";
  return history
    .map((message) => {
      const time = new Date(message.timestamp).toISOString();
      return `- [${time}] ${message.author}: ${message.content}`;
    })
    .join("\n");
}

function getMetadata(
  blocks: DiscordContextBlock[] | SlackContextBlock[]
): ChannelContextMetadata | undefined {
  const block = blocks.find((entry) => entry.type === "metadata");
  if (!block) return undefined;
  return {
    channel: block.channel,
    place: block.place,
    conversationType: block.conversationType,
    sender: block.sender,
    ...("conversationId" in block && block.conversationId
      ? { conversationId: block.conversationId }
      : {}),
  };
}

function getBlock<T extends DiscordContextBlock["type"] | SlackContextBlock["type"]>(
  blocks: DiscordContextBlock[] | SlackContextBlock[],
  type: T
): Extract<DiscordContextBlock | SlackContextBlock, { type: T }> | undefined {
  return blocks.find((block) => block.type === type) as
    | Extract<DiscordContextBlock | SlackContextBlock, { type: T }>
    | undefined;
}

function renderChannelContext(
  metadata: ChannelContextMetadata,
  blocks: DiscordContextBlock[] | SlackContextBlock[],
  options?: { includeSlackFormatting?: boolean }
): string {
  const channelName =
    renderBlockOrFallback(getBlock(blocks, "channel_name"), {
      direct_message: "direct message",
      group_direct_message: "group direct message",
      channel_message: "unknown channel",
      thread_reply: "unknown channel",
    }[metadata.conversationType]) ?? "unknown channel";
  const channelTopic =
    renderBlockOrFallback(getBlock(blocks, "channel_topic"), "unavailable") ??
    "unavailable";
  const threadName =
    renderBlockOrFallback(
      getBlock(blocks, "thread_name"),
      metadata.conversationType === "thread_reply" ? "unavailable" : "not a thread"
    ) ??
    "unavailable";
  const threadStarter = renderThreadStarter(
    getBlock(blocks, "thread_starter"),
    metadata.conversationType === "thread_reply" ? "unavailable" : "not a thread"
  );
  const recentHistory = renderHistory(getBlock(blocks, "history")?.messages);
  const proactiveDmNotes = getBlock(blocks, "proactive_dm_notes")?.notes;
  const unpaired = getBlock(blocks, "sender_identity")?.unpaired;

  const parts = [
    "[CHANNEL CONTEXT]",
    `channel: ${metadata.channel}`,
    `place: ${metadata.place}`,
    `conversation_type: ${metadata.conversationType}`,
    ...(metadata.conversationId
      ? [`conversation_id: ${metadata.conversationId}`]
      : []),
    `sender: ${metadata.sender}`,
    ...(unpaired ? [UNPAIRED_SENDER_NOTE] : []),
    "proactive_dm_notes:",
    proactiveDmNotes?.map((note) => `- ${note}`).join("\n") ?? "- none",
    `channel_name: ${channelName}`,
    `channel_topic: ${channelTopic}`,
    `thread_name: ${threadName}`,
    `thread_starter: ${threadStarter}`,
    "recent_history:",
    recentHistory,
    "[END CHANNEL CONTEXT]",
  ];

  if (options?.includeSlackFormatting) {
    parts.push("", SLACK_FORMATTING, "", SLACK_REPLY_DELIVERY);
  }

  return parts.join("\n");
}

const UNPAIRED_SENDER_NOTE =
  "sender_identity: unpaired — this Slack user is not linked to a Yoplai account, so tools use team credentials only (never their personal connections). If a requested tool needs credentials, call that tool first and share its single connection link, which pairs and connects together. Use slack.pair only when the user explicitly asks to pair or expects their own account/data without needing a credential connection; if team credentials are used, say the data is the team's, not theirs.";

function renderBlockOrFallback(
  block: DiscordContextBlock | SlackContextBlock | undefined,
  fallback: string
): string {
  if (!block) return fallback;
  let rendered = "";
  switch (block.type) {
    case "channel_name":
      rendered = `#${block.name}`;
      break;
    case "channel_topic":
      rendered = block.topic;
      break;
    case "thread_name":
      rendered = block.name;
      break;
    default:
      rendered = "";
      break;
  }
  return rendered || fallback;
}

export function renderDiscordContext(ctx: DiscordContext): string {
  const metadata = getMetadata(ctx.blocks);
  if (!metadata) return "";
  return renderChannelContext(metadata, ctx.blocks);
}

export function renderSlackContext(ctx: SlackContext): string {
  const metadata = getMetadata(ctx.blocks);
  if (!metadata) return "";
  return renderChannelContext(metadata, ctx.blocks, {
    includeSlackFormatting: true,
  });
}

export function renderTelegramContext(ctx: TelegramContext): string {
  const metadataBlock = ctx.blocks.find((block) => block.type === "metadata");
  if (!metadataBlock || metadataBlock.type !== "metadata") return "";
  const historyBlock = ctx.blocks.find((block) => block.type === "history");
  const history =
    historyBlock && historyBlock.type === "history"
      ? historyBlock.messages
      : undefined;
  return [
    "[CHANNEL CONTEXT]",
    `channel: ${metadataBlock.channel}`,
    `place: ${metadataBlock.place}`,
    `conversation_type: ${metadataBlock.conversationType}`,
    `sender: ${metadataBlock.sender}`,
    "recent_history:",
    renderHistory(history),
    "[END CHANNEL CONTEXT]",
  ].join("\n");
}

export function renderIrcContext(ctx: IrcContext): string {
  const metadata = ctx.blocks.find((block) => block.type === "metadata");
  if (!metadata || metadata.type !== "metadata") return "";
  const history = ctx.blocks.find((block) => block.type === "history");
  return ["[CHANNEL CONTEXT]", "channel: irc", `place: ${metadata.place}`, `conversation_type: ${metadata.conversationType}`, `sender: ${metadata.sender}`, "recent_history:", renderHistory(history && history.type === "history" ? history.messages : undefined), "[END CHANNEL CONTEXT]"].join("\n");
}

function renderUserContext(ctx: UserContext): string {
  const name = ctx.name?.trim().replace(/\s+/g, " ") || "unknown";
  return [
    "[USER CONTEXT]",
    "context: web UI",
    `name: ${name}`,
    "[END USER CONTEXT]",
  ].join("\n");
}

export function renderAgentContext(ctx: AgentContext): string {
  if (ctx.kind === "discord") return renderDiscordContext(ctx);
  if (ctx.kind === "slack") return renderSlackContext(ctx);
  if (ctx.kind === "telegram") return renderTelegramContext(ctx);
  if (ctx.kind === "irc") return renderIrcContext(ctx);
  if (ctx.kind === "web") return renderUserContext(ctx);
  return "";
}

export function buildUserContext(opts: { name?: string | null }): UserContext {
  return { kind: "web", name: opts.name ?? undefined };
}

export function buildDiscordContext(opts: {
  metadata?: ChannelContextMetadata;
  channelName?: string;
  channelTopic?: string;
  threadName?: string;
  threadStarter?: { author: string; content: string; timestamp: number };
  history?: Array<{ author: string; content: string; timestamp: number }>;
  reaction?: { emoji: string; user: string; messageId: string; action: "add" | "remove" };
}): DiscordContext {
  const blocks: DiscordContextBlock[] = [];

  if (opts.metadata) {
    blocks.push({
      type: "metadata",
      channel: "discord",
      place: opts.metadata.place,
      conversationType: opts.metadata.conversationType,
      sender: opts.metadata.sender,
    });
  }
  if (opts.channelName) {
    blocks.push({ type: "channel_name", name: opts.channelName });
  }
  if (opts.channelTopic) {
    blocks.push({ type: "channel_topic", topic: opts.channelTopic });
  }
  if (opts.threadName) {
    blocks.push({ type: "thread_name", name: opts.threadName });
  }
  if (opts.threadStarter) {
    blocks.push({ type: "thread_starter", ...opts.threadStarter });
  }
  if (opts.history && opts.history.length > 0) {
    blocks.push({ type: "history", messages: opts.history });
  }
  if (opts.reaction) {
    blocks.push({ type: "reaction", ...opts.reaction });
  }

  return { kind: "discord", blocks };
}

export function buildSlackContext(opts: {
  metadata?: ChannelContextMetadata;
  channelName?: string;
  channelTopic?: string;
  threadName?: string;
  threadParent?: { author: string; content: string; timestamp: number };
  proactiveDmNotes?: string[];
  unpairedSender?: boolean;
  history?: Array<{ author: string; content: string; timestamp: number }>;
  reaction?: { emoji: string; user: string; messageId: string; action: "add" | "remove" };
}): SlackContext {
  const blocks: SlackContextBlock[] = [];

  if (opts.metadata) {
    blocks.push({
      type: "metadata",
      channel: "slack",
      place: opts.metadata.place,
      conversationType: opts.metadata.conversationType,
      sender: opts.metadata.sender,
      ...(opts.metadata.conversationId
        ? { conversationId: opts.metadata.conversationId }
        : {}),
    });
  }
  if (opts.channelName) {
    blocks.push({ type: "channel_name", name: opts.channelName });
  }
  if (opts.channelTopic) {
    blocks.push({ type: "channel_topic", topic: opts.channelTopic });
  }
  if (opts.threadName) {
    blocks.push({ type: "thread_name", name: opts.threadName });
  }
  if (opts.threadParent) {
    blocks.push({ type: "thread_starter", ...opts.threadParent });
  }
  if (opts.proactiveDmNotes && opts.proactiveDmNotes.length > 0) {
    blocks.push({ type: "proactive_dm_notes", notes: opts.proactiveDmNotes });
  }
  if (opts.unpairedSender) {
    blocks.push({ type: "sender_identity", unpaired: true });
  }
  if (opts.history && opts.history.length > 0) {
    blocks.push({ type: "history", messages: opts.history });
  }
  if (opts.reaction) {
    blocks.push({ type: "reaction", ...opts.reaction });
  }

  return { kind: "slack", blocks };
}

export function buildTelegramContext(opts: {
  metadata?: ChannelContextMetadata;
  history?: Array<{ author: string; content: string; timestamp: number }>;
}): TelegramContext {
  const blocks: TelegramContextBlock[] = [];

  if (opts.metadata) {
    blocks.push({
      type: "metadata",
      channel: "telegram",
      place: opts.metadata.place,
      conversationType: opts.metadata.conversationType,
      sender: opts.metadata.sender,
    });
  }
  if (opts.history && opts.history.length > 0) {
    blocks.push({ type: "history", messages: opts.history });
  }

  return { kind: "telegram", blocks };
}
