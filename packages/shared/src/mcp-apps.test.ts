import { expect, it } from "vitest";
import { CapabilitiesResponseSchema, ContainerFileOutputRequestSchema, GatewayConfigSchema, GatewayRootConfigSchema, HistoryEventSchema, McpAppViewReferenceSchema, StreamEventSchema } from "./types.js";

// ALG-614 seams approved by Thinh in fa28457a-d6a4-4709-97cd-91ff575553b9.
it("accepts optional send_file titles up to 200 characters and preserves file replay metadata", () => {
  expect(ContainerFileOutputRequestSchema.parse({ type: "file_output", path: "/workspace/files/report.html" })).toEqual({ type: "file_output", path: "/workspace/files/report.html" });
  expect(ContainerFileOutputRequestSchema.parse({ type: "file_output", path: "/workspace/files/report.html", title: "a".repeat(200) }).title).toHaveLength(200);
  expect(() => ContainerFileOutputRequestSchema.parse({ type: "file_output", path: "/workspace/files/report.html", title: "a".repeat(201) })).toThrow();
  const file = { fileId: "file-1", filename: "report.html", mimeType: "text/html", size: 42, title: "Quarterly report" };
  expect(McpAppViewReferenceSchema.parse({ recordId: "record-1", server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer", file })).toHaveProperty("file", file);
});

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
