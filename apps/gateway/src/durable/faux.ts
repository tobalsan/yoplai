import { getCurrentSystemPrompt, getCurrentTools, lazyStream } from "@earendil-works/pi-ai-durable";
import type { SimpleStreamOptions, TranscriptContext, Usage } from "@earendil-works/pi-ai-durable";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai-durable/providers/faux";
import { withDurableRequestPolicy, type DurableModelsFactory } from "./models.js";

type ScriptedTool = { tool: string; args?: Parameters<typeof fauxToolCall>[1]; id?: string };
type ScriptedBlock = string | ScriptedTool | { thinking: string; redacted?: boolean; signature?: string };
type ScriptedContent = string | ((modelId: string, signal?: AbortSignal) => string | Promise<string>)
  | { errorMessage: string; partial?: string } | ScriptedTool | ScriptedBlock[];
type UsageCounts = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;
type ScriptedAnswer = ScriptedContent | { content: ScriptedContent; usage: Partial<UsageCounts> };

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
  limits?: Partial<{ contextWindow: number; maxTokens: number }>,
  api?: string,
) {
  const requests: TranscriptContext[] = [];
  const cacheRetentions: SimpleStreamOptions["cacheRetention"][] = [];
  const usageOverrides = new WeakMap<TranscriptContext, UsageCounts>();
  const faux = fauxProvider({
    api,
    provider: fixture?.provider,
    models: [
      { id: fixture?.model ?? "fixture", contextWindow: 8000, maxTokens: 1000, ...limits },
      { id: "fixture-alternate", contextWindow: 6000, maxTokens: 1000 },
    ],
    tokensPerSecond,
  });
  const createModelsForAgent: DurableModelsFactory = (agent, requestPolicy) => {
    const models = createModels();
    models.setProvider({
      ...faux.provider,
      streamSimple(model, request, options) {
        const stream = faux.provider.streamSimple(model, request, options);
        async function* withUsage() {
          for await (const event of stream) {
            const counts = usageOverrides.get(request);
            if (!counts || (event.type !== "done" && event.type !== "error")) {
              yield event;
              continue;
            }
            const message = event.type === "done" ? event.message : event.error;
            const usage = {
              ...message.usage, ...counts,
              totalTokens: counts.input + counts.output + counts.cacheRead + counts.cacheWrite,
            };
            if (event.type === "done") yield { ...event, message: { ...message, usage } };
            else yield { ...event, error: { ...message, usage } };
          }
        }
        return lazyStream(model, async () => withUsage(), undefined, options?.signal);
      },
    });
    return withDurableRequestPolicy(models, requestPolicy, { agentId: fixture ? agent.id : undefined, useFixtureProvider: true });
  };
  return {
    createModels: createModelsForAgent,
    script: (...answers: ScriptedAnswer[]) => faux.setResponses(answers.map((step) =>
      async (request, options, _state, model) => {
        let answer: ScriptedContent;
        if (typeof step === "object" && "usage" in step) {
          usageOverrides.set(request, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...step.usage });
          answer = step.content;
        } else {
          answer = step;
        }
        fixture?.observeKey(options?.apiKey);
        requests.push(request);
        cacheRetentions.push(options?.cacheRetention);
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
    cacheRetentions,
    offeredTools: (index: number) => getCurrentTools(requests.at(index)?.messages ?? []).map(({ name }) => name),
    prompt: (index: number) => getCurrentSystemPrompt(requests.at(index)?.messages ?? []),
  };
}
