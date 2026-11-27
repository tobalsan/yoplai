import { expect, it } from "vitest";
import { roomMentions } from "./mentions.js";

it("recognizes complete agent IDs and resolves case collisions only by exact spelling", () => {
  expect(roomMentions(
    "email@Scout @ghost @PILOT-X @pilot_x @PilotX @Pilot.notes @Pilot, @SCOUT @Scout: @scout.",
    ["Pilot", "pilot-x", "Scout", "scout"],
  )).toEqual(["pilot-x", "Pilot", "Scout", "scout"]);
});
