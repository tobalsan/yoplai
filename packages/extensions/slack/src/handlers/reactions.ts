import type { SlackComponentConfig } from "@yoplai/shared";
import { matchesUserAllowlist } from "../utils/allowlist.js";

export type ReactionData = {
  reaction: string;
  user: string;
  item: {
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
};

export type ReactionPipelineResult = {
  shouldProcess: boolean;
  reason?: string;
  channel?: string;
  messageTs?: string;
};

export function processReaction(
  data: ReactionData,
  config: SlackComponentConfig,
  messageAuthor?: string,
  botUserId?: string,
  botId?: string
): ReactionPipelineResult {
  const channel = data.item.channel;
  const messageTs = data.item.ts;
  if (!channel || !messageTs) {
    return { shouldProcess: false, reason: "missing_item" };
  }

  const route = config.channels?.[channel];
  if (!route) {
    return { shouldProcess: false, reason: "channel_not_configured" };
  }

  if (
    route.users &&
    route.users.length > 0 &&
    !matchesUserAllowlist(data.user, route.users)
  ) {
    return { shouldProcess: false, reason: "user_not_in_channel_allowlist" };
  }

  if (botUserId && data.user === botUserId) {
    return { shouldProcess: false, reason: "self_reaction" };
  }

  const mode = route.reactionNotifications ?? "off";
  if (mode === "off") {
    return { shouldProcess: false, reason: "reactions_off" };
  }
  if (mode === "all") {
    return { shouldProcess: true, channel, messageTs };
  }
  if (mode === "allowlist") {
    const allowlist = route.reactionAllowlist;
    if (!allowlist?.length) {
      return { shouldProcess: false, reason: "empty_allowlist" };
    }
    if (!matchesUserAllowlist(data.user, allowlist)) {
      return { shouldProcess: false, reason: "user_not_in_allowlist" };
    }
    return { shouldProcess: true, channel, messageTs };
  }
  if (mode === "own") {
    if (!messageAuthor) {
      return { shouldProcess: false, reason: "no_message_author" };
    }
    if (messageAuthor !== botUserId && messageAuthor !== botId) {
      return { shouldProcess: false, reason: "not_own_message" };
    }
    return { shouldProcess: true, channel, messageTs };
  }

  return { shouldProcess: false, reason: "unknown_mode" };
}

export function formatReactionMessage(
  data: ReactionData,
  action: "add" | "remove"
): string {
  const verb = action === "add" ? "reacted with" : "removed reaction";
  return `[SYSTEM] User ${data.user} ${verb} ${data.reaction} on message ${
    data.item.ts ?? "unknown"
  }`;
}
