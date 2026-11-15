import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInsideRoot } from "../util/paths.js";
import type { DeviceToolName } from "@yoplai/shared";
import { isSecretPath } from "./device-secrets.js";
import type { ChatDeviceSettings } from "./device-settings.js";

export type DeviceMode = "ask" | "workspace" | "full";
export type GateDecision = "pass" | "ask" | "refuse";

/** The mode that results from the settings of a chat. Full wins over a workspace folder. */
export function resolveDeviceMode(settings: ChatDeviceSettings): DeviceMode {
  if (settings.full) return "full";
  return settings.workspaceFolder ? "workspace" : "ask";
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Applies the path changes of the Pi file tools once. */
function resolveOnce(folder: string, rawPath: string): string {
  let normalized = rawPath.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") normalized = os.homedir();
  else if (normalized.startsWith("~/")) normalized = path.join(os.homedir(), normalized.slice(2));
  if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
  return path.resolve(folder, normalized);
}

const MAX_RESOLVE_PASSES = 8;

/**
 * Gives the checked path of a file call. It applies the changes that the Pi file tools apply to
 * a path before they open it, until the result does not change. It throws when the result does
 * not settle. The file operations of the device tools still compare the path that Pi opens with
 * this path, so a rule that this copy does not know makes the call fail and not write.
 */
export function resolveAgainstFolder(folder: string, rawPath: string): string {
  let current = rawPath;
  for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
    const next = resolveOnce(folder, current);
    if (next === current) return next;
    current = next;
  }
  throw new Error("The path does not settle to one final path. The call did not run.");
}

/**
 * Resolves each symbolic link. For a path that does not exist, it resolves the nearest
 * directory that exists. Returns undefined for a dangling symbolic link, because a write
 * would follow it to an unknown place.
 */
export async function realPathOrNearest(target: string): Promise<string | undefined> {
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

/** True when the path, or the real path behind it, is on the list of secret files. */
export async function touchesSecretFile(target: string): Promise<boolean> {
  if (isSecretPath(target)) return true;
  const real = await realPathOrNearest(target);
  return real !== undefined && isSecretPath(real);
}

export async function decideGate(input: {
  tool: DeviceToolName;
  mode: DeviceMode;
  folder?: string;
  /** The resolved path of a file call. */
  absolutePath?: string;
}): Promise<GateDecision> {
  if (input.mode === "full") return "pass";
  const secret = input.absolutePath !== undefined && (await touchesSecretFile(input.absolutePath));
  if (input.tool === "device_read") return secret ? "refuse" : "pass";
  if (
    !secret &&
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
