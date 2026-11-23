import { lazyStream, isRetryableAssistantError, type AssistantMessageEvent } from "@earendil-works/pi-ai-durable";
import { createModels, type Models } from "@earendil-works/pi-ai-durable/models";
import { builtinProviders } from "@earendil-works/pi-ai-durable/providers/all";
import { isSafetyRefusal, type AgentConfig } from "@yoplai/shared";
import { getAgent, loadConfig } from "../config/index.js";
import { resolveGatewayModelCredentials } from "../desktop/model-auth.js";
import { fallbackFailureMessage, type getModelPolicy } from "./fallback.js";
import { durableExtensionEnv } from "./env.js";

type RequestPolicy = (sessionId?: string) => Promise<Awaited<ReturnType<typeof getModelPolicy>> | undefined>;
export type DurableModelsFactory = (agent: AgentConfig, requestPolicy: RequestPolicy) => Models;

export const createDurableModels: DurableModelsFactory = (agent, requestPolicy) => {
  const models = createModels();
  for (const provider of builtinProviders()) models.setProvider(provider);
  return withDurableRequestPolicy(models, requestPolicy, agent.id);
};

async function* safeModelEvents(events: AsyncIterable<AssistantMessageEvent>, fallback: boolean, key?: string) {
  for await (const event of events) {
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
    const source = livePrimary || !primary ? agent.model.source : primary.source;
    const env = durableExtensionEnv(agent, loadConfig());
    const auth = await resolveGatewayModelCredentials({
      provider: model.provider, model: model.id,
      source: fallback ? undefined : source,
      mode: model.provider === (primary?.provider ?? agent.model.provider) && mode !== "proxy" ? mode : undefined,
      env, signal: options?.signal,
    });
    if (!auth) throw new Error(`Provider is not configured: ${model.provider}`);
    const target = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    return safeModelEvents(streamSimple(target, transcript, {
      ...options, apiKey: auth.apiKey, headers: { ...auth.headers, ...options?.headers },
      env: { ...env, ...auth.env, ...options?.env },
    }), fallback, auth.apiKey);
  }, undefined, options?.signal);
  return models;
}
