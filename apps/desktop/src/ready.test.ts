import { describe, expect, it } from "vitest";
import { waitForReady } from "./ready.js";

describe("waitForReady", () => {
  it("resolves once every URL answers", async () => {
    const hits = new Map<string, number>();
    await waitForReady(["a", "b"], {
      timeoutMs: 1000,
      intervalMs: 5,
      probe: async (url) => {
        const n = (hits.get(url) ?? 0) + 1;
        hits.set(url, n);
        return url === "a" || n >= 3;
      },
    });
    expect(hits.get("b")).toBe(3);
  });

  it("throws on timeout and names the pending URL", async () => {
    await expect(
      waitForReady(["a", "b"], { timeoutMs: 30, intervalMs: 5, probe: async (u) => u === "a" })
    ).rejects.toThrow(/Timed out waiting for b/);
  });

  it("stops early when aborted", async () => {
    await expect(
      waitForReady(["a"], { timeoutMs: 1000, intervalMs: 5, probe: async () => false, shouldAbort: () => true })
    ).rejects.toThrow(/aborted/);
  });
});
