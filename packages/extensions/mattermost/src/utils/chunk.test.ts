import { describe, expect, it } from "vitest";
import { MATTERMOST_MAX, splitMessage } from "./chunk.js";

describe("splitMessage", () => {
  it("keeps a short message whole and drops empty ones", () => {
    expect(splitMessage("  hello  ")).toEqual(["hello"]);
    expect(splitMessage("   \n ")).toEqual([]);
  });

  it("stays well under Mattermost's 16383-character post limit", () => {
    expect(MATTERMOST_MAX).toBeLessThan(16_383);
    const chunks = splitMessage("word ".repeat(10_000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks)
      expect(chunk.length).toBeLessThanOrEqual(MATTERMOST_MAX);
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      "word ".repeat(10_000).trim()
    );
  });

  it("cuts at a paragraph boundary before a line or a word", () => {
    const first = "a".repeat(60);
    const second = "b".repeat(60);
    expect(splitMessage(`${first}\n\n${second}`, 100)).toEqual([first, second]);
  });

  it("closes a code block cut in two and reopens it with its language", () => {
    const code = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const chunks = splitMessage("Intro\n```ts\n" + code + "\n```\nOutro", 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      const fences = chunk
        .split("\n")
        .filter((line) => line.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    }
    expect(chunks[1].startsWith("```ts\n")).toBe(true);
  });

  it("hard-cuts a single word longer than the limit", () => {
    const chunks = splitMessage("x".repeat(250), 100);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join("")).toBe("x".repeat(250));
  });
});
