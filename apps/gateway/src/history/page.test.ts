import { describe, expect, it } from "vitest";
import type { FullHistoryMessage } from "@yoplai/shared";
import { activeContextUsage, historyPage } from "./page.js";

describe("history pagination and active context", () => {
  it("reaches all 1000 originals once with timestamp ties through bounded pages", () => {
    const messages: FullHistoryMessage[] = Array.from({ length: 1000 }, (_, i) => ({ role: "user", timestamp: Math.floor(i / 3), content: [{ type: "text", text: `${i}` }] }));
    const loaded: FullHistoryMessage[] = [];
    let before: string | undefined;
    do {
      const page = historyPage(messages, 100, before);
      expect(page.messages.length).toBeLessThanOrEqual(100);
      expect(page.historyOffset).toBe(messages.indexOf(page.messages[0]!));
      loaded.unshift(...page.messages);
      before = page.nextCursor;
    } while (before);
    expect(loaded).toEqual(messages);
  });
  it("keeps tool calls and their results together across page boundaries", () => {
    const messages: FullHistoryMessage[] = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "read" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "tc", name: "read", arguments: {} }] },
      { role: "toolResult", timestamp: 3, content: [{ type: "text", text: "result" }], toolCallId: "tc", toolName: "read", isError: false },
      { role: "assistant", timestamp: 4, content: [{ type: "text", text: "done" }] },
    ];
    const page = historyPage(messages, 2);
    expect(page.messages).toEqual(messages.slice(1));
    expect(historyPage(messages, 2, page.nextCursor).messages).toEqual(messages.slice(0, 1));
  });
  it("follows tool identities when a user message interleaves the call and result", () => {
    const messages: FullHistoryMessage[] = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "initial" }] },
      { role: "assistant", timestamp: 2, content: [{ type: "toolCall", id: "tc", name: "read", arguments: {} }] },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "interleaved" }] },
      { role: "toolResult", timestamp: 4, content: [{ type: "text", text: "result" }], toolCallId: "tc", toolName: "read", isError: false },
    ];
    const page = historyPage(messages, 2);
    expect(page.messages).toEqual(messages.slice(1));
    expect(historyPage(messages, 2, page.nextCursor).messages).toEqual(messages.slice(0, 1));
  });
  it("ignores archived usage after a compaction and uses subsequent usage independently of pages", () => {
    const messages: FullHistoryMessage[] = [
      { role: "assistant", timestamp: 1, content: [], meta: { usage: { input: 120000, output: 1, totalTokens: 120001 } } },
      { role: "system", timestamp: 2, content: [{ type: "text", text: "[COMPACTED CONTEXT SUMMARY]\nsummary" }], compaction: { id: "c1", coveredThrough: 1 } },
    ];
    expect(activeContextUsage(messages)).toEqual({ inputTokens: 0 });
    messages.push({ role: "assistant", timestamp: 3, content: [], meta: { model: "small", usage: { input: 100, cacheRead: 10, output: 1, totalTokens: 111 } } });
    expect(activeContextUsage(messages)).toEqual({ inputTokens: 110, model: "small" });
  });
  it("rejects malformed cursors", () => {
    expect(() => historyPage([], 100, "bad")).toThrow();
  });
});
