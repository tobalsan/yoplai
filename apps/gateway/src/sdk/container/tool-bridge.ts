import { claimAgentToolName, type ContainerExtensionTool, type GatewayConfig, type McpAppView } from "@yoplai/shared";
import { getExtensionSystemPromptContributions } from "../../extensions/prompts.js";
import { getExtensionAgentTools } from "../../extensions/tools.js";
import type { SdkRunParams } from "../types.js";
import { projectTools } from "../../chat-projects/tools.js";
import { skillSaveTool } from "../../skills/tools.js";

export class ContainerToolBridge {
  readonly mcpViews = new Map<string, McpAppView>();

  async buildSystemPrompts(
    params: SdkRunParams,
    config: GatewayConfig
  ): Promise<string[]> {
    return getExtensionSystemPromptContributions(
      params.agent,
      config,
      params.extensionRuntime,
      params.userId,
      params
    );
  }

  async buildTools(
    params: SdkRunParams,
    config: GatewayConfig,
    includeDescribeImage = false
  ): Promise<ContainerExtensionTool[]> {
    const tools = await getExtensionAgentTools(
      params.agent,
      config,
      params.extensionRuntime,
      params.userId,
      params
    );
    // Match the runner's Pi inventory, including its send_file reservation.
    const usedToolNames = new Set(["read", "bash", "edit", "write", "tool_search", "codemode"]);
    claimAgentToolName("send_file", usedToolNames);
    this.mcpViews.clear();
    for (const tool of tools) {
      const name = claimAgentToolName(tool.name, usedToolNames);
      if (tool.mcp?.ui?.resourceUri) this.mcpViews.set(name, {
        server: tool.mcp.server, tool: tool.mcp.tool, resourceUri: tool.mcp.ui.resourceUri,
      });
    }
    const gatewayTools: ContainerExtensionTool[] = [{
      extensionId: "gateway",
      name: "extract_document",
      description: "Extract normalized text from a PDF under /workspace, /workspace/data, or /workspace/uploads.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Absolute container path to a PDF" } }, required: ["path"] },
    }];
    gatewayTools.push(skillSaveTool);
    if (includeDescribeImage) gatewayTools.push({
      extensionId: "gateway", name: "describe_image", description: "Describe an image under /workspace, optionally answering a specific question.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Absolute container image path" }, question: { type: "string" } }, required: ["path"] },
    });
    if (params.context?.project?.id) gatewayTools.push(...projectTools);
    return tools.map<ContainerExtensionTool>((tool) => ({
      extensionId: tool.extensionId,
      extensionDescription: tool.extensionDescription,
      name: tool.name,
      canonicalName: tool.name,
      description: tool.description,
      namespace: tool.namespace,
      parameters: tool.parameters,
      outputSchema: tool.outputSchema,
    })).concat(gatewayTools);
  }
}
