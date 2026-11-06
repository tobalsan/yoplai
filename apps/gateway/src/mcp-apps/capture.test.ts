import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentConfigSchema, GatewayConfigSchema } from "@yoplai/shared";

// Thinh approved public capture/read/clear/delete with real files in ALG-599
// comment f0b31b16-5802-41d7-aa24-72d7e959dd59. This catches replay lookup and
// record identity; HTTP authorization and browser delivery are covered elsewhere.
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-app-records-"));
  vi.stubEnv("YOPLAI_HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

function context(toolCallId: string) {
  return {
    agent: AgentConfigSchema.parse({ id: "artist", name: "Artist", workspace: path.join(home, "workspace"), model: { provider: "test", model: "test" } }),
    config: GatewayConfigSchema.parse({ agents: [] }), sessionId: "drawing", toolCallId,
  };
}
const mcp = { server: "canvas", tool: "draw", ui: { resourceUri: "ui://canvas/view", visibility: ["model" as const, "app" as const] } };

it("reads captured calls among many records after a turn ends without listing the directory again", async () => {
  const capture = await import("./capture.js");
  for (let index = 0; index < 40; index++) {
    await capture.captureMcpApp(mcp, context(`call-${index}`), { shape: "box" }, { content: [{ type: "text", text: "Drawing" }] });
  }
  capture.clearMcpAppViews({ agentId: "artist", sessionId: "drawing" });
  const dir = path.join(home, "history", "mcp-apps", "artist", "drawing");
  await fs.chmod(dir, 0o111);
  try {
    await expect(fs.readdir(dir)).rejects.toMatchObject({ code: "EACCES" });
    expect(await capture.readMcpAppRecord({ agentId: "artist", sessionId: "drawing" }, "call-17")).toMatchObject({
      toolCallId: "call-17", args: { shape: "box" }, result: { content: [{ type: "text", text: "Drawing" }] },
    });
  } finally { await fs.chmod(dir, 0o700); }
});

it("discovers persisted records after restart and reuses that lookup on subsequent reads", async () => {
  const initial = await import("./capture.js");
  await initial.captureMcpApp(mcp, context("saved-call"), { shape: "circle" }, { content: [{ type: "text", text: "Saved drawing" }] });
  vi.resetModules();
  const reloaded = await import("./capture.js");
  expect(await reloaded.readMcpAppRecord({ agentId: "artist", sessionId: "drawing" }, "unknown-call")).toBeUndefined();
  const dir = path.join(home, "history", "mcp-apps", "artist", "drawing");
  await fs.chmod(dir, 0o111);
  try {
    expect(await reloaded.readMcpAppRecord({ agentId: "artist", sessionId: "drawing" }, "saved-call")).toMatchObject({
      toolCallId: "saved-call", args: { shape: "circle" }, result: { content: [{ type: "text", text: "Saved drawing" }] },
    });
  } finally { await fs.chmod(dir, 0o700); }
});

it("revalidates every stored identity and payload field on repeated reads", async () => {
  const capture = await import("./capture.js");
  const scope = { agentId: "artist", sessionId: "drawing" };
  await capture.captureMcpApp(mcp, context("call-one"), {}, { content: [{ type: "text", text: "Original" }] });
  const record = await capture.readMcpAppRecord(scope, "call-one");
  expect(record).toBeDefined();
  const filename = path.join(home, "history", "mcp-apps", "artist", "drawing", `${record!.recordId}.json`);
  for (const invalid of [
    { recordId: "different-record" }, { agentId: "other-agent" }, { sessionId: "other-session" },
    { ownerUserId: "other-owner" }, { toolCallId: "other-call" }, { server: 7 }, { tool: null },
    { resourceUri: false }, { result: { content: "not-an-array" } },
  ]) {
    await fs.writeFile(filename, JSON.stringify({ ...record, ...invalid }));
    expect(await capture.readMcpAppRecord(scope, "call-one")).toBeUndefined();
    await fs.writeFile(filename, JSON.stringify(record));
    expect(await capture.readMcpAppRecord(scope, "call-one")).toMatchObject({ toolCallId: "call-one", result: { content: [{ type: "text", text: "Original" }] } });
  }
});

it("deletes replay data and lets a recreated session return only its new capture", async () => {
  const capture = await import("./capture.js");
  const scope = { agentId: "artist", sessionId: "drawing" };
  await capture.captureMcpApp(mcp, context("call-one"), { revision: 1 }, { content: [{ type: "text", text: "Old drawing" }] });
  expect(await capture.readMcpAppRecord(scope, "call-one")).toMatchObject({ args: { revision: 1 } });
  await capture.deleteMcpAppRecords(scope);
  expect(capture.getMcpAppView(scope, "call-one")).toBeUndefined();
  expect(await capture.readMcpAppRecord(scope, "call-one")).toBeUndefined();
  await capture.captureMcpApp(mcp, context("call-one"), { revision: 2 }, { content: [{ type: "text", text: "New drawing" }] });
  expect(await capture.readMcpAppRecord(scope, "call-one")).toMatchObject({
    args: { revision: 2 }, result: { content: [{ type: "text", text: "New drawing" }] },
  });
});

// Pom approved built-in capture -> public record/reference reads and schema
// parsing in ALG-656 comment 77af29fb; browser consumption is covered separately.
it("persists a built-in preview and preserves its reuse key and frameability through history parsing", async () => {
  const capture = await import("./capture.js");
  const { McpAppViewReferenceSchema, StreamEventSchema } = await import("@yoplai/shared");
  const identity = { agentId: "artist", sessionId: "drawing" };
  const result = {
    content: [{ type: "text", text: "Web preview shown: https://example.test/page" }],
    structuredContent: { url: "https://example.test/page#heading", finalUrl: "https://example.test/page#heading", title: "Example", frameable: true, reason: null, status: 200 },
  };
  await capture.captureYoplaiView({ ...identity, toolCallId: "preview-one" }, capture.yoplaiPreviewView,
    { url: "https://example.test/page#heading", title: "Example" }, result,
    { key: "https://example.test/page", preview: { frameable: true } });
  const view = capture.getMcpAppView(identity, "preview-one");
  expect(McpAppViewReferenceSchema.parse(view)).toMatchObject({
    server: "yoplai", tool: "web_preview", resourceUri: "ui://yoplai/web-preview",
    key: "https://example.test/page", preview: { frameable: true },
  });
  expect(StreamEventSchema.parse({ type: "tool_result", id: "preview-one", name: "web_preview", content: "Preview", isError: false, view })).toMatchObject({
    view: { key: "https://example.test/page", preview: { frameable: true } },
  });
  capture.clearMcpAppViews(identity);
  expect(await capture.readMcpAppRecord(identity, "preview-one")).toMatchObject({
    server: "yoplai", tool: "web_preview", args: { url: "https://example.test/page#heading", title: "Example" }, result,
  });
});

it("keeps send_file capture metadata and its legacy result unchanged", async () => {
  const capture = await import("./capture.js");
  const identity = { agentId: "artist", sessionId: "drawing" };
  const file = { fileId: "example-file", filename: "report.html", title: "Example report", mimeType: "text/html", size: 24 };
  await capture.captureSendFile({ ...identity, toolCallId: "file-one" }, { path: "report.html" }, file);
  expect(capture.getMcpAppView(identity, "file-one")).toEqual({
    recordId: expect.any(String), server: "yoplai", tool: "send_file", resourceUri: "ui://yoplai/file-viewer", file,
  });
  expect(await capture.readMcpAppRecord(identity, "file-one")).toMatchObject({ result: {
    content: [{ type: "text", text: "File sent to user" }], structuredContent: { uri: "yoplai-file://example-file", ...file },
  } });
});

it("silently skips only the exact built-in preview and still warns once for other reserved-server tools", async () => {
  const capture = await import("./capture.js");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = { content: [{ type: "text", text: "Example" }] };
    await capture.captureMcpApp({ server: "yoplai", tool: "web_preview", ui: { resourceUri: "ui://yoplai/web-preview", visibility: ["model"] } }, context("builtin"), {}, result);
    expect(warn).not.toHaveBeenCalled();
    await capture.captureMcpApp({ server: "yoplai", tool: "web_preview", ui: { resourceUri: "ui://example.test/pretend", visibility: ["model"] } }, context("wrong-resource"), {}, result);
    await capture.captureMcpApp({ server: "yoplai", tool: "other", ui: { resourceUri: "ui://yoplai/web-preview", visibility: ["model"] } }, context("other"), {}, result);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ server: "yoplai", outcome: "reserved_server" });
    expect(await capture.readMcpAppRecord({ agentId: "artist", sessionId: "drawing" }, "other")).toBeUndefined();
  } finally { warn.mockRestore(); }
});
