import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { releaseOptions } from "./mac-release.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const fingerprint = "A".repeat(40);
const input = { YOPLAI_MAC_IDENTITY: fingerprint, APPLE_KEYCHAIN_PROFILE: "test-profile" };

beforeEach(() => vi.resetAllMocks());

describe("releaseOptions", () => {
  it("requires the profile before it searches for the certificate", () => {
    expect(() => releaseOptions({})).toThrow("YOPLAI_MAC_IDENTITY");
    expect(() => releaseOptions({ YOPLAI_MAC_IDENTITY: fingerprint })).toThrow("APPLE_KEYCHAIN_PROFILE");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("rejects an identity that cannot sign Developer ID apps", () => {
    vi.mocked(execFileSync).mockReturnValue(`  1) ${fingerprint} "Apple Development: Test (TESTTEAMID)"\n`);
    expect(() => releaseOptions(input)).toThrow("Developer ID Application identity");
  });

  it("uses the selected Developer ID identity and only the keychain profile", () => {
    vi.mocked(execFileSync).mockReturnValue(`  1) ${fingerprint} "Developer ID Application: Test (TESTTEAMID)"\n`);
    const { args, env } = releaseOptions({
      ...input,
      APPLE_ID: "test",
      APPLE_APP_SPECIFIC_PASSWORD: "test",
      APPLE_API_KEY_ID: "test",
      APPLE_API_ISSUER: "test",
      APPLE_TEAM_ID: "test",
      CSC_LINK: "test",
    });
    expect(args).toContain(`-c.mac.identity=${fingerprint}`);
    expect(env).toEqual({ ...input, YOPLAI_SIGNING_TEAM: "TESTTEAMID" });
  });
});
