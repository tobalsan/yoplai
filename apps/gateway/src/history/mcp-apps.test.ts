import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryEventSchema } from "@yoplai/shared";

let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-apps-history-"));
  vi.stubEnv("YOPLAI_HOME", home);
  vi.resetModules();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

it("replays a result reference after reload while call markers stay live only", async () => {
  const store = await import("./store.js");
  const marker = { server: "drawing", tool: "draw", resourceUri: "ui://drawing/view" };
  const view = { recordId: "00112233445566778899aabbccddeeff", ...marker };
  const buffer = store.createTurnBuffer();
  store.bufferHistoryEvent(buffer, HistoryEventSchema.parse({
    type: "tool_call", id: "call-1", name: "drawing_draw", args: { shape: "circle" }, timestamp: 1, view: marker,
  }));
  store.bufferHistoryEvent(buffer, HistoryEventSchema.parse({
    type: "tool_result", id: "call-1", name: "drawing_draw", content: "Model's unchanged text", isError: false, timestamp: 2, view,
  }));
  expect(buffer.toolCalls[0]).toHaveProperty("view", marker);
  expect(buffer.toolResults[0]).toHaveProperty("view", view);
  expect(store.snapshotTurnBuffer(buffer).find(message => message.role === "toolResult")).toHaveProperty("view", view);
  await store.flushTurnBuffer("artist", "chat-1", buffer, "alice");
  vi.resetModules();
  const reloaded = await import("./store.js");
  const history = await reloaded.getFullHistory("artist", "chat-1", "alice");
  expect(history).toEqual([
    { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "call-1", name: "drawing_draw", arguments: { shape: "circle" } }] },
    { role: "toolResult", timestamp: 2, toolCallId: "call-1", toolName: "drawing_draw", content: [{ type: "text", text: "Model's unchanged text" }], isError: false, view },
  ]);
  expect(await reloaded.getFullHistory("artist", "chat-1", "bob")).toEqual([]);
});

it("loads old text-only results without inventing replay references", async () => {
  await fs.mkdir(path.join(home, "history"), { recursive: true });
  await fs.writeFile(path.join(home, "history", "artist-old-chat.jsonl"),
    '{"type":"history","role":"toolResult","toolCallId":"old-call","toolName":"drawing_draw","content":[{"type":"text","text":"Old drawing"}],"isError":false,"timestamp":1}\n');
  const store = await import("./store.js");
  expect(await store.getFullHistory("artist", "old-chat")).toEqual([
    { role: "toolResult", toolCallId: "old-call", toolName: "drawing_draw", content: [{ type: "text", text: "Old drawing" }], isError: false, timestamp: 1 },
  ]);
});
