import type { FeedItem } from "@yoplai/shared";

export type RoomMessage = {
  roomId: string;
  seq: number;
  id: string;
  producerId: string;
  authorId: string;
  authorName: string;
  audience: string;
  text: string;
  timestamp: number;
  authorKind?: "user" | "agent" | "digest";
  agentId?: string | null;
  ref?: { conversationId: number; answerId: number } | null;
  mentions?: string[];
};

export function projectRoomMessage(row: RoomMessage): FeedItem {
  const { id, text, timestamp } = row;
  if (row.authorKind === "agent") {
    return { id, role: "assistant", text, timestamp, sender: row.authorName, toolCallCount: 0 };
  }
  if (row.authorKind === "digest") {
    return { id, role: "user", text, timestamp, sender: "Thread digest" };
  }
  return { id, role: "user", text, timestamp, sender: row.authorName, surface: "web" };
}
