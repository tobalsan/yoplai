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
};

export function projectRoomMessage(row: RoomMessage): Extract<FeedItem, { role: "user" }> {
  return { id: row.id, role: "user", text: row.text, timestamp: row.timestamp, sender: row.authorName, surface: "web" };
}
