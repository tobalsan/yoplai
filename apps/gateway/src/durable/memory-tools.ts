import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type ConversationId, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { applyPlan, emptyMemory, MemoryDoc, planParameters } from "./memory.js";

const noParameters = { type: "object", additionalProperties: false } as const;

function memoryResult(value: object) {
  return { output: [{ type: "text" as const, text: JSON.stringify(value) }], details: { hidden: true } };
}

export function createMemoryTools(audienceOf: (id: ConversationId) => string | undefined) {
  async function read(api: ToolExecutionApi, context: Context) {
    const key = audienceOf(api.conversationId);
    return (key === undefined ? undefined : await api.snapshot(MemoryDoc, key, context)) ?? emptyMemory();
  }

  return defineExtension({
    name: "yoplai-memory",
    tools: [
      defineTool({
        name: "topics_get", description: "Read the remembered open loops, decisions, and digests for this audience.",
        parameters: noParameters,
        async execute(_args, api, context) {
          const { topics } = await read(api, context);
          return memoryResult({ topics });
        },
      }),
      defineTool({
        name: "plan_get", description: "Read the current plan and drift notes for this audience.",
        parameters: noParameters,
        async execute(_args, api, context) {
          const { plan, drift } = await read(api, context);
          return memoryResult({ plan, drift });
        },
      }),
      defineTool({
        name: "plan_update", description: "Replace both the goals and the next steps of the current plan.",
        parameters: planParameters,
        async execute(input, api, context) {
          const key = audienceOf(api.conversationId);
          if (key === undefined) throw new Error("Memory audience is unavailable.");
          const plan = await api.commit(async (tx) => {
            const doc = await tx.doc(MemoryDoc, key, null);
            const { plan } = applyPlan(doc, input, api.now());
            doc.plan = plan;
            return plan;
          }, context);
          return memoryResult({ plan });
        },
      }),
    ],
  });
}
