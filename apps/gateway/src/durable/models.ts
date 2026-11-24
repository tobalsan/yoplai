import { lazyStream, isRetryableAssistantError, normalizeContext, type AssistantMessageEvent } from "@earendil-works/pi-ai-durable";
import { createModels, type Models } from "@earendil-works/pi-ai-durable/models";
import { builtinProviders } from "@earendil-works/pi-ai-durable/providers/all";
import { isSafetyRefusal, type AgentConfig } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import { isExternalSource } from "../desktop/external-sources.js";
import { resolveGatewayModelCredentials, safeProviderError } from "../desktop/model-auth.js";
import { fallbackFailureMessage, type getModelPolicy } from "./fallback.js";
import { durableExtensionEnv } from "./env.js";

type RequestPolicy = (sessionId?: string) => Promise<Awaited<ReturnType<typeof getModelPolicy>> | undefined>;
export type DurableModelsFactory = (agent: AgentConfig, requestPolicy: RequestPolicy) => Models;

export const createDurableModels: DurableModelsFactory = (agent, requestPolicy) => {
  const models = createModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  return withDurableRequestPolicy(models, requestPolicy, agent.id);
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

export function withDurableRequestPolicy(models: Models, requestPolicy: RequestPolicy, agentId?: string): Models {
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
    const target = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
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
      const provider = models.getProvider(target.provider);
      if (!provider) throw new Error(`Unknown provider: ${target.provider}`);
      const { transformHeaders, ...providerOptions } = requestOptions;
      const headers = transformHeaders ? await transformHeaders(providerOptions.headers ?? {}) : providerOptions.headers;
      events = provider.streamSimple(target, normalizeContext(transcript), {
        ...providerOptions, headers, transport: "sse",
      });
    } else {
      events = streamSimple(target, transcript, requestOptions);
    }
    return safeModelEvents(events, fallback, auth.apiKey,
      external ? (message) => safeProviderError(target.provider, true, status, message) : undefined);
  }, undefined, options?.signal);
  return models;
}
