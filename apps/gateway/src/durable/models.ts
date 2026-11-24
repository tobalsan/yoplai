import path from "node:path";
import { lazyStream, isRetryableAssistantError, normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai-durable";
import { createModels, type Models } from "@earendil-works/pi-ai-durable/models";
import { isSafetyRefusal, type AgentConfig } from "@yoplai/shared";
import { CONFIG_DIR, getAgent, loadConfig } from "../config/index.js";
import { isExternalSource } from "../desktop/external-sources.js";
import { resolveGatewayModelCredentials, safeProviderError } from "../desktop/model-auth.js";
import { fallbackFailureMessage, type getModelPolicy } from "./fallback.js";
import { durableExtensionEnv } from "./env.js";

type RequestPolicy = (sessionId?: string) => Promise<Awaited<ReturnType<typeof getModelPolicy>> | undefined>;
export type DurableModelsFactory = (agent: AgentConfig, requestPolicy: RequestPolicy) => Models | Promise<Models>;

export const createDurableModels: DurableModelsFactory = async (agent, requestPolicy) => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create({
    authPath: path.join(CONFIG_DIR, "auth.json"),
    modelsPath: path.join(CONFIG_DIR, "models.json"),
    refreshOnCreate: false,
  });
  const models = createModels();
  for (const provider of runtime.getProviders()) models.setProvider(provider);
  return withDurableRequestPolicy(models, requestPolicy, { agentId: agent.id });
};

async function* safeModelEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  fallback: boolean,
  key?: string,
  externalError?: (message?: string) => string,
) {
  for await (const event of events) {
    if (event.type === "error" && event.reason === "error" && externalError) {
      const error = { ...event.error, errorMessage: externalError(event.error.errorMessage) };
      delete error.diagnostics;
      yield { ...event, error };
      continue;
    }
    if (event.type !== "error" || !event.error.errorMessage) {
      yield event;
      continue;
    }
    const errorMessage = isSafetyRefusal(undefined, event.error.errorMessage)
      ? "The model refused to complete the request."
      : fallback && isRetryableAssistantError(event.error)
        ? fallbackFailureMessage(event.error.errorMessage)
        : key ? event.error.errorMessage.replaceAll(key, "[redacted]") : event.error.errorMessage;
    yield { ...event, error: { ...event.error, errorMessage } };
  }
}

export function withDurableRequestPolicy(
  models: Models,
  requestPolicy: RequestPolicy,
  { agentId, useFixtureProvider = false }: { agentId?: string; useFixtureProvider?: boolean } = {},
): Models {
  const streamSimple = models.streamSimple.bind(models);
  models.streamSimple = (model, transcript, options) => lazyStream(model, async () => {
    const policy = await requestPolicy(options?.sessionId);
    const fallback = policy?.fallback ?? false;
    const agent = agentId && getAgent(agentId);
    if (!agent) return safeModelEvents(streamSimple(model, transcript, options), fallback);
    const primary = policy?.primary;
    const livePrimary = agent.model.provider === primary?.provider && agent.model.model === primary?.modelId;
    const mode = livePrimary || !primary ? agent.auth?.mode : primary.mode;
    const source = fallback ? undefined : livePrimary || !primary ? agent.model.source : primary.source;
    const env = durableExtensionEnv(agent, loadConfig());
    const auth = await resolveGatewayModelCredentials({
      provider: model.provider, model: model.id,
      source,
      mode: model.provider === (primary?.provider ?? agent.model.provider) && mode !== "proxy" ? mode : undefined,
      env, signal: options?.signal,
    });
    if (!auth) throw new Error(`Provider is not configured: ${model.provider}`);
    const requestModel = useFixtureProvider ? model : auth.model;
    const provider = useFixtureProvider ? models.getProvider(model.provider) : auth.provider;
    if (!requestModel || !provider) throw new Error(`Model is not configured: ${model.provider}/${model.id}`);
    const target = auth.baseUrl ? { ...requestModel, baseUrl: auth.baseUrl } : requestModel;
    const external = source !== undefined && isExternalSource(source);
    let status: number | undefined;
    const requestOptions: NonNullable<typeof options> = {
      ...options, apiKey: auth.apiKey, headers: { ...auth.headers, ...options?.headers },
      env: { ...env, ...auth.env, ...options?.env },
      ...(external && {
        async onResponse(response, responseModel) {
          status = response.status;
          await options?.onResponse?.(response, responseModel);
        },
      }),
    };
    let events: AsyncIterable<AssistantMessageEvent>;
    if (external && target.provider === "openai-codex") {
      // Models re-resolves API keys, but the Codex provider only registers OAuth.
      const { transformHeaders, ...providerOptions } = requestOptions;
      const headers = transformHeaders ? await transformHeaders(providerOptions.headers ?? {}) : providerOptions.headers;
      events = provider.streamSimple(target, normalizeContext(transcript), {
        ...providerOptions, headers, transport: "sse",
      });
    } else if (useFixtureProvider) {
      events = streamSimple(target, transcript, requestOptions);
    } else {
      // Dispatch with the provider used for auth so a config edit cannot mix request settings.
      const requestModels = createModels();
      requestModels.setProvider(provider);
      events = requestModels.streamSimple(target, transcript, requestOptions);
    }
    return safeModelEvents(events, fallback, auth.apiKey,
      external ? (message) => safeProviderError(target.provider, true, status, message) : undefined);
  }, undefined, options?.signal);
  return models;
}
