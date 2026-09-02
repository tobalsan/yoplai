import { describe, expect, it, vi } from "vitest";
import { describeImage } from "./describe.js";

const completeSimple = vi.hoisted(() => vi.fn());
const find = vi.hoisted(() => vi.fn());

vi.mock("@earendil-works/pi-ai/compat", () => ({ completeSimple }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  ModelRuntime: { create: vi.fn(async () => ({ getModel: find })) },
}));

const config = {
  agents: [], extensions: {}, imageDescription: { enabled: true, provider: "vision", model: "vision-1" },
} as never;

describe("describeImage", () => {
  it("preserves the describer's transcription and passes an optional question", async () => {
    find.mockReturnValue({ input: ["text", "image"] });
    completeSimple.mockResolvedValue({ content: [{ type: "text", text: "Row 4: [illegible]" }] });
    await expect(describeImage(Buffer.from("image"), "image/png", config, "Read row 4")).resolves.toBe("Row 4: [illegible]");
    expect(completeSimple).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ messages: [expect.objectContaining({ content: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Read row 4") })]) })] }), expect.anything());
  });

  it("fails loudly when the describer errors or returns nothing", async () => {
    find.mockReturnValue({ input: ["text", "image"] });
    completeSimple.mockResolvedValue({ stopReason: "error", errorMessage: "No API key for provider: openrouter", content: [] });
    await expect(describeImage(Buffer.from("image"), "image/png", config)).rejects.toThrow("No API key for provider: openrouter");
    completeSimple.mockResolvedValue({ content: [{ type: "text", text: "   " }] });
    await expect(describeImage(Buffer.from("image"), "image/png", config)).rejects.toThrow("returned no text");
  });

  it("rejects a configured model without image input", async () => {
    find.mockReturnValue({ input: ["text"] });
    await expect(describeImage(Buffer.from("image"), "image/png", config)).rejects.toThrow("does not support image input");
  });
});
