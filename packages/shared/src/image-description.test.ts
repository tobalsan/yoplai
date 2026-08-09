import { describe, expect, it } from "vitest";
import { formatImageDescriptionBlocks, modelSupportsImages } from "./image-description.js";

describe("image description helpers", () => {
  it("formats separately labelled descriptions in message order", () => {
    const text = formatImageDescriptionBlocks([
      { path: "/workspace/uploads/1-a.png", description: "first" },
      { path: "/workspace/uploads/2-b.png", description: "second" },
    ]);
    expect(text).toContain("Image 1 description — generated from, not the original image");
    expect(text).toContain("/workspace/uploads/2-b.png");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
  });

  it("uses the model input capability as the sole image gate", () => {
    expect(modelSupportsImages({ input: ["text", "image"] })).toBe(true);
    expect(modelSupportsImages({ input: ["text"] })).toBe(false);
  });
});
