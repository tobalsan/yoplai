import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai-durable/providers/faux";
import type { DurableModelsFactory } from "./models.js";

/** Test adapter. Keep the provider and all Pi types on this side of the host. */
export function createDurableFaux(tokensPerSecond?: number) {
  const faux = fauxProvider({
    models: ["fixture", "fixture-alternate"].map((id) => ({ id, contextWindow: 8000, maxTokens: 1000 })),
    tokensPerSecond,
  });
  const createModelsForAgent: DurableModelsFactory = () => {
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  };
  return {
    createModels: createModelsForAgent,
    script: (...answers: (string | ((modelId: string) => string))[]) => faux.setResponses(answers.map((answer) =>
      (_request, _options, _state, model) => fauxAssistantMessage(typeof answer === "string" ? answer : answer(model.id)))),
    callCount: () => faux.state.callCount,
  };
}
