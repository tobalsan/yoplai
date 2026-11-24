import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import fg from "fast-glob";
import yaml from "js-yaml";
import {
  AgentYamlConfigSchema,
  GatewayRootConfigSchema,
  expandHomePlaceholder,
  resolveConfigPath,
  readEnv,
  resolveHomeDir,
  type AgentConfig,
  type AgentYamlConfig,
  type GatewayConfig,
  type SubagentConfig,
} from "@yoplai/shared";
import { envRefName, isEnvRef } from "./secrets.js";

export const CONFIG_DIR = resolveHomeDir();
export const SCHEDULES_PATH = path.join(CONFIG_DIR, "schedules.json");

let cachedConfig: GatewayConfig | null = null;
let rawLoadedConfig: GatewayConfig | null = null;
let singleAgentId: string | null = null;
let warnedLegacyPool = false;
const warnedLegacyChannels = new Set<string>();
const warnedLegacyDurable = new Set<string>();
const agentEnvDigests = new Map<string, string>();

export function getConfigPath(): string {
  return resolveConfigPath();
}

function resolvePathFromConfig(input: string, configDir: string): string {
  const expanded = input.startsWith("~")
    ? path.join(os.homedir(), input.slice(1))
    : expandHomePlaceholder(input, CONFIG_DIR);
  return path.isAbsolute(expanded)
    ? expanded
    : path.resolve(configDir, expanded);
}

function hasGlobMagic(input: string): boolean {
  return /[*?[\]{}]/.test(input);
}

function globToDirs(pattern: string, configDir: string, files?: fg.Options["fs"]): string[] {
  const resolved = resolvePathFromConfig(pattern, configDir);
  if (!hasGlobMagic(pattern)) return [resolved];
  return fg
    .sync(resolved, {
      absolute: true,
      dot: true,
      onlyDirectories: true,
      unique: true,
      fs: files,
    })
    .filter((dir) => !dir.split(path.sep).includes(".git"));
}

// Give discovery a view of the new directories without making them on disk.
function projectDirectories(dirs: string[], configDir: string) {
  const children = new Map<string, Set<string>>();
  const projected = new Set<string>();
  function project(dir: string): string {
    try {
      return fs.realpathSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = project(path.dirname(dir));
      const name = path.basename(dir);
      const names = children.get(parent) ?? new Set<string>();
      names.add(name);
      children.set(parent, names);
      const result = path.join(parent, name);
      projected.add(result);
      return result;
    }
  }
  const identities = dirs.map(project);
  function identity(dir: string): string {
    try {
      return fs.realpathSync(dir);
    } catch (error) {
      const parent = path.dirname(dir);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === dir) throw error;
      return path.join(identity(parent), path.basename(dir));
    }
  }
  const stat = fs.statSync(configDir);
  function readdirSync(dir: string, options: { withFileTypes: true }): fs.Dirent[];
  function readdirSync(dir: string): string[];
  function readdirSync(dir: string, options?: { withFileTypes: true }): fs.Dirent[] | string[] {
    const key = identity(path.resolve(dir));
    const existing = projected.has(key) ? [] : fs.readdirSync(dir, { withFileTypes: true });
    const added = [...(children.get(key) ?? [])].map((name) => ({
      name, parentPath: dir, path: dir,
      isDirectory: () => true,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isFile: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
    }));
    const all = [...existing, ...added];
    return options ? all : all.map((entry) => entry.name);
  }
  const files = {
    readdirSync,
    lstatSync: (dir: string) => projected.has(identity(path.resolve(dir))) ? stat : fs.lstatSync(dir),
    statSync: (dir: string) => projected.has(identity(path.resolve(dir))) ? stat : fs.statSync(dir),
  };
  return { identity, identities, files };
}

const DEFAULT_AGENT_DISCOVERY = "$YOPLAI_HOME/agents/*";

function readDesktopDiscoveryRules() {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  const config = GatewayRootConfigSchema.parse(JSON.parse(fs.readFileSync(configPath, "utf8")));
  return { configDir, agents: config.agents ?? DEFAULT_AGENT_DISCOVERY };
}

export function desktopDiscoveryCaseAliases(parent: string): string[] {
  const { configDir, agents } = readDesktopDiscoveryRules();
  const realParent = fs.realpathSync(parent);
  return [agents].flat().flatMap((rule) => {
    if (hasGlobMagic(rule)) return [];
    const resolved = path.resolve(resolvePathFromConfig(rule, configDir));
    const name = path.basename(resolved);
    if (name === name.toLowerCase()) return [];
    try {
      return fs.realpathSync(path.dirname(resolved)) === realParent ? [name.toLowerCase()] : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  });
}

export function allowsDesktopAgentDiscovery(finalDir: string, stagingDir: string): boolean {
  const { configDir, agents } = readDesktopDiscoveryRules();
  const { identity, identities: [final, staging], files } = projectDirectories([finalDir, stagingDir], configDir);
  const agentDirs = [agents].flat().flatMap((pattern) => globToDirs(pattern, configDir, files))
    .map((dir) => identity(path.resolve(dir)));
  return agentDirs.filter((dir) => dir === final).length === 1 && !agentDirs.includes(staging);
}

function discoverAgents(
  agentGlobs: string | string[],
  configDir: string,
  extensionEnvAllowlist: ReadonlySet<string>,
  strict: boolean
): AgentConfig[] {
  const patterns =
    typeof agentGlobs === "string" ? [agentGlobs] : agentGlobs;
  const agents: AgentConfig[] = [];
  const seen = new Map<string, string>();

  for (const pattern of patterns) {
    for (const workspaceDir of globToDirs(pattern, configDir)) {
      const agentPath = path.join(workspaceDir, "agent.yaml");
      if (!fs.existsSync(agentPath)) {
        const message = `[config] no agent.yaml in ${workspaceDir}`;
        if (strict) {
          throw new Error(
            `${message}. Configure agents with directories that contain agent.yaml.`
          );
        }
        console.warn(`${message}; skipping`);
        continue;
      }
      let parsedYaml: unknown;
      try {
        parsedYaml = yaml.load(fs.readFileSync(agentPath, "utf8"));
      } catch (error) {
        const message = `[config] failed to read ${agentPath}: ${(error as Error).message}`;
        if (strict) throw new Error(message);
        console.warn(message);
        continue;
      }
      const parsed = AgentYamlConfigSchema.safeParse(parsedYaml);
      if (!parsed.success) {
        const message = `[config] invalid ${agentPath}: ${parsed.error.message}`;
        if (strict) throw new Error(message);
        console.warn(message);
        continue;
      }
      const folderName = path.basename(workspaceDir);
      if (parsed.data.id !== folderName) {
        throw new Error(
          `agent.yaml id mismatch in ${agentPath}: id "${parsed.data.id}" must match folder "${folderName}"`
        );
      }
      const duplicate = seen.get(parsed.data.id);
      if (duplicate) {
        throw new Error(
          `Duplicate agent id "${parsed.data.id}" in ${duplicate} and ${agentPath}`
        );
      }
      seen.set(parsed.data.id, agentPath);
      if (parsedYaml && typeof parsedYaml === "object" && Object.hasOwn(parsedYaml, "durable") &&
          !warnedLegacyDurable.has(parsed.data.id)) {
        warnedLegacyDurable.add(parsed.data.id);
        console.warn(`[config] agent "${parsed.data.id}": \`durable\` is ignored; Durable mode is now a per-user setting`);
      }
      const { discord, slack, telegram, irc, mattermost, ...settings } = parsed.data;
      const legacy = { discord, slack, telegram, irc, mattermost };
      const agent = { ...settings, workspace: workspaceDir, workspaceDir };
      const unfiltered = new Set(Object.entries(legacy).flatMap(([id, block]) => block === undefined ? [] : [id]));
      agents.push(foldLegacyChannels(filterAgentExtensionEnvRefs(agent, extensionEnvAllowlist, unfiltered), legacy));
    }
  }

  if (strict && agents.length === 0) {
    throw new Error(
      `[config] no valid agents found. Configure agents with directories that contain agent.yaml.`
    );
  }

  return agents.sort((a, b) => a.id.localeCompare(b.id));
}

function foldLegacyChannels(
  agent: AgentConfig,
  legacy: Pick<AgentYamlConfig, "discord" | "slack" | "telegram" | "irc" | "mattermost">
): AgentConfig {
  const channels = ["discord", "slack", "telegram", "irc", "mattermost"] as const;
  const legacyChannelExtensions = channels.filter((id) => legacy[id] !== undefined);
  if (legacyChannelExtensions.length === 0) return agent;
  const extensions = { ...agent.extensions };
  for (const id of legacyChannelExtensions) {
    const { enabled, ...ignored } = extensions[id] ?? {};
    extensions[id] = { ...legacy[id], ...(enabled === undefined ? {} : { enabled }) };
    const key = JSON.stringify([agent.workspace, id]);
    if (!warnedLegacyChannels.has(key)) {
      warnedLegacyChannels.add(key);
      const fields = Object.keys(ignored).sort();
      const details = fields.length ? `; ignored extensions.${id} fields: ${fields.join(", ")}` : "";
      console.warn(`[config] agent "${agent.id}" top-level "${id}" is deprecated; use extensions.${id}${details}`);
    }
  }
  return { ...agent, extensions, legacyChannelExtensions };
}

function readEnvFile(envPath: string): {
  content: string;
  env: Record<string, string>;
} {
  const content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  return {
    content,
    env: Object.fromEntries(
      Object.entries(parseEnv(content)).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    ),
  };
}

function filterAgentExtensionEnvRefs(agent: AgentConfig, allowlist: ReadonlySet<string>, ignored: ReadonlySet<string>): AgentConfig {
  if (!agent.extensions || Object.keys(agent.extensions).length === 0) return agent;
  const workspaceEnv = readEnvFile(path.join(agent.workspaceDir ?? agent.workspace, ".env")).env;

  function filter(value: unknown, extensionId: string): unknown {
    if (isEnvRef(value)) {
      const name = envRefName(value);
      if (Object.hasOwn(workspaceEnv, name) || allowlist.has(name)) return value;
      console.warn(`[config] agent "${agent.id}" extension "${extensionId}" dropped environment reference ${JSON.stringify(name)}`);
      return undefined;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => filter(entry, extensionId)).filter((entry) => entry !== undefined);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .map(([key, entry]) => [key, filter(entry, extensionId)] as const)
          .filter(([, entry]) => entry !== undefined)
      );
    }
    return value;
  }

  const extensions = Object.fromEntries(
    Object.entries(agent.extensions).map(([id, block]) => [id, ignored.has(id) ? block : filter(block, id) as typeof block])
  );
  return { ...agent, extensions };
}

function processEnvRecord(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

export function resolveAgentEnv(
  agent: AgentConfig,
  config: GatewayConfig = loadConfig()
): Record<string, string> {
  const configDir = path.dirname(getConfigPath());
  const homeEnv = readEnvFile(path.join(configDir, ".env")).env;
  const agentDir = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
  const agentEnvPath = path.join(agentDir, ".env");
  const { content, env: agentEnv } = readEnvFile(agentEnvPath);
  const envKey = JSON.stringify([agent.id, path.resolve(agentEnvPath)]);
  const digest = createHash("sha256").update(content).digest("hex");
  const changed = agentEnvDigests.get(envKey) !== digest;
  agentEnvDigests.set(envKey, digest);

  if (Object.keys(agentEnv).length > 0 && changed) {
    console.log(
      `[config] loaded agent env for "${agent.id}": ${Object.keys(agentEnv)
        .sort()
        .join(", ")}`
    );
  }

  return {
    ...processEnvRecord(),
    ...(config.env ?? {}),
    ...homeEnv,
    ...agentEnv,
  };
}

function portFromEnv(name: string): number | undefined {
  const value = readEnv(name);
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`YOPLAI_${name} must be a port from 1 to 65535, got "${value}"`);
  }
  return port;
}

/**
 * The launcher sets the ports it chose in the environment. They win over the file,
 * so the listeners, the MCP Apps ticket URLs, and the origin checks read the same ports.
 * Port 0 is refused: the proxy target, the origins, and the tickets would name port 0, not the bound port.
 */
function applyEnvPorts(config: GatewayConfig): void {
  const gatewayPort = portFromEnv("GATEWAY_PORT");
  const uiPort = portFromEnv("UI_PORT");
  const appsPort = portFromEnv("APPS_PORT");
  if (gatewayPort !== undefined) config.gateway = { ...config.gateway, port: gatewayPort };
  if (uiPort !== undefined) config.ui = { ...config.ui, port: uiPort };
  if (appsPort !== undefined) config.apps = { ...config.apps, port: appsPort };
}

export function loadConfig(configPathOverride?: string): GatewayConfig {
  if (!configPathOverride && cachedConfig) return cachedConfig;

  // Load .env file from YOPLAI_HOME if it exists (silently skip if absent)
  const dotenvPath = path.join(CONFIG_DIR, ".env");
  if (fs.existsSync(dotenvPath)) {
    process.loadEnvFile(dotenvPath);
  }

  const configPath = resolveConfigPath(configPathOverride);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const json = JSON.parse(raw);
  if (
    json.version !== 3 ||
    (Array.isArray(json.agents) &&
      json.agents.some(
        (agent: unknown) => typeof agent === "object" && agent !== null
      ))
  ) {
    throw new Error(
      "yoplai.json is version 2. Run `yoplai agents migrate` to upgrade to version 3."
    );
  }
  const parsed = GatewayRootConfigSchema.parse(json);
  const configDir = path.dirname(configPath);
  const extensionEnvAllowlist = new Set(parsed.extensionEnvAllowlist);
  const hasLegacyPool = Object.hasOwn(json, "pool");
  if (hasLegacyPool && !warnedLegacyPool) {
    warnedLegacyPool = true;
    console.warn("[config] The legacy pool key is ignored. Define runnable agents under agents/.");
  }
  const result: GatewayConfig = {
    ...parsed,
    version: 3,
    agents: discoverAgents(
      parsed.agents ?? DEFAULT_AGENT_DISCOVERY,
      configDir,
      extensionEnvAllowlist,
      !hasLegacyPool && parsed.agents === undefined
    ),
  };

  applyEnvPorts(result);

  // Validate OneCLI CA file path at startup if configured
  if (result.onecli?.enabled && result.onecli.ca?.source === "file") {
    result.onecli.ca.path = result.onecli.ca.path.replace(/^~/, os.homedir());
    if (!fs.existsSync(result.onecli.ca.path)) {
      console.warn(
        `[onecli] CA file not found: ${result.onecli.ca.path}. OneCLI proxy may fail until the CA is installed.`
      );
    }
  }

  // Apply env vars from config (only if not already set in process.env)
  if (result.env) {
    for (const [key, value] of Object.entries(result.env)) {
      if (!process.env[key]?.trim()) {
        process.env[key] = value;
      }
    }
  }

  // Apply defaults
  for (const agent of result.agents) {
    if (!agent.queueMode) agent.queueMode = "queue";
  }

  if (!configPathOverride) {
    rawLoadedConfig = result;
    cachedConfig = result;
  }
  return result;
}

/** Snapshot from disk before runtime secret resolution. */
export function getRawLoadedConfig(): GatewayConfig | null {
  return rawLoadedConfig;
}

export function reloadConfig(): GatewayConfig {
  cachedConfig = null;
  return loadConfig();
}

export function setLoadedConfig(config: GatewayConfig): void {
  cachedConfig = config;
}

export function clearConfigCacheForTests(): void {
  cachedConfig = null;
  rawLoadedConfig = null;
  singleAgentId = null;
  agentEnvDigests.clear();
}

/** Set single-agent mode - only this agent will be active */
export function setSingleAgentMode(agentId: string | null) {
  singleAgentId = agentId;
}

/** Check if agent is active (respects single-agent mode) */
export function isAgentActive(agentId: string): boolean {
  if (!singleAgentId) return true;
  return singleAgentId === agentId;
}

export function getAgent(id: string) {
  const config = loadConfig();
  return config.agents.find((a) => a.id === id);
}

export function getAgents() {
  return loadConfig().agents;
}

/** Get agents filtered by single-agent mode */
export function getActiveAgents() {
  const agents = loadConfig().agents;
  if (!singleAgentId) return agents;
  return agents.filter((a) => a.id === singleAgentId);
}

export function getSubagentTemplates(): SubagentConfig[] {
  const cfg = loadConfig();
  return cfg.subagents ?? [];
}

export function resolveWorkspaceDir(workspaceDir: string): string {
  if (workspaceDir.startsWith("~")) {
    return path.join(os.homedir(), workspaceDir.slice(1));
  }
  if (path.isAbsolute(workspaceDir)) {
    return workspaceDir;
  }
  // Resolve relative paths against the config file's parent directory
  const configDir = path.dirname(getConfigPath());
  return path.resolve(configDir, workspaceDir);
}
