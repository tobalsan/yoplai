import { expect, it } from "vitest";
import { CapabilitiesResponseSchema, GatewayConfigSchema, GatewayRootConfigSchema, HistoryEventSchema, StreamEventSchema } from "./types.js";

it("preserves view identity through gateway stream and runner history protocols", () => {
  const marker = { server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" };
  const view = { recordId: "00112233445566778899aabbccddeeff", ...marker };
  expect(StreamEventSchema.parse({
    type: "tool_call", id: "call-1", name: "drawing_draw", arguments: {}, view: marker,
  })).toEqual({
    type: "tool_call", id: "call-1", name: "drawing_draw", arguments: {}, view: marker,
  });
  expect(HistoryEventSchema.parse({
    type: "tool_call", id: "call-1", name: "drawing_draw", args: {}, timestamp: 1, view: marker,
  })).toHaveProperty("view", marker);
  const result = { type: "tool_result", id: "call-1", name: "drawing_draw", content: "unchanged", isError: false, view };
  expect(StreamEventSchema.parse(result)).toEqual(result);
  expect(HistoryEventSchema.parse({ ...result, timestamp: 2 })).toHaveProperty("view", view);
});

it("retains apps configuration and reports listener availability to clients", () => {
  const apps = { origin: "https://views.example.net", port: 4101 };
  expect(GatewayRootConfigSchema.parse({ apps })).toHaveProperty("apps", apps);
  expect(GatewayConfigSchema.parse({ agents: [], apps })).toHaveProperty("apps", apps);
  expect(CapabilitiesResponseSchema.parse({
    version: 1, extensions: {}, agents: [], multiUser: false, apps: { available: false },
  })).toHaveProperty("apps", { available: false });
});
