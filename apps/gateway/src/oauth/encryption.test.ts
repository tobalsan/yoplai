import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "@yoplai/shared";
import { resolveTokenCipher } from "./encryption.js";

const withKey = (encryptionKey: string) => () => ({ oauth: { encryptionKey } }) as GatewayConfig;

describe("resolveTokenCipher", () => {
  it("derives the key once per secret, so building stores stays cheap", () => {
    const first = resolveTokenCipher(withKey("fixture-secret-a"));
    expect(resolveTokenCipher(withKey("fixture-secret-a"))).toBe(first);
    const rotated = resolveTokenCipher(withKey("fixture-secret-b"));
    expect(rotated).not.toBe(first);
    expect(rotated!.decrypt(rotated!.encrypt("value"))).toBe("value");
  });
});
