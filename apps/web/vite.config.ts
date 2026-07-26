import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { readEnv, resolveConfigPath } from "../../packages/shared/src/config-path.js";
import { resolveBindHost } from "../../packages/shared/src/network.js";

type BindMode = "loopback" | "lan" | "tailnet";

interface TailscaleConfig {
  mode?: "off" | "serve";
  resetOnExit?: boolean;
}

interface UiConfig {
  port?: number;
  bind?: BindMode;
  tailscale?: TailscaleConfig;
}

interface GatewayConfig {
  host?: string;
  port?: number;
  bind?: BindMode;
}

interface BaseUrlConfig {
  baseUrl?: string;
}

interface AppConfig {
  ui?: UiConfig;
  gateway?: GatewayConfig;
  server?: BaseUrlConfig;
  web?: BaseUrlConfig;
}

function loadConfig(): AppConfig {
  try {
    const configPath = resolveConfigPath();
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Get tailnet MagicDNS hostname
 */
function getTailnetHostname(): string | null {
  try {
    const output = execSync("tailscale status --json", {
      encoding: "utf-8",
      timeout: 5000,
    });
    const status = JSON.parse(output);
    const dns = status?.Self?.DNSName as string | undefined;
    return dns ? dns.replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

function resolveHost(bind?: BindMode): string {
  const host = resolveBindHost(bind);
  if (bind === "tailnet" && host === "127.0.0.1") {
    console.warn(
      "[vite] tailnet bind: no tailnet IP found, falling back to 127.0.0.1"
    );
  }
  return host;
}

function resolveEnvReference(value?: string): string | undefined {
  if (!value) return undefined;
  const match = /^\$env:([A-Z0-9_]+)$/.exec(value.trim());
  if (!match) return value;
  return process.env[match[1]];
}

function extractHostname(url?: string): string | null {
  const resolvedUrl = resolveEnvReference(url);
  if (!resolvedUrl) return null;
  try {
    return new URL(resolvedUrl).hostname;
  } catch {
    return null;
  }
}

const config = loadConfig();
const uiConfig = config.ui ?? {};
const gatewayConfig = config.gateway ?? {};

// Dev mode detection: YOPLAI_DEV=1 from scripts/dev.ts
const isDevMode = readEnv("DEV") === "1";

// Port resolution: env vars from dev orchestrator take precedence
const port = readEnv("UI_PORT")
  ? parseInt(readEnv("UI_PORT")!, 10)
  : (uiConfig.port ?? 3000);

// In dev mode, disable tailscale serve (handled separately by production)
const tailscaleServe = !isDevMode && uiConfig.tailscale?.mode === "serve";

// When using tailscale serve, bind to localhost so tailscale can proxy to it
// Otherwise, use the configured bind mode
const host = tailscaleServe ? "127.0.0.1" : resolveHost(uiConfig.bind);

// Get MagicDNS hostname for allowed hosts when using tailscale serve
const tailnetHostname = tailscaleServe ? getTailnetHostname() : null;
const configuredHostnames = [
  extractHostname(config.server?.baseUrl),
  extractHostname(config.web?.baseUrl),
  tailnetHostname,
  "thinhs-mac-studio.catla-powan.ts.net",
].filter(
  (value, index, values): value is string =>
    !!value && values.indexOf(value) === index
);
const hmrHostOverride = readEnv("HMR_HOST");

// Resolve gateway target for proxy
// In dev mode, use YOPLAI_GATEWAY_PORT from orchestrator
const gatewayBindHost = gatewayConfig.host ?? resolveHost(gatewayConfig.bind);
// The proxy connects (not listens), so 0.0.0.0 isn't a valid destination on
// macOS — rewrite to loopback. The gateway still listens on all interfaces.
const gatewayHost = gatewayBindHost === "0.0.0.0" ? "127.0.0.1" : gatewayBindHost;
const gatewayPort = readEnv("GATEWAY_PORT")
  ? parseInt(readEnv("GATEWAY_PORT")!, 10)
  : (gatewayConfig.port ?? 4000);
const gatewayTarget = `http://${gatewayHost}:${gatewayPort}`;

// In dev mode, always use root path (no /yoplai prefix)
const base = tailscaleServe ? "/yoplai" : "/";

export default defineConfig({
  base,
  plugins: [solid()],
  build: {
    rollupOptions: {
      input: "./index.html",
    },
  },
  server: {
    host,
    port,
    allowedHosts: configuredHostnames.length > 0 ? configuredHostnames : undefined,
    // Let HMR follow the browser host by default; allow override if needed
    hmr: hmrHostOverride ? { host: hmrHostOverride } : undefined,
    proxy: {
      "/api": {
        target: gatewayTarget,
        changeOrigin: true,
      },
      "/ws": {
        target: gatewayTarget,
        ws: true,
      },
    },
  },
  preview: {
    host,
    port,
    allowedHosts: configuredHostnames.length > 0 ? configuredHostnames : undefined,
  },
});
