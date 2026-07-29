import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentConfig,
  GlobalSandboxConfig,
  MountAllowlist,
  OnecliConfig,
  SandboxMount,
} from "@yoplai/shared";
import { resolveWorkspaceDir } from "../config/index.js";
import { logWarn } from "../logging.js";

export type ContainerVolumeMount = {
  source: string;
  target: string;
  readonly: boolean;
};

const DEFAULT_IMAGE = "yoplai-agent:latest";
const AGENT_IMAGE_HASH_LABEL = "yoplai.agent-runner.hash";
const DEFAULT_MEMORY = "2g";
const DEFAULT_CPUS = 1;
const DEFAULT_NETWORK = "yoplai-agents";
const DEFAULT_GATEWAY_URL = "http://gateway:4000";
const CONTAINER_ONECLI_CA_PATH =
  "/usr/local/share/ca-certificates/onecli-ca.pem";
export const CONTAINER_DATA_DIR = "/workspace/data";
export const CONTAINER_UPLOADS_DIR = "/workspace/uploads";

function createContainerName(agentId: string): string {
  return `yoplai-agent-${agentId}-${randomUUID()}`;
}

export function getMountedOnecliCaPath(
  onecli?: OnecliConfig
): string | undefined {
  if (onecli?.ca?.source !== "file" || !onecli.ca.path) return undefined;
  if (!fs.existsSync(resolveHostPath(onecli.ca.path))) return undefined;
  return CONTAINER_ONECLI_CA_PATH;
}
const SECRET_KEY_PATTERNS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "AUTH",
  "PRIVATE",
  "API_KEY",
  "ACCESS_KEY",
  "SECRET_KEY",
];
const SECRET_VALUE_PREFIXES = [
  "sk-",
  "pk-",
  "ghp_",
  "gho_",
  "ghu_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "xapp-",
];

function resolveHostPath(hostPath: string): string {
  if (hostPath === "~") return os.homedir();
  if (hostPath.startsWith("~/")) {
    return path.join(os.homedir(), hostPath.slice(2));
  }
  return path.resolve(hostPath);
}

function isUnderRoot(hostPath: string, root: string): boolean {
  let rootPath = resolveHostPath(root);
  try {
    rootPath = fs.realpathSync(rootPath);
  } catch {
    // Nonexistent roots are validated lexically.
  }
  const relative = path.relative(rootPath, hostPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function blockedHostSegment(
  hostPath: string,
  patterns: string[]
): string | null {
  const segments = resolveHostPath(hostPath).split(path.sep).filter(Boolean);
  return (
    patterns.find((pattern) =>
      segments.some((segment) => segment.includes(pattern))
    ) ?? null
  );
}

function addMount(
  mounts: ContainerVolumeMount[],
  source: string,
  target: string,
  readonly: boolean
): void {
  mounts.push({ source, target, readonly });
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

export function getAgentDataDir(homeDir: string, agentId: string): string {
  return path.join(
    resolveHostPath(homeDir),
    "agents",
    sanitizePathSegment(agentId),
    "data"
  );
}

export function getSessionUploadsDir(
  homeDir: string,
  agentId: string,
  sessionId: string
): string {
  return path.join(
    resolveHostPath(homeDir),
    "agents",
    sanitizePathSegment(agentId),
    "uploads",
    sanitizePathSegment(sessionId)
  );
}

export function validateMount(
  mount: SandboxMount,
  allowlist: MountAllowlist
): void {
  let hostPath = resolveHostPath(mount.host);

  try {
    hostPath = fs.realpathSync(hostPath);
  } catch {
    // Nonexistent paths can still be created later.
  }

  if (!allowlist.allowedRoots.some((root) => isUnderRoot(hostPath, root))) {
    throw new Error(
      `Mount host path is not allowed by sandbox allowlist: ${mount.host}`
    );
  }

  const blockedPattern = blockedHostSegment(
    hostPath,
    allowlist.blockedPatterns ?? []
  );
  if (blockedPattern) {
    throw new Error(
      `Mount host path contains blocked pattern "${blockedPattern}": ${mount.host}`
    );
  }

  if (!mount.container.startsWith("/")) {
    throw new Error(
      `Mount container path must be absolute: ${mount.container}`
    );
  }

  if (mount.container.split("/").includes("..")) {
    throw new Error(
      `Mount container path cannot contain path traversal: ${mount.container}`
    );
  }
}

export function buildVolumeMounts(
  agent: AgentConfig,
  globalSandbox: GlobalSandboxConfig,
  homeDir: string,
  userId?: string,
  onecli?: OnecliConfig,
  sessionId?: string
): ContainerVolumeMount[] {
  const mounts: ContainerVolumeMount[] = [];
  const sandbox = agent.sandbox;
  const workspace = resolveWorkspaceDir(agent.workspace);
  const home = resolveHostPath(homeDir);

  addMount(mounts, workspace, "/workspace", !sandbox?.workspaceWritable);

  const dataDir = getAgentDataDir(homeDir, agent.id);
  fs.mkdirSync(dataDir, { recursive: true });
  addMount(mounts, dataDir, CONTAINER_DATA_DIR, false);

  if (sessionId) {
    const uploadsDir = getSessionUploadsDir(homeDir, agent.id, sessionId);
    fs.mkdirSync(uploadsDir, { recursive: true });
    addMount(mounts, uploadsDir, CONTAINER_UPLOADS_DIR, true);
  }

  if (globalSandbox.sharedDir) {
    addMount(
      mounts,
      resolveHostPath(globalSandbox.sharedDir),
      "/shared",
      false
    );
  }

  if (userId) {
    addMount(
      mounts,
      path.join(home, "sessions", "users", userId),
      `/users/${userId}`,
      false
    );
  }

  addMount(mounts, path.join(home, "sessions", agent.id), "/sessions", false);
  addMount(mounts, path.join(home, "ipc", agent.id), "/workspace/ipc", false);

  const modelsPath = path.join(home, "models.json");
  if (fs.existsSync(modelsPath)) {
    addMount(mounts, modelsPath, "/sessions/models.json", true);
  }

  if (onecli?.ca?.source === "file" && onecli.ca.path) {
    const caPath = resolveHostPath(onecli.ca.path);
    if (fs.existsSync(caPath)) {
      addMount(mounts, caPath, CONTAINER_ONECLI_CA_PATH, true);
    }
  }

  const workspaceEnvPath = path.join(workspace, ".env");
  if (fs.existsSync(workspaceEnvPath)) {
    addMount(mounts, "/dev/null", "/workspace/.env", true);
  }

  if (sandbox?.mounts?.length) {
    if (!globalSandbox.mountAllowlist) {
      throw new Error("Custom sandbox mounts require a mount allowlist");
    }

    for (const mount of sandbox.mounts) {
      validateMount(mount, globalSandbox.mountAllowlist);
      addMount(
        mounts,
        resolveHostPath(mount.host),
        mount.container,
        mount.readonly ?? true
      );
    }
  }

  return mounts;
}

export function filterSecretEnvVars(
  env: Record<string, string> | undefined,
  warn: (message: string) => void = console.warn
): Record<string, string> {
  if (!env) return {};

  const filtered: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    const lowerValue = value.toLowerCase();
    const keyLooksSecret = SECRET_KEY_PATTERNS.some((pattern) =>
      upperKey.includes(pattern)
    );
    const valueLooksBase64Secret =
      value.length > 20 && /^[A-Za-z0-9+/=]+$/.test(value);
    const valueLooksPrefixedSecret = SECRET_VALUE_PREFIXES.some((prefix) =>
      lowerValue.startsWith(prefix)
    );

    if (keyLooksSecret || valueLooksBase64Secret || valueLooksPrefixedSecret) {
      warn(`Filtered sandbox.env key "${key}" (looks like secret)`);
      continue;
    }

    filtered[key] = value;
  }

  return filtered;
}

function buildContainerOnecliProxyUrl(
  onecli: OnecliConfig | undefined,
  agent: AgentConfig
): string | undefined {
  if (!onecli?.gatewayUrl) return undefined;
  const base = onecli.sandbox?.url ?? onecli.gatewayUrl;
  const url = new URL(base);
  if (!onecli.sandbox?.url) {
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = "host.docker.internal";
    }
  }
  if (agent.onecliToken) {
    url.username = "onecli";
    url.password = agent.onecliToken;
  }
  return url.toString().replace(/\/$/, "");
}

export function buildContainerArgs(
  agent: AgentConfig,
  globalSandbox: GlobalSandboxConfig,
  mounts: ContainerVolumeMount[],
  _homeDir: string,
  _userId?: string,
  onecli?: OnecliConfig,
  configEnv?: Record<string, string>
): string[] {
  const sandbox = agent.sandbox;
  const onecliEnabled = onecli?.enabled !== false && !!onecli?.gatewayUrl;
  const args = [
    "run",
    "-i",
    "--rm",
    "--name",
    createContainerName(agent.id),
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--memory",
    sandbox?.memory ?? DEFAULT_MEMORY,
    "--cpus",
    String(sandbox?.cpus ?? DEFAULT_CPUS),
    "--network",
    sandbox?.network ?? globalSandbox.network?.name ?? DEFAULT_NETWORK,
    "--add-host",
    "host.docker.internal:host-gateway",
  ];

  for (const mount of mounts) {
    args.push(
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target}${
        mount.readonly ? ",readonly" : ""
      }`
    );
  }

  const containerProxyUrl = onecliEnabled
    ? buildContainerOnecliProxyUrl(onecli, agent)
    : undefined;
  const caMountedInContainer = onecliEnabled
    ? getMountedOnecliCaPath(onecli)
    : undefined;

  const env: Record<string, string> = {
    GATEWAY_URL: DEFAULT_GATEWAY_URL,
    ...(containerProxyUrl
      ? {
          ONECLI_URL: containerProxyUrl,
          HTTP_PROXY: containerProxyUrl,
          HTTPS_PROXY: containerProxyUrl,
          NO_PROXY: "gateway,host.docker.internal,localhost,127.0.0.1",
          ...(caMountedInContainer
            ? {
                NODE_EXTRA_CA_CERTS: caMountedInContainer,
                SSL_CERT_FILE: caMountedInContainer,
                REQUESTS_CA_BUNDLE: caMountedInContainer,
                ONECLI_CA_PATH: caMountedInContainer,
              }
            : { NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
        }
      : {}),
    ...filterSecretEnvVars(configEnv),
    ...filterSecretEnvVars(sandbox?.env),
  };

  for (const [key, value] of Object.entries(env)) {
    args.push("--env", `${key}=${value}`);
  }

  args.push(sandbox?.image ?? DEFAULT_IMAGE);

  return args;
}

export function ensureNetwork(networkName: string, internal: boolean): void {
  try {
    execFileSync("docker", ["network", "inspect", networkName], {
      stdio: "ignore",
    });
  } catch {
    execFileSync(
      "docker",
      ["network", "create", ...(internal ? ["--internal"] : []), networkName],
      { stdio: "ignore" }
    );
  }
}

function findRepoRoot(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "container/agent-runner/Dockerfile"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function sortedFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) return sortedFiles(file);
    return entry.isFile() ? [file] : [];
  });
}

export function getAgentImageHash(repoRoot: string): string | null {
  const inputs = [
    "container/agent-runner/Dockerfile",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "container/agent-runner/package.json",
    "packages/shared/package.json",
  ].map((file) => path.join(repoRoot, file));
  const runnerDist = path.join(repoRoot, "container/agent-runner/dist");
  const sharedDist = path.join(repoRoot, "packages/shared/dist");

  if (!fs.existsSync(runnerDist) || !fs.existsSync(sharedDist)) return null;
  if (!inputs.every((file) => fs.existsSync(file))) return null;

  const files = [
    ...inputs,
    ...sortedFiles(runnerDist),
    ...sortedFiles(sharedDist),
  ]
    .map((file) => path.relative(repoRoot, file).split(path.sep).join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(repoRoot, file)));
  }
  return hash.digest("hex");
}

const imageInputWarnings = new Set<string>();

function warnUnresolvableImageInputs(reason: string): void {
  if (imageInputWarnings.has(reason)) return;
  imageInputWarnings.add(reason);
  logWarn(`[container] skipping sandbox image freshness check: ${reason}`);
}

function buildAgentImage(
  image: string,
  repoRoot: string,
  hash: string,
  reason: string
): void {
  console.log(`Container sandbox: building ${image} (${reason})...`);
  execFileSync(
    "docker",
    [
      "build",
      "--label",
      `${AGENT_IMAGE_HASH_LABEL}=${hash}`,
      "-t",
      image,
      "-f",
      path.join(repoRoot, "container/agent-runner/Dockerfile"),
      repoRoot,
    ],
    { stdio: "inherit" }
  );
}

export function ensureAgentImage(
  image: string,
  repoRoot = findRepoRoot()
): void {
  let imagePresent = true;
  try {
    execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  } catch {
    imagePresent = false;
  }
  if (image !== DEFAULT_IMAGE) {
    if (imagePresent) return;
    throw new Error(
      `Sandbox image ${image} not present locally; build it before starting the gateway.`
    );
  }
  if (!repoRoot) {
    warnUnresolvableImageInputs("repository root was not found");
    return;
  }
  const hash = getAgentImageHash(repoRoot);
  if (!hash) {
    warnUnresolvableImageInputs(
      "agent-runner or shared build output is missing"
    );
    return;
  }
  if (!imagePresent) {
    buildAgentImage(image, repoRoot, hash, "first run");
    return;
  }
  const imageHash = execFileSync(
    "docker",
    [
      "image",
      "inspect",
      "--format",
      `{{index .Config.Labels "${AGENT_IMAGE_HASH_LABEL}"}}`,
      image,
    ],
    { encoding: "utf8" }
  ).trim();
  if (imageHash !== hash) {
    console.log(
      `Container sandbox: ${image} is stale (image hash ${imageHash || "missing"}, current hash ${hash})`
    );
    buildAgentImage(image, repoRoot, hash, "stale image");
  }
}

export function cleanupOrphanContainers(): void {
  // Match containers named by both the current and pre-rename gateway so
  // containers left behind by an older gateway (named `aihub-agent-*`) are
  // still reaped. Multiple `--filter name=` values are OR'd by docker.
  const containerIds = execFileSync(
    "docker",
    [
      "ps",
      "-q",
      "--filter",
      "name=yoplai-agent-",
      "--filter",
      "name=aihub-agent-",
    ],
    { encoding: "utf8" }
  )
    .split("\n")
    .map((id) => id.trim())
    .filter(Boolean);

  if (containerIds.length) {
    execFileSync("docker", ["rm", "-f", ...containerIds], { stdio: "ignore" });
  }
}
