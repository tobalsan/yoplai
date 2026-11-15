import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  detectSupportedImageMimeTypeFromFile,
} from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { DeviceToolName } from "@yoplai/shared";
import { touchesSecretFile } from "./device-gate.js";
import { secretReadRefusal } from "./device-secrets.js";

/** The part of a Pi SDK tool that the device link uses. */
type PiToolLike = {
  parameters: unknown;
  execute(
    toolCallId: string,
    params: never,
    signal?: AbortSignal
  ): Promise<{ content: unknown[]; details?: unknown }>;
};

export type DeviceToolDefinition = {
  name: DeviceToolName;
  description: string;
  /** True when the arguments have a `path` that the permission gate checks. */
  filePath: boolean;
  /**
   * `checkedPath` is the path that the gate checked. A write or edit opens no other path.
   * `enforceSecrets` makes a read throw for a secret file, at the point of use.
   */
  create(cwd: string, checkedPath?: string, enforceSecrets?: boolean): PiToolLike;
};

function sameAsChecked(checkedPath: string | undefined, actual: string): void {
  if (checkedPath === undefined || actual !== checkedPath) {
    throw new Error("The path changed after the permission check. The call did not run.");
  }
}

/** Each device tool has the parameters of the Pi SDK tool with the same function. */
export const DEVICE_TOOL_DEFINITIONS: Record<DeviceToolName, DeviceToolDefinition> = {
  device_read: {
    name: "device_read",
    description:
      "Read a file on the device of the user. This is not the workspace of the agent. Give a path. Use offset and limit for a long file.",
    filePath: true,
    create: (cwd, _checkedPath, enforceSecrets) => {
      const refuseSecret = async (target: string) => {
        if (enforceSecrets && (await touchesSecretFile(target))) throw new Error(secretReadRefusal(target));
      };
      return createReadTool(cwd, {
        operations: {
          access: async (target) => {
            await refuseSecret(target);
            await fs.access(target, constants.R_OK);
          },
          readFile: async (target) => {
            await refuseSecret(target);
            return fs.readFile(target);
          },
          detectImageMimeType: async (target) => {
            await refuseSecret(target);
            return detectSupportedImageMimeTypeFromFile(target);
          },
        },
      });
    },
  },
  device_write: {
    name: "device_write",
    description:
      "Write a file on the device of the user. This is not the workspace of the agent. It replaces the file when it exists. The user can refuse the call.",
    filePath: true,
    create: (cwd, checkedPath) =>
      createWriteTool(cwd, {
        operations: {
          mkdir: async (dir) => {
            sameAsChecked(checkedPath === undefined ? undefined : path.dirname(checkedPath), dir);
            await fs.mkdir(dir, { recursive: true });
          },
          writeFile: async (target, content) => {
            sameAsChecked(checkedPath, target);
            await fs.writeFile(target, content, "utf-8");
          },
        },
      }),
  },
  device_edit: {
    name: "device_edit",
    description:
      "Edit a file on the device of the user. This is not the workspace of the agent. Give exact text to replace. The user can refuse the call.",
    filePath: true,
    create: (cwd, checkedPath) =>
      createEditTool(cwd, {
        operations: {
          access: async (target) => {
            sameAsChecked(checkedPath, target);
            await fs.access(target, constants.R_OK | constants.W_OK);
          },
          readFile: async (target) => {
            sameAsChecked(checkedPath, target);
            return fs.readFile(target);
          },
          writeFile: async (target, content) => {
            sameAsChecked(checkedPath, target);
            await fs.writeFile(target, content, "utf-8");
          },
        },
      }),
  },
  device_bash: {
    name: "device_bash",
    description:
      "Run a shell command on the device of the user. This is not the workspace of the agent. The command starts in the workspace folder of the chat. The user can refuse the call.",
    filePath: false,
    create: (cwd) => createBashTool(cwd),
  },
};

export function getDeviceToolDefinition(name: string): DeviceToolDefinition | undefined {
  return Object.hasOwn(DEVICE_TOOL_DEFINITIONS, name)
    ? DEVICE_TOOL_DEFINITIONS[name as DeviceToolName]
    : undefined;
}

/** The JSON schema of the arguments of a device tool. */
export function deviceToolParameters(name: DeviceToolName): Record<string, unknown> {
  const tool = DEVICE_TOOL_DEFINITIONS[name].create(process.cwd());
  return JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
}
