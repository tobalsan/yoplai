import { expect, it } from "vitest";
import { applyVisibleOrder, mergeGatewayOrder, projectForGateway } from "./sidebar-ordering.js";

it("preserves hidden slots and inserts a new visible agent where it was dropped", () => {
  const stored = ["A", "B", "C", "D", "E", "F"];
  expect(applyVisibleOrder(stored, ["B", "C", "E"])).toEqual(["A", "B", "C", "D", "E", "F"]);
  expect(applyVisibleOrder(stored, ["E", "B", "C"])).toEqual(["A", "E", "B", "D", "C", "F"]);
  expect(applyVisibleOrder(["A", "B"], ["A", "R", "B"])).toEqual(["A", "R", "B"]);
});

it("projects only the gateway's IDs and refills its slots with the peer's order", () => {
  const isLocal = (id: string) => id === "local@Studio";
  const stored = ["pilot@Studio", "L", "offline@Studio", "other@Cabin", "local@Studio", "name@team@Studio"];
  expect(projectForGateway(stored, "Studio", isLocal)).toEqual(["pilot", "offline", "name@team"]);
  const peerOrder = ["new", "name@team", "pilot", "local", "../unsupported"];
  const merged = mergeGatewayOrder(stored, "Studio", peerOrder, isLocal);
  expect(merged).toEqual(["new@Studio", "L", "offline@Studio", "other@Cabin", "local@Studio", "name@team@Studio", "pilot@Studio"]);
  expect(mergeGatewayOrder(merged, "Studio", peerOrder, isLocal))
    .toEqual(["new@Studio", "L", "offline@Studio", "other@Cabin", "local@Studio", "name@team@Studio", "pilot@Studio"]);
});
