import type { Command } from "commander";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, loadConfig } from "../config/index.js";
import { logError } from "../logging.js";

const LABEL = "com.yoplai.gateway";
// Pre-rename launchd label. It names an existing job and an existing plist
// FILE on disk, so it must stay readable or installs made before the rename
// become uncontrollable orphans.
const LEGACY_LABEL = "com.aihub.gateway";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function assertDarwin(): void {
  if (process.platform !== "darwin") {
    logError(
      "yoplai gateway service is unsupported on this platform",
      "macOS launchd only — Linux/systemd support pending."
    );
    process.exit(1);
  }
}

function plistPathFor(label: string): string {
  return path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${label}.plist`
  );
}

function serviceTargetFor(label: string): string {
  return `gui/${process.getuid?.() ?? ""}/${label}`;
}

function getDomainTarget(): string {
  return `gui/${process.getuid?.() ?? ""}`;
}

/** True when `label` names an install that exists on disk or in launchd. */
function installExists(label: string): boolean {
  return fs.existsSync(plistPathFor(label)) || isLoaded(label);
}

let warnedLegacyLabel = false;

/**
 * The label of the install that actually exists. Always prefers the current
 * label so a stale legacy plist can never shadow a new install; falls back to
 * the pre-rename label (warning once) so a service installed before the rename
 * stays fully controllable.
 */
function resolveActiveLabel(): string {
  if (installExists(LABEL)) return LABEL;
  if (installExists(LEGACY_LABEL)) {
    if (!warnedLegacyLabel) {
      warnedLegacyLabel = true;
      console.warn(
        `[gateway] Using legacy launchd service ${LEGACY_LABEL}; run 'yoplai gateway install' to migrate it to ${LABEL}.`
      );
    }
    return LEGACY_LABEL;
  }
  return LABEL;
}

function resolveCliEntry(): string {
  // service.ts lives in dist/cli/ at runtime → sibling index.js is the bin entry
  const candidate = path.join(__dirname, "index.js");
  if (fs.existsSync(candidate)) return candidate;
  // Fallback to globally-linked yoplai
  try {
    const out = execSync("command -v yoplai", { encoding: "utf-8" }).trim();
    if (out) return out;
  } catch {
    // ignore
  }
  throw new Error(
    `Cannot resolve yoplai CLI entry; expected ${candidate} or 'yoplai' on PATH.`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPlist(): string {
  const node = process.execPath;
  const entry = resolveCliEntry();
  const logsDir = path.join(CONFIG_DIR, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const stdout = path.join(logsDir, "gateway.out.log");
  const stderr = path.join(logsDir, "gateway.err.log");
  const homePath = process.env.HOME ?? os.homedir();
  const pathEnv =
    process.env.PATH ??
    "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin";

  const args = [node, entry, "gateway"];
  const argXml = args
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(CONFIG_DIR)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>YOPLAI_HOME</key>
    <string>${escapeXml(CONFIG_DIR)}</string>
    <key>HOME</key>
    <string>${escapeXml(homePath)}</string>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderr)}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`;
}

function runLaunchctl(args: string[], allowFail = false): number {
  try {
    execFileSync("launchctl", args, { stdio: "inherit" });
    return 0;
  } catch (err) {
    if (allowFail) {
      const status =
        (err as { status?: number }).status ??
        (typeof (err as { code?: number }).code === "number"
          ? ((err as { code: number }).code as number)
          : 1);
      return status;
    }
    throw err;
  }
}

function isLoaded(label: string): boolean {
  try {
    execFileSync("launchctl", ["print", serviceTargetFor(label)], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function installService(): void {
  assertDarwin();
  const plistPath = plistPathFor(LABEL);
  const legacyPlistPath = plistPathFor(LEGACY_LABEL);
  const migrating = installExists(LEGACY_LABEL);

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const plist = buildPlist();
  fs.writeFileSync(plistPath, plist, { mode: 0o644 });

  // Only one job may own the gateway port, so any legacy job goes down before
  // the new one comes up — the two are never loaded at the same time. The
  // legacy plist is kept on disk until bootstrap succeeds, so a failure can be
  // rolled back to the still-installed legacy service.
  if (migrating && isLoaded(LEGACY_LABEL)) {
    runLaunchctl(["bootout", serviceTargetFor(LEGACY_LABEL)], true);
  }
  // Bootout existing instance if present (idempotent install)
  if (isLoaded(LABEL)) {
    runLaunchctl(["bootout", serviceTargetFor(LABEL)], true);
  }

  try {
    runLaunchctl(["bootstrap", getDomainTarget(), plistPath]);
  } catch (err) {
    if (migrating) {
      // Drop the half-installed new plist first so it cannot shadow the
      // legacy install we are restoring.
      fs.rmSync(plistPath, { force: true });
      runLaunchctl(["bootstrap", getDomainTarget(), legacyPlistPath], true);
      logError(
        "install failed; rolled back to the legacy service",
        `Restored ${LEGACY_LABEL}. If it is not running, start it with 'yoplai gateway start'.`
      );
    }
    throw err;
  }

  if (migrating && fs.existsSync(legacyPlistPath)) {
    fs.rmSync(legacyPlistPath, { force: true });
  }

  const logsDir = path.join(CONFIG_DIR, "logs");
  if (migrating) {
    console.log(`Migrated:  ${LEGACY_LABEL} -> ${LABEL}`);
  }
  console.log(`Installed: ${plistPath}`);
  console.log(`Logs:      ${logsDir}/gateway.{out,err}.log`);
  console.log(`Service:   ${LABEL} (loaded, RunAtLoad=true)`);
}

function startService(): void {
  assertDarwin();
  const label = resolveActiveLabel();
  const plistPath = plistPathFor(label);
  if (!fs.existsSync(plistPath)) {
    logError("Service not installed", "Run 'yoplai gateway install' first.");
    process.exit(1);
  }
  if (!isLoaded(label)) {
    runLaunchctl(["bootstrap", getDomainTarget(), plistPath]);
  }
  runLaunchctl(["kickstart", "-k", serviceTargetFor(label)]);
  console.log(`Started: ${label}`);
}

function restartService(): void {
  assertDarwin();
  const label = resolveActiveLabel();
  const plistPath = plistPathFor(label);
  if (!fs.existsSync(plistPath)) {
    logError("Service not installed", "Run 'yoplai gateway install' first.");
    process.exit(1);
  }
  if (!isLoaded(label)) {
    runLaunchctl(["bootstrap", getDomainTarget(), plistPath]);
  }
  // kickstart -k stops and restarts in one shot
  runLaunchctl(["kickstart", "-k", serviceTargetFor(label)]);
  console.log(`Restarted: ${label}`);
}

function stopService(): void {
  assertDarwin();
  const label = resolveActiveLabel();
  if (!isLoaded(label)) {
    console.log(`Not running: ${label}`);
    return;
  }
  runLaunchctl(["bootout", serviceTargetFor(label)]);
  console.log(`Stopped: ${label}`);
}

type LaunchctlInfo = {
  loaded: boolean;
  pid: number | null;
  state: string | null;
  lastExitCode: number | null;
};

function readLaunchctlInfo(label: string): LaunchctlInfo {
  let raw: string;
  try {
    raw = execFileSync("launchctl", ["print", serviceTargetFor(label)], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { loaded: false, pid: null, state: null, lastExitCode: null };
  }
  const pidMatch = raw.match(/^\s*pid\s*=\s*(\d+)/m);
  const stateMatch = raw.match(/^\s*state\s*=\s*(\S+)/m);
  const exitMatch = raw.match(/^\s*last exit code\s*=\s*(-?\d+)/m);
  return {
    loaded: true,
    pid: pidMatch ? parseInt(pidMatch[1], 10) : null,
    state: stateMatch ? stateMatch[1] : null,
    lastExitCode: exitMatch ? parseInt(exitMatch[1], 10) : null,
  };
}

function readPorts(): { gateway: number; ui: number; uiEnabled: boolean } {
  try {
    const cfg = loadConfig();
    return {
      gateway: cfg.gateway?.port ?? 4000,
      ui: cfg.ui?.port ?? 3000,
      uiEnabled: cfg.ui?.enabled !== false,
    };
  } catch {
    return { gateway: 4000, ui: 3000, uiEnabled: true };
  }
}

function homeTilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function statusService(): void {
  assertDarwin();
  const label = resolveActiveLabel();
  const info = readLaunchctlInfo(label);
  const { gateway, ui, uiEnabled } = readPorts();
  const plistPath = plistPathFor(label);
  const plistExists = fs.existsSync(plistPath);
  const logsDir = path.join(CONFIG_DIR, "logs");

  let statusLine: string;
  if (!plistExists && !info.loaded) {
    statusLine = "not installed";
  } else if (info.loaded && info.pid && info.pid > 0) {
    const stateSuffix =
      info.state && info.state !== "running" ? ` (${info.state})` : "";
    statusLine = `running pid ${info.pid}${stateSuffix}`;
  } else if (info.loaded) {
    const exitSuffix =
      info.lastExitCode !== null ? ` last_exit=${info.lastExitCode}` : "";
    statusLine = `loaded, not running${exitSuffix}`;
  } else {
    statusLine = "installed, not loaded";
  }

  const rows: Array<[string, string]> = [
    ["Service", label],
    ["Status", statusLine],
    ["Gateway", `http://127.0.0.1:${gateway}`],
    ["UI", uiEnabled ? `http://127.0.0.1:${ui}` : "disabled"],
    ["Plist", homeTilde(plistPath)],
    ["Logs", `${homeTilde(logsDir)}/gateway.{out,err}.log`],
  ];
  if (label !== LEGACY_LABEL && installExists(LEGACY_LABEL)) {
    rows.push([
      "Legacy",
      `${LEGACY_LABEL} also present — 'yoplai gateway install' removes it`,
    ]);
  }

  const labelWidth = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => `  ${k.padEnd(labelWidth)}  ${v}`);
  const inner = Math.max(...lines.map((l) => l.length));
  const bar = "─".repeat(inner + 2);

  console.log(`┌${bar}┐`);
  console.log(`│ ${"Yoplai Gateway Service".padEnd(inner)} │`);
  console.log(`├${bar}┤`);
  for (const line of lines) {
    console.log(`│${line.padEnd(inner + 2)}│`);
  }
  console.log(`└${bar}┘`);
}

function uninstallService(): void {
  assertDarwin();
  // Remove every install that exists, so a legacy job is never left loaded
  // with no CLI path to stop it. Both present is handled by removing both.
  const labels = [LABEL, LEGACY_LABEL].filter((label) => installExists(label));
  if (labels.length === 0) {
    console.log(`No plist at ${plistPathFor(LABEL)}`);
    console.log(`Uninstalled: ${LABEL}`);
    return;
  }
  for (const label of labels) {
    if (isLoaded(label)) {
      runLaunchctl(["bootout", serviceTargetFor(label)], true);
    }
    const plistPath = plistPathFor(label);
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
      console.log(`Removed: ${plistPath}`);
    }
    console.log(`Uninstalled: ${label}`);
  }
}

export function registerGatewayServiceCommands(gatewayCmd: Command): void {
  gatewayCmd
    .command("install")
    .description("Install the gateway as a launchd service (macOS)")
    .action(() => {
      try {
        installService();
      } catch (err) {
        logError("install failed", err);
        process.exit(1);
      }
    });

  gatewayCmd
    .command("start")
    .description("Start the installed gateway service")
    .action(() => {
      try {
        startService();
      } catch (err) {
        logError("start failed", err);
        process.exit(1);
      }
    });

  gatewayCmd
    .command("restart")
    .description("Restart the installed gateway service (stop + start)")
    .action(() => {
      try {
        restartService();
      } catch (err) {
        logError("restart failed", err);
        process.exit(1);
      }
    });

  gatewayCmd
    .command("stop")
    .description("Stop the installed gateway service")
    .action(() => {
      try {
        stopService();
      } catch (err) {
        logError("stop failed", err);
        process.exit(1);
      }
    });

  gatewayCmd
    .command("status")
    .description("Show gateway service status")
    .action(() => {
      try {
        statusService();
      } catch (err) {
        logError("status failed", err);
        process.exit(1);
      }
    });

  gatewayCmd
    .command("uninstall")
    .description("Remove the gateway launchd service")
    .action(() => {
      try {
        uninstallService();
      } catch (err) {
        logError("uninstall failed", err);
        process.exit(1);
      }
    });
}
