import type { ContainerExtensionTool, GatewayConfig } from "@yoplai/shared";
import { getExtensionSystemPromptContributions } from "../../extensions/prompts.js";
import { getExtensionAgentTools } from "../../extensions/tools.js";
import type { SdkRunParams } from "../types.js";
import { projectTools } from "../../chat-projects/tools.js";
import { skillSaveTool } from "../../skills/tools.js";

export class ContainerToolBridge {
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
