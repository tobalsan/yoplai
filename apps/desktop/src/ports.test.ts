import { describe, expect, it } from "vitest";
import { findFreePort, pickPorts } from "./ports.js";

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

describe("pickPorts", () => {
  it("picks the base ports when they are free", async () => {
    expect(await pickPorts(async () => true)).toEqual({ gatewayPort: 4000, uiPort: 3000, appsPort: 4001 });
  });

  it("skips busy ports and never picks the same port twice", async () => {
    const taken = new Set([4000, 3000, 4001]);
    const ports = await pickPorts(async (p) => !taken.has(p));
    expect(ports).toEqual({ gatewayPort: 4002, uiPort: 3001, appsPort: 4003 });
    expect(new Set(Object.values(ports)).size).toBe(3);
  });

  it("does not give the apps port to a gateway that moved onto the apps base", async () => {
    const ports = await pickPorts(async (p) => p !== 4000);
    expect(ports.gatewayPort).toBe(4001);
    expect(ports.appsPort).toBe(4002);
  });
});
