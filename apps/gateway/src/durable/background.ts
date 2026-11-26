import { messageText, messageToolCalls } from "../history/condense.js";
import type { ToolStep, TranscriptEntry } from "../history/transcript.js";
import type { PublicRecord } from "./feed-projection.js";

export function handoffTranscript(records: PublicRecord[]): TranscriptEntry[] {
  const results = new Map<string, NonNullable<ToolStep["result"]>>();
  let answerId: string | undefined;
  for (const record of records) {
    if (record.kind !== "result") {
      answerId = record.kind === "assistant" ? record.id : undefined;
      continue;
    }
    if (answerId === undefined) continue;
    const { message } = record;
    results.set(message.toolCallId, { id: answerId, text: messageText(message), isError: message.isError });
  }

  return records.flatMap((record) => {
    if (record.kind !== "user" && record.kind !== "assistant") return [];
    const { id, message } = record;
    const toolCalls = messageToolCalls(message).map(({ id: callId, name, arguments: args }) => ({
      callId, name, arguments: args, result: results.get(callId),
    }));
    return [{
      id, role: message.role, timestamp: message.timestamp, text: messageText(message),
      ...(record.kind === "user" && { author: { name: record.sender } }),
      ...(toolCalls.length > 0 && { toolCalls }),
    }];
  });
}
