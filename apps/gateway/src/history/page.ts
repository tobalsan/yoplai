import type { FullHistoryMessage, SimpleHistoryMessage } from "@yoplai/shared";

type Message = FullHistoryMessage | SimpleHistoryMessage;
export function historyPage<T extends Message>(messages: T[], limit: number, before?: string): { messages: T[]; nextCursor?: string; historyOffset: number } {
  let end = messages.length;
  if (before) {
    const cursor = JSON.parse(Buffer.from(before, "base64url").toString()) as { timestamp: number; ordinal: number };
    if (!Number.isFinite(cursor.timestamp) || !Number.isSafeInteger(cursor.ordinal) || cursor.ordinal < 0) throw new Error("Invalid history cursor");
    let ordinal = 0;
    end = messages.findIndex((message) => message.timestamp === cursor.timestamp && ordinal++ === cursor.ordinal);
    if (end < 0) throw new Error("History cursor no longer exists");
  }
  let start = Math.max(0, end - limit);
  // Include the owning assistant even when user/system entries interleave calls and results.
  const calls = new Map<string, number>();
  for (let i = 0; i < end; i++) {
    const message = messages[i]!;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, i);
    }
  }
  let previousStart;
  do {
    previousStart = start;
    for (let i = start; i < end; i++) {
      const message = messages[i]!;
      if (message.role === "toolResult") start = Math.min(start, calls.get(message.toolCallId) ?? start);
    }
  } while (start !== previousStart);
  const first = messages[start];
  const nextCursor = start > 0 && first ? Buffer.from(JSON.stringify({
    timestamp: first.timestamp,
    ordinal: messages.slice(0, start).filter((message) => message.timestamp === first.timestamp).length,
  })).toString("base64url") : undefined;
  return { messages: messages.slice(start, end), nextCursor, historyOffset: start };
}

export function activeContextUsage(messages: FullHistoryMessage[]): { inputTokens: number; model?: string } {
  let latestCompaction = -1;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === "system" && message.content.some((block) => block.type === "text" && block.text.startsWith("[COMPACTED CONTEXT SUMMARY]"))) latestCompaction = i;
  }
  let inputTokens = 0;
  let model: string | undefined;
  for (const message of messages.slice(latestCompaction + 1)) {
    if (message.role === "assistant" && message.meta?.usage) {
      inputTokens = message.meta.usage.input + (message.meta.usage.cacheRead ?? 0) + (message.meta.usage.cacheWrite ?? 0);
      model = message.meta.model;
    }
  }
  return { inputTokens, model };
}
