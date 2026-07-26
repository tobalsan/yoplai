#!/usr/bin/env node
/**
 * Dev orchestrator: spawns gateway + web UI (if ui.enabled !== false)
 *
 * - Ensures only one Vite process (won't respawn on gateway restart)
 * - Uses YOPLAI_SKIP_WEB env var to prevent double-spawn
 * - Forwards SIGINT/SIGTERM to both processes
 * - Auto-discovers free ports for gateway and web UI
 * - Passes --dev flag to gateway to disable external services
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
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

async function main() {
  const config = loadConfig();
  const uiEnabled = config.ui?.enabled !== false; // default true

  const rootDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const children: ChildProcess[] = [];

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
    const web = spawn("pnpm", ["--filter", "@yoplai/web", "dev"], {
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
    children.push(web);
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
  children.push(gateway);

  // Cleanup handler
  const cleanup = (signal: string) => {
    console.log(`\n[dev] Received ${signal}, shutting down...`);
    for (const child of children) {
      child.kill("SIGTERM");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // Exit when gateway exits
  gateway.on("exit", (code) => {
    for (const child of children) {
      if (child !== gateway) child.kill("SIGTERM");
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("[dev] Error:", err);
  process.exit(1);
});
