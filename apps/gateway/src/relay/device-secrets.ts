import fs from "node:fs";
import path from "node:path";
import { resolveHomeDir } from "@yoplai/shared";

/** A path segment anywhere in a path makes it secret. */
const SECRET_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".password-store"]);

/** Two segments in a row make a path secret. */
const SECRET_SEGMENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  [".config", "gcloud"],
  ["library", "keychains"],
  [".docker", "config.json"],
];

const SECRET_FILE_NAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  "auth.json",
  "credentials",
  "credentials.json",
]);

const ENV_TEMPLATE_SUFFIXES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
const SECRET_FILE_PREFIXES = ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"];
const SECRET_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".keychain-db", ".kdbx"];

/** Files of the Yoplai home that hold links, settings, tokens, and accounts. */
const YOPLAI_HOME_FILES = ["remote-gateways.json", "device-settings.json", "user-token.json", "auth.db"];

/** The text that a refused read of a secret file gives to the agent. */
export function secretReadRefusal(filePath: string): string {
  return `${filePath} is on the list of secret files of this device. The call did not run. The user can allow it with Full access.`;
}

function homeDirectories(): string[] {
  const home = resolveHomeDir();
  const directories = [home];
  try {
    directories.push(fs.realpathSync(home));
  } catch {
    // A home directory that does not exist has no real path.
  }
  return directories.map((directory) => directory.toLowerCase());
}

/** True when the path is on the list of secret files. It compares in lower case, because the macOS file system ignores case. */
export function isSecretPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const segments = lower.split(/[\\/]+/).filter((segment) => segment !== "");
  if (segments.some((segment) => SECRET_SEGMENTS.has(segment))) return true;
  for (let index = 0; index + 1 < segments.length; index++) {
    if (SECRET_SEGMENT_PAIRS.some(([first, second]) => segments[index] === first && segments[index + 1] === second)) return true;
  }
  const name = segments.at(-1);
  if (name === undefined) return false;
  if (SECRET_FILE_NAMES.has(name)) return true;
  if (name.startsWith(".env.") && !ENV_TEMPLATE_SUFFIXES.has(name)) return true;
  if (SECRET_FILE_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  if (SECRET_EXTENSIONS.some((extension) => name.endsWith(extension))) return true;
  const normalized = path.normalize(lower);
  return homeDirectories().some((home) => YOPLAI_HOME_FILES.some((file) => normalized === path.join(home, file)));
}
