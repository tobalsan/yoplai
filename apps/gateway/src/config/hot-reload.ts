import fs from "node:fs";
import path from "node:path";
import {
  getAgentJobsPath,
  getScheduler,
  hasSchedulerContext,
} from "@yoplai/extension-scheduler";
import type { GatewayConfig } from "@yoplai/shared";
import { getConfigPath, reloadConfig, setLoadedConfig } from "./index.js";
import { resolveStartupConfig } from "./validate.js";

export const HOT_RELOAD_INTERVAL_MS = 5000;

type HotReloadOptions = {
  intervalMs?: number;
  onReload?: (config: GatewayConfig) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

function mtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined;
  }
}

function signature(config: GatewayConfig): string {
  const parts = [String(mtimeMs(getConfigPath()) ?? "missing")];
  parts.push(...config.agents.map((agent) => {
    const workspace = agent.workspaceDir ?? agent.workspace;
    return [
      agent.id,
      mtimeMs(path.join(workspace, "agent.yaml")) ?? "missing",
      mtimeMs(getAgentJobsPath(workspace)) ?? "missing",
    ].join(":");
  }));
  return parts.join("|");
}

export function startGatewayHotReload(
  initialConfig: GatewayConfig,
  options: HotReloadOptions = {}
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? HOT_RELOAD_INTERVAL_MS;
  let lastConfig = initialConfig;
  let lastSignature = signature(initialConfig);
  let running = false;

  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const currentSignature = signature(lastConfig);
      if (currentSignature === lastSignature) return;

      const rawConfig = reloadConfig();
      const nextConfig = await resolveStartupConfig(rawConfig);
      const nextSignature = signature(nextConfig);
      // resolveStartupConfig returns a new object; reloadConfig left the raw
      // config in the cache, so install the resolved one (with $env: refs
      // interpolated) before anything reads it via getAgent()/loadConfig().
      setLoadedConfig(nextConfig);
      lastConfig = nextConfig;
      lastSignature = nextSignature;
      if (nextConfig.extensions?.scheduler && hasSchedulerContext()) {
        await getScheduler().refreshFromDisk();
      }
      await options.onReload?.(nextConfig);
    } catch (error) {
      setLoadedConfig(lastConfig);
      options.onError?.(error);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}
