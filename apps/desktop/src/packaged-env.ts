import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The only variables that pass from the app environment to the gateway. LC_* passes too. */
const PASSED_NAMES = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ"];

export interface PackagedEnvInput {
  parentEnv: NodeJS.ProcessEnv;
  shellPath: string;
  home: string;
  ports: { gatewayPort: number; uiPort: number; appsPort: number };
  resourcesPath: string;
  loopbackHost: string;
}

/**
 * The gateway environment: an allowlist of the parent values and the PATH from the probe, then the values of the
 * launcher. NODE_OPTIONS, dev flags, and credentials do not pass. Credentials go in $YOPLAI_HOME/.env.
 */
export function buildPackagedEnv(input: PackagedEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(input.parentEnv)) {
    if (value === undefined) continue;
    if (PASSED_NAMES.includes(name) || name.startsWith("LC_")) env[name] = value;
  }
  env.PATH = input.shellPath;
  return {
    ...env,
    YOPLAI_HOME: input.home,
    YOPLAI_DESKTOP: "1",
    YOPLAI_GATEWAY_PORT: String(input.ports.gatewayPort),
    YOPLAI_UI_PORT: String(input.ports.uiPort),
    YOPLAI_APPS_PORT: String(input.ports.appsPort),
    YOPLAI_GATEWAY_HOST: input.loopbackHost,
    YOPLAI_UI_HOST: input.loopbackHost,
    YOPLAI_SKIP_WEB: "1",
    YOPLAI_WEB_DIST: path.join(input.resourcesPath, "web"),
    YOPLAI_TEMPLATES_DIR: path.join(input.resourcesPath, "templates"),
    ELECTRON_RUN_AS_NODE: "1",
  };
}

/** A leading `~` means the user home, as for YOPLAI_HOME in `packages/shared/src/config-path.ts`. */
function expandHomePath(rawPath: string): string {
  return rawPath.startsWith("~") ? path.join(os.homedir(), rawPath.slice(1)) : path.resolve(rawPath);
}

/** YOPLAI_HOME wins. Else the app support folder of the user. */
export function resolveHome(parentEnv: NodeJS.ProcessEnv, appSupportDir: string): string {
  const override = parentEnv.YOPLAI_HOME?.trim();
  return override ? expandHomePath(override) : path.join(appSupportDir, "Yoplai", "home");
}

/**
 * The first-run config: no agents and loopback bind. Slice 6 adds the real setup.
 * OAuth tokens need an encryption key, and an app user cannot set one, so the seed makes one in `.env`.
 */
export const SEED_CONFIG = {
  version: 3,
  agents: [],
  gateway: { bind: "loopback" },
  ui: { bind: "loopback" },
  oauth: { encryptionKey: "$env:OAUTH_ENCRYPTION_KEY" },
} as const;

const CONFIG_NAMES = ["yoplai.json", "aihub.json"];

/** Create the home and write the seed config when no config file exists. Returns true when it wrote the seed. */
export function seedHome(home: string): boolean {
  fs.mkdirSync(home, { recursive: true });
  if (CONFIG_NAMES.some((name) => fs.existsSync(path.join(home, name)))) return false;
  // The gateway loads `$YOPLAI_HOME/.env`. Append, so a `.env` that exists keeps its other values.
  const key = randomBytes(32).toString("base64url");
  fs.appendFileSync(path.join(home, ".env"), `OAUTH_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "yoplai.json"), `${JSON.stringify(SEED_CONFIG, null, 2)}\n`, { flag: "wx" });
  return true;
}
