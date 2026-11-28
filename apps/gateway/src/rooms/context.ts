import type { TranscriptEntry } from "../history/transcript.js";
import type { RoomMessage } from "./projection.js";

function authorName(row: RoomMessage) {
  return row.authorKind === "digest" ? "Thread digest" : row.authorName;
}

function visibleTo(rows: RoomMessage[], agentId: string) {
  return rows.filter((row) => row.authorKind !== "agent" || row.agentId !== agentId);
}

export function roomInput(rows: RoomMessage[], agentId: string) {
  const events = visibleTo(rows, agentId);
  if (!events.length) return;
  const anchor = events.find((row) => row.authorKind !== "agent" && row.authorKind !== "digest" && row.mentions?.includes(agentId));
  return {
    eventIds: events.map(({ id }) => id),
    anchor: anchor?.id,
    content: events.map((row) =>
      "[from " + authorName(row).replace(/[\r\n[\]]/g, " ") + " via web]\n" + row.text).join("\n\n"),
  };
}

export function roomHandoffTranscript(rows: RoomMessage[], agentId: string): TranscriptEntry[] {
  return visibleTo(rows, agentId).map((row) => ({
    id: row.id, role: row.authorKind === "agent" ? "assistant" : "user",
    timestamp: row.timestamp, text: row.text, author: { name: authorName(row) },
  }));
}
