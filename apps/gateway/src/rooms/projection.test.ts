import { expect, it } from "vitest";
import { projectRoomMessage } from "./projection.js";

it("exposes only the public fields of a room message", () => {
  const row = {
    id: "r_3", roomId: "orchard", seq: 3, producerId: "web:fixture:note",
    authorId: "fixture", authorName: "Alice", audience: "room:orchard",
    text: "Pick the pears", timestamp: 1234, privateNote: "internal",
  };
  expect(projectRoomMessage(row)).toEqual({
    id: "r_3", role: "user", text: "Pick the pears", timestamp: 1234, sender: "Alice", surface: "web",
  });
});
