import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAvatarUrl } from "./default-avatar";

afterEach(() => vi.unstubAllEnvs());

describe("defaultAvatarUrl", () => {
  it("returns the same image for the same agent ID on every call", () => {
    expect(defaultAvatarUrl("alpha")).toBe(defaultAvatarUrl("alpha"));
  });

  it("picks one of the ten bundled images", () => {
    const ids = Array.from({ length: 200 }, (_, index) => `agent-${index}`);
    const numbers = new Set(ids.map((id) => Number(/default-(\d+)\.webp$/.exec(defaultAvatarUrl(id))![1])));
    expect([...numbers].every((number) => number >= 1 && number <= 10)).toBe(true);
    expect(numbers.size).toBe(10);
  });

  it("hashes the full wire ID, so one agent on two gateways can differ", () => {
    const urls = new Set(["east", "west", "north", "south", "ams", "tms"].map((name) => defaultAvatarUrl(`scribe@${name}`)));
    expect(urls.size).toBeGreaterThan(1);
  });

  it("uses a known FNV-1a value", () => {
    // fnv1a("a") = 0xe40c292c = 3826002220, and 3826002220 % 10 = 0, so the image is 1.
    expect(defaultAvatarUrl("a")).toMatch(/default-1\.webp$/);
  });

  it("follows the base path of the app", () => {
    vi.stubEnv("BASE_URL", "/yoplai/");
    expect(defaultAvatarUrl("alpha")).toMatch(/^\/yoplai\/avatars\/default-\d+\.webp$/);
  });
});
