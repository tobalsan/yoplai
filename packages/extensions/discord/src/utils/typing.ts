import type { CarbonClient } from "../client.js";
import { getDiscordContext } from "../context.js";

const TYPING_INTERVAL_MS = 5000; // Discord typing expires after 10s
const QUEUED_TTL_MS = 30000; // Stop typing after 30s if queued run never completes

type TypingEntry = {
  client: CarbonClient;
  interval: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout> | null;
  unsubscribe: () => void;
};

type TypingMatch = {
  sessionId?: string;
  sessionKey?: string;
};

// Per-channel active typing indicators
const activeTyping = new Map<string, TypingEntry>();

async function sendTyping(client: CarbonClient, channelId: string) {
  try {
    await client.rest.post(`/channels/${channelId}/typing`, { body: {} });
  } catch {
    // Ignore typing errors
  }
}

/**
 * Start continuous typing indicator for a channel.
 * Stops when agentEventBus emits done/error for matching agentId+sessionId,
 * or after TTL expires for queued runs.
 */
export function startTyping(
  client: CarbonClient,
  channelId: string,
  agentId: string,
  match: TypingMatch,
  queued: boolean
): void {
  const { sessionId, sessionKey } = match;
  if (!sessionId && !sessionKey) return;

  // Already typing in this channel? Stop old one first
  stopTyping(channelId);

  // Send initial typing
  sendTyping(client, channelId);

  // Keep-alive interval
  const interval = setInterval(() => {
    sendTyping(client, channelId);
  }, TYPING_INTERVAL_MS);

  // Subscribe to done/error events
  const unsubscribe = getDiscordContext().subscribe("agent.stream", (payload) => {
    const event = payload as {
      agentId: string;
      sessionId?: string;
      sessionKey?: string;
      type: string;
    };
    if (event.agentId !== agentId) return;
    if (sessionKey) {
      if (event.sessionKey !== sessionKey) return;
    } else if (event.sessionId !== sessionId) {
      return;
    }
    if (event.type === "done" || event.type === "error") {
      stopTyping(channelId);
    }
  });

  // TTL timeout for queued runs
  const timeout = queued
    ? setTimeout(() => stopTyping(channelId), QUEUED_TTL_MS)
    : null;

  activeTyping.set(channelId, { client, interval, timeout, unsubscribe });
}

/**
 * Stop typing indicator for a channel.
 */
export function stopTyping(channelId: string): void {
  const entry = activeTyping.get(channelId);
  if (!entry) return;

  clearInterval(entry.interval);
  if (entry.timeout) clearTimeout(entry.timeout);
  entry.unsubscribe();
  activeTyping.delete(channelId);
}

/**
 * Stop all active typing indicators (for cleanup on bot stop).
 */
export function stopAllTyping(client: CarbonClient): void {
  for (const [channelId, entry] of activeTyping) {
    if (entry.client === client) stopTyping(channelId);
  }
}
