import { describe, expect, it, vi } from "vitest";
import { createNoReplyHoldback, isNoReply } from "./no-reply.js";
import type { StreamEvent } from "@yoplai/shared";

describe("no reply", () => {
  it.each(["NO_REPLY", " NO_REPLY. ", "*NO_REPLY*", "**NO_REPLY**", "`NO_REPLY`"])(
    "recognizes %s",
    (text) => expect(isNoReply(text)).toBe(true)
  );

  it("does not recognize token mixed with other text", () => {
    expect(isNoReply("NO_REPLY thanks")).toBe(false);
  });

  it("holds a complete token while passing non-text events", () => {
    const emit = vi.fn<(event: StreamEvent) => void>();
    const holdback = createNoReplyHoldback(emit);
    holdback.push({ type: "text", data: "NO_" });
    holdback.push({ type: "thinking", data: "hmm" });
    holdback.push({ type: "text", data: "REPLY" });
    holdback.drop();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ type: "thinking", data: "hmm" });
  });

  it("resets at tool boundaries without concatenating assistant messages", () => {
    const emit = vi.fn<(event: StreamEvent) => void>();
    const holdback = createNoReplyHoldback(emit);
    holdback.push({ type: "text", data: "NO_REPLY" });
    holdback.push({ type: "tool_start", toolName: "check" });
    holdback.push({ type: "text", data: "Hello" });
    holdback.flush();
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "tool_start", toolName: "check" },
      { type: "text", data: "Hello" },
    ]);
  });

  it("flushes a non-silent assistant message before its tool boundary", () => {
    const emit = vi.fn<(event: StreamEvent) => void>();
    const holdback = createNoReplyHoldback(emit);
    holdback.push({ type: "text", data: "NO" });
    holdback.push({ type: "tool_call", id: "1", name: "check", arguments: {} });
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "text", data: "NO" },
      { type: "tool_call", id: "1", name: "check", arguments: {} },
    ]);
  });

  it("flushes buffered text as one event when it diverges", () => {
    const emit = vi.fn<(event: StreamEvent) => void>();
    const holdback = createNoReplyHoldback(emit);
    holdback.push({ type: "text", data: "NO" });
    holdback.push({ type: "text", data: " thanks" });
    holdback.push({ type: "text", data: "!" });
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "text", data: "NO thanks" },
      { type: "text", data: "!" },
    ]);
  });
});
