import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai-durable";
import type { TranscriptContext } from "@earendil-works/pi-ai-durable";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai-durable/providers/faux";
import { withDurableRequestPolicy, type DurableModelsFactory } from "./models.js";

type ScriptedTool = { tool: string; args?: Parameters<typeof fauxToolCall>[1]; id?: string };
type ScriptedBlock = string | ScriptedTool | { thinking: string; redacted?: boolean; signature?: string };
type ScriptedAnswer = string | ((modelId: string, signal?: AbortSignal) => string | Promise<string>)
  | { errorMessage: string; partial?: string } | ScriptedTool | ScriptedBlock[];

function scriptedBlock(block: ScriptedBlock) {
  if (typeof block === "string") return fauxText(block);
  if ("tool" in block) return fauxToolCall(block.tool, block.args ?? {}, { id: block.id });
  return { ...fauxThinking(block.thinking), redacted: block.redacted, thinkingSignature: block.signature };
}

/** Test adapter. Keep the provider and all Pi types on this side of the host. */
export function createDurableFaux(
  tokensPerSecond?: number,
  fixture?: { provider: string; model: string; observeKey: (key?: string) => void },
  onRequest?: (request: TranscriptContext) => Promise<void>,
) {
  const requests: TranscriptContext[] = [];
  const faux = fauxProvider({
    provider: fixture?.provider,
    models: [fixture?.model ?? "fixture", "fixture-alternate"].map((id) => ({ id, contextWindow: 8000, maxTokens: 1000 })),
    tokensPerSecond,
  });
  const createModelsForAgent: DurableModelsFactory = (agent, requestPolicy) => {
    const models = createModels();
    models.setProvider(faux.provider);
    return withDurableRequestPolicy(models, requestPolicy, { agentId: fixture ? agent.id : undefined, useFixtureProvider: true });
  };
  return {
    createModels: createModelsForAgent,
    script: (...answers: ScriptedAnswer[]) => faux.setResponses(answers.map((answer) =>
      async (request, options, _state, model) => {
        fixture?.observeKey(options?.apiKey);
        requests.push(request);
        await onRequest?.(request);
        if (Array.isArray(answer)) {
          const blocks = answer.map(scriptedBlock);
          return fauxAssistantMessage(blocks, { stopReason: blocks.some(({ type }) => type === "toolCall") ? "toolUse" : "stop" });
        }
        if (typeof answer === "object" && "tool" in answer) {
          return fauxAssistantMessage(scriptedBlock(answer), { stopReason: "toolUse" });
        }
        if (typeof answer === "object") {
          return fauxAssistantMessage(answer.partial ?? [], { stopReason: "error", errorMessage: answer.errorMessage });
        }
        return fauxAssistantMessage(typeof answer === "string" ? answer : await answer(model.id, options?.signal));
      })),
    callCount: () => faux.state.callCount,
    requests,
    offeredTools: (index: number) => getCurrentTools(requests.at(index)?.messages ?? []).map(({ name }) => name),
    prompt: (index: number) => getCurrentSystemPrompt(requests.at(index)?.messages ?? []),
  };
}
