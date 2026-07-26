import type { AgentConfig, ChannelConversationType, FileAttachment } from "@yoplai/shared";
import { DEFAULT_MAIN_KEY, buildTelegramContext } from "@yoplai/shared";
import { getTelegramContext } from "../context.js";
import {
  matchesChatAllowlist,
  matchesUserAllowlist,
  type AllowlistEntry,
} from "../utils/allowlist.js";
import { splitMessage, TELEGRAM_MAX } from "../utils/chunk.js";
import { renderMarkdown } from "../utils/render.js";
import { StreamCoalescer } from "../utils/stream.js";
import { ToolNotes } from "../utils/tool-notes.js";
import { TypingKeepAlive, type SendTyping } from "../utils/typing.js";
import type { TelegramMediaItem } from "../utils/attachments.js";

export type TelegramMessageData = {
  chatId: number;
  chatType: string;
  /** Public group/channel username, when the chat exposes one. */
  chatUsername?: string;
  /** Message text, or the caption when the message carries media. */
  text: string;
  userId?: number;
  /** Sender's Telegram @username, when set. */
  username?: string;
  senderName: string;
  isBot: boolean;
  /** Inbound media (photos/documents) attached to the message. */
  media?: TelegramMediaItem[];
  /**
   * Whether the bot was addressed in a group chat: an @mention of the bot, a
   * reply to one of the bot's own messages, or a command. Always treated as
   * true for private chats by the bot layer. Drives the group-chat gate so the
   * bot joins the conversation only when spoken to, never hijacking every
   * message.
   */
  isAddressed?: boolean;
};

/**
 * Allowlist configuration for the bot, mirroring the discord/slack allow-list
 * shape. Both lists gate access independently: the sender must match
 * `allowedUsers` and the chat must match `allowedChats`.
 */
export type TelegramAllowlistConfig = {
  allowedUsers?: AllowlistEntry[];
  allowedChats?: AllowlistEntry[];
};

/**
 * Per-turn behavior options resolved from config. `showToolCalls` opts the chat
 * into seeing concise one-line notes about the agent's tool calls/actions as the
 * turn progresses (auditability). OFF by default so the chat only sees the
 * agent's reply; operators enable it per chat/config without code changes.
 */
export type TelegramTurnOptions = {
  showToolCalls?: boolean;
};

export type TelegramReplyTarget = {
  agent: AgentConfig;
  logPrefix: string;
};

export type TelegramSendOptions = {
  /** Render with this Telegram parse mode. */
  parseMode?: "HTML";
  /** Thread this message as a reply to the given message id. */
  replyToMessageId?: number;
};

/**
 * Send one rendered chunk. Returns the id of the message Telegram created so the
 * next chunk can thread as a reply to it (visual grouping for overflow).
 */
export type TelegramSend = (
  text: string,
  options?: TelegramSendOptions
) => Promise<number | undefined>;

/**
 * Edit a previously sent message in place. Live streaming previews are plain
 * text (no parse mode), so callers omit `parseMode`. Best-effort: a failed edit
 * (e.g. "message is not modified" or a transient API error) must not abort the
 * turn, since the final clean render is sent regardless.
 */
export type TelegramEdit = (
  messageId: number,
  text: string,
  options?: TelegramSendOptions
) => Promise<void>;

export type TelegramHandlerHooks = {
  /** Best-effort sender for Telegram's "typing" chat action. */
  sendTyping?: SendTyping;
  /**
   * Edit a previously sent message in place, used to progressively grow the
   * live streaming preview. When omitted, streaming previews are disabled and
   * the handler falls back to sending only the final rendered reply.
   */
  editMessage?: TelegramEdit;
  /**
   * Download and persist inbound media, returning the resulting attachments to
   * hand to the agent. Invoked only when the message carries media. Implemented
   * by the bot layer, which owns the grammY context needed to fetch files.
   */
  collectAttachments?: (
    media: TelegramMediaItem[]
  ) => Promise<FileAttachment[]>;
};

export type TelegramPipelineResult = {
  shouldReply: boolean;
  reason?: string;
};

/** A private (1:1) chat is the only Telegram chat type treated as a DM. */
function isDirectMessage(chatType: string): boolean {
  return chatType === "private";
}

/**
 * Control commands the bot handles itself instead of forwarding to the agent.
 * `/new` (and its `/reset` alias) start a fresh session. These mirror the
 * gateway's reset triggers, but we intercept them here so Telegram gets an
 * immediate confirmation — matching the Slack/Discord experience — rather than
 * forwarding an empty post-reset message to the agent (which surfaces as the
 * confusing "Sorry, I encountered an error processing your message.").
 */
const RESET_COMMANDS = ["/new", "/reset"];

/**
 * Resolve the session key for a chat: DMs use the agent's main session
 * (isolated per user, matching discord/slack DM handling); group chats use a
 * shared per-chat key so the whole channel shares one conversation.
 */
function resolveSessionKey(data: TelegramMessageData): string {
  return isDirectMessage(data.chatType)
    ? DEFAULT_MAIN_KEY
    : `telegram:${data.chatId}`;
}

/**
 * Detect a reset control command. Telegram appends `@botname` to commands sent
 * in groups (e.g. `/new@my_bot`), so we strip that suffix before matching.
 */
function isResetCommand(text: string): boolean {
  const command = text.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return command !== undefined && RESET_COMMANDS.includes(command);
}

/**
 * Handle a `/new`/`/reset` command: clear the chat's session and confirm
 * immediately. Clearing mirrors the Slack handler — drop the session entry,
 * delete the underlying session, and invalidate its cached history — so the
 * next message starts genuinely fresh.
 */
async function handleResetCommand(
  data: TelegramMessageData,
  target: TelegramReplyTarget,
  send: TelegramSend
): Promise<void> {
  const ctx = getTelegramContext();
  const sessionKey = resolveSessionKey(data);
  try {
    const cleared = await ctx.clearSessionEntry(target.agent.id, sessionKey);
    if (cleared) {
      ctx.deleteSession(target.agent.id, cleared.sessionId);
      await ctx.invalidateHistoryCache(target.agent.id, cleared.sessionId);
    }
  } catch (err) {
    console.error(`${target.logPrefix} Session reset failed:`, err);
    await send("Sorry, I couldn't start a new session. Please try again.");
    return;
  }
  await send("Context cleared, new session started.");
}

/**
 * Decide whether an inbound message should be handled.
 *
 * DMs (private chats) always run, matching the walking skeleton. Group chats
 * (`group`/`supergroup`) act as a shared group brain: the bot joins the
 * conversation only when addressed (an @mention, a reply to the bot, or a
 * command) so it contributes to the channel without hijacking every message.
 * The bot's own messages are ignored everywhere.
 *
 * Before any dispatch the user and chat allowlists are enforced: the sender
 * must be in `allowedUsers` and the chat in `allowedChats`. Both lists fail
 * closed — an empty/omitted list allows no one — matching the discord/slack
 * allowlist convention.
 */
export function processMessage(
  data: TelegramMessageData,
  allowlist: TelegramAllowlistConfig = {}
): TelegramPipelineResult {
  if (data.isBot) {
    return { shouldReply: false, reason: "author_is_bot" };
  }
  if (
    !matchesUserAllowlist(
      { id: data.userId, username: data.username },
      allowlist.allowedUsers
    )
  ) {
    return { shouldReply: false, reason: "user_not_allowed" };
  }
  if (
    !matchesChatAllowlist(
      { id: data.chatId, username: data.chatUsername },
      allowlist.allowedChats
    )
  ) {
    return { shouldReply: false, reason: "chat_not_allowed" };
  }
  // In a group, only respond when the bot is directly addressed.
  if (!isDirectMessage(data.chatType) && !data.isAddressed) {
    return { shouldReply: false, reason: "not_addressed" };
  }
  // Media-only messages are valid: the caption (if any) is the text part and
  // the attachments carry the content.
  if (!data.text.trim() && !(data.media && data.media.length > 0)) {
    return { shouldReply: false, reason: "empty_message" };
  }
  return { shouldReply: true };
}

export async function handleTelegramMessage(
  data: TelegramMessageData,
  target: TelegramReplyTarget,
  send: TelegramSend,
  hooks: TelegramHandlerHooks = {},
  allowlist: TelegramAllowlistConfig = {},
  options: TelegramTurnOptions = {}
): Promise<void> {
  const result = processMessage(data, allowlist);
  if (!result.shouldReply) {
    if (result.reason && result.reason !== "author_is_bot") {
      console.debug(`${target.logPrefix} Ignored: ${result.reason}`);
    }
    return;
  }

  // Intercept reset control commands (`/new`, `/reset`) before starting a turn:
  // clear the session and confirm immediately, mirroring Slack/Discord, instead
  // of forwarding the empty post-reset message to the agent.
  if (isResetCommand(data.text)) {
    await handleResetCommand(data, target, send);
    return;
  }

  // DMs resolve to the agent's main session (matching discord/slack DM
  // handling), keeping each person's DM isolated. Group chats resolve to a
  // shared per-chat session key so the whole channel contributes to one
  // collective conversation — the shared group brain.
  const isDm = isDirectMessage(data.chatType);
  const sessionKey = resolveSessionKey(data);
  const conversationType: ChannelConversationType = isDm
    ? "direct_message"
    : "channel_message";
  const place = isDm
    ? `direct message / ${data.senderName}`
    : `group chat / ${data.chatId}`;
  const context = buildTelegramContext({
    metadata: {
      channel: "telegram",
      place,
      conversationType,
      sender: data.senderName,
    },
  });

  // Resolve any inbound media into agent attachments before starting the turn.
  let attachments: FileAttachment[] = [];
  if (data.media && data.media.length > 0 && hooks.collectAttachments) {
    try {
      attachments = await hooks.collectAttachments(data.media);
    } catch (err) {
      console.error(`${target.logPrefix} Attachment download failed:`, err);
      await send(
        "Sorry, I couldn't download the attached media. Please try again."
      );
      return;
    }
  }

  // A media-only message with no caption and no usable attachments has nothing
  // for the agent to act on.
  if (!data.text.trim() && attachments.length === 0) return;

  // Keep the typing indicator alive for the full turn. It starts as the turn
  // begins, refreshes on a ~2s cadence, and is re-triggered after each
  // intermediate send (delivering a message clears Telegram's typing bubble).
  const typing = hooks.sendTyping
    ? new TypingKeepAlive(hooks.sendTyping)
    : null;
  // Await the first typing action so the indicator is dispatched before the
  // agent run produces its first reply. On a warm session the run completes
  // before the keep-alive interval fires, so without this the lone initial
  // action would race (and lose to) the reply and the bubble would never show.
  await typing?.start();

  // Opt-in tool-call visibility (ALG-288): when enabled, surface concise
  // one-line notes about the agent's tool calls/actions during the turn,
  // coalesced/throttled so they don't flood the chat. OFF by default — the chat
  // then only sees the agent's reply. Notes are posted as their own plain-text
  // messages, separate from the streaming reply preview, so an operator can
  // audit what the agent did without the notes contaminating the rendered
  // answer.
  const toolNotesEnabled = options.showToolCalls === true;
  const toolNotes = toolNotesEnabled ? new ToolNotes() : null;
  // Serialize note sends so batches arrive in order and never race the reply.
  let noteChain: Promise<void> = Promise.resolve();
  const flushToolNotes = (text: string): Promise<void> => {
    noteChain = noteChain.then(async () => {
      try {
        await send(text);
        // A delivered message clears Telegram's typing bubble.
        typing?.poke();
      } catch (err) {
        // Audit notes are best-effort; a failed send must not abort the turn.
        console.debug(`${target.logPrefix} Tool-call note send failed:`, err);
      }
    });
    return noteChain;
  };

  // Live streaming preview: coalesce text deltas and progressively edit a
  // single message at natural breakpoints. Disabled when no edit hook is wired
  // (the final clean render is still sent either way).
  const coalescer = new StreamCoalescer();
  // Message id of the live preview message, once the first snapshot is sent.
  let liveMessageId: number | undefined;
  let streamingEnabled = hooks.editMessage !== undefined;
  // Serialize preview sends/edits. onEvent fires synchronously and we surface
  // without blocking it, so chaining keeps the first send (which mints the
  // message id) ahead of every subsequent edit and avoids out-of-order writes.
  let surfaceChain: Promise<void> = Promise.resolve();

  // Surface a coalesced snapshot: send the first one as a new message, edit it
  // thereafter. Previews are plain text (no parse mode) so a mid-render
  // truncation can never produce invalid HTML; the final pass renders cleanly.
  const surface = (snapshot: string): Promise<void> => {
    surfaceChain = surfaceChain.then(async () => {
      if (!streamingEnabled) return;
      const preview = livePreview(snapshot);
      try {
        if (liveMessageId === undefined) {
          liveMessageId = await send(preview);
          // No id back means we can't edit later; stop streaming previews.
          if (liveMessageId === undefined) streamingEnabled = false;
        } else {
          await hooks.editMessage!(liveMessageId, preview);
        }
        // A delivered/edited message clears Telegram's typing bubble.
        typing?.poke();
      } catch (err) {
        // Streaming is best-effort liveness; a failed edit must not abort the
        // turn. Disable further previews; the final render carries the reply.
        console.debug(
          `${target.logPrefix} Streaming preview edit failed:`,
          err
        );
        streamingEnabled = false;
      }
    });
    return surfaceChain;
  };

  try {
    const agentResult = await getTelegramContext().runAgent({
      agentId: target.agent.id,
      message: data.text,
      attachments: attachments.length > 0 ? attachments : undefined,
      sessionKey,
      source: "telegram",
      context,
      onEvent:
        streamingEnabled || toolNotes
          ? (event) => {
              if (event.type === "text") {
                if (!streamingEnabled) return;
                coalescer.push(event.data);
                const edit = coalescer.takeEdit();
                if (edit) void surface(edit.text);
                return;
              }
              if (toolNotes) {
                toolNotes.push(event);
                const flush = toolNotes.takeFlush();
                if (flush) void flushToolNotes(flush.text);
              }
            }
          : undefined,
    });

    // Drain any remaining tool-call notes so the audit trail is complete before
    // the reply is finalized, and so the note chain can't outlive the turn.
    if (toolNotes) {
      const finalNotes = toolNotes.takeFinal();
      if (finalNotes) void flushToolNotes(finalNotes.text);
      await noteChain;
    }

    if (agentResult.meta.queued) {
      // Drain any in-flight preview writes before returning so the chain can't
      // outlive the turn.
      await surfaceChain;
      return;
    }

    // Let any preview writes queued during streaming settle before the final
    // render. We deliberately skip a plain-text final flush here: the clean
    // render pass below promotes the same live message straight to the fully
    // rendered HTML, so an intermediate plain-text edit would only add a
    // redundant edit and a brief flash.
    await surfaceChain;

    // Clean render pass: render the agent's final text to Telegram HTML and
    // deliver it. When a live preview message exists, edit it in place to the
    // first rendered chunk so the streamed message becomes the final clean one
    // (no duplicate). Overflow chunks thread as replies to the previous chunk.
    for (const payload of agentResult.payloads) {
      if (!payload.text) continue;
      const html = renderMarkdown(payload.text);
      const chunks = splitMessage(html);
      let replyToMessageId: number | undefined;
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        // Promote the live preview to the final render on the first chunk.
        if (i === 0 && liveMessageId !== undefined && hooks.editMessage) {
          try {
            await hooks.editMessage(liveMessageId, chunk, { parseMode: "HTML" });
            replyToMessageId = liveMessageId;
            typing?.poke();
            continue;
          } catch (err) {
            // Couldn't reuse the preview message (e.g. it was deleted); fall
            // through to sending a fresh message so the reply is never lost.
            console.debug(`${target.logPrefix} Final edit failed:`, err);
          }
        }
        const sentId = await send(chunk, {
          parseMode: "HTML",
          replyToMessageId,
        });
        if (sentId !== undefined) replyToMessageId = sentId;
        // Re-trigger typing: a delivered message clears Telegram's bubble.
        typing?.poke();
      }
      // Each payload renders as its own grouped thread.
      liveMessageId = undefined;
    }
  } catch (err) {
    console.error(`${target.logPrefix} Error:`, err);
    await send("Sorry, I encountered an error processing your message.");
  } finally {
    typing?.stop();
  }
}

/**
 * Clamp a live streaming preview to a single Telegram message. Previews are
 * plain text, so we can safely truncate the tail and append an ellipsis; the
 * final pass delivers the full, chunked, rendered reply.
 */
function livePreview(text: string): string {
  if (text.length <= TELEGRAM_MAX) return text;
  return text.slice(0, TELEGRAM_MAX - 1) + "…";
}
