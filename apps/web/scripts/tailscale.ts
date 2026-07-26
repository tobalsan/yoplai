import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const TAILSCALE_CANDIDATES = [
  "tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

function getTailscaleCmd(): string {
  for (const candidate of TAILSCALE_CANDIDATES) {
    if (candidate.startsWith("/") && !existsSync(candidate)) continue;
    try {
      execSync(`${candidate} version`, { encoding: "utf-8", timeout: 5000 });
      return candidate;
    } catch {
      // Try next
    }
  }
  throw new Error("Tailscale CLI not found");
}

/**
 * Get tailnet hostname (DNS name or IP fallback) from tailscale status
 */
export function getTailnetHostname(): string {
  const cmd = getTailscaleCmd();
  const stdout = execSync(`${cmd} status --json`, {
    encoding: "utf-8",
    timeout: 5000,
  });
  const parsed = JSON.parse(stdout);
  const self = parsed?.Self;
  const dns = typeof self?.DNSName === "string" ? self.DNSName : undefined;
  const ips = Array.isArray(self?.TailscaleIPs) ? self.TailscaleIPs : [];

  if (dns && dns.length > 0) return dns.replace(/\.$/, "");
  if (ips.length > 0) return ips[0];
  throw new Error("Could not determine Tailscale DNS or IP");
}

/**
 * Enable tailscale serve on a port (HTTPS proxy)
 */
export function enableTailscaleServe(port: number, path: string = "/yoplai"): void {
  const cmd = getTailscaleCmd();
  const normalizedPath = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  const target = `http://127.0.0.1:${port}${normalizedPath}`;
  execSync(`${cmd} serve --bg --yes --set-path=${normalizedPath} ${target}`, {
    encoding: "utf-8",
    timeout: 15000,
  });
}

/**
 * Disable tailscale serve
 */
export function disableTailscaleServe(): void {
  try {
    const cmd = getTailscaleCmd();
    execSync(`${cmd} serve reset`, {
      encoding: "utf-8",
      timeout: 15000,
    });
  } catch {
    // Ignore errors on reset
  }
}
