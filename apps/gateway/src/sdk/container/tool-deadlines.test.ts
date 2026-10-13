import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolDeadlines } from "./tool-deadlines.js";
import type { HistoryEvent } from "../types.js";
const start = (id: string, name = "bash", args = {}): HistoryEvent => ({
  type: "tool_call",
  id,
  name,
  args,
  timestamp: -999,
});
const end = (id: string): HistoryEvent => ({
  type: "tool_result",
  id,
  name: "bash",
  content: "ok",
  isError: false,
  timestamp: 0,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());
describe("per-call deadlines", () => {
  it("uses gateway time, trusts 400 and 900 seconds without a cap", () => {
    const calls = new ToolDeadlines();
    calls.observe(start("400", "bash", { timeout: 400 }));
    vi.advanceTimersByTime(350_000);
    expect(calls.earliest()?.deadline).toBe(415_000);
    calls.observe(end("400"));
    calls.observe(start("900", "bash", { timeout: 900 }));
    expect(calls.earliest()?.deadline).toBe(1_265_000);
  });
  it.each([undefined, "400", 0, -1, NaN, Infinity])(
    "defaults invalid timeout %s to 300 seconds",
    (timeout) => {
      const calls = new ToolDeadlines();
      calls.observe(start("a", "bash", { timeout }));
      expect(calls.earliest()?.deadline).toBe(315_000);
    }
  );
  it("defaults other tools even when args contain timeout", () => {
    const calls = new ToolDeadlines();
    calls.observe(start("a", "read", { timeout: 900 }));
    expect(calls.earliest()?.deadline).toBe(315_000);
  });
  it("keeps overlapping deadlines independent and remembers completed IDs", () => {
    const calls = new ToolDeadlines();
    calls.observe(start("long", "bash", { timeout: 400 }));
    calls.observe(start("short", "bash", { timeout: 10 }));
    calls.observe(end("short"));
    vi.advanceTimersByTime(410_000);
    calls.observe(start("long", "bash", { timeout: 900 }));
    calls.observe(start("short", "bash", { timeout: 900 }));
    calls.observe(end("unknown"));
    expect(calls.earliest()?.deadline).toBe(415_000);
  });
  it("keeps empty IDs and missing results guarded; text cannot renew a call", () => {
    const calls = new ToolDeadlines();
    calls.observe(start(""));
    vi.advanceTimersByTime(200_000);
    calls.observe({ type: "assistant_text", text: "working", timestamp: 0 });
    calls.observe(end(""));
    expect(calls.earliest()?.deadline).toBe(315_000);
  });
});
