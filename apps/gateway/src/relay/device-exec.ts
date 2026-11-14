import fs from "node:fs";
import os from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { DeviceCall, DeviceToolName } from "@yoplai/shared";
import { addGatewaySuffix } from "./agent-id.js";
import { APPROVAL_TIMEOUT_MS, type DeviceApprovals } from "./device-approvals.js";
import {
  decideGate,
  resolveAgainstFolder,
  resolveDeviceMode,
  type GateDecision,
} from "./device-gate.js";
import { deviceChatKey, type DeviceSettingsStore } from "./device-settings.js";
import { deviceToolParameters, getDeviceToolDefinition } from "./device-tools.js";

export type DeviceExecutorOptions = {
  settings: DeviceSettingsStore;
  approvals: DeviceApprovals;
  approvalTimeoutMs?: number;
  /** Gives the checked path of a file call. Tests replace it to prove the compare of the file operations. */
  resolvePath?: (folder: string, rawPath: string) => string;
};

export type DeviceExecution = { content: unknown[]; details?: unknown };

const ajv = new Ajv2020({ strict: false });
const validators = new Map<string, ValidateFunction>();

function validatorFor(tool: DeviceToolName): ValidateFunction {
  let validate = validators.get(tool);
  if (!validate) {
    validate = ajv.compile(deviceToolParameters(tool));
    validators.set(tool, validate);
  }
  return validate;
}

function isDirectory(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Runs a device call with the tool functions of the Pi SDK, after the permission gate.
 * It starts no agent session and no model run. It throws an error for each refusal and failure.
 */
export class DeviceExecutor {
  constructor(private readonly options: DeviceExecutorOptions) {}

  /** `gatewayName` is the name of the link that carried the call. It never comes from the message. */
  async execute(call: DeviceCall, gatewayName: string, signal: AbortSignal): Promise<DeviceExecution> {
    const definition = getDeviceToolDefinition(call.tool);
    if (!definition) throw new Error(`Unknown device tool: ${call.tool}`);

    const validate = validatorFor(definition.name);
    if (!validate(call.arguments)) {
      throw new Error(`Invalid arguments for ${definition.name}: ${ajv.errorsText(validate.errors)}`);
    }
    let args = call.arguments as Record<string, unknown>;

    const { settings, approvals } = this.options;
    const chatSettings = settings.getChat(deviceChatKey(gatewayName, call.sessionId));
    const folder =
      chatSettings.workspaceFolder && isDirectory(chatSettings.workspaceFolder)
        ? chatSettings.workspaceFolder
        : undefined;
    const cwd = folder ?? os.homedir();
    let absolutePath: string | undefined;
    if (definition.filePath) {
      absolutePath = (this.options.resolvePath ?? resolveAgainstFolder)(cwd, args.path as string);
      args = { ...args, path: absolutePath };
    }

    const agentKey = addGatewaySuffix(call.agentId, gatewayName);
    const full = chatSettings.full || (call.runKind === "background" && settings.getAgentFullBackground(agentKey));
    const decision: GateDecision = await decideGate({
      tool: definition.name,
      mode: full ? "full" : resolveDeviceMode({ ...chatSettings, workspaceFolder: folder }),
      folder,
      absolutePath,
    });
    signal.throwIfAborted();

    if (decision === "ask") {
      if (call.runKind === "background") {
        throw new Error(
          `${definition.name} needs the approval of the user, and no user is present in this run. The call did not run. The user can allow background calls in the settings of this agent.`
        );
      }
      const timeoutMs = this.options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
      const outcome = await approvals.request({
        gateway: gatewayName,
        agentId: agentKey,
        sessionId: call.sessionId,
        toolCallId: call.toolCallId,
        tool: definition.name,
        arguments: args,
        signal,
        timeoutMs,
      });
      if (outcome === "refused") throw new Error("The user refused this call. It did not run.");
      if (outcome === "timeout") {
        throw new Error(`The user did not answer within ${Math.round(timeoutMs / 1000)} seconds. The call did not run.`);
      }
      if (outcome === "cancelled") throw new Error("The call was cancelled.");
    }

    signal.throwIfAborted();
    const tool = definition.create(cwd, absolutePath);
    return tool.execute(call.callId, args as never, signal);
  }
}
