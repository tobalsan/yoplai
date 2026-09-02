import { readEnv, type ContainerInput, type GatewayConfig } from "@yoplai/shared";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import { getDefaultSdkId } from "../registry.js";
import type { SdkRunParams } from "../types.js";
import { getMountedOnecliCaPath } from "../../agents/container.js";
import { remapAttachmentsToContainer } from "./launch-spec.js";
import { ContainerToolBridge } from "./tool-bridge.js";
import { logWarn } from "../../logging.js";
import { configuredModelSupportsImages } from "../../media/describe.js";

const DEFAULT_GATEWAY_PORT = 4000;

export class ContainerInputBuilder {
  constructor(private readonly toolBridge = new ContainerToolBridge()) {}

  async build(
    params: SdkRunParams,
    config: GatewayConfig,
    agentToken: string,
    bootstrapPrompt?: string,
    runId?: string
  ): Promise<ContainerInput> {
    const extensionSystemPrompts = await this.toolBridge.buildSystemPrompts(
      params,
      config
    );
    const provider = params.model?.provider ?? params.agent.model.provider;
    const model = params.model?.model ?? params.agent.model.model;
    const imageInputSupported = provider
      ? await configuredModelSupportsImages(config, provider, model)
      : false;
    const extensionTools = await this.toolBridge.buildTools(params, config, !imageInputSupported && config.imageDescription?.enabled === true);
    const systemFiles = await resolveSystemFiles({
      workspaceDir: params.workspaceDir,
      systemFiles: params.agent.system_files,
      warn: (message) => logWarn(message),
    });
    return {
      agentId: params.agentId,
      sessionId: params.sessionId,
      runId,
      userId: params.userId,
      message: params.message,
      attachments: remapAttachmentsToContainer(params.attachments),
      imageInputSupported,
      thinkLevel: params.thinkLevel,
      context: params.context,
      systemFiles: systemFiles.map((file) => ({
        path: file.path,
        content: file.content,
      })),
      extensionSystemPrompts:
        bootstrapPrompt || extensionSystemPrompts.length > 0
          ? [bootstrapPrompt, ...extensionSystemPrompts].filter(
              (prompt): prompt is string => Boolean(prompt)
            )
          : undefined,
      extensionTools: extensionTools.length > 0 ? extensionTools : undefined,
      workspaceDir: "/workspace",
      sessionDir: "/sessions",
      ipcDir: "/workspace/ipc",
      gatewayUrl: resolveContainerGatewayUrl(config),
      agentToken,
      onecli:
        config.onecli?.enabled && config.onecli.gatewayUrl
          ? {
              enabled: true,
              url:
                resolveOnecliProxyUrl(config, params.agentId) ??
                config.onecli.gatewayUrl,
              caPath: getMountedOnecliCaPath(config.onecli),
            }
          : undefined,
      sdkConfig: {
        sdk: params.agent.sdk ?? getDefaultSdkId(),
        model: {
          provider,
          model,
        },
      },
    };
  }
}

export function resolveContainerGatewayUrl(config: GatewayConfig): string {
  const envPort = Number(readEnv("GATEWAY_PORT"));
  const port =
    Number.isFinite(envPort) && envPort > 0
      ? envPort
      : (config.gateway?.port ?? DEFAULT_GATEWAY_PORT);
  return `http://host.docker.internal:${port}`;
}

export function resolveOnecliProxyUrl(
  config: GatewayConfig,
  agentId: string
): string | undefined {
  const onecli = config.onecli;
  if (!onecli?.enabled || !onecli.gatewayUrl) return undefined;
  const agent = config.agents.find((a) => a.id === agentId);
  const base = onecli.sandbox?.url ?? onecli.gatewayUrl;
  const url = new URL(base);
  if (!onecli.sandbox?.url) {
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      url.hostname = "host.docker.internal";
    }
  }
  if (agent?.onecliToken) {
    url.username = "onecli";
    url.password = agent.onecliToken;
  }
  return url.toString().replace(/\/$/, "");
}
