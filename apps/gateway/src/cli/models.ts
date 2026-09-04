import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { CONFIG_DIR } from "../config/index.js";
import { logError } from "../logging.js";

type RefreshResult = {
  aborted: boolean;
  errors: ReadonlyMap<string, Error>;
};

type RefreshRuntime = {
  refresh(options: {
    allowNetwork: true;
    force: true;
    signal: AbortSignal;
  }): Promise<RefreshResult>;
};

type CreateRuntime = (options: {
  authPath: string;
  modelsPath: string;
  allowModelNetwork: true;
  refreshOnCreate: false;
}) => Promise<RefreshRuntime>;

type ModelRefreshDeps = {
  configDir?: string;
  createRuntime?: CreateRuntime;
};

async function createRuntime(
  options: Parameters<CreateRuntime>[0]
): Promise<RefreshRuntime> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create(options);
}

export async function runModelRefreshCommand(
  deps: ModelRefreshDeps = {}
): Promise<void> {
  const configDir = deps.configDir ?? CONFIG_DIR;
  await fs.mkdir(configDir, { recursive: true });

  console.log("Refreshing model catalog...");
  const runtime = await (deps.createRuntime ?? createRuntime)({
    authPath: path.join(configDir, "auth.json"),
    modelsPath: path.join(configDir, "models.json"),
    allowModelNetwork: true,
    refreshOnCreate: false,
  });
  const result = await runtime.refresh({
    allowNetwork: true,
    force: true,
    signal: AbortSignal.timeout(30_000),
  });
  if (result.aborted) {
    throw new Error("Model catalog refresh timed out after 30 seconds");
  }
  if (result.errors.size > 0) {
    const details = [...result.errors]
      .map(([provider, error]) => `${provider}: ${error.message}`)
      .join("; ");
    throw new Error(`Model catalog refresh failed: ${details}`);
  }
  console.log(
    `Model catalog refreshed: ${path.join(configDir, "models-store.json")}`
  );
}

export function registerModelCommands(
  program: Command,
  deps: ModelRefreshDeps = {}
): void {
  program
    .command("models")
    .description("Manage model catalogs")
    .command("refresh")
    .description("Refresh Pi model catalogs from the network")
    .action(async () => {
      try {
        await runModelRefreshCommand(deps);
      } catch (error) {
        logError("Model catalog refresh failed", error);
        process.exitCode = 1;
      }
    });
}
