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

/** An unknown run counts as a background run, so no prompt waits for a user who is not there. */
export function deviceRunKind(run: ExtensionRunInfo | undefined): DeviceRunKind {
  if (!run || run.background === true) return "background";
  return run.source !== undefined && BACKGROUND_SOURCES.has(run.source) ? "background" : "chat";
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
  getAgentTools(_agent, hook) {
    const userId = hook?.userId ?? LOCAL_DEVICE_USER;
    if (!getDeviceRegistry().has(userId)) return [];
    return DEVICE_TOOL_NAMES.map((name) => ({
      name,
      description: DEVICE_TOOL_DEFINITIONS[name].description,
      parameters: deviceToolParameters(name),
      async execute(args: unknown, context: ExtensionAgentToolContext) {
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
