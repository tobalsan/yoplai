import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { TurnPlan } from "@yoplai/shared";
import { z } from "zod";

export const TURN_PLAN = "turn_plan";

const statuses = ["pending", "in_progress", "completed"] as const;
const explanationPattern = "^[^\\r\\n\\u2028\\u2029]*$";

export const turnPlanSchema = z.object({
  steps: z.array(z.object({
    id: z.string(),
    text: z.string().min(1).max(200),
    status: z.enum(statuses),
  }).strict()).min(1).max(20),
  explanation: z.string().max(200).regex(new RegExp(explanationPattern, "u")).optional(),
}).strict();

export const turnPlanTools = defineExtension({
  name: "yoplai-turn-plan",
  tools: [defineTool({
    name: TURN_PLAN,
    description: "Replace the visible checklist for this turn with the full current list of steps. Call directly.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array", minItems: 1, maxItems: 20,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string", minLength: 1, maxLength: 200 },
              status: { type: "string", enum: [...statuses] },
            },
            required: ["id", "text", "status"],
            additionalProperties: false,
          },
        },
        explanation: { type: "string", maxLength: 200, pattern: explanationPattern },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    async execute(input) {
      const plan = turnPlanSchema.parse(input);
      return {
        output: [{ type: "text" as const, text: "Turn plan updated." }],
        details: { hidden: true, plan },
      };
    },
  })],
});

export function formatTurnPlan({ steps, explanation }: TurnPlan) {
  const rows = steps.map(({ text, status }) => {
    const box = status === "completed" ? "[x]" : "[ ]";
    const suffix = status === "in_progress" ? " (in progress)" : "";
    return `- ${box} ${text.replace(/[\r\n\u2028\u2029]+/gu, " ")}${suffix}`;
  });
  return explanation ? [explanation, ...rows].join("\n") : rows.join("\n");
}
