import type { ContainerExtensionTool, GatewayConfig } from "@yoplai/shared";
import { getExtensionSystemPromptContributions } from "../../extensions/prompts.js";
import { getExtensionAgentTools } from "../../extensions/tools.js";
import type { SdkRunParams } from "../types.js";

export class ContainerToolBridge {
  async buildSystemPrompts(
    params: SdkRunParams,
    config: GatewayConfig
  ): Promise<string[]> {
    return params.extensionRuntime
      ? getExtensionSystemPromptContributions(
          params.agent,
          config,
          params.extensionRuntime
        )
      : getExtensionSystemPromptContributions(params.agent);
  }

  async buildTools(
    params: SdkRunParams,
    config: GatewayConfig,
    includeDescribeImage = false
  ): Promise<ContainerExtensionTool[]> {
    const tools = params.extensionRuntime
      ? await getExtensionAgentTools(
          params.agent,
          config,
          params.extensionRuntime
        )
      : await getExtensionAgentTools(params.agent);
    const gatewayTools: ContainerExtensionTool[] = [{
      extensionId: "gateway",
      name: "extract_document",
      description: "Extract normalized text from a PDF under /workspace, /workspace/data, or /workspace/uploads.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Absolute container path to a PDF" } }, required: ["path"] },
    }];
    if (includeDescribeImage) gatewayTools.push({
      extensionId: "gateway", name: "describe_image", description: "Describe an image under /workspace, optionally answering a specific question.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Absolute container image path" }, question: { type: "string" } }, required: ["path"] },
    });
    return tools.map((tool) => ({
      extensionId: tool.extensionId,
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })).concat(gatewayTools);
  }
}
