/**
 * Reaction pipeline handler for Discord
 *
 * Determines whether the bot should process a reaction event based on gating config.
 */

import type { DiscordConfig } from "@yoplai/shared";
import { matchesUserAllowlist } from "../utils/allowlist.js";

export type ReactionData = {
  emoji: { name: string | null; id?: string | null }; // Custom emojis have id
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  message_author_id?: string; // From fetched message
};

export type ReactionPipelineResult = {
  shouldProcess: boolean;
  reason?: string;
};

type GuildConfigValue = NonNullable<DiscordConfig["guilds"]>[string];

function getGuildConfig(
  config: DiscordConfig,
  guildId: string | undefined
): GuildConfigValue | undefined {
  if (!guildId || !config.guilds) return undefined;
  return config.guilds[guildId];
}

/**
 * Process a reaction event through the gating pipeline
 *
 * Gating modes:
 * - "off": ignore all reactions
 * - "all": process all reactions
 * - "own": only when reaction is on a message authored by the bot
 * - "allowlist": only when reacting user matches reactionAllowlist
 */
export function processReaction(
  data: ReactionData,
  config: DiscordConfig,
  botId: string | undefined
): ReactionPipelineResult {
  // DMs: no reaction notifications (no guild config)
  if (!data.guild_id) {
    return { shouldProcess: false, reason: "dm_reaction" };
  }

  const guildConfig = getGuildConfig(config, data.guild_id);

  // Get notification mode (default "off")
  const mode = guildConfig?.reactionNotifications ?? "off";

  if (mode === "off") {
    return { shouldProcess: false, reason: "reactions_off" };
  }

  if (mode === "all") {
    return { shouldProcess: true };
  }

  if (mode === "own") {
    // Need message author to determine if it's our message
    if (!data.message_author_id) {
      return { shouldProcess: false, reason: "no_message_author" };
    }
    if (data.message_author_id !== botId) {
      return { shouldProcess: false, reason: "not_own_message" };
    }
    return { shouldProcess: true };
  }

  if (mode === "allowlist") {
    const allowlist = guildConfig?.reactionAllowlist;
    if (!allowlist || allowlist.length === 0) {
      return { shouldProcess: false, reason: "empty_allowlist" };
    }
    // Check if reacting user is in allowlist (only have user_id)
    if (!matchesUserAllowlist({ id: data.user_id }, allowlist)) {
      return { shouldProcess: false, reason: "user_not_in_allowlist" };
    }
    return { shouldProcess: true };
  }

  return { shouldProcess: false, reason: "unknown_mode" };
}

/**
 * Format emoji for display (handles custom vs unicode)
 */
export function formatEmoji(emoji: { name: string | null; id?: string | null }): string {
  if (emoji.id && emoji.name) {
    // Custom emoji: <:name:id> or <a:name:id> for animated
    return `<:${emoji.name}:${emoji.id}>`;
  }
  // Unicode emoji or fallback
  return emoji.name ?? "emoji";
}
