import { expect, it } from "vitest";
import { OpsMetrics } from "./ops-metrics.js";

it("counts each metric by id and agent within one gateway", () => {
  const metrics = new OpsMetrics();
  const anotherGateway = new OpsMetrics();
  expect(metrics.snapshot()).toEqual([]);
  metrics.increment("interrupted_tool_calls", "orchard");
  metrics.increment("interrupted_tool_calls", "greenhouse");
  metrics.increment("interrupted_tool_calls", "orchard");
  metrics.increment("fixture_counter", "orchard");

  expect(metrics.snapshot()).toEqual([
    { id: "interrupted_tool_calls", agentId: "orchard", value: 2 },
    { id: "interrupted_tool_calls", agentId: "greenhouse", value: 1 },
    { id: "fixture_counter", agentId: "orchard", value: 1 },
  ]);
  expect(anotherGateway.snapshot()).toEqual([]);
});
