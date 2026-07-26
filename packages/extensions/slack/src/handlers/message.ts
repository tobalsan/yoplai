import type {
  SlackComponentChannelConfig,
  SlackComponentConfig,
} from "@yoplai/shared";
import type { SlackFile } from "../utils/attachments.js";
import { matchesUserAllowlist } from "../utils/allowlist.js";

export type MessageData = {
  ts: string;
  text: string;
  channel: string;
  user?: string;
  bot_id?: string;
  channel_type?: string;
  thread_ts?: string;
  isAppMention?: boolean;
  files?: SlackFile[];
};

export type BangCommand = "new" | "stop";

export type BangCommandMatch = {
  command: BangCommand;
  arg?: string;
};

export function detectBangCommand(
  content: string
): BangCommandMatch | undefined {
  const match = content.match(/^!(new|stop)\b(.*)/i);
  if (!match) return undefined;
  return {
    command: match[1].toLowerCase() as BangCommand,
    arg: match[2].trim() || undefined,
  };
}

export type PipelineResult = {
  shouldReply: boolean;
  reason?: string;
  normalizedContent: string;
  isDm: boolean;
  channelConfig?: SlackComponentChannelConfig;
};

function containsMention(
  content: string,
  botUserId: string | undefined,
  mentionPatterns: string[] | undefined
): { mentioned: boolean; cleanedContent: string } {
  let mentioned = false;
  let cleanedContent = content;

  if (botUserId) {
    const mentionRegex = new RegExp(`<@${botUserId}>\\s*`, "g");
    if (mentionRegex.test(cleanedContent)) {
      mentioned = true;
      cleanedContent = cleanedContent.replace(mentionRegex, "").trim();
    }
  }

  for (const pattern of mentionPatterns ?? []) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(cleanedContent)) {
      mentioned = true;
      cleanedContent = cleanedContent.replace(regex, "").trim();
      break;
    }
  }

  return { mentioned, cleanedContent };
}

export function processMessage(
  data: MessageData,
  config: SlackComponentConfig,
  botUserId: string | undefined
): PipelineResult {
  const content = data.text?.trim() ?? "";
  const isDm = data.channel_type === "im";

  if (data.bot_id || (botUserId && data.user === botUserId)) {
    return {
      shouldReply: false,
      reason: "author_is_bot",
      normalizedContent: content,
      isDm,
    };
  }

  if (isDm) {
    if (!config.dm || config.dm.enabled === false) {
      return {
        shouldReply: false,
        reason: "dm_disabled",
        normalizedContent: content,
        isDm,
      };
    }
    if (
      config.dm.allowFrom &&
      config.dm.allowFrom.length > 0 &&
      (!data.user || !matchesUserAllowlist(data.user, config.dm.allowFrom))
    ) {
      return {
        shouldReply: false,
        reason: "dm_user_not_allowed",
        normalizedContent: content,
        isDm,
      };
    }
    return { shouldReply: true, normalizedContent: content, isDm };
  }

  const channels = config.channels ?? {};
  const channelConfig = channels[data.channel];
  if (Object.keys(channels).length > 0 && !channelConfig) {
    return {
      shouldReply: false,
      reason: "channel_not_configured",
      normalizedContent: content,
      isDm,
    };
  }

  if (
    channelConfig?.users &&
    channelConfig.users.length > 0 &&
    (!data.user || !matchesUserAllowlist(data.user, channelConfig.users))
  ) {
    return {
      shouldReply: false,
      reason: "user_not_in_channel_allowlist",
      normalizedContent: content,
      isDm,
      channelConfig,
    };
  }

  const requireMention = channelConfig?.requireMention ?? true;
  const { mentioned, cleanedContent } = containsMention(
    content,
    botUserId,
    config.mentionPatterns
  );

  if (requireMention && !data.isAppMention && !mentioned) {
    return {
      shouldReply: false,
      reason: "mention_required",
      normalizedContent: content,
      isDm,
      channelConfig,
    };
  }

  const finalContent = cleanedContent || content;

  return {
    shouldReply: true,
    normalizedContent: finalContent,
    isDm,
    channelConfig,
  };
}
