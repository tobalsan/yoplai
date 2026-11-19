import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkBuilderEnv, releaseOptions, stapleRelease } from "./mac-release.mjs";
import sign from "./mac-sign.mjs";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawnSync: vi.fn() }));

const fingerprint = "A".repeat(40);
const input = { YOPLAI_MAC_IDENTITY: fingerprint, APPLE_KEYCHAIN_PROFILE: "test-profile" };

let directory: string;
beforeEach(() => {
  vi.resetAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "yoplai-mac-release-test-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("checkBuilderEnv", () => {
  it("allows a build directory without an environment file", () => {
    expect(() => checkBuilderEnv(directory)).not.toThrow();
  });

  it.each(["", "APPLE_ID=test"])("rejects an environment file with contents %j", (contents) => {
    fs.writeFileSync(path.join(directory, "electron-builder.env"), contents);
    expect(() => checkBuilderEnv(directory)).toThrow("Move apps/desktop/electron-builder.env");
  });

  it("rejects a dangling environment file symlink", () => {
    fs.symlinkSync("missing.env", path.join(directory, "electron-builder.env"));
    expect(() => checkBuilderEnv(directory)).toThrow("Move apps/desktop/electron-builder.env");
  });
});

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

describe("sign", () => {
  it("blocks app submission when the Mach-O audit fails after signing", async () => {
    const file = path.join(directory, "gateway.node");
    fs.writeFileSync(file, Buffer.from("feedfacf", "hex"));
    vi.stubEnv("YOPLAI_SIGNING_TEAM", "TESTTEAMID");
    vi.mocked(execFileSync).mockReturnValueOnce("Mach-O").mockReturnValueOnce("Mach-O").mockReturnValueOnce("arm64");
    const doSign = vi.fn().mockResolvedValue(undefined);
    vi.mocked(spawnSync).mockImplementation((_command, args) => {
      expect(doSign).toHaveBeenCalledOnce();
      return {
        status: args?.[0] === "--verify" ? 1 : 0,
        stderr: "flags=0x10000(runtime)\nTimestamp=Test\n",
        stdout: "",
        output: [],
        pid: 0,
        signal: null,
      };
    });
    const submit = vi.fn();

    await expect(sign({ app: directory, identity: fingerprint }, { doSign }).then(submit))
      .rejects.toThrow("gateway.node: Developer ID signature check failed.");
    expect(spawnSync).toHaveBeenCalledWith("codesign", expect.arrayContaining(["--verify", file]));
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("stapleRelease", () => {
  it.each(["Invalid", "In Progress"])("does not staple the DMG when Apple returns %s", (status) => {
    const env = { ...input, YOPLAI_SIGNING_TEAM: "TESTTEAMID" };
    const dmg = path.join(directory, "Yoplai-0.0.0-arm64.dmg");
    vi.mocked(execFileSync).mockReturnValueOnce("").mockReturnValueOnce("")
      .mockReturnValueOnce(JSON.stringify({ status, id: "test-id" }));

    expect(() => stapleRelease(directory, "0.0.0", env)).toThrow("The notary service did not accept the DMG.");
    expect(execFileSync).toHaveBeenCalledWith("xcrun", ["notarytool", "submit", dmg,
      "--keychain-profile", input.APPLE_KEYCHAIN_PROFILE, "--wait", "--output-format", "json"], expect.any(Object));
    expect(execFileSync).not.toHaveBeenCalledWith("xcrun", ["stapler", "staple", dmg], expect.anything());
  });
});
