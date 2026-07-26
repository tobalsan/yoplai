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
  config: SlackComponentConfig
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

  return { shouldProcess: true, channel, messageTs };
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
