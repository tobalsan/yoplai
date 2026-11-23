import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai-durable";
import type { TranscriptContext } from "@earendil-works/pi-ai-durable";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai-durable/providers/faux";
import { withDurableRequestPolicy, type DurableModelsFactory } from "./models.js";

type ScriptedAnswer = string | ((modelId: string) => string | Promise<string>) | { errorMessage: string; partial?: string } | { tool: string; args?: Parameters<typeof fauxToolCall>[1]; id?: string };

/** Test adapter. Keep the provider and all Pi types on this side of the host. */
export function createDurableFaux(tokensPerSecond?: number, fixture?: { provider: string; model: string; observeKey: (key?: string) => void }) {
  const requests: TranscriptContext[] = [];
  const faux = fauxProvider({
    provider: fixture?.provider,
    models: [fixture?.model ?? "fixture", "fixture-alternate"].map((id) => ({ id, contextWindow: 8000, maxTokens: 1000 })),
    tokensPerSecond,
  });
  const createModelsForAgent: DurableModelsFactory = (agent, requestPolicy) => {
    const models = createModels();
    models.setProvider(faux.provider);
    return withDurableRequestPolicy(models, requestPolicy, fixture ? agent.id : undefined);
  };
  return {
    createModels: createModelsForAgent,
    script: (...answers: ScriptedAnswer[]) => faux.setResponses(answers.map((answer) =>
      async (request, options, _state, model) => {
        fixture?.observeKey(options?.apiKey);
        requests.push(request);
        if (typeof answer === "object" && "tool" in answer) {
          return fauxAssistantMessage(fauxToolCall(answer.tool, answer.args ?? {}, { id: answer.id }), { stopReason: "toolUse" });
        }
        if (typeof answer === "object") {
          return fauxAssistantMessage(answer.partial ?? [], { stopReason: "error", errorMessage: answer.errorMessage });
        }
        return fauxAssistantMessage(typeof answer === "string" ? answer : await answer(model.id));
      })),
    callCount: () => faux.state.callCount,
    requests,
    offeredTools: (index: number) => getCurrentTools(requests.at(index)?.messages ?? []).map(({ name }) => name),
    prompt: (index: number) => getCurrentSystemPrompt(requests.at(index)?.messages ?? []),
  };
}
