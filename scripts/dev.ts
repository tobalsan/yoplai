#!/usr/bin/env node
/**
 * Dev orchestrator: spawns gateway + web UI (if ui.enabled !== false)
 *
 * - Ensures only one Vite process (won't respawn on gateway restart)
 * - Uses YOPLAI_SKIP_WEB env var to prevent double-spawn
 * - Stops the full child process tree on SIGINT/SIGTERM (pnpm shims do not
 *   forward signals, so stopping only direct children leaves orphans)
 * - Auto-discovers free ports for gateway and web UI
 * - Passes --dev flag to gateway to disable external services
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { readEnv, resolveConfigPath } from "../packages/shared/src/config-path.js";

interface Config {
  ui?: {
    enabled?: boolean;
    port?: number;
    bind?: "loopback" | "lan" | "tailnet";
    tailscale?: { mode?: "off" | "serve" };
  };
  gateway?: {
    port?: number;
  };
}

function loadConfig(): Config {
  try {
    const configPath = resolveConfigPath();
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(200);
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(true);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function findFreePort(basePort: number, maxAttempts: number = 50): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset++) {
    const port = basePort + offset;
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free port found in range ${basePort}-${basePort + maxAttempts - 1}`);
}

const STOP_GRACE_MS = 10_000;

/** All live descendants of this process, found from `ps` parent PIDs. */
function descendantPids(): number[] {
  const children = new Map<number, number[]>();
  const rows = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  for (const row of rows.trim().split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const found: number[] = [];
  const queue = [process.pid];
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()!) ?? []) {
      found.push(pid);
      queue.push(pid);
    }
  }
  return found;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function waitForExit(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    alive = alive.filter(isAlive);
  }
  return alive;
}

async function main() {
  const config = loadConfig();
  const uiEnabled = config.ui?.enabled !== false; // default true

  const rootDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));

  // Find free ports
  const baseGatewayPort = config.gateway?.port ?? 4000;
  const baseUiPort = config.ui?.port ?? 3000;

  console.log("[dev] Finding free ports...");
  const gatewayPort = await findFreePort(baseGatewayPort);
  const uiPort = uiEnabled ? await findFreePort(baseUiPort) : null;

  if (gatewayPort !== baseGatewayPort) {
    console.log(`[dev] Gateway port ${baseGatewayPort} in use, using ${gatewayPort}`);
  }
  if (uiPort && uiPort !== baseUiPort) {
    console.log(`[dev] UI port ${baseUiPort} in use, using ${uiPort}`);
  }

  // Start web UI (unless disabled or already spawned)
  if (uiEnabled && !readEnv("SKIP_WEB") && uiPort) {
    console.log("[dev] Starting web UI...");
    spawn("pnpm", ["--filter", "@yoplai/web", "dev"], {
      stdio: "inherit",
      cwd: rootDir,
      env: {
        ...process.env,
        YOPLAI_DEV: "1",
        YOPLAI_GATEWAY_PORT: String(gatewayPort),
        YOPLAI_UI_PORT: String(uiPort),
        // VITE_ prefixed vars are exposed to browser via import.meta.env
        VITE_YOPLAI_DEV: "true",
        VITE_YOPLAI_UI_PORT: String(uiPort),
      },
    });
  } else if (!uiEnabled) {
    console.log("[dev] Web UI disabled (ui.enabled: false)");
  }

  // Start gateway with tsx watch and --dev flag
  console.log("[dev] Starting gateway...");
  const gatewayNodeOptions = [process.env.NODE_OPTIONS, "--conditions=development"].filter(Boolean).join(" ");
  const gateway = spawn(
    "pnpm",
    ["--filter", "@yoplai/gateway", "exec", "tsx", "watch", "src/cli/index.ts", "gateway", "--dev", "--port", String(gatewayPort)],
    {
      stdio: "inherit",
      cwd: rootDir,
      env: { ...process.env, YOPLAI_SKIP_WEB: "1", YOPLAI_DEV: "1", YOPLAI_WORKSPACE_ROOT: rootDir, YOPLAI_GATEWAY_PORT: String(gatewayPort), NODE_OPTIONS: gatewayNodeOptions, ...(uiPort ? { YOPLAI_UI_PORT: String(uiPort) } : {}) },
    }
  );

  let stopping = false;
  // `fromTerminal`: a Ctrl-C already sent SIGINT to every process in the
  // group. A second signal makes `tsx watch` SIGKILL the gateway during its
  // shutdown, so in that case send SIGTERM only to late survivors.
  const stopTree = async (reason: string, code: number, fromTerminal = false) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[dev] ${reason}, shutting down...`);
    // Snapshot the tree first: once a pnpm shim exits, its children move to
    // PID 1 and drop out of the tree.
    const pids = descendantPids();
    if (!fromTerminal) signalAll(pids, "SIGTERM");
    let alive = await waitForExit(pids, STOP_GRACE_MS);
    if (alive.length > 0 && fromTerminal) {
      signalAll(alive, "SIGTERM");
      alive = await waitForExit(alive, STOP_GRACE_MS);
    }
    if (alive.length > 0) {
      console.log(`[dev] Force killing ${alive.length} process(es)`);
      signalAll(alive, "SIGKILL");
    }
    process.exit(code);
  };

  process.on("SIGINT", () => void stopTree("Received SIGINT", 0, true));
  process.on("SIGTERM", () => void stopTree("Received SIGTERM", 0));

  // Exit when gateway exits
  gateway.on("exit", (code) => void stopTree("Gateway exited", code ?? 0));
}

main().catch((err) => {
  console.error("[dev] Error:", err);
  process.exit(1);
});
