import type { AgentConfig, ExtensionContext } from "@yoplai/shared";
import { getDiscordContext } from "./context.js";

export type ForumSubscriberSource =
  | readonly AgentConfig[]
  | Pick<ExtensionContext, "getAgents">;

export function getForumSubscribers(
  channelId: string,
  source?: ForumSubscriberSource
): AgentConfig[] {
  const agents =
    source === undefined
      ? getDiscordContext().getAgents()
      : "getAgents" in source
        ? source.getAgents()
        : source;

  return agents.filter((agent) =>
    (agent.discord?.forumChannels ?? []).includes(channelId)
  );
}
