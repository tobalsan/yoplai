import { describe, expect, it } from "vitest";
import { codemodeScriptBudget } from "./index.js";

// Seam approved in the ALG-602 Testing Decisions (groomed GO by Thinh, comment
// 7f8c870e): the shared budget rule catches option parsing and fallbacks used by
// both the runner and the gateway watchdog; it misses how either one applies it.
describe("codemode script budget", () => {
  it("defaults a script without an options line to 300 seconds", () => {
    expect(codemodeScriptBudget('text("hello");')).toBe(300);
  });

  it.each([
    ['// @options: {"timeout_ms": 900000}\ntext("x");', 900],
    ['// @options: {"max_output_tokens": 2000, "timeout_ms": 1500}\ntext("x");', 1.5],
    ['  // @options: {"timeout_ms": 2147483647}\r\ntext("x");', 2_147_483.647],
  ])("reads timeout_ms from the first-line options of %j", (code, seconds) => {
    expect(codemodeScriptBudget(code)).toBe(seconds);
  });

  it.each([
    ['// @options: {"max_output_tokens": 2000}\ntext("x");'],
    ['// @options: {timeout_ms: 900000}\ntext("x");'],
    ['// @options: {"timeout_ms": 0}\ntext("x");'],
    ['// @options: {"timeout_ms": 2147483648}\ntext("x");'],
    ['// @options: {"timeout_ms": 1.5}\ntext("x");'],
    ['// @options: {"timeout_ms": "900000"}\ntext("x");'],
    ['// @options: {"timeout_ms": 900000, "retries": 2}\ntext("x");'],
    ['text("x");\n// @options: {"timeout_ms": 900000}'],
    ['// @options: {"timeout_ms": 900000}'],
    [""],
  ])("falls back to 300 seconds for %j", (code) => {
    expect(codemodeScriptBudget(code)).toBe(300);
  });
});
