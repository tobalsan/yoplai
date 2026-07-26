import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@yoplai/shared";
import { formatToolNote, ToolNotes } from "./tool-notes.js";

function toolCall(
  name: string,
  args?: unknown,
  id = "t1"
): StreamEvent {
  return { type: "tool_call", id, name, arguments: args };
}

function toolResult(name: string, isError = false, id = "t1"): StreamEvent {
  return { type: "tool_result", id, name, content: "ok", isError };
}

describe("formatToolNote", () => {
  it("formats a tool call with an object-argument hint", () => {
    expect(
      formatToolNote(toolCall("search_files", { path: "src/index.ts" }))
    ).toBe("🔧 search_files (src/index.ts)");
  });

  it("formats a tool call with a string argument", () => {
    expect(formatToolNote(toolCall("shell", "ls -la"))).toBe("🔧 shell (ls -la)");
  });

  it("formats a tool call without usable arguments", () => {
    expect(formatToolNote(toolCall("list_dir", {}))).toBe("🔧 list_dir");
    expect(formatToolNote(toolCall("ping"))).toBe("🔧 ping");
  });

  it("formats a successful tool result", () => {
    expect(formatToolNote(toolResult("search_files"))).toBe("✓ search_files");
  });

  it("formats a failed tool result", () => {
    expect(formatToolNote(toolResult("search_files", true))).toBe(
      "⚠ search_files failed"
    );
  });

  it("ignores non-tool events", () => {
    expect(formatToolNote({ type: "text", data: "hi" })).toBeNull();
    expect(formatToolNote({ type: "thinking", data: "hmm" })).toBeNull();
  });

  it("clamps a long argument hint", () => {
    const note = formatToolNote(toolCall("q", { query: "x".repeat(200) }));
    expect(note).toMatch(/^🔧 q \(x+…\)$/);
    expect(note!.length).toBeLessThanOrEqual(120);
  });
});

describe("ToolNotes coalescing", () => {
  it("flushes the first note immediately, then throttles by interval", () => {
    let now = 0;
    const notes = new ToolNotes({ minFlushIntervalMs: 1000, now: () => now });

    notes.push(toolCall("a"));
    // First flush is due (no prior flush).
    expect(notes.takeFlush()).toEqual({ text: "🔧 a", count: 1 });

    // A second note arrives before the interval elapses → not yet due.
    now = 500;
    notes.push(toolCall("b"));
    expect(notes.takeFlush()).toBeNull();

    // Once the interval passes, the buffered note(s) surface as one batch.
    now = 1000;
    notes.push(toolResult("b"));
    expect(notes.takeFlush()).toEqual({ text: "🔧 b\n✓ b", count: 2 });
  });

  it("flushes early when the batch ceiling is reached", () => {
    const now = 0;
    const notes = new ToolNotes({
      minFlushIntervalMs: 10_000,
      maxPendingNotes: 3,
      now: () => now,
    });

    // Prime the first flush so subsequent ones are interval-gated.
    notes.push(toolCall("seed"));
    expect(notes.takeFlush()).not.toBeNull();

    // Interval has not elapsed, but hitting the ceiling forces a flush.
    notes.push(toolCall("a"));
    notes.push(toolCall("b"));
    expect(notes.takeFlush()).toBeNull();
    notes.push(toolCall("c"));
    const flush = notes.takeFlush();
    expect(flush?.count).toBe(3);
    expect(flush?.text).toBe("🔧 a\n🔧 b\n🔧 c");
  });

  it("ignores text/thinking events", () => {
    const notes = new ToolNotes();
    notes.push({ type: "text", data: "hello" });
    notes.push({ type: "thinking", data: "..." });
    expect(notes.pendingCount).toBe(0);
    expect(notes.takeFlush()).toBeNull();
  });

  it("drains remaining notes on takeFinal regardless of interval", () => {
    let now = 0;
    const notes = new ToolNotes({ minFlushIntervalMs: 10_000, now: () => now });
    notes.push(toolCall("a"));
    expect(notes.takeFlush()).not.toBeNull();

    now = 1; // well within the interval
    notes.push(toolResult("a"));
    expect(notes.takeFlush()).toBeNull();
    expect(notes.takeFinal()).toEqual({ text: "✓ a", count: 1 });
    // Nothing left to drain.
    expect(notes.takeFinal()).toBeNull();
  });
});
