import { expect, it } from "vitest";
import { roomInput, roomHandoffTranscript } from "./context.js";
import type { RoomMessage } from "./projection.js";

function event(seq: number, authorName: string, text: string, detail: Partial<RoomMessage> = {}): RoomMessage {
  return {
    roomId: "orchard", seq, id: "r_" + seq, producerId: "test-" + seq, authorId: authorName,
    authorName, audience: "room:orchard", text, timestamp: 100 + seq, ...detail,
  };
}

it("builds ordered attributed input from a delivery window and a public handoff from history", () => {
  const rows = [
    event(1, "Alice", "Two pear trees"),
    event(2, "Scout", "The south bed is ready", { authorKind: "agent", agentId: "scout" }),
    event(3, "Pilot", "I already checked the shed", { authorKind: "agent", agentId: "pilot" }),
    event(4, "Internal", "Order new stakes", { authorKind: "digest" }),
    event(5, "Bob", "@pilot Check the order", { mentions: ["pilot"] }),
  ];
  expect(roomInput(rows.slice(1), "pilot")).toEqual({
    eventIds: ["r_2", "r_4", "r_5"],
    anchor: "r_5",
    content: "[from Scout via web]\nThe south bed is ready\n\n[from Thread digest via web]\nOrder new stakes\n\n[from Bob via web]\n@pilot Check the order",
  });
  expect(roomHandoffTranscript(rows.slice(0, 4), "pilot")).toEqual([
    { id: "r_1", role: "user", timestamp: 101, author: { name: "Alice" }, text: "Two pear trees" },
    { id: "r_2", role: "assistant", timestamp: 102, author: { name: "Scout" }, text: "The south bed is ready" },
    { id: "r_4", role: "user", timestamp: 104, author: { name: "Thread digest" }, text: "Order new stakes" },
  ]);
});
