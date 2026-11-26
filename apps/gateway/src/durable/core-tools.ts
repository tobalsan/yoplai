import { ContainerFileOutputRequestSchema, type GatewayConfig } from "@yoplai/shared";
import { executeAgentUpdateInstructions, executeSharedUpdateSystemFile, instructionTools } from "../instructions/tools.js";
import { captureSendFile } from "../mcp-apps/capture.js";
import { executeGenerateImage, generateImageTool } from "../media/generate-tool.js";
import { ContainerFileOutputAdapter } from "../sdk/container/file-output.js";
import { legacyHistoryTool, runLegacyHistory } from "../session-history/legacy.js";
import { executeSkillSave, skillSaveTool } from "../skills/tools.js";
import type { mainPrincipal } from "./principal.js";

const sendFile = {
  name: "send_file",
  description: "Send a regular file in this conversation's files directory to the user. Subfolders are allowed. Finish writing the file first. Symlinks are not supported.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Absolute path to the conversation file" }, title: { type: "string", maxLength: 200 } },
    required: ["path"],
  },
};

export function durableCoreTools(config: GatewayConfig, legacyHistoryEnabled = false) {
  return [
    sendFile, skillSaveTool, ...instructionTools,
    ...(config.imageGeneration?.enabled ? [generateImageTool] : []),
    ...(legacyHistoryEnabled ? [legacyHistoryTool] : []),
  ];
}

export async function executeDurableCoreTool(
  name: string,
  args: unknown,
  config: GatewayConfig,
  principal: ReturnType<typeof mainPrincipal>,
  agentId: string,
  toolCallId: string,
  signal?: AbortSignal,
) {
  const identity = { ...principal, agentId, toolCallId, signal };
  switch (name) {
    case "send_file": {
      const input = ContainerFileOutputRequestSchema.parse({ ...(args as object), type: "file_output" });
      const { fileId, filename, mimeType, size } = await new ContainerFileOutputAdapter().handle(
        { ...identity, onEvent() {}, onHistoryEvent() {} },
        input, undefined, signal, principal.conversationFiles,
      );
      await captureSendFile(identity, args, { fileId, filename, mimeType, size, ...(input.title === undefined ? {} : { title: input.title }) });
      return "File sent to user";
    }
    case "legacy_history":
      signal?.throwIfAborted();
      return runLegacyHistory(args, identity);
    case "skill_save":
      return executeSkillSave(args, { userId: principal.userId });
    case "agent_update_instructions":
      return executeAgentUpdateInstructions(args, { ...identity, config });
    case "shared_update_system_file":
      return executeSharedUpdateSystemFile(args, { ...identity, config });
    case "generate_image":
      if (config.imageGeneration?.enabled) return executeGenerateImage(args, config, principal.conversationFiles, signal);
      break;
  }
  return { isError: true, error: "Tool is no longer available." };
}
