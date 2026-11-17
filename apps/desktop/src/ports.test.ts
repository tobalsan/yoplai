import { describe, expect, it } from "vitest";
import { findFreePort } from "./ports.js";

describe("findFreePort", () => {
  it("returns the first free port from the base", async () => {
    const taken = new Set([3000, 3001]);
    const port = await findFreePort(3000, { isFree: async (p) => !taken.has(p) });
    expect(port).toBe(3002);
  });

  it("throws when no port in range is free", async () => {
    await expect(findFreePort(3000, { maxAttempts: 3, isFree: async () => false })).rejects.toThrow(
      /No free port/
    );
  });
});
