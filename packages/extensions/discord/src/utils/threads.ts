/**
 * Thread starter resolution with caching
 * Fetches the first message in a thread along with author info
 */

import type { Client } from "@buape/carbon";
import { formatDiscordAuthor } from "./author.js";

export type ThreadStarterInfo = {
  author: string;
  content: string;
  timestamp: number;
};

// Cache: threadId -> ThreadStarterInfo
const threadStarterCache = new Map<string, ThreadStarterInfo>();

/**
 * Get thread starter info for a channel (if it's a thread)
 * Returns null if not a thread or fetch fails
 */
export async function getThreadStarter(
  client: Client,
  channelId: string
): Promise<ThreadStarterInfo | null> {
  // Check cache first
  const cached = threadStarterCache.get(channelId);
  if (cached) return cached;

  try {
    // Fetch channel info to check if it's a thread
    const channel = (await client.rest.get(`/channels/${channelId}`)) as {
      type?: number;
      parent_id?: string;
      id?: string;
    };

    // Thread types: 10 (news thread), 11 (public thread), 12 (private thread)
    const isThread = channel.type === 10 || channel.type === 11 || channel.type === 12;
    if (!isThread) return null;

    // For threads, the channel ID is also the starter message ID
    // Fetch the starter message from the parent channel
    const parentId = channel.parent_id;
    if (!parentId) return null;

    const starterMessage = (await client.rest.get(
      `/channels/${parentId}/messages/${channelId}`
    )) as {
      author?: { id: string; username?: string; bot?: boolean };
      content?: string;
      timestamp?: string;
    };

    const info: ThreadStarterInfo = {
      author: starterMessage.author
        ? formatDiscordAuthor(starterMessage.author)
        : "Unknown",
      content: starterMessage.content ?? "",
      timestamp: starterMessage.timestamp
        ? new Date(starterMessage.timestamp).getTime()
        : Date.now(),
    };

    // Cache result
    threadStarterCache.set(channelId, info);
    return info;
  } catch {
    // Fetch failed - likely not a thread or no access
    return null;
  }
}

/**
 * Clear cached thread starter info
 */
export function clearThreadStarterCache(channelId?: string): void {
  if (channelId) {
    threadStarterCache.delete(channelId);
  } else {
    threadStarterCache.clear();
  }
}
