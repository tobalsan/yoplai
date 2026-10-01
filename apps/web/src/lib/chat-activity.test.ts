import { describe, expect, it } from "vitest";
import { groupActivityItems, lastFiveWords } from "./chat-activity";

describe("chat activity helpers", () => {
  it("groups only consecutive activity items", () => {
    const items = ["thinking", "tool", "text", "tool", "file"];
    expect(
      groupActivityItems(
        items,
        (item) => item === "thinking" || item === "tool"
      )
    ).toEqual([
      {
        kind: "activity",
        items: ["thinking", "tool"],
        startIndex: 0,
        endIndex: 1,
      },
      { kind: "message", item: "text", startIndex: 2, endIndex: 2 },
      { kind: "activity", items: ["tool"], startIndex: 3, endIndex: 3 },
      { kind: "message", item: "file", startIndex: 4, endIndex: 4 },
    ]);
  });

  it("returns last five normalized words", () => {
    expect(lastFiveWords("one  two\nthree four five six seven ")).toBe(
      "three four five six seven…"
    );
    expect(lastFiveWords("  one two ")).toBe("one two…");
    // Trailing partial token dropped
    expect(lastFiveWords("one two three four five six sev")).toBe(
      "two three four five six…"
    );
    expect(lastFiveWords("partial")).toBe("partial…");
    expect(lastFiveWords("")).toBe("");
  });
});
