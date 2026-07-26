import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandPath(rawPath: string): string {
  if (rawPath.startsWith("~")) {
    return path.join(os.homedir(), rawPath.slice(1));
  }
  return path.resolve(rawPath);
}

function trimValue(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

const warnedEnvVars = new Set<string>();

/**
 * Reads a YOPLAI_<suffix> env var, falling back to the deprecated
 * AIHUB_<suffix> form (warning once per suffix). `name` may be the bare
 * suffix ("HOME") or the full YOPLAI_ name ("YOPLAI_HOME").
 */
export function readEnv(name: string): string | undefined {
  const suffix = name.startsWith("YOPLAI_") ? name.slice("YOPLAI_".length) : name;

  const value = trimValue(process.env[`YOPLAI_${suffix}`]);
  if (value) return value;

  const legacyValue = trimValue(process.env[`AIHUB_${suffix}`]);
  if (legacyValue) {
    if (!warnedEnvVars.has(suffix)) {
      warnedEnvVars.add(suffix);
      console.warn(
        `[config] AIHUB_${suffix} is deprecated; set YOPLAI_${suffix} instead.`
      );
    }
    return legacyValue;
  }

  return undefined;
}

const HOME_PLACEHOLDER = /^\$(YOPLAI|AIHUB)_HOME(?=\/|$)/;
let warnedHomePlaceholder = false;

/**
 * Expands a leading `$YOPLAI_HOME` placeholder inside a config *value* (e.g.
 * `"$YOPLAI_HOME/agents/*"`), accepting the deprecated `$AIHUB_HOME` form
 * (warning once) so configs written before the rename keep resolving.
 * Values without the placeholder are returned unchanged.
 */
export function expandHomePlaceholder(value: string, homeDir: string): string {
  const match = HOME_PLACEHOLDER.exec(value);
  if (!match) return value;

  if (match[1] === "AIHUB" && !warnedHomePlaceholder) {
    warnedHomePlaceholder = true;
    console.warn(
      "[config] $AIHUB_HOME in config values is deprecated; rewrite it as $YOPLAI_HOME."
    );
  }

  return homeDir + value.slice(match[0].length);
}

const CONFIG_FILENAME = "yoplai.json";
const LEGACY_CONFIG_FILENAME = "aihub.json";

/** True when `dir` holds a config file under the current or the legacy name. */
function hasConfigFile(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, CONFIG_FILENAME)) ||
    fs.existsSync(path.join(dir, LEGACY_CONFIG_FILENAME))
  );
}

let warnedLegacyHomeEnv = false;
let warnedLegacyConfigEnv = false;
let warnedLegacyConfigEnvPredecessor = false;
let warnedLegacyDefaultHomeDir = false;

export function resolveHomeDir(): string {
  const homeDir = trimValue(process.env.YOPLAI_HOME);
  if (homeDir) return expandPath(homeDir);

  const legacyHomeDir = trimValue(process.env.AIHUB_HOME);
  if (legacyHomeDir) {
    if (!warnedLegacyHomeEnv) {
      warnedLegacyHomeEnv = true;
      console.warn("[config] AIHUB_HOME is deprecated; set YOPLAI_HOME instead.");
    }
    return expandPath(legacyHomeDir);
  }

  const legacyConfigPath = trimValue(process.env.YOPLAI_CONFIG);
  if (legacyConfigPath) {
    if (!warnedLegacyConfigEnv) {
      warnedLegacyConfigEnv = true;
      console.warn(
        "[config] YOPLAI_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
      );
    }
    return path.dirname(expandPath(legacyConfigPath));
  }

  const legacyConfigPathPredecessor = trimValue(process.env.AIHUB_CONFIG);
  if (legacyConfigPathPredecessor) {
    if (!warnedLegacyConfigEnvPredecessor) {
      warnedLegacyConfigEnvPredecessor = true;
      console.warn(
        "[config] AIHUB_CONFIG is deprecated; set YOPLAI_HOME to the containing directory instead."
      );
    }
    return path.dirname(expandPath(legacyConfigPathPredecessor));
  }

  // Key on the config file, never on directory existence: an empty ~/.yoplai
  // created by any stray write would otherwise silently sever a legacy install
  // from its config, .env and auth.json.
  const defaultHomeDir = path.join(os.homedir(), ".yoplai");
  if (hasConfigFile(defaultHomeDir)) return defaultHomeDir;

  const legacyDefaultHomeDir = path.join(os.homedir(), ".aihub");
  if (hasConfigFile(legacyDefaultHomeDir)) {
    if (!warnedLegacyDefaultHomeDir) {
      warnedLegacyDefaultHomeDir = true;
      console.warn(
        `[config] Using legacy ${legacyDefaultHomeDir}; migrate it to ${defaultHomeDir} or set YOPLAI_HOME.`
      );
    }
    return legacyDefaultHomeDir;
  }

  return defaultHomeDir;
}

let warnedLegacyConfigFilename = false;

export function getDefaultConfigPath(): string {
  const homeDir = resolveHomeDir();
  const configPath = path.join(homeDir, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) return configPath;

  const legacyConfigPath = path.join(homeDir, LEGACY_CONFIG_FILENAME);
  if (fs.existsSync(legacyConfigPath)) {
    if (!warnedLegacyConfigFilename) {
      warnedLegacyConfigFilename = true;
      console.warn(
        `[config] Using legacy ${legacyConfigPath}; rename it to ${configPath} to migrate.`
      );
    }
    return legacyConfigPath;
  }

  return configPath;
}

/** Test-only: resets the once-per-process warning flags in this module. */
export function resetConfigPathWarningsForTests(): void {
  warnedEnvVars.clear();
  warnedHomePlaceholder = false;
  warnedLegacyHomeEnv = false;
  warnedLegacyConfigEnv = false;
  warnedLegacyConfigEnvPredecessor = false;
  warnedLegacyDefaultHomeDir = false;
  warnedLegacyConfigFilename = false;
}

export function resolveConfigPath(configPath?: string): string {
  const rawPath = trimValue(configPath) ?? getDefaultConfigPath();
  return expandPath(rawPath);
}
