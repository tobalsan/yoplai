import type { SlackWebClient } from "../types.js";
import { getSlackContext } from "../context.js";

const THINKING_REACTION = "thinking_face";

type ThinkingEntry = {
  client: SlackWebClient;
  unsubscribe: () => void;
};

type ThinkingMatch = {
  sessionId?: string;
  sessionKey?: string;
};

const activeThinking = new Map<string, ThinkingEntry>();

function key(channel: string, timestamp: string): string {
  return `${channel}:${timestamp}`;
}

async function addThinkingReaction(
  client: SlackWebClient,
  channel: string,
  timestamp: string
): Promise<void> {
  try {
    await client.reactions.add({
      channel,
      timestamp,
      name: THINKING_REACTION,
    });
  } catch {
    // Slack may reject duplicate or unavailable reaction state.
  }
}

async function removeThinkingReaction(
  client: SlackWebClient,
  channel: string,
  timestamp: string
): Promise<void> {
  try {
    await client.reactions.remove({
      channel,
      timestamp,
      name: THINKING_REACTION,
    });
  } catch {
    // Reaction may already be gone or unavailable.
  }
}

export async function startThinkingReaction(
  client: SlackWebClient,
  channel: string,
  timestamp: string,
  agentId: string,
  match: ThinkingMatch
): Promise<void> {
  await addThinkingReaction(client, channel, timestamp);
  const activeKey = key(channel, timestamp);
  activeThinking.get(activeKey)?.unsubscribe();

  const unsubscribe = getSlackContext().subscribe("agent.stream", (payload) => {
    const event = payload as {
      type: "done" | "error" | string;
      agentId: string;
      sessionId: string;
      sessionKey?: string;
    };
    if (event.agentId !== agentId) return;
    if (match.sessionKey && event.sessionKey !== match.sessionKey) return;
    if (!match.sessionKey && match.sessionId && event.sessionId !== match.sessionId) {
      return;
    }
    if (event.type !== "done" && event.type !== "error") return;

    stopThinkingReaction(client, channel, timestamp);
  });

  activeThinking.set(activeKey, { client, unsubscribe });
}

export async function stopThinkingReaction(
  client: SlackWebClient,
  channel: string,
  timestamp: string
): Promise<void> {
  const activeKey = key(channel, timestamp);
  const entry = activeThinking.get(activeKey);
  entry?.unsubscribe();
  activeThinking.delete(activeKey);
  await removeThinkingReaction(client, channel, timestamp);
}

export function stopAllThinkingReactions(client: SlackWebClient): void {
  for (const [activeKey, entry] of activeThinking) {
    if (entry.client !== client) continue;
    entry.unsubscribe();
    activeThinking.delete(activeKey);
  }
}
