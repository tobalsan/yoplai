#!/usr/bin/env node
/**
 * Dev launcher for web UI with optional Tailscale HTTPS support.
 *
 * Reads $YOPLAI_HOME/yoplai.json for ui config:
 * - ui.port: dev server port (default 3000)
 * - ui.bind: "loopback" | "lan" | "tailnet"
 * - ui.tailscale.mode: "off" | "serve" (enables HTTPS via tailscale serve)
 * - ui.tailscale.resetOnExit: reset tailscale serve on exit (default true)
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { getTailnetHostname, enableTailscaleServe, disableTailscaleServe } from "./tailscale.js";
import { readEnv, resolveConfigPath } from "../../../packages/shared/src/config-path.js";

type UiBindMode = "loopback" | "lan" | "tailnet";

interface UiConfig {
  port?: number;
  bind?: UiBindMode;
  tailscale?: {
    mode?: "off" | "serve";
    resetOnExit?: boolean;
  };
}

interface GatewayConfig {
  port?: number;
  bind?: UiBindMode;
}

interface Config {
  ui?: UiConfig;
  gateway?: GatewayConfig;
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

async function main() {
  const config = loadConfig();
  const uiConfig = config.ui ?? {};
  const gatewayConfig = config.gateway ?? {};

  // In dev mode (YOPLAI_DEV=1), use ports from orchestrator
  const isDevMode = readEnv("DEV") === "1";
  const port = readEnv("UI_PORT") ? parseInt(readEnv("UI_PORT")!, 10) : (uiConfig.port ?? 3000);
  const gatewayPort = readEnv("GATEWAY_PORT") ? parseInt(readEnv("GATEWAY_PORT")!, 10) : (gatewayConfig.port ?? 4000);

  // In dev mode, skip tailscale serve entirely
  const tailscaleMode = isDevMode ? "off" : (uiConfig.tailscale?.mode ?? "off");
  const resetOnExit = uiConfig.tailscale?.resetOnExit ?? true;

  let tailscaleHostname: string | null = null;

  // Enable tailscale serve if configured (skipped in dev mode)
  if (tailscaleMode === "serve") {
    try {
      console.log(`[dev] Enabling Tailscale serve on port ${port} (path /yoplai)...`);
      enableTailscaleServe(port, "/yoplai");
      enableTailscaleServe(gatewayPort, "/api");
      enableTailscaleServe(gatewayPort, "/ws");
      tailscaleHostname = getTailnetHostname();
      console.log(`[dev] HTTPS available at: https://${tailscaleHostname}/yoplai`);
    } catch (err) {
      console.error("[dev] Failed to enable Tailscale serve:", err);
      console.log("[dev] Continuing without HTTPS...");
    }
  }

  // Spawn vite dev server
  const vite = spawn("pnpm", ["exec", "vite"], {
    stdio: "inherit",
    env: {
      ...process.env,
      // Vite reads host/port from config, but we can override via env if needed
    },
    cwd: path.dirname(path.dirname(new URL(import.meta.url).pathname)),
  });

  // Cleanup on exit
  const cleanup = () => {
    if (tailscaleMode === "serve" && resetOnExit) {
      console.log("\n[dev] Resetting Tailscale serve...");
      disableTailscaleServe();
    }
    vite.kill();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  vite.on("exit", (code) => {
    if (tailscaleMode === "serve" && resetOnExit) {
      disableTailscaleServe();
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
