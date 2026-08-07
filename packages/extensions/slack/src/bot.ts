import { App, SocketModeReceiver } from "@slack/bolt";
import type {
  AgentConfig,
  FileAttachment,
  FileOutputEvent,
  SlackAgentConfig,
  SlackComponentChannelConfig,
  SlackComponentConfig,
  SlackComponentDmConfig,
} from "@yoplai/shared";
import { DEFAULT_MAIN_KEY } from "@yoplai/shared";
import { getSlackContext } from "./context.js";
import {
  detectBangCommand,
  processMessage,
  type MessageData,
} from "./handlers/message.js";
import {
  MAX_UPLOAD_SIZE_BYTES,
  downloadSlackFile,
  extractSnippetText,
  formatSlackFileError,
  isSlackSnippet,
  isSupportedSlackFile,
  uploadSlackFileToMedia,
  type SlackFile,
} from "./utils/attachments.js";
import {
  formatReactionMessage,
  processReaction,
  type ReactionData,
} from "./handlers/reactions.js";
import {
  handleAbortCommand,
  handleHelpCommand,
  handleNewCommand,
  handlePingCommand,
  type SlackCommandData,
  type SlackCommandTarget,
  type SlackRespond,
} from "./handlers/commands.js";
import { matchesUserAllowlist } from "./utils/allowlist.js";
import { splitMessage } from "./utils/chunk.js";
import { buildSlackContext } from "./utils/context.js";
import {
  createSlackEventDeduper,
  describeSlackEventIdentity,
  type SlackEventDeduper,
  type SlackEventIdentity,
} from "./utils/dedupe.js";
import { clearHistory, getHistory, recordMessage } from "./utils/history.js";
import { markdownToMrkdwn } from "./utils/mrkdwn.js";
import { createProactiveDmNoteStore } from "./proactive-dm-notes.js";
import { createSlackThreadSessionBindingStore } from "./thread-session-bindings.js";
import {
  buildSlackHistoryKey,
  buildSlackSessionKey,
  getThreadParent,
  lookupReactionMessage,
  resolveReplyThreadTs,
} from "./utils/threads.js";
import {
  startThinkingReaction,
  stopAllThinkingReactions,
  stopThinkingReaction,
} from "./utils/typing.js";
import type { SlackWebClient } from "./types.js";

export type SlackBot = {
  app: App;
  agentId: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type SlackMessageTarget = {
  agent: AgentConfig;
  config: SlackComponentConfig;
  channelConfig?: SlackComponentChannelConfig;
  dmConfig?: SlackComponentDmConfig;
  isMainSession: boolean;
  logPrefix: string;
};

type SlackReactionTarget = {
  agent: AgentConfig;
  config: SlackComponentConfig;
  logPrefix: string;
};

type ThinkingStreamDisplay = {
  cleanup: () => Promise<void>;
  setSessionId: (sessionId: string | undefined) => void;
};

const MAX_THINKING_CHARS = 3000;
const THINKING_UPDATE_INTERVAL_MS = 3000;
const SLACK_CLIENT_PING_TIMEOUT_MS = 20_000;

function createSocketModeApp(token: string, appToken: string): App {
  return new App({
    token,
    receiver: new SocketModeReceiver({
      appToken,
      clientPingTimeout: SLACK_CLIENT_PING_TIMEOUT_MS,
    }),
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function toSlackFiles(value: unknown): SlackFile[] {
  if (!Array.isArray(value)) return [];
  const files: SlackFile[] = [];
  for (const item of value) {
    const file = asRecord(item);
    if (Object.keys(file).length === 0) continue;
    files.push({
      id: asString(file.id),
      name: asString(file.name),
      title: asString(file.title),
      mimetype: asString(file.mimetype),
      filetype: asString(file.filetype),
      size: asNumber(file.size),
      url_private_download: asString(file.url_private_download),
      subtype: asString(file.subtype),
      mode: asString(file.mode),
      preview: asString(file.preview),
    });
  }
  return files;
}

function slackTsToMs(ts: string | undefined): number {
  if (!ts) return Date.now();
  const parsed = Number(ts) * 1000;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toMessageData(raw: unknown, isAppMention = false): MessageData | null {
  const event = asRecord(raw);
  const ts = asString(event.ts);
  const channel = asString(event.channel);
  if (!ts || !channel) return null;

  return {
    ts,
    text: asString(event.text) ?? "",
    channel,
    user: asString(event.user),
    bot_id: asString(event.bot_id),
    channel_type: asString(event.channel_type),
    thread_ts: asString(event.thread_ts),
    isAppMention,
    files: toSlackFiles(event.files),
  };
}

function toSlackEventIdentity(
  body: unknown,
  data: MessageData
): SlackEventIdentity {
  const envelope = asRecord(body);
  return {
    eventId: asString(envelope.event_id),
    team: asString(envelope.team_id),
    channel: data.channel,
    ts: data.ts,
  };
}

// Claims the inbound Slack event's identity just before an agent turn is
// started. Returns false (and logs by identity only, never message text)
// when the event was already claimed — by Slack's own retry or by the
// overlapping message/app_mention listeners firing for the same action.
//
// Deliberately called only once the bot has decided it will reply: claiming a
// delivery the bot then ignores would burn the shared channel/ts key and
// silence the sibling delivery that would have answered.
function claimSlackMessageEvent(
  deduper: SlackEventDeduper,
  body: unknown,
  data: MessageData,
  logPrefix: string
): boolean {
  const identity = toSlackEventIdentity(body, data);
  if (deduper.claim(identity)) return true;
  console.debug(
    `${logPrefix} Suppressed duplicate Slack event: ${describeSlackEventIdentity(identity)}`
  );
  return false;
}

// Releases a claim taken above when handling the event failed without the
// failure ever being reported anywhere (see the release() calls in
// handleSlackMessage). This re-opens the message/app_mention overlap window
// for this event, which is acceptable: losing the message outright is worse.
function releaseSlackMessageEvent(
  deduper: SlackEventDeduper,
  body: unknown,
  data: MessageData
): void {
  deduper.release(toSlackEventIdentity(body, data));
}

function slackThreadUnlockKey(
  data: MessageData,
  includeRoot = false
): string | undefined {
  const threadTs = data.thread_ts ?? (includeRoot ? data.ts : undefined);
  return threadTs ? `${data.channel}:${threadTs}` : undefined;
}

function mentionsSlackBot(
  data: MessageData,
  botUserId: string | undefined
): boolean {
  return Boolean(
    data.isAppMention ||
    (botUserId && new RegExp(`<@${botUserId}>`).test(data.text ?? ""))
  );
}

function withoutSlackMentionRequirement(
  target: SlackMessageTarget,
  channel: string
): SlackMessageTarget {
  const channelConfig = target.config.channels?.[channel];
  const effectiveChannelConfig: SlackComponentChannelConfig = {
    ...channelConfig,
    agent: channelConfig?.agent ?? target.agent.id,
    requireMention: false,
  };

  return {
    ...target,
    config: {
      ...target.config,
      channels: {
        ...target.config.channels,
        [channel]: effectiveChannelConfig,
      },
    },
    channelConfig: effectiveChannelConfig,
  };
}

function toReactionData(raw: unknown): ReactionData | null {
  const event = asRecord(raw);
  const item = asRecord(event.item);
  const reaction = asString(event.reaction);
  const user = asString(event.user);
  if (!reaction || !user) return null;
  return {
    reaction,
    user,
    item: {
      channel: asString(item.channel),
      ts: asString(item.ts),
      thread_ts: asString(item.thread_ts),
    },
  };
}

async function getChannelMetadata(client: SlackWebClient, channel: string) {
  try {
    const result = await client.conversations.info({ channel });
    return {
      name: result.channel?.name,
      topic: result.channel?.topic?.value,
    };
  } catch {
    return {};
  }
}

async function getSlackUserDisplayName(
  client: SlackWebClient,
  userId: string | undefined
): Promise<string | undefined> {
  if (!userId || !client.users?.info) return undefined;
  try {
    const result = await client.users.info({ user: userId });
    const profile = result.user?.profile;
    return (
      profile?.display_name?.trim() ||
      profile?.real_name?.trim() ||
      result.user?.real_name?.trim() ||
      result.user?.name?.trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

function resolveSlackConversationType(
  data: MessageData
): "direct_message" | "channel_message" | "thread_reply" {
  if (data.channel_type === "im") return "direct_message";
  if (data.thread_ts && data.thread_ts !== data.ts) return "thread_reply";
  return "channel_message";
}

function slackToolTargetsThread(
  event: unknown,
  channel: string,
  threadTs: string | undefined
): boolean {
  if (!event || typeof event !== "object") return false;
  const candidate = event as Record<string, unknown>;
  if (candidate.type !== "tool_call") return false;
  if (
    candidate.name !== "slack.send_message" &&
    candidate.name !== "slack_send_message"
  ) {
    return false;
  }
  const input =
    candidate.arguments && typeof candidate.arguments === "object"
      ? (candidate.arguments as Record<string, unknown>)
      : candidate.args && typeof candidate.args === "object"
        ? (candidate.args as Record<string, unknown>)
        : undefined;
  return input?.channel === channel && input.threadTs === threadTs;
}

async function sendSlackReply(
  client: SlackWebClient,
  channel: string,
  payloads: Array<{ text?: string }>,
  threadTs?: string
): Promise<void> {
  for (const payload of payloads) {
    if (!payload.text) continue;
    const text = markdownToMrkdwn(payload.text);
    for (const chunk of splitMessage(text)) {
      await client.chat.postMessage({
        channel,
        text: chunk,
        mrkdwn: true,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });
    }
  }
}

function getSlackErrorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes("Container idle timed out")) {
    return "Request timed out while I was still working. Please retry, or narrow the request if it is broad.";
  }
  if (message.includes("Container exceeded max runtime")) {
    return "Request ran too long and was stopped. Please retry with a narrower request.";
  }
  return "Sorry, I encountered an error processing your message.";
}

async function sendSlackError(
  client: SlackWebClient,
  channel: string,
  threadTs: string | undefined,
  err: unknown
): Promise<void> {
  await client.chat.postMessage({
    channel,
    text: getSlackErrorText(err),
    mrkdwn: true,
    thread_ts: threadTs,
  });
}

async function sendSlackFileError(
  client: SlackWebClient,
  channel: string,
  threadTs: string | undefined,
  text: string
): Promise<void> {
  await client.chat.postMessage({
    channel,
    text,
    mrkdwn: true,
    thread_ts: threadTs,
    unfurl_links: false,
    unfurl_media: false,
  });
}

async function collectSlackAttachments(params: {
  data: MessageData;
  client: SlackWebClient;
  botToken: string;
  threadTs?: string;
}): Promise<{ contentSuffix: string; attachments: FileAttachment[] }> {
  const { data, client, botToken, threadTs } = params;
  const files = data.files ?? [];
  if (files.length === 0) return { contentSuffix: "", attachments: [] };

  const saveMediaFile = getSlackContext().saveMediaFile;
  if (!saveMediaFile) {
    throw new Error(
      "Media upload is not available in the Slack extension context"
    );
  }

  const snippets: string[] = [];
  const attachments: FileAttachment[] = [];

  for (const file of files) {
    if (isSlackSnippet(file)) {
      const snippet = extractSnippetText(file);
      if (snippet) snippets.push(snippet);
      continue;
    }

    if (file.size && file.size > MAX_UPLOAD_SIZE_BYTES) {
      await sendSlackFileError(
        client,
        data.channel,
        threadTs,
        formatSlackFileError(file, "File exceeds the 25MB upload limit")
      );
      continue;
    }

    if (!isSupportedSlackFile(file)) {
      await sendSlackFileError(
        client,
        data.channel,
        threadTs,
        formatSlackFileError(
          file,
          `Unsupported file type ${file.mimetype ?? file.filetype ?? "unknown"}`
        )
      );
      continue;
    }

    try {
      const downloaded = await downloadSlackFile(file, botToken);
      attachments.push(await uploadSlackFileToMedia(downloaded, saveMediaFile));
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Download failed";
      await sendSlackFileError(
        client,
        data.channel,
        threadTs,
        formatSlackFileError(file, reason)
      );
    }
  }

  return {
    contentSuffix: snippets.join("\n\n"),
    attachments,
  };
}

function withContentSuffix(content: string, suffix: string): string {
  const trimmed = content.trim();
  if (!suffix) return trimmed;
  return trimmed ? `${trimmed}\n\n${suffix}` : suffix;
}

async function uploadSlackFileOutput(params: {
  client: SlackWebClient;
  channel: string;
  threadTs?: string;
  event: FileOutputEvent;
}): Promise<void> {
  const { client, channel, threadTs, event } = params;
  try {
    const readMediaFile = getSlackContext().readMediaFile;
    if (!readMediaFile) {
      throw new Error(
        "Media download is not available in the Slack extension context"
      );
    }
    if (!client.files?.uploadV2) {
      throw new Error("Slack file upload API is not available");
    }
    const media = await readMediaFile(event.fileId);
    await client.files.uploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: media.data,
      filename: media.filename || event.filename,
      title: media.filename || event.filename,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Upload failed";
    await sendSlackFileError(
      client,
      channel,
      threadTs,
      `Could not upload ${event.filename} to Slack: ${reason}`
    );
  }
}

function formatThinkingMessage(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const truncated =
    trimmed.length > MAX_THINKING_CHARS
      ? trimmed.slice(0, MAX_THINKING_CHARS) + "…"
      : trimmed;
  // Break into lines after sentences (.) and dashes (-)
  const formatted = truncated.replace(/\.\s+/g, ".\n").replace(/ - /g, "\n- ");
  return `🧠 Thinking:\n${formatted}`;
}

function startThinkingStreamDisplay(params: {
  client: SlackWebClient;
  channel: string;
  threadTs: string;
  agentId: string;
  sessionKey: string;
  deleteOnComplete: boolean;
  logPrefix: string;
}): ThinkingStreamDisplay {
  const {
    client,
    channel,
    threadTs,
    agentId,
    sessionKey,
    deleteOnComplete,
    logPrefix,
  } = params;
  let messageTs: string | undefined;
  let matchedSessionId: string | undefined;
  let closed = false;
  let unsubscribe: () => void = () => {};
  let posting = false;
  let pendingPost: Promise<void> | null = null;
  let latestText: string | undefined;
  let lastUpdateTime = 0;
  let throttleTimer: ReturnType<typeof setTimeout> | null = null;
  let accumulatedThinking = "";

  const setSessionId = (sessionId: string | undefined) => {
    if (!sessionId) return;
    matchedSessionId = sessionId;
  };

  const matchesRun = (event: {
    agentId: string;
    sessionId: string;
    sessionKey?: string;
  }) => {
    if (event.agentId !== agentId) return false;
    if (matchedSessionId) return event.sessionId === matchedSessionId;
    if (event.sessionKey !== sessionKey) return false;
    matchedSessionId = event.sessionId;
    return true;
  };

  const doUpdate = async (text: string) => {
    if (!messageTs || closed) return;
    try {
      await client.chat.update({ channel, ts: messageTs, text, mrkdwn: true });
      lastUpdateTime = Date.now();
    } catch (err) {
      console.debug(`${logPrefix} Thinking message update failed:`, err);
    }
  };

  const publishThinking = async (text: string) => {
    latestText = text;

    // First message: post it immediately
    if (!messageTs && !posting) {
      posting = true;
      pendingPost = (async () => {
        try {
          const result = await client.chat.postMessage({
            channel,
            text,
            mrkdwn: true,
            thread_ts: threadTs,
            unfurl_links: false,
            unfurl_media: false,
          });
          messageTs = result.ts;
          lastUpdateTime = Date.now();
        } catch (err) {
          console.debug(`${logPrefix} Thinking message post failed:`, err);
        } finally {
          posting = false;
          pendingPost = null;
        }
      })();
      await pendingPost;
      return;
    }

    // Still posting the first message — just buffer
    if (posting) return;

    // Throttle updates: if enough time has passed, update now
    const elapsed = Date.now() - lastUpdateTime;
    if (elapsed >= THINKING_UPDATE_INTERVAL_MS) {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      await doUpdate(text);
    } else if (!throttleTimer) {
      // Schedule a trailing update
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (!closed && latestText && messageTs) {
          doUpdate(latestText);
        }
      }, THINKING_UPDATE_INTERVAL_MS - elapsed);
    }
  };

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    await pendingPost;
    if (!deleteOnComplete || !messageTs) return;
    try {
      await client.chat.delete({ channel, ts: messageTs });
    } catch (err) {
      console.debug(`${logPrefix} Thinking message cleanup failed:`, err);
    }
  };

  unsubscribe = getSlackContext().subscribe("agent.stream", async (payload) => {
    const event = payload as {
      type: "thinking" | "done" | "error";
      data?: string;
      agentId: string;
      sessionId: string;
      sessionKey?: string;
    };
    if (!matchesRun(event)) return;
    if (event.type === "thinking") {
      if (closed) return;
      accumulatedThinking += event.data ?? "";
      const text = formatThinkingMessage(accumulatedThinking);
      try {
        await publishThinking(text);
      } catch (err) {
        console.debug(`${logPrefix} Thinking message update failed:`, err);
      }
      return;
    }
    if (event.type === "done" || event.type === "error") {
      await cleanup();
    }
  });

  return { cleanup, setSessionId };
}

async function handleBangCommand(
  data: MessageData,
  client: SlackWebClient,
  target: SlackMessageTarget,
  bang: { command: "new" | "stop"; arg?: string }
): Promise<boolean> {
  if (!data.user) return false;

  const sessionKey = target.isMainSession
    ? DEFAULT_MAIN_KEY
    : buildSlackSessionKey(data.channel, data.thread_ts);
  const effectiveSessionKey = bang.arg || sessionKey;

  if (bang.command === "new") {
    try {
      const ctx = getSlackContext();
      const cleared = await ctx.clearSessionEntry(
        target.agent.id,
        effectiveSessionKey
      );
      if (cleared) {
        ctx.deleteSession(target.agent.id, cleared.sessionId);
        await ctx.invalidateHistoryCache(target.agent.id, cleared.sessionId);
      }
      await client.chat.postEphemeral({
        channel: data.channel,
        user: data.user,
        text: "Context cleared, new session started.",
        mrkdwn: true,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : "Unknown error";
      await client.chat.postEphemeral({
        channel: data.channel,
        user: data.user,
        text: `Error: ${text}`,
        mrkdwn: true,
      });
    }
    return true;
  }

  if (bang.command === "stop") {
    try {
      const agentResult = await getSlackContext().runAgent({
        agentId: target.agent.id,
        message: "/stop",
        sessionKey: effectiveSessionKey,
        source: "slack",
        slackDelivery: {
          channel: data.channel,
          threadTs: data.thread_ts,
          eventId: data.ts,
        },
      });
      await client.chat.postEphemeral({
        channel: data.channel,
        user: data.user,
        text: agentResult.payloads[0]?.text ?? "Abort requested.",
        mrkdwn: true,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : "Unknown error";
      await client.chat.postEphemeral({
        channel: data.channel,
        user: data.user,
        text: `Error: ${text}`,
        mrkdwn: true,
      });
    }
    return true;
  }

  return false;
}

async function handleSlackMessage(
  data: MessageData,
  client: SlackWebClient,
  target: SlackMessageTarget,
  botUserId: string | undefined,
  // Returns false when this delivery duplicates one already being acted on.
  claimEvent: () => boolean = () => true,
  // Drops the claim taken via claimEvent above. Only called on a genuine
  // unhandled failure (see the two call sites below), never when an error
  // was already caught and reported to the user.
  releaseEvent: () => void = () => {}
): Promise<void> {
  // Detect bang commands on raw text before any normalization/mention gating.
  // Bang commands bypass mention requirements — they're slash-command alternatives.
  const rawBang = detectBangCommand(data.text?.trim() ?? "");
  if (rawBang && (data.bot_id || (botUserId && data.user === botUserId))) {
    return; // never process bot's own messages
  }
  // Claim at most once per delivery: a bang command that falls through to
  // normal handling must not be rejected by its own earlier claim.
  let claimResult: boolean | undefined;
  const claimOnce = (): boolean => (claimResult ??= claimEvent());
  // Drops the claim taken above, if any, and resets the memo so this same
  // call cannot short-circuit back to a claim that no longer exists.
  const releaseClaim = (): void => {
    if (!claimResult) return;
    releaseEvent();
    claimResult = undefined;
  };
  if (rawBang) {
    if (!claimOnce()) return;
    try {
      const handled = await handleBangCommand(data, client, target, rawBang);
      if (handled) return;
    } catch (err) {
      // handleBangCommand already catches and reports its own errors via
      // postEphemeral; reaching here means even that report failed, so
      // nothing was communicated. Release so Slack's retry is processed.
      releaseClaim();
      throw err;
    }
  }

  let boundSessionId: string | undefined;
  if (data.thread_ts && data.thread_ts !== data.ts) {
    try {
      const store = createSlackThreadSessionBindingStore(
        getSlackContext().getDataDir()
      );
      try {
        boundSessionId = store.getBinding(
          data.channel,
          data.thread_ts,
          target.agent.id
        )?.sessionId;
      } finally {
        store.close();
      }
    } catch (err) {
      console.debug(`${target.logPrefix} Thread binding lookup failed:`, err);
    }
  }

  const result = processMessage(
    data,
    boundSessionId
      ? withoutSlackMentionRequirement(target, data.channel).config
      : target.config,
    botUserId
  );
  const historyLimit = target.config.historyLimit ?? 20;

  if (!result.shouldReply) {
    if (result.reason && result.reason !== "author_is_bot") {
      console.debug(`${target.logPrefix} Ignored: ${result.reason}`);
    }
    return;
  }

  if (!claimOnce()) return;

  const sessionKey = target.isMainSession
    ? DEFAULT_MAIN_KEY
    : buildSlackSessionKey(data.channel, data.thread_ts);
  const historyKey = buildSlackHistoryKey(data.channel, data.thread_ts);
  const defaultReplyThreadTs = resolveReplyThreadTs(
    target.channelConfig?.threadPolicy ?? target.dmConfig?.threadPolicy,
    data.ts,
    data.thread_ts
  );
  let replyThreadTs = boundSessionId ? data.thread_ts : defaultReplyThreadTs;
  const fileThreadTs = data.thread_ts ?? data.ts;

  let thinkingDisplay: ThinkingStreamDisplay | null = null;
  try {
    const { contentSuffix, attachments } = await collectSlackAttachments({
      data,
      client,
      botToken: target.config.token ?? "",
      threadTs: fileThreadTs,
    });
    const content = withContentSuffix(result.normalizedContent, contentSuffix);
    if (!content && attachments.length === 0) return;

    // Also detect bang commands on normalized content (after mention stripping).
    // This handles "@bot !new" where the raw text starts with a mention, not !.
    const normalizedBang = rawBang ? undefined : detectBangCommand(content);
    if (normalizedBang && attachments.length === 0) {
      const handled = await handleBangCommand(
        data,
        client,
        target,
        normalizedBang
      );
      if (handled) return;
    }

    await startThinkingReaction(
      client,
      data.channel,
      data.ts,
      target.agent.id,
      {
        sessionKey,
      }
    );
    thinkingDisplay = target.config.showThinking
      ? startThinkingStreamDisplay({
          client,
          channel: data.channel,
          threadTs: replyThreadTs ?? data.ts,
          agentId: target.agent.id,
          sessionKey,
          deleteOnComplete: target.config.deleteThinkingOnComplete !== false,
          logPrefix: target.logPrefix,
        })
      : null;

    const [channelMeta, threadParent, senderName] = await Promise.all([
      getChannelMetadata(client, data.channel),
      getThreadParent(client, data.channel, data.thread_ts, data.ts),
      getSlackUserDisplayName(client, data.user),
    ]);
    const sender = senderName ?? data.user ?? "unknown";
    recordMessage(
      historyKey,
      {
        author: sender,
        content: data.text ?? "",
        timestamp: slackTsToMs(data.ts),
      },
      50,
      data.ts
    );
    const conversationType = resolveSlackConversationType(data);
    const proactiveDmNotes =
      target.isMainSession &&
      conversationType === "direct_message" &&
      (!data.thread_ts || data.thread_ts === data.ts)
        ? takeProactiveDmNotes(target.agent.id, data.user, data.channel)
        : [];
    const channelName = channelMeta.name;
    const placeChannel = `#${channelName ?? data.channel}`;
    const threadName =
      conversationType === "thread_reply"
        ? `thread:${data.thread_ts ?? data.ts}`
        : undefined;
    const place =
      conversationType === "direct_message"
        ? `direct message / ${sender}`
        : conversationType === "thread_reply"
          ? `${placeChannel} / ${threadName}`
          : placeChannel;
    const context = buildSlackContext({
      metadata: {
        channel: "slack",
        place,
        conversationType,
        sender,
      },
      channelName,
      channelTopic: channelMeta.topic,
      threadName,
      threadParent: threadParent ?? undefined,
      proactiveDmNotes: proactiveDmNotes.map((note) => note.text),
      history: getHistory(historyKey, historyLimit),
    });

    const fileUploads: Promise<void>[] = [];
    let slackToolPostedToThread = false;
    const slackToolCallsToThread = new Set<string>();
    const runAgent = (sessionId?: string) =>
      getSlackContext().runAgent({
        agentId: target.agent.id,
        message: content,
        attachments,
        ...(sessionId ? { sessionId } : {}),
        sessionKey,
        source: "slack",
        slackDelivery: {
          channel: data.channel,
          threadTs: data.thread_ts,
          eventId: data.ts,
        },
        background: Boolean(sessionId),
        context,
        onEvent: (event) => {
          if (
            event.type === "tool_call" &&
            slackToolTargetsThread(event, data.channel, replyThreadTs)
          ) {
            slackToolCallsToThread.add(event.id);
          }
          if (
            event.type === "tool_result" &&
            !event.isError &&
            slackToolCallsToThread.has(event.id)
          ) {
            slackToolPostedToThread = true;
          }
          if (event.type !== "file_output") return;
          fileUploads.push(
            uploadSlackFileOutput({
              client,
              channel: data.channel,
              threadTs: fileThreadTs,
              event,
            })
          );
        },
      });
    let agentResult;
    try {
      agentResult = await runAgent(boundSessionId);
    } catch (err) {
      if (!boundSessionId) throw err;
      console.debug(
        `${target.logPrefix} Bound session unavailable; falling back:`,
        err
      );
      replyThreadTs = defaultReplyThreadTs;
      agentResult = await runAgent();
    }
    thinkingDisplay?.setSessionId(agentResult.meta.sessionId);

    if (agentResult.meta.queued) {
      await thinkingDisplay?.cleanup();
      return;
    }

    if (!slackToolPostedToThread) {
      await sendSlackReply(
        client,
        data.channel,
        agentResult.payloads,
        replyThreadTs
      );
    }
    await Promise.all(fileUploads);

    if (target.config.clearHistoryAfterReply === true) {
      clearHistory(historyKey);
    }
    await thinkingDisplay?.cleanup();
    await stopThinkingReaction(client, data.channel, data.ts);
  } catch (err) {
    console.error(`${target.logPrefix} Error:`, err);
    try {
      await sendSlackError(client, data.channel, replyThreadTs, err);
      await thinkingDisplay?.cleanup();
      await stopThinkingReaction(client, data.channel, data.ts);
    } catch (reportErr) {
      // The error above couldn't even be reported to the user (e.g. Slack
      // itself is unreachable), so nothing was actually communicated.
      // Release so Slack's retry is processed instead of being suppressed
      // for the rest of the claim's TTL.
      releaseClaim();
      throw reportErr;
    }
  }
}

function takeProactiveDmNotes(
  agentId: string,
  userId: string | undefined,
  channelId: string
) {
  const store = createProactiveDmNoteStore(getSlackContext().getDataDir());
  try {
    return store.takeNotes(agentId, userId, channelId);
  } finally {
    store.close();
  }
}

async function handleSlackReaction(
  data: ReactionData,
  client: SlackWebClient,
  target: SlackReactionTarget,
  action: "add" | "remove",
  botUserId: string | undefined,
  botId: string | undefined
): Promise<void> {
  if (botUserId && data.user === botUserId) {
    console.debug(`${target.logPrefix} Reaction ignored: self_reaction`);
    return;
  }
  const channel = data.item.channel;
  const route = channel ? target.config.channels?.[channel] : undefined;
  const mode = route?.reactionNotifications ?? "off";
  let result = processReaction(data, target.config, undefined, botUserId);
  let messageInfo: Awaited<ReturnType<typeof lookupReactionMessage>>;
  if (mode === "own" && result.reason === "no_message_author") {
    messageInfo = await lookupReactionMessage(
      client,
      channel ?? "",
      data.item.ts ?? ""
    );
    result = processReaction(
      data,
      target.config,
      messageInfo?.author,
      botUserId,
      botId
    );
  }
  if (!result.shouldProcess || !result.channel || !result.messageTs) {
    if (result.reason && result.reason !== "channel_not_configured") {
      console.debug(`${target.logPrefix} Reaction ignored: ${result.reason}`);
    }
    return;
  }

  const context = buildSlackContext({
    reaction: {
      emoji: data.reaction,
      user: data.user,
      messageId: result.messageTs,
      action,
    },
  });

  try {
    if (!messageInfo && !data.item.thread_ts) {
      messageInfo = await lookupReactionMessage(
        client,
        result.channel,
        result.messageTs
      );
    }
    const reactionThreadTs = data.item.thread_ts ?? messageInfo?.threadTs;
    await getSlackContext().runAgent({
      agentId: target.agent.id,
      message: formatReactionMessage(data, action),
      sessionKey: buildSlackSessionKey(result.channel, reactionThreadTs),
      source: "slack",
      slackDelivery: {
        channel: result.channel,
        threadTs: reactionThreadTs,
        eventId: result.messageTs,
      },
      context,
    });
  } catch (err) {
    console.error(`${target.logPrefix} Reaction error:`, err);
  }
}

function setupSlackBroadcasts(params: {
  client: SlackWebClient;
  textAccumulators: Map<string, string>;
  acceptsAgent: (agentId: string) => boolean;
  getBroadcastChannel: () => string | undefined;
  logPrefix: string;
}): () => void {
  const {
    client,
    textAccumulators,
    acceptsAgent,
    getBroadcastChannel,
    logPrefix,
  } = params;

  return getSlackContext().subscribe("agent.stream", async (payload) => {
    const event = payload as {
      type: "text" | "done" | "error";
      data?: string;
      agentId: string;
      sessionId: string;
      source?: string;
    };
    if (!acceptsAgent(event.agentId)) return;
    if (event.source === "slack" || event.source === "heartbeat") return;

    const broadcastChannel = getBroadcastChannel();
    if (!broadcastChannel) return;

    const mainEntry = await getSlackContext().getSessionEntry(
      event.agentId,
      DEFAULT_MAIN_KEY
    );
    if (!mainEntry || mainEntry.sessionId !== event.sessionId) return;

    const accKey = `${event.agentId}:${event.sessionId}`;
    if (event.type === "text") {
      const current = textAccumulators.get(accKey) ?? "";
      textAccumulators.set(accKey, current + event.data);
      return;
    }
    if (event.type === "done") {
      const text = textAccumulators.get(accKey);
      textAccumulators.delete(accKey);
      if (!text) return;
      try {
        for (const chunk of splitMessage(markdownToMrkdwn(text))) {
          await client.chat.postMessage({
            channel: broadcastChannel,
            text: chunk,
            mrkdwn: true,
            unfurl_links: false,
            unfurl_media: false,
          });
        }
      } catch (err) {
        console.error(`${logPrefix} Broadcast error:`, err);
      }
      return;
    }
    if (event.type === "error") {
      textAccumulators.delete(accKey);
    }
  });
}

function resolveCommandTarget(
  componentConfig: SlackComponentConfig,
  agentsById: Map<string, AgentConfig>,
  fallbackAgent: AgentConfig | undefined,
  command: SlackCommandData
): SlackCommandTarget | null {
  const route = componentConfig.channels?.[command.channel_id];
  if (route) {
    if (
      route.users &&
      route.users.length > 0 &&
      !matchesUserAllowlist(command.user_id, route.users)
    ) {
      return null;
    }
    const agent = agentsById.get(route.agent);
    return agent
      ? {
          agent,
          config: componentConfig,
          channelConfig: route,
          isDm: false,
        }
      : null;
  }

  const isDm = command.channel_id.startsWith("D");
  if (
    isDm &&
    componentConfig.dm?.enabled !== false &&
    componentConfig.dm?.agent
  ) {
    if (
      componentConfig.dm.allowFrom &&
      componentConfig.dm.allowFrom.length > 0 &&
      !matchesUserAllowlist(command.user_id, componentConfig.dm.allowFrom)
    ) {
      return null;
    }
    const agent = agentsById.get(componentConfig.dm.agent);
    return agent ? { agent, config: componentConfig, isDm: true } : null;
  }

  if (!componentConfig.channels && fallbackAgent) {
    return {
      agent: fallbackAgent,
      config: componentConfig,
      isDm,
    };
  }

  return null;
}

export function createSlackBot(
  agents: AgentConfig[],
  componentConfig: SlackComponentConfig
): SlackBot | null {
  if (!componentConfig.token || !componentConfig.appToken) return null;

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const fallbackAgent = agents[0];
  const routedAgentIds = new Set<string>();

  for (const route of Object.values(componentConfig.channels ?? {})) {
    routedAgentIds.add(route.agent);
  }
  if (componentConfig.dm?.agent) {
    routedAgentIds.add(componentConfig.dm.agent);
  }
  if (!componentConfig.channels && fallbackAgent) {
    routedAgentIds.add(fallbackAgent.id);
  }
  if (!agents.some((agent) => routedAgentIds.has(agent.id))) {
    return null;
  }

  const app = createSocketModeApp(
    componentConfig.token,
    componentConfig.appToken
  );
  const client = app.client as unknown as SlackWebClient;
  const textAccumulators = new Map<string, string>();
  const unlockedThreadKeys = new Set<string>();
  // One claim store per bot: sibling bots in the same channel see the same
  // user message under different event_ids, so a shared store would let one
  // bot's claim suppress every other bot's copy.
  const deduper = createSlackEventDeduper();
  const logPrefix = "[slack]";
  let cleanupBroadcasts: (() => void) | null = null;
  let botUserId: string | undefined;
  let botId: string | undefined;

  const resolveMessageTarget = (
    data: MessageData
  ): SlackMessageTarget | null => {
    if (data.channel_type === "im") {
      if (!componentConfig.dm || componentConfig.dm.enabled === false)
        return null;
      if (!componentConfig.dm.agent) return null;
      const dmAgent = agentsById.get(componentConfig.dm.agent);
      if (!dmAgent) return null;
      return {
        agent: dmAgent,
        config: componentConfig,
        dmConfig: componentConfig.dm,
        isMainSession: true,
        logPrefix: `[slack:${dmAgent.id}]`,
      };
    }

    const route = componentConfig.channels?.[data.channel];
    if (route) {
      const agent = agentsById.get(route.agent);
      if (!agent) return null;
      return {
        agent,
        config: componentConfig,
        channelConfig: route,
        isMainSession: false,
        logPrefix: `[slack:${agent.id}]`,
      };
    }

    if (!componentConfig.channels && fallbackAgent) {
      return {
        agent: fallbackAgent,
        config: componentConfig,
        isMainSession: false,
        logPrefix: `[slack:${fallbackAgent.id}]`,
      };
    }

    return null;
  };

  const resolveReactionTarget = (
    data: ReactionData
  ): SlackReactionTarget | null => {
    const channel = data.item.channel;
    if (!channel) return null;
    const route = componentConfig.channels?.[channel];
    if (!route) return null;
    const agent = agentsById.get(route.agent);
    return agent
      ? { agent, config: componentConfig, logPrefix: `[slack:${agent.id}]` }
      : null;
  };

  app.message(async ({ message, client: eventClient, body }) => {
    const data = toMessageData(message);
    if (!data) return;
    const target = resolveMessageTarget(data);
    if (!target) return;
    const mentioned = mentionsSlackBot(data, botUserId);
    const unlockKey = slackThreadUnlockKey(data, mentioned);
    if (unlockKey && mentioned) {
      unlockedThreadKeys.add(unlockKey);
    }
    const threadKey = slackThreadUnlockKey(data);
    const effectiveTarget =
      threadKey && unlockedThreadKeys.has(threadKey)
        ? withoutSlackMentionRequirement(target, data.channel)
        : target;
    await handleSlackMessage(
      data,
      eventClient as unknown as SlackWebClient,
      effectiveTarget,
      botUserId,
      () => claimSlackMessageEvent(deduper, body, data, target.logPrefix),
      () => releaseSlackMessageEvent(deduper, body, data)
    );
  });

  app.event("app_mention", async ({ event, client: eventClient, body }) => {
    const data = toMessageData(event, true);
    if (!data) return;
    const target = resolveMessageTarget(data);
    if (!target) return;
    const unlockKey = slackThreadUnlockKey(data, true);
    if (unlockKey) {
      unlockedThreadKeys.add(unlockKey);
    }
    const threadKey = slackThreadUnlockKey(data);
    const effectiveTarget =
      threadKey && unlockedThreadKeys.has(threadKey)
        ? withoutSlackMentionRequirement(target, data.channel)
        : target;
    await handleSlackMessage(
      data,
      eventClient as unknown as SlackWebClient,
      effectiveTarget,
      botUserId,
      () => claimSlackMessageEvent(deduper, body, data, target.logPrefix),
      () => releaseSlackMessageEvent(deduper, body, data)
    );
  });

  app.event("reaction_added", async ({ event, client: eventClient }) => {
    const data = toReactionData(event);
    if (!data) return;
    const target = resolveReactionTarget(data);
    if (!target) return;
    await handleSlackReaction(
      data,
      eventClient as unknown as SlackWebClient,
      target,
      "add",
      botUserId,
      botId
    );
  });

  app.event("reaction_removed", async ({ event, client: eventClient }) => {
    const data = toReactionData(event);
    if (!data) return;
    const target = resolveReactionTarget(data);
    if (!target) return;
    await handleSlackReaction(
      data,
      eventClient as unknown as SlackWebClient,
      target,
      "remove",
      botUserId,
      botId
    );
  });

  const registerCommand = (
    name: "/new" | "/stop" | "/help" | "/ping",
    handler: (
      command: SlackCommandData,
      target: SlackCommandTarget,
      respond: SlackRespond
    ) => Promise<void>
  ) => {
    app.command(name, async ({ command, ack, respond }) => {
      await ack();
      const target = resolveCommandTarget(
        componentConfig,
        agentsById,
        fallbackAgent,
        {
          channel_id: command.channel_id,
          user_id: command.user_id,
          text: command.text,
        }
      );
      if (!target) {
        await respond({
          text: "No agent is configured for this Slack route.",
          response_type: "ephemeral",
        });
        return;
      }
      await handler(
        {
          channel_id: command.channel_id,
          user_id: command.user_id,
          text: command.text,
        },
        target,
        respond as SlackRespond
      );
    });
  };

  registerCommand("/new", handleNewCommand);
  registerCommand("/stop", handleAbortCommand);
  registerCommand("/help", handleHelpCommand);
  registerCommand("/ping", handlePingCommand);

  return {
    app,
    agentId: "slack",
    start: async () => {
      try {
        const auth = await client.auth?.test();
        botUserId = auth?.user_id;
        botId = auth?.bot_id;
      } catch {
        botUserId = undefined;
        botId = undefined;
      }
      await app.start();
      cleanupBroadcasts = setupSlackBroadcasts({
        client,
        textAccumulators,
        acceptsAgent: (agentId) => routedAgentIds.has(agentId),
        getBroadcastChannel: () => componentConfig.broadcastToChannel,
        logPrefix,
      });
      console.log(`${logPrefix} Started Socket Mode bot`);
    },
    stop: async () => {
      cleanupBroadcasts?.();
      cleanupBroadcasts = null;
      textAccumulators.clear();
      unlockedThreadKeys.clear();
      stopAllThinkingReactions();
      await app.stop();
    },
  };
}

export function createSlackAgentBot(agent: AgentConfig): SlackBot | null {
  if (!agent.slack?.token || !agent.slack?.appToken) return null;

  const agentSlackConfig = agent.slack as SlackAgentConfig;
  const slackConfig = agent.slack as SlackComponentConfig;
  const app = createSocketModeApp(
    agentSlackConfig.token,
    agentSlackConfig.appToken
  );
  const client = app.client as unknown as SlackWebClient;
  const textAccumulators = new Map<string, string>();
  const unlockedThreadKeys = new Set<string>();
  // One claim store per bot — see createSlackBot.
  const deduper = createSlackEventDeduper();
  const logPrefix = `[slack:${agent.id}]`;
  let cleanupBroadcasts: (() => void) | null = null;
  let botUserId: string | undefined;
  let botId: string | undefined;

  const resolveMessageTarget = (
    data: MessageData
  ): SlackMessageTarget | null => {
    if (data.channel_type === "im") {
      if (!agentSlackConfig.dm || agentSlackConfig.dm.enabled === false) {
        return null;
      }
      if (
        agentSlackConfig.dm.allowFrom &&
        agentSlackConfig.dm.allowFrom.length > 0 &&
        (!data.user ||
          !matchesUserAllowlist(data.user, agentSlackConfig.dm.allowFrom))
      ) {
        return null;
      }
      return {
        agent,
        config: slackConfig,
        dmConfig: agentSlackConfig.dm,
        isMainSession: true,
        logPrefix,
      };
    }

    const channels = agentSlackConfig.channels;
    const channelConfig = channels?.[data.channel];
    if (channels && Object.keys(channels).length > 0 && !channelConfig) {
      return null;
    }

    return {
      agent,
      config: slackConfig,
      channelConfig,
      isMainSession: false,
      logPrefix,
    };
  };

  const resolveReactionTarget = (
    data: ReactionData
  ): SlackReactionTarget | null => {
    const channel = data.item.channel;
    if (!channel) return null;

    const channels = agentSlackConfig.channels;
    if (channels && Object.keys(channels).length > 0 && !channels[channel]) {
      return null;
    }

    const reactionConfig: SlackComponentConfig = channels
      ? slackConfig
      : {
          ...slackConfig,
          channels: {
            [channel]: {
              agent: agent.id,
            },
          },
        };

    return {
      agent,
      config: reactionConfig,
      logPrefix,
    };
  };

  const resolveAgentCommandTarget = (
    command: SlackCommandData
  ): SlackCommandTarget | null => {
    const channelConfig = agentSlackConfig.channels?.[command.channel_id];
    if (channelConfig) {
      if (
        channelConfig.users &&
        channelConfig.users.length > 0 &&
        !matchesUserAllowlist(command.user_id, channelConfig.users)
      ) {
        return null;
      }
      return {
        agent,
        config: slackConfig,
        channelConfig,
        isDm: false,
      };
    }

    const isDm = command.channel_id.startsWith("D");
    if (isDm) {
      if (!agentSlackConfig.dm || agentSlackConfig.dm.enabled === false) {
        return null;
      }
      if (
        agentSlackConfig.dm.allowFrom &&
        agentSlackConfig.dm.allowFrom.length > 0 &&
        !matchesUserAllowlist(command.user_id, agentSlackConfig.dm.allowFrom)
      ) {
        return null;
      }
      return {
        agent,
        config: slackConfig,
        isDm: true,
      };
    }

    if (!agentSlackConfig.channels) {
      return {
        agent,
        config: slackConfig,
        isDm: false,
      };
    }

    return null;
  };

  app.message(async ({ message, client: eventClient, body }) => {
    const data = toMessageData(message);
    if (!data) return;
    const target = resolveMessageTarget(data);
    if (!target) return;
    const mentioned = mentionsSlackBot(data, botUserId);
    const unlockKey = slackThreadUnlockKey(data, mentioned);
    if (unlockKey && mentioned) {
      unlockedThreadKeys.add(unlockKey);
    }
    const threadKey = slackThreadUnlockKey(data);
    const effectiveTarget =
      threadKey && unlockedThreadKeys.has(threadKey)
        ? withoutSlackMentionRequirement(target, data.channel)
        : target;
    await handleSlackMessage(
      data,
      eventClient as unknown as SlackWebClient,
      effectiveTarget,
      botUserId,
      () => claimSlackMessageEvent(deduper, body, data, target.logPrefix),
      () => releaseSlackMessageEvent(deduper, body, data)
    );
  });

  app.event("app_mention", async ({ event, client: eventClient, body }) => {
    const data = toMessageData(event, true);
    if (!data) return;
    const target = resolveMessageTarget(data);
    if (!target) return;
    const unlockKey = slackThreadUnlockKey(data, true);
    if (unlockKey) {
      unlockedThreadKeys.add(unlockKey);
    }
    const threadKey = slackThreadUnlockKey(data);
    const effectiveTarget =
      threadKey && unlockedThreadKeys.has(threadKey)
        ? withoutSlackMentionRequirement(target, data.channel)
        : target;
    await handleSlackMessage(
      data,
      eventClient as unknown as SlackWebClient,
      effectiveTarget,
      botUserId,
      () => claimSlackMessageEvent(deduper, body, data, target.logPrefix),
      () => releaseSlackMessageEvent(deduper, body, data)
    );
  });

  app.event("reaction_added", async ({ event, client: eventClient }) => {
    const data = toReactionData(event);
    if (!data) return;
    const target = resolveReactionTarget(data);
    if (!target) return;
    await handleSlackReaction(
      data,
      eventClient as unknown as SlackWebClient,
      target,
      "add",
      botUserId,
      botId
    );
  });

  app.event("reaction_removed", async ({ event, client: eventClient }) => {
    const data = toReactionData(event);
    if (!data) return;
    const target = resolveReactionTarget(data);
    if (!target) return;
    await handleSlackReaction(
      data,
      eventClient as unknown as SlackWebClient,
      target,
      "remove",
      botUserId,
      botId
    );
  });

  const registerCommand = (
    name: "/new" | "/stop" | "/help" | "/ping",
    handler: (
      command: SlackCommandData,
      target: SlackCommandTarget,
      respond: SlackRespond
    ) => Promise<void>
  ) => {
    app.command(name, async ({ command, ack, respond }) => {
      await ack();
      const target = resolveAgentCommandTarget({
        channel_id: command.channel_id,
        user_id: command.user_id,
        text: command.text,
      });
      if (!target) {
        await respond({
          text: "No agent is configured for this Slack route.",
          response_type: "ephemeral",
        });
        return;
      }
      await handler(
        {
          channel_id: command.channel_id,
          user_id: command.user_id,
          text: command.text,
        },
        target,
        respond as SlackRespond
      );
    });
  };

  registerCommand("/new", handleNewCommand);
  registerCommand("/stop", handleAbortCommand);
  registerCommand("/help", handleHelpCommand);
  registerCommand("/ping", handlePingCommand);

  return {
    app,
    agentId: agent.id,
    start: async () => {
      try {
        const auth = await client.auth?.test();
        botUserId = auth?.user_id;
        botId = auth?.bot_id;
      } catch {
        botUserId = undefined;
        botId = undefined;
      }
      await app.start();
      cleanupBroadcasts = setupSlackBroadcasts({
        client,
        textAccumulators,
        acceptsAgent: (agentId) => agentId === agent.id,
        getBroadcastChannel: () => agentSlackConfig.broadcastToChannel,
        logPrefix,
      });
      console.log(`${logPrefix} Started Socket Mode bot`);
    },
    stop: async () => {
      cleanupBroadcasts?.();
      cleanupBroadcasts = null;
      textAccumulators.clear();
      unlockedThreadKeys.clear();
      stopAllThinkingReactions();
      await app.stop();
    },
  };
}
