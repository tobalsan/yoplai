import type { JsonValue } from "@earendil-works/chord/json";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { claimAgentToolName } from "@yoplai/shared";

type Descriptor = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
};

export function claimToolDescriptor<T extends Descriptor>(descriptor: T, used: Set<string>) {
  return {
    ...descriptor,
    name: claimAgentToolName(descriptor.name, used),
    canonicalName: descriptor.name,
  };
}

export function defineGatewayTool(
  { name, description, parameters, outputSchema, deferred }: Descriptor & { deferred: boolean },
  execute: (args: unknown, api: ToolExecutionApi, context: Context) => Promise<unknown>,
) {
  return defineTool({
    name, description, parameters, structuredOutputSchema: outputSchema,
    deferred: deferred ? true : undefined,
    async execute(args, api, context) {
      const result = await execute(args, api, context);
      const details = JSON.parse(JSON.stringify(result ?? null)) as JsonValue;
      const isError = Boolean(result && typeof result === "object" && "isError" in result && result.isError === true);
      return {
        output: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(details) }],
        details, isError,
        ...(outputSchema && !isError ? { structuredOutput: details } : {}),
      };
    },
  });
}
