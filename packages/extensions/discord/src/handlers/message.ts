/**
 * Message pipeline handler for Discord
 *
 * Determines whether the bot should reply to a message with explicit gating reasons.
 */

import type { DiscordConfig } from "@yoplai/shared";
import { MessageType } from "discord-api-types/v10";
import { matchesUserAllowlist } from "../utils/allowlist.js";

export type MessageData = {
  id: string;
  content: string;
  type?: number;
  channel_id: string;
  parent_channel_id?: string;
  guild_id?: string;
  author: {
    id: string;
    username?: string;
    discriminator?: string;
    bot?: boolean;
  };
  mentions?: Array<{ id: string }>;
  attachments?: Array<{
    filename: string;
    url: string;
    size?: number;
    content_type?: string | null;
  }>;
};

export type PipelineResult = {
  shouldReply: boolean;
  reason?: string;
  normalizedContent: string;
  isDm: boolean;
  guildConfig?: ReturnType<typeof getGuildConfig>;
  channelConfig?: ReturnType<typeof getChannelConfig>;
};

type GuildConfigValue = NonNullable<DiscordConfig["guilds"]>[string];
type ChannelConfigValue = NonNullable<GuildConfigValue["channels"]>[string];

function getGuildConfig(
  config: DiscordConfig,
  guildId: string | undefined
): GuildConfigValue | undefined {
  if (!guildId || !config.guilds) return undefined;
  return config.guilds[guildId];
}

function getChannelConfig(
  guildConfig: GuildConfigValue | undefined,
  channelId: string
): ChannelConfigValue | undefined {
  if (!guildConfig?.channels) return undefined;
  return guildConfig.channels[channelId];
}

/**
 * Check if content contains a bot mention or matches configured patterns
 */
function containsMention(
  content: string,
  botId: string | undefined,
  mentions: Array<{ id: string }> | undefined,
  mentionPatterns: string[] | undefined
): { mentioned: boolean; cleanedContent: string } {
  let mentioned = false;
  let cleanedContent = content;

  // Check Discord mentions
  if (botId && mentions?.some((m) => m.id === botId)) {
    mentioned = true;
    // Remove <@botId> or <@!botId> from content
    cleanedContent = cleanedContent.replace(new RegExp(`<@!?${botId}>\\s*`, "g"), "").trim();
  }

  // Check configured patterns
  if (mentionPatterns) {
    for (const pattern of mentionPatterns) {
      const regex = new RegExp(pattern, "i");
      if (regex.test(cleanedContent)) {
        mentioned = true;
        cleanedContent = cleanedContent.replace(regex, "").trim();
        break;
      }
    }
  }

  return { mentioned, cleanedContent };
}

/**
 * Process a message through the gating pipeline
 *
 * Pipeline order:
 * 1. Ignore bots/self
 * 2. DM gating (dm.enabled, dm.allowFrom)
 * 3. Guild gating (groupPolicy, legacy guildId)
 * 4. Channel allow/disable resolution
 * 5. User allowlist (guild + channel)
 * 6. Mention gating (requireMention + mentionPatterns)
 */
export function processMessage(
  data: MessageData,
  config: DiscordConfig,
  botId: string | undefined
): PipelineResult {
  const content = data.content?.trim() ?? "";
  const isDm = !data.guild_id;

  // 1. Ignore bots
  if (data.author.bot) {
    return { shouldReply: false, reason: "author_is_bot", normalizedContent: content, isDm };
  }

  // Discord emits system messages such as THREAD_CREATED into the parent
  // channel. Only user-authored default messages and replies should invoke
  // agents.
  if (
    data.type !== undefined &&
    data.type !== MessageType.Default &&
    data.type !== MessageType.Reply
  ) {
    return {
      shouldReply: false,
      reason: "unsupported_message_type",
      normalizedContent: content,
      isDm,
    };
  }

  // 2. DM gating
  if (isDm) {
    const dmConfig = config.dm;

    // Check if DMs are enabled (default true)
    if (dmConfig?.enabled === false) {
      return { shouldReply: false, reason: "dm_disabled", normalizedContent: content, isDm };
    }

    // Check allowFrom if specified
    if (dmConfig?.allowFrom && dmConfig.allowFrom.length > 0) {
      if (!matchesUserAllowlist(data.author, dmConfig.allowFrom)) {
        return { shouldReply: false, reason: "dm_user_not_allowed", normalizedContent: content, isDm };
      }
    }

    // DMs pass - no mention required
    return { shouldReply: true, normalizedContent: content, isDm };
  }

  // 3. Guild gating
  const guildId = data.guild_id!;

  // Legacy mode: if guildId is configured, only that guild is allowed
  if (config.guildId && guildId !== config.guildId) {
    return { shouldReply: false, reason: "guild_not_configured", normalizedContent: content, isDm };
  }

  // Legacy mode: if channelId is configured, only that channel is allowed
  if (config.channelId && data.channel_id !== config.channelId) {
    return { shouldReply: false, reason: "channel_not_configured", normalizedContent: content, isDm };
  }

  // Group policy
  const groupPolicy = config.groupPolicy ?? "open";
  const guildConfig = getGuildConfig(config, guildId);

  if (groupPolicy === "disabled") {
    return { shouldReply: false, reason: "group_policy_disabled", normalizedContent: content, isDm };
  }

  if (groupPolicy === "allowlist" && !guildConfig) {
    return { shouldReply: false, reason: "guild_not_in_allowlist", normalizedContent: content, isDm };
  }

  // 4. Channel resolution
  const channelConfig = getChannelConfig(guildConfig, data.channel_id);

  // When groupPolicy is allowlist, channel must be explicitly configured
  if (groupPolicy === "allowlist" && guildConfig && !channelConfig) {
    return {
      shouldReply: false,
      reason: "channel_not_in_allowlist",
      normalizedContent: content,
      isDm,
      guildConfig,
    };
  }

  // Check if channel is explicitly disabled
  if (channelConfig?.enabled === false) {
    return {
      shouldReply: false,
      reason: "channel_disabled",
      normalizedContent: content,
      isDm,
      guildConfig,
      channelConfig,
    };
  }

  // 5. User allowlist (guild-level + channel-level)
  const guildUsers = guildConfig?.users;
  const channelUsers = channelConfig?.users;

  // If any allowlist is set, user must match
  if ((guildUsers && guildUsers.length > 0) || (channelUsers && channelUsers.length > 0)) {
    const matchesGuild = !guildUsers || guildUsers.length === 0 || matchesUserAllowlist(data.author, guildUsers);
    const matchesChannel = !channelUsers || channelUsers.length === 0 || matchesUserAllowlist(data.author, channelUsers);

    // User must match channel allowlist if set, otherwise guild allowlist
    if (channelUsers && channelUsers.length > 0) {
      if (!matchesChannel) {
        return {
          shouldReply: false,
          reason: "user_not_in_channel_allowlist",
          normalizedContent: content,
          isDm,
          guildConfig,
          channelConfig,
        };
      }
    } else if (!matchesGuild) {
      return {
        shouldReply: false,
        reason: "user_not_in_guild_allowlist",
        normalizedContent: content,
        isDm,
        guildConfig,
        channelConfig,
      };
    }
  }

  // 6. Mention gating
  // Determine if mention is required (channel overrides guild)
  const requireMention = channelConfig?.requireMention ?? guildConfig?.requireMention ?? true;

  const { mentioned, cleanedContent } = containsMention(
    content,
    botId,
    data.mentions,
    config.mentionPatterns
  );

  if (requireMention && !mentioned) {
    return {
      shouldReply: false,
      reason: "mention_required",
      normalizedContent: content,
      isDm,
      guildConfig,
      channelConfig,
    };
  }

  // All gates passed
  return {
    shouldReply: true,
    normalizedContent: cleanedContent || content,
    isDm,
    guildConfig,
    channelConfig,
  };
}
