import { z } from "zod";
import {
  DEVICE_TOOL_NAMES,
  type DeviceRunKind,
  type Extension,
  type ExtensionAgentToolContext,
  type ExtensionRunInfo,
} from "@yoplai/shared";
import { getDeviceRegistry, LOCAL_DEVICE_USER } from "./device-registry.js";
import { DEVICE_TOOL_DEFINITIONS, deviceToolParameters } from "./device-tools.js";

/** Run origins with no human present. */
const BACKGROUND_SOURCES = new Set([
  "scheduler",
  "heartbeat",
  "webhook",
  "agent",
  "orchestrator",
  "dream",
  "system",
]);

/** A run with no origin, and an unknown run, count as a background run, so no prompt waits for a user who is not there. */
export function deviceRunKind(run: ExtensionRunInfo | undefined): DeviceRunKind {
  if (!run || run.background === true || run.source === undefined) return "background";
  return BACKGROUND_SOURCES.has(run.source) ? "background" : "chat";
}

/** A background run gets the device tools only when its job says that it needs the device. */
function mayUseDevice(run: ExtensionRunInfo | undefined): boolean {
  return deviceRunKind(run) === "chat" || run?.requiresDevice === true;
}

/** Joins the text of a tool result. The model sees text only. */
function resultText(content: unknown[]): string {
  return content
    .map((block) => {
      const item = block as { type?: string; text?: string };
      return item.type === "text" && typeof item.text === "string" ? item.text : `[${item.type ?? "unknown"} content omitted]`;
    })
    .join("\n");
}

export const deviceToolsExtension: Extension = {
  id: "deviceTools",
  displayName: "Device tools",
  description: "Read, write, and edit files and run commands on the device of the user, through the desktop relay.",
  factory: true,
  dependencies: [],
  routePrefixes: [],
  configSchema: z.object({}),
  validateConfig: () => ({ valid: true, errors: [] }),
  registerRoutes: () => {},
  async start() {},
  async stop() {},
  capabilities: () => [],
  getSystemPromptContributions(_agent, hook) {
    if (!getDeviceRegistry().has(hook?.userId ?? LOCAL_DEVICE_USER)) return undefined;
    return (
      "Device tools: the user has a desktop device connected. The tools device_read, device_write, device_edit, and device_bash work on the files and the shell of that device, not in your workspace. " +
      "A scheduled job gets these tools only when the job has requiresDevice: true. Set that flag in scheduler.create_job or scheduler.update_job."
    );
  },
  getAgentTools(_agent, hook) {
    const userId = hook?.userId ?? LOCAL_DEVICE_USER;
    if (!getDeviceRegistry().has(userId)) return [];
    if (!mayUseDevice(hook?.run)) return [];
    return DEVICE_TOOL_NAMES.map((name) => ({
      name,
      description: DEVICE_TOOL_DEFINITIONS[name].description,
      parameters: deviceToolParameters(name),
      async execute(args: unknown, context: ExtensionAgentToolContext) {
        if (!mayUseDevice(context.run)) {
          throw new Error("This background run has no device tools. A scheduled job needs requiresDevice: true.");
        }
        const result = await getDeviceRegistry().call(
          context.userId ?? LOCAL_DEVICE_USER,
          {
            tool: name,
            arguments: args,
            agentId: context.agent.id,
            sessionId: context.sessionId ?? "",
            toolCallId: context.toolCallId ?? "",
            runKind: deviceRunKind(context.run),
          },
          context.signal
        );
        return resultText(result.content);
      },
    }));
  },
};
