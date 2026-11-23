import type { AgentConfig } from "@yoplai/shared";
import { createModels, type Models } from "@earendil-works/pi-ai-durable/models";
import { builtinProviders } from "@earendil-works/pi-ai-durable/providers/all";

export type DurableModelsFactory = (agent: AgentConfig) => Models;

export const createDurableModels: DurableModelsFactory = (agent) => {
  const models = createModels();
  const provider = builtinProviders().find(({ id }) => id === agent.model.provider);
  if (!provider) throw new Error(`Unsupported Durable model provider: ${agent.model.provider}`);
  models.setProvider(provider);
  return models;
};
