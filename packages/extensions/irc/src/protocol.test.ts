import { describe, expect, it } from "vitest";
import { IrcLoopGuard } from "./loop-guard.js";
import { isAddressed, normalizeIrcText, parseIrcLine, splitIrcText, toPlainIrcText } from "./protocol.js";
describe("IRC protocol helpers", () => {
  it("parses messages and rejects malformed prefixes", () => { expect(parseIrcLine(":nick!u@h PRIVMSG #room :hello")).toMatchObject({ prefix: "nick!u@h", command: "PRIVMSG", params: ["#room"], trailing: "hello" }); expect(parseIrcLine(": PRIVMSG #room :bad")).toBeNull(); });
  it("handles case-insensitive addressing and ACTION text", () => { expect(isAddressed("YoPlAi: hello", "yoplai")).toEqual({ addressed: true, text: "hello" }); expect(normalizeIrcText("\u0001ACTION waves\u0001")).toBe("* waves"); });
  it("splits Unicode without exceeding byte limits", () => { const chunks = splitIrcText("🙂🙂🙂", 5); expect(chunks).toEqual(["🙂", "🙂", "🙂"]); expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 5)).toBe(true); });
  it("removes IRC controls and markdown formatting from replies", () => { expect(toPlainIrcText("**hello** \u0002world\u000f\u0001DCC SEND\u0001")).toBe("hello worldDCC SEND"); });
  it("splits on newlines into separate chunks", () => { expect(splitIrcText("line one\nline two")).toEqual(["line one", "line two"]); });
  it("skips blank lines when splitting", () => { expect(splitIrcText("a\n\n  \nb")).toEqual(["a", "b"]); });
  it("splits long lines on word boundaries within char and byte budgets", () => { const words = new Array(200).fill("lorem"); const chunks = splitIrcText(words.join(" "), 400); expect(chunks.length).toBeGreaterThan(1); expect(chunks.every((c) => c.length <= 450 && Buffer.byteLength(c) <= 400 && !c.startsWith(" ") && !c.endsWith(" "))).toBe(true); expect(chunks.join(" ").split(" ")).toEqual(words); });
  it("hard-splits a single oversized word by codepoint", () => { const word = "a".repeat(500); const chunks = splitIrcText(word); expect(chunks.every((c) => c.length <= 450)).toBe(true); expect(chunks.join("")).toBe(word); });
  it("preserves newlines while stripping markdown", () => { expect(toPlainIrcText("**bold**\n# Heading\nplain")).toBe("bold\nHeading\nplain"); });
  it("strips markdown links and bare URL brackets", () => { expect(toPlainIrcText("[see here](https://example.com)")).toBe("see here"); expect(toPlainIrcText("<https://example.com>")).toBe("https://example.com"); });
  it("keeps mid-line hashes untouched", () => { expect(toPlainIrcText("join #rust-lang")).toBe("join #rust-lang"); expect(toPlainIrcText("C# language")).toBe("C# language"); });
});
describe("A2A loop guard", () => { it("caps per channel, resets only configured humans, and excludes DMs", () => { const guard = new IrcLoopGuard(1, ["Alice"]); expect(guard.allow("#one", "bot")).toBe(true); expect(guard.allow("#one", "bot")).toBe(false); expect(guard.allow("#two", "bot")).toBe(true); expect(guard.allow("#one", "ALICE")).toBe(true); expect(guard.allow("#one", "bot")).toBe(true); expect(guard.allow("#one", "bot", true)).toBe(true); }); });
