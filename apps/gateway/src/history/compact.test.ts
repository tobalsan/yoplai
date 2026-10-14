import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FullHistoryMessage } from "@yoplai/shared";
let tmpDir = "";
vi.mock("../config/index.js", () => ({ get CONFIG_DIR() { return tmpDir; } }));
vi.mock("@yoplai/extension-multi-user/isolation", () => ({
  getUserHistoryDir: (userId: string | undefined, configDir: string) => userId ? path.join(configDir, "users", userId, "history") : path.join(configDir, "history"),
}));
vi.mock("../sessions/store.js", () => ({ getSessionCreatedAt: vi.fn(() => 1) }));

async function seed(messages: FullHistoryMessage[]) {
  const dir = path.join(tmpDir, "history");
  await mkdir(dir, { recursive: true });
  const content = messages.map((message) => JSON.stringify({ type: "history", agentId: "alpha", sessionId: "s1", ...message })).join("\n") + "\n";
  await writeFile(path.join(dir, "alpha-s1.jsonl"), content);
  return content;
}

describe("durable compaction history", () => {
  beforeEach(async () => { tmpDir = await mkdtemp(path.join(os.tmpdir(), "yoplai-compact-")); });
  afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); vi.resetModules(); });

  it("preserves original records byte-for-byte including tools, thinking, attachments and usage", async () => {
    const { appendCanonicalCompaction, getFullHistory } = await import("./store.js");
    const messages: FullHistoryMessage[] = Array.from({ length: 24 }, (_, i) => ({ role: "user", content: [{ type: "text", text: `message ${i}` }], timestamp: i }));
    messages.push({ role: "assistant", timestamp: 24, content: [{ type: "thinking", thinking: "reasoning" }, { type: "toolCall", id: "tc", name: "read", arguments: {} }], meta: { model: "test", usage: { input: 120000, output: 2, totalTokens: 120002 } } });
    messages.push({ role: "toolResult", toolCallId: "tc", toolName: "read", content: [{ type: "text", text: "result" }], timestamp: 25, isError: false });
    messages[0]!.content.push({ type: "file", fileId: "attachment-1", filename: "notes.txt", mimeType: "text/plain", size: 4, direction: "inbound" });
    const original = await seed(messages);
    for (const id of ["first", "second"]) await appendCanonicalCompaction({ agentId: "alpha", sessionId: "s1", summary: `summary ${id}`, recentMessages: messages.slice(-16), coveredThrough: 25, id });
    const stored = await readFile(path.join(tmpDir, "history", "alpha-s1.jsonl"), "utf-8");
    expect(stored.startsWith(original)).toBe(true);
    const history = await getFullHistory("alpha", "s1");
    expect(history).toHaveLength(messages.length + 2);
    expect(history.slice(0, messages.length)).toEqual(messages);
    expect(history.slice(-2).map((message) => message.role === "system" ? message.compaction?.id : undefined)).toEqual(["first", "second"]);
  });

  it("keeps legacy prefix summaries readable", async () => {
    const { getFullHistory } = await import("./store.js");
    await seed([{ role: "system", content: [{ type: "text", text: "[COMPACTED CONTEXT SUMMARY]\nlegacy" }], timestamp: 1 }]);
    expect(await getFullHistory("alpha", "s1")).toMatchObject([{ role: "system", content: [{ text: "[COMPACTED CONTEXT SUMMARY]\nlegacy" }] }]);
  });

  it("isolates users and sanitizes newly appended summaries", async () => {
    const { appendCanonicalCompaction, getFullHistory } = await import("./store.js");
    await appendCanonicalCompaction({ agentId: "alpha", sessionId: "s1", userId: "u1", summary: "Authorization: Bearer compact-history-canary", recentMessages: [], coveredThrough: 0, id: "c1" });
    expect(await getFullHistory("alpha", "s1", "u2")).toEqual([]);
    const dir = path.join(tmpDir, "users", "u1", "history");
    const [file] = await readdir(dir);
    expect(await readFile(path.join(dir, file!), "utf-8")).not.toContain("compact-history-canary");
  });
});
