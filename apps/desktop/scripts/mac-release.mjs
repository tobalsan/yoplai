import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function checkBuilderEnv(builderDir) {
  try {
    fs.lstatSync(path.join(builderDir, "electron-builder.env"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Move apps/desktop/electron-builder.env before you build a release.");
}

export function releaseOptions(sourceEnv) {
  const fingerprint = sourceEnv.YOPLAI_MAC_IDENTITY?.trim().toUpperCase();
  const profile = sourceEnv.APPLE_KEYCHAIN_PROFILE?.trim();
  if (!fingerprint) throw new Error("Set YOPLAI_MAC_IDENTITY to the certificate fingerprint.");
  if (!/^[0-9A-F]{40}$/.test(fingerprint)) throw new Error("Use a 40-digit SHA-1 certificate fingerprint.");
  if (!profile) throw new Error("Set APPLE_KEYCHAIN_PROFILE to the notarytool profile name.");

  const identities = execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
  const identity = identities.match(new RegExp(`^\\s*\\d+\\) ${fingerprint} "Developer ID Application: .+ \\(([A-Z0-9]{10})\\)"`, "m"));
  if (!identity) throw new Error("Install the Developer ID Application identity in the keychain.");

  const env = { ...sourceEnv, APPLE_KEYCHAIN_PROFILE: profile, YOPLAI_SIGNING_TEAM: identity[1] };
  for (const name of Object.keys(env)) {
    if (["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_API_ISSUER", "APPLE_TEAM_ID", "APPLE_KEYCHAIN"].includes(name)
      || name.startsWith("APPLE_API_KEY") || name.startsWith("CSC_")) delete env[name];
  }
  return {
    env,
    args: [
      "--publish", "never",
      "-c.directories.output=release/signed",
      "-c.forceCodeSigning=true",
      `-c.mac.identity=${fingerprint}`,
      "-c.mac.notarize=true",
      "-c.mac.sign=scripts/mac-sign.mjs",
      "-c.mac.entitlements=entitlements/mac-release.plist",
      "-c.mac.entitlementsInherit=entitlements/mac-release.plist",
      "-c.mac.preAutoEntitlements=false",
      "-c.dmg.sign=true",
      "-c.dmg.writeUpdateInfo=false",
    ],
  };
}

export function developerIdRequirement(team) {
  if (!/^[A-Z0-9]{10}$/.test(team ?? "")) throw new Error("The signing team is missing or invalid.");
  return `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`;
}

export function stapleRelease(releaseDir, version, env) {
  const app = path.join(releaseDir, "mac-arm64", "Yoplai.app");
  const dmg = path.join(releaseDir, `Yoplai-${version}-arm64.dmg`);
  execFileSync("xcrun", ["stapler", "validate", app], { stdio: "inherit", env });
  execFileSync("codesign", ["--verify", "--strict", "-R", developerIdRequirement(env.YOPLAI_SIGNING_TEAM), dmg], { env });
  fs.rmSync(`${dmg}.blockmap`, { force: true });
  const result = JSON.parse(execFileSync("xcrun", ["notarytool", "submit", dmg,
    "--keychain-profile", env.APPLE_KEYCHAIN_PROFILE, "--wait", "--output-format", "json"], { encoding: "utf8", env }));
  console.log(`DMG notarization: ${result.status} (${result.id})`);
  if (result.status !== "Accepted") throw new Error("The notary service did not accept the DMG.");
  execFileSync("xcrun", ["stapler", "staple", dmg], { stdio: "inherit", env });
  execFileSync("xcrun", ["stapler", "validate", dmg], { stdio: "inherit", env });
}
