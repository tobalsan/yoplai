import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIG_NAMES, expandHomePath, SEED_CONFIG, seedHome, seedOAuthKeyFile } from "./packaged-env.js";

export interface DevHome {
  mode: "fresh" | "persistent";
  home: string;
  userHome?: string;
  userData: string;
}

export function createDevHome(env: NodeJS.ProcessEnv, args: string[], appData: string): DevHome {
  if (args.includes("--fresh") || env.YOPLAI_DESKTOP_FRESH === "1") {
    const parent = env.YOPLAI_DESKTOP_DEV_PARENT || os.tmpdir();
    const root = fs.mkdtempSync(path.join(path.resolve(parent), "yoplai-desktop-"));
    return { mode: "fresh", home: path.join(root, "home"), userHome: root, userData: path.join(root, "userData") };
  }
  const userHome = env.HOME || os.homedir();
  const home = expandHomePath(env.YOPLAI_HOME?.trim() || "~/.yoplai", userHome);
  fs.mkdirSync(home, { recursive: true });
  const key = createHash("sha256").update(fs.realpathSync(home)).digest("hex");
  return { mode: "persistent", home, userHome, userData: path.join(appData, "Yoplai Dev", key) };
}

export function seedDevHome({ home, mode }: DevHome, env: NodeJS.ProcessEnv, warn = console.warn): string | undefined {
  if (mode === "fresh") {
    seedHome(home);
    return "OAUTH_ENCRYPTION_KEY";
  }
  const configPath = CONFIG_NAMES.map((name) => path.join(home, name)).find((file) => fs.existsSync(file));
  let config;
  try {
    config = configPath ? JSON.parse(fs.readFileSync(configPath, "utf8")) : SEED_CONFIG;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Correct the JSON in the desktop config. Select Restart.");
    throw error;
  }

  const values = seedOAuthKeyFile(home, env.OAUTH_ENCRYPTION_KEY);

  if (!configPath) {
    fs.writeFileSync(path.join(home, CONFIG_NAMES[0]), `${JSON.stringify(SEED_CONFIG, null, 2)}\n`, { flag: "wx" });
  }
  const rules = config?.agents;
  const discoversAgents = rules === undefined ? config?.pool === undefined
    : [rules].flat().some((rule) => typeof rule === "string" && rule.trim());
  if (!discoversAgents) {
    warn(`[desktop] No agent discovery rules in ${configPath}. Setup cannot add agents.`);
  }

  const secret = config?.oauth?.encryptionKey;
  const keyName = typeof secret === "string" && secret.startsWith("$env:") ? secret.slice(5) : undefined;
  if (typeof secret !== "string" || !secret.trim() || (keyName !== undefined && !(env[keyName] ?? values[keyName]))) {
    warn(`[desktop] No usable oauth.encryptionKey in ${configPath ?? home}. OAuth connections cannot save tokens.`);
  }
  return keyName;
}
