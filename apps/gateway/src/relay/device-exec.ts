import fs from "node:fs";
import os from "node:os";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { DeviceCall, DeviceToolName } from "@yoplai/shared";
import { addGatewaySuffix } from "./agent-id.js";
import { APPROVAL_TIMEOUT_MS, MAX_APPROVAL_COMMAND_CHARS, type DeviceApprovals } from "./device-approvals.js";
import {
  decideGate,
  resolveAgainstFolder,
  resolveDeviceMode,
  type GateDecision,
} from "./device-gate.js";
import { getDeviceTurns, type DeviceTurns } from "./device-turns.js";
import { deviceAgentKey, deviceChatKey, type DeviceSettingsStore, type LinkIdentity } from "./device-settings.js";
import { secretReadRefusal } from "./device-secrets.js";
import { deviceToolParameters, getDeviceToolDefinition } from "./device-tools.js";

export type DeviceExecutorOptions = {
  settings: DeviceSettingsStore;
  approvals: DeviceApprovals;
  approvalTimeoutMs?: number;
  /** The turns that this gateway forwarded. Defaults to the registry of the process. */
  turns?: DeviceTurns;
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

  /** `link` is the link that carried the call. It never comes from the message. */
  async execute(call: DeviceCall, link: LinkIdentity, signal: AbortSignal): Promise<DeviceExecution> {
    const definition = getDeviceToolDefinition(call.tool);
    if (!definition) throw new Error(`Unknown device tool: ${call.tool}`);

    const validate = validatorFor(definition.name);
    if (!validate(call.arguments)) {
      throw new Error(`Invalid arguments for ${definition.name}: ${ajv.errorsText(validate.errors)}`);
    }
    let args = call.arguments as Record<string, unknown>;

    const { settings, approvals } = this.options;
    const agentKey = addGatewaySuffix(call.agentId, link.name);
    // Only a token that this gateway issued for this link and agent makes a chat call. The message says nothing else about the chat.
    const found = (this.options.turns ?? getDeviceTurns()).find(call.turnToken);
    const turn =
      found && found.gateway === link.name && found.generation === link.generation && found.agentId === call.agentId ? found : undefined;
    const chatSettings = turn ? settings.getChat(deviceChatKey(link, agentKey, turn.chat)) : { full: false };
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

    const full = chatSettings.full || (!turn && settings.getAgentFullBackground(deviceAgentKey(link, agentKey)));
    const decision: GateDecision = await decideGate({
      tool: definition.name,
      mode: full ? "full" : resolveDeviceMode({ ...chatSettings, workspaceFolder: folder }),
      folder,
      absolutePath,
    });
    signal.throwIfAborted();

    if (decision === "refuse") throw new Error(secretReadRefusal(absolutePath ?? ""));
    if (decision === "ask") {
      if (!turn) {
        throw new Error(
          `${definition.name} needs the approval of the user, and no user is present in this run. The call did not run. The user can allow background calls in the settings of this agent.`
        );
      }
      const command = definition.name === "device_bash" ? args.command : undefined;
      if (typeof command === "string" && command.length > MAX_APPROVAL_COMMAND_CHARS) {
        throw new Error(
          `The command has ${command.length} characters. The limit for an approval is ${MAX_APPROVAL_COMMAND_CHARS.toLocaleString("en-US")}. The call did not run. Write the commands to a script file, then run the file.`
        );
      }
      const timeoutMs = this.options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
      const outcome = await approvals.request({
        gateway: link.name,
        agentId: agentKey,
        chat: turn.chat,
        page: turn.page,
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
    const tool = definition.create(cwd, absolutePath, !full && decision === "pass");
    return tool.execute(call.callId, args as never, signal);
  }
}
