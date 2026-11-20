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
 * The first-run config finds agents in the home and uses the loopback address.
 * OAuth tokens need an encryption key, and an app user cannot set one, so the seed makes one in `.env`.
 */
export const SEED_CONFIG = {
  version: 3,
  agents: "$YOPLAI_HOME/agents/*",
  gateway: { bind: "loopback" },
  ui: { bind: "loopback" },
  oauth: { encryptionKey: "$env:OAUTH_ENCRYPTION_KEY" },
} as const;

const CONFIG_NAMES = ["yoplai.json", "aihub.json"];

function migrateAgentDiscovery(file: string): void {
  const configPath = fs.realpathSync(file);
  const raw = fs.readFileSync(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new Error("Correct the JSON in the desktop config. Select Restart.");
  }
  if (!Array.isArray(config?.agents) || config.agents.length !== 0) return;
  config.agents = SEED_CONFIG.agents;
  const temp = `${configPath}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, "wx", fs.statSync(configPath).mode & 0o777);
  try {
    try {
      fs.writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, configPath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Prepare the desktop config. Return true only for a new seed. */
export function seedHome(home: string): boolean {
  fs.mkdirSync(home, { recursive: true });
  const config = CONFIG_NAMES.map((name) => path.join(home, name)).find((file) => fs.existsSync(file));
  if (config) {
    migrateAgentDiscovery(config);
    return false;
  }
  // The gateway loads `$YOPLAI_HOME/.env`. Append, so a `.env` that exists keeps its other values.
  const key = randomBytes(32).toString("base64url");
  fs.appendFileSync(path.join(home, ".env"), `OAUTH_ENCRYPTION_KEY=${key}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(home, "yoplai.json"), `${JSON.stringify(SEED_CONFIG, null, 2)}\n`, { flag: "wx" });
  return true;
}
