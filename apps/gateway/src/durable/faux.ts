import type { TranscriptContext } from "@earendil-works/pi-ai-durable";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai-durable/providers/faux";
import type { DurableModelsFactory } from "./models.js";

type ScriptedAnswer = string | ((modelId: string) => string) | { errorMessage: string };

/** Test adapter. Keep the provider and all Pi types on this side of the host. */
export function createDurableFaux(tokensPerSecond?: number) {
  const requests: TranscriptContext[] = [];
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
    script: (...answers: ScriptedAnswer[]) => faux.setResponses(answers.map((answer) =>
      (request, _options, _state, model) => {
        requests.push(request);
        if (typeof answer === "object") {
          return fauxAssistantMessage([], { stopReason: "error", errorMessage: answer.errorMessage });
        }
        return fauxAssistantMessage(typeof answer === "string" ? answer : answer(model.id));
      })),
    callCount: () => faux.state.callCount,
    requests,
  };
}
