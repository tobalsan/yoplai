import {
  DEFAULT_RETRY_BASE_DELAY_SECONDS,
  DEFAULT_RETRY_MAX_ATTEMPTS,
  readEnv,
  type ContainerInput,
  type GatewayConfig,
} from "@yoplai/shared";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import { resolveToolDeferralConfig } from "@yoplai/shared/tool-deferral";
import { selfImprovementPrompt } from "../../agents/self-improvement.js";
import { getDefaultSdkId } from "../registry.js";
import type { SdkRunParams } from "../types.js";
import {
  CONTAINER_GATEWAY_SOCKET_PATH,
  getMountedOnecliCaPath,
  usesGatewaySocket,
} from "../../agents/container.js";
import { remapAttachmentsToContainer, remapProjectContextToContainer } from "./launch-spec.js";
import { ContainerToolBridge } from "./tool-bridge.js";
import { logWarn } from "../../logging.js";
import { configuredModelSupportsImages } from "../../media/describe.js";

const DEFAULT_GATEWAY_PORT = 4000;

export class ContainerInputBuilder {
  constructor(private readonly toolBridge: Pick<ContainerToolBridge, "buildSystemPrompts" | "buildTools"> = new ContainerToolBridge()) {}

  async build(
    params: SdkRunParams,
    config: GatewayConfig,
    agentToken: string,
    bootstrapPrompt?: string,
    runId?: string,
    oauthTokens?: ContainerInput["oauthTokens"],
    managedSkillsDir?: string
  ): Promise<ContainerInput> {
    const extensionSystemPrompts = await this.toolBridge.buildSystemPrompts(
      params,
      config
    );
    const systemPrompts = [
      bootstrapPrompt,
      ...extensionSystemPrompts,
      selfImprovementPrompt(params.agent),
    ].filter((prompt): prompt is string => Boolean(prompt));
    const provider = params.model?.provider ?? params.agent.model.provider;
    const model = params.model?.model ?? params.agent.model.model;
    const primaryImageInputSupported = provider
      ? await configuredModelSupportsImages(config, provider, model)
      : false;
    const fallbackImageInputSupported = params.agent.fallback_model
      ? await configuredModelSupportsImages(
          config,
          params.agent.fallback_model.provider,
          params.agent.fallback_model.model
        )
      : true;
    // A single prompt representation must remain valid if the turn falls back.
    const imageInputSupported =
      primaryImageInputSupported && fallbackImageInputSupported;
    const extensionTools = await this.toolBridge.buildTools(
      params,
      config,
      !imageInputSupported && config.imageDescription?.enabled === true
    );
    const systemFiles = await resolveSystemFiles({
      workspaceDir: params.workspaceDir,
      systemFiles: params.agent.system_files,
      warn: (message) => logWarn(message),
    });
    const sessionOwnerId = params.sessionOwnerId === undefined ? params.userId : params.sessionOwnerId ?? undefined;
    return {
      agentId: params.agentId,
      codemode: params.agent.codemode,
      toolDeferral: resolveToolDeferralConfig(params.agent.toolDeferral),
      sessionId: params.sessionId,
      runId,
      userId: params.userId,
      actorUserId: params.actorUserId,
      actorKind: params.actorKind,
      message: params.message,
      attachments: remapAttachmentsToContainer(params.attachments),
      imageInputSupported,
      thinkLevel: params.thinkLevel,
      context: remapProjectContextToContainer(params.context),
      systemFiles: systemFiles.map((file) => ({
        path: file.path,
        content: file.content,
      })),
      extensionSystemPrompts:
        systemPrompts.length > 0 ? systemPrompts : undefined,
      extensionTools: extensionTools.length > 0 ? extensionTools : undefined,
      retry: {
        maxAttempts:
          params.agent.retryMaxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
        baseDelaySeconds:
          params.agent.retryBaseDelay ?? DEFAULT_RETRY_BASE_DELAY_SECONDS,
      },
      workspaceDir: "/workspace",
      managedSkillsDir,
      sessionDir: sessionOwnerId ? `/users/${sessionOwnerId}/sessions/${params.agentId}` : "/sessions",
      ipcDir: "/workspace/ipc",
      gatewayUrl: resolveContainerGatewayUrl(config),
      gatewaySocketPath: usesGatewaySocket(config.sandbox ?? {})
        ? CONTAINER_GATEWAY_SOCKET_PATH
        : undefined,
      agentToken,
      oauthTokens,
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
        fallbackModel: params.agent.fallback_model,
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
