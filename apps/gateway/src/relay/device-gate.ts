import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInsideRoot } from "../util/paths.js";
import type { DeviceToolName } from "@yoplai/shared";
import type { ChatDeviceSettings } from "./device-settings.js";

export type DeviceMode = "ask" | "workspace" | "full";
export type GateDecision = "pass" | "ask";

/** The mode that results from the settings of a chat. Full wins over a workspace folder. */
export function resolveDeviceMode(settings: ChatDeviceSettings): DeviceMode {
  if (settings.full) return "full";
  return settings.workspaceFolder ? "workspace" : "ask";
}

/** Resolves a path one time to an absolute path. The gate and the tool both use this result. */
export function resolveAgainstFolder(folder: string, rawPath: string): string {
  const expanded =
    rawPath === "~" ? os.homedir() : rawPath.startsWith("~/") ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  return path.resolve(folder, expanded);
}

/**
 * Resolves each symbolic link. For a path that does not exist, it resolves the nearest
 * directory that exists. Returns undefined for a dangling symbolic link, because a write
 * would follow it to an unknown place.
 */
async function realPathOrNearest(target: string): Promise<string | undefined> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    try {
      await fs.lstat(current);
      return undefined;
    } catch {
      // The path does not exist, so look at its parent.
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    missing.push(path.basename(current));
    current = parent;
  }
}

/** Compares real paths: a symbolic link in the folder that points outside is not in the folder. */
export async function isInsideWorkspaceFolder(folder: string, absolutePath: string): Promise<boolean> {
  const realFolder = await realPathOrNearest(folder);
  const realTarget = await realPathOrNearest(absolutePath);
  return realFolder !== undefined && realTarget !== undefined && isInsideRoot(realFolder, realTarget);
}

export async function decideGate(input: {
  tool: DeviceToolName;
  mode: DeviceMode;
  folder?: string;
  /** The resolved path of a file call. */
  absolutePath?: string;
}): Promise<GateDecision> {
  if (input.mode === "full" || input.tool === "device_read") return "pass";
  if (
    input.mode === "workspace" &&
    (input.tool === "device_write" || input.tool === "device_edit") &&
    input.folder !== undefined &&
    input.absolutePath !== undefined &&
    (await isInsideWorkspaceFolder(input.folder, input.absolutePath))
  ) {
    return "pass";
  }
  return "ask";
}
