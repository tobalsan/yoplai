import type { FullHistoryMessage } from "@yoplai/shared";
import { messageText, messageToolCalls } from "./condense.js";
import { legacySessionRef } from "./legacy-session-ref.js";
import type { ToolStep, TranscriptEntry } from "./transcript.js";

export function orderMessagesByTimestamp<T extends { timestamp: number }>(
  messages: T[]
): T[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const diff = a.message.timestamp - b.message.timestamp;
      return diff === 0 ? a.index - b.index : diff;
    })
    .map((entry) => entry.message);
}

/** Parse the canonical JSONL rows and keep diagnostics for the history reader. */
export function parseHistoryJsonl(raw: string): {
  messages: FullHistoryMessage[];
  errors: string[];
} {
  const messages: FullHistoryMessage[] = [];
  const errors: string[] = [];
  for (const line of raw.trim().split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as FullHistoryMessage & {
        type: "history";
      };
      if (entry.type !== "history") continue;

      if (entry.role === "system") {
        messages.push({
          role: "system",
          content: entry.content,
          timestamp: entry.timestamp,
          context: entry.context,
          ...(entry.compaction ? { compaction: entry.compaction } : {}),
        });
      } else if (entry.role === "user") {
        messages.push({
          role: "user",
          content: entry.content,
          timestamp: entry.timestamp,
        });
      } else if (entry.role === "assistant") {
        messages.push({
          role: "assistant",
          content: entry.content,
          timestamp: entry.timestamp,
          meta: entry.meta,
        });
      } else if (entry.role === "toolResult") {
        messages.push({
          role: "toolResult",
          toolCallId: entry.toolCallId,
          parentToolCallId: entry.parentToolCallId,
          toolName: entry.toolName,
          content: entry.content,
          isError: entry.isError,
          details: entry.details,
          view: entry.view,
          timestamp: entry.timestamp,
        });
      }
    } catch (err) {
      errors.push(String(err));
    }
  }
  return { messages: orderMessagesByTimestamp(messages), errors };
}

/** Adapt ordered full history, preserving the original #index anchors. */
export function legacyTranscript(
  messages: FullHistoryMessage[],
  owner: { agentId: string; sessionId: string }
): TranscriptEntry[] {
  const ref = legacySessionRef(owner.agentId, owner.sessionId);
  const idAt = (index: number) => `${ref}#${index}`;
  const results = new Map<string, NonNullable<ToolStep["result"]>>();
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") {
      results.set(message.toolCallId, {
        id: idAt(index),
        text: messageText(message),
        isError: message.isError,
      });
    }
  }

  const transcript: TranscriptEntry[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const toolCalls = messageToolCalls(message).map(
      ({ id, name, arguments: args }) => {
        const result = results.get(id);
        return {
          callId: id,
          name,
          arguments: args,
          ...(result ? { result } : {}),
        };
      }
    );
    transcript.push({
      id: idAt(index),
      role: message.role,
      text: messageText(message),
      timestamp: message.timestamp,
      ...(toolCalls.length ? { toolCalls } : {}),
    });
  }
  return transcript;
}
