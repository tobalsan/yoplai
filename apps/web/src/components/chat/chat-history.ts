import type { Message, FullHistoryMessage, FullToolResultMessage, ContentBlock, FileBlock, ModelMeta } from "../../api/types";
import { isNoReply } from "@yoplai/shared/no-reply";
import { extractBlockText } from "../../lib/history";
import type { ActivityItem } from "./ChatBlocks";

export function userText(message: FullHistoryMessage): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}


export type SimpleToolMessage = {
  id: string;
  parentToolCallId?: string;
  result?: FullToolResultMessage;
  role: "tool";
  toolName: string;
  arguments?: unknown;
  timestamp: number;
};

export type SimpleThinkingMessage = {
  id: string;
  role: "thinking";
  content: string;
  timestamp: number;
  endedAt?: number;
};

export type SimpleSummaryMessage = {
  id: string;
  role: "compaction";
  content: string;
  timestamp: number;
};

export type SimpleViewMessage = Message | SimpleToolMessage | SimpleThinkingMessage | SimpleSummaryMessage;

const COMPACT_SUMMARY_PREFIX = "[COMPACTED CONTEXT SUMMARY]";

export function compactSummary(message: FullHistoryMessage): string | undefined {
  if (message.role !== "system") return undefined;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => extractBlockText(block.text))
    .join("\n");
  return text.startsWith(COMPACT_SUMMARY_PREFIX)
    ? text.slice(COMPACT_SUMMARY_PREFIX.length).trim()
    : undefined;
}


export type FullDisplayRow =
  | { kind: "activity"; item: ActivityItem; historyIndex: number }
  | {
      kind: "assistant-content";
      historyIndex: number;
      block: Extract<ContentBlock, { type: "text" | "file" }>;
      timestamp: number;
      meta?: ModelMeta;
      footer: boolean;
    }
  | { kind: "message"; message: FullHistoryMessage; historyIndex: number };

export function fullHistoryDisplayRows(
  messages: FullHistoryMessage[],
  toolResults: Map<string, FullToolResultMessage>
): FullDisplayRow[] {
  const rows: FullDisplayRow[] = [];
  messages.forEach((message, historyIndex) => {
    if (message.role === "toolResult") return;
    if (message.role !== "assistant") {
      rows.push({ kind: "message", message, historyIndex });
      return;
    }
    const visibleBlocks = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "text" | "file" }> =>
        block.type === "text" || block.type === "file"
    );
    let visibleIndex = 0;
    for (const block of message.content) {
      if (block.type === "thinking") {
        rows.push({
          kind: "activity",
          historyIndex,
          item: {
            type: "thinking",
            content: block.thinking,
            startedAt: block.startedAt,
            endedAt: block.endedAt,
          },
        });
      } else if (block.type === "toolCall") {
        rows.push({
          kind: "activity",
          historyIndex,
          item: {
            type: "tool",
            id: block.id,
            parentToolCallId: block.parentToolCallId,
            name: block.name,
            arguments: block.arguments,
            result: toolResults.get(block.id),
            at: message.timestamp,
          },
        });
      } else if (block.type === "text" || block.type === "file") {
        visibleIndex += 1;
        rows.push({
          kind: "assistant-content",
          historyIndex,
          block,
          timestamp: message.timestamp,
          meta: message.meta,
          footer: visibleIndex === visibleBlocks.length,
        });
      }
    }
  });
  return rows;
}

export function fullMessagesToSimpleView(
  messages: FullHistoryMessage[]
): SimpleViewMessage[] {
  const simple: SimpleViewMessage[] = [];
  const results = new Map(
    messages.filter((message): message is FullToolResultMessage => message.role === "toolResult")
      .map((message) => [message.toolCallId, message])
  );
  for (const message of messages) {
    const summary = compactSummary(message);
    if (summary !== undefined) {
      simple.push({ id: crypto.randomUUID(), role: "compaction", content: summary, timestamp: message.timestamp });
      continue;
    }
    if (message.role === "toolResult" || message.role === "system") continue;
    if (message.role === "user") {
      const text = message.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text"
        )
        .map((block) => block.text)
        .join("\n");
      simple.push({
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        files: message.content.filter(
          (block): block is FileBlock => block.type === "file"
        ),
        timestamp: message.timestamp,
      });
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text" && block.text.trim() && !isNoReply(block.text)) {
        simple.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: block.text,
          meta: message.meta,
          timestamp: message.timestamp,
        });
      } else if (block.type === "thinking" && block.thinking.trim()) {
        simple.push({
          id: crypto.randomUUID(),
          role: "thinking",
          content: block.thinking,
          timestamp: block.startedAt ?? message.timestamp,
          endedAt: block.endedAt,
        });
      } else if (block.type === "toolCall") {
        simple.push({
          id: block.id,
          parentToolCallId: block.parentToolCallId,
          result: results.get(block.id),
          role: "tool",
          toolName: block.name,
          arguments: block.arguments,
          timestamp: message.timestamp,
        });
      } else if (block.type === "file") {
        simple.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          files: [block],
          timestamp: message.timestamp,
        });
      }
    }
  }
  return simple;
}
