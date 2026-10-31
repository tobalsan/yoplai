import type { AgentConfig, GatewayConfig } from "@yoplai/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logWarn } from "../logging.js";
import type { ExtensionRuntime, LoadedExtensionAgentTool } from "./runtime.js";
import { getExtensionAgentTools } from "./tools.js";
import { validateToolParameters } from "./tool-schema.js";

vi.mock("../logging.js", () => ({ logWarn: vi.fn() }));

const toolWith = (name: string, parameters: Record<string, unknown>): LoadedExtensionAgentTool => ({
  extensionId: "mcp",
  name,
  description: "Test tool",
  parameters,
  execute: async () => "ok",
});

const getTools = (...tools: LoadedExtensionAgentTool[]) => getExtensionAgentTools(
  { id: "cira" } as AgentConfig,
  {} as GatewayConfig,
  runtimeWith(tools)
);

function runtimeWith(tools: LoadedExtensionAgentTool[]): ExtensionRuntime {
  return { getTools: async () => tools } as unknown as ExtensionRuntime;
}

describe("getExtensionAgentTools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the original error when a malformed pointer makes repair ambiguous", async () => {
    expect(await getTools(toolWith("malformed-ref", { required: 5, $ref: "#/%FF" }))).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith("Dropping extension tool with invalid parameters", {
      agentId: "cira", extensionId: "mcp", toolName: "malformed-ref", reason: "/required must be array",
    });
  });

  it("reports the original error for ambiguity and the new error after a failed repair", async () => {
    expect(await getTools(
      toolWith("ambiguous", { required: 5, definitions: {}, $defs: {} }),
      toolWith("empty", { items: [] }),
    )).toEqual([]);
    expect(vi.mocked(logWarn).mock.calls).toEqual([
      ["Dropping extension tool with invalid parameters", {
        agentId: "cira", extensionId: "mcp", toolName: "ambiguous", reason: "/required must be array",
      }],
      ["Dropping extension tool with invalid parameters", {
        agentId: "cira", extensionId: "mcp", toolName: "empty", reason: "/prefixItems must NOT have fewer than 1 items",
      }],
    ]);
  });

  it.each([
    "contains", "additionalProperties", "propertyNames", "if", "then", "else", "not",
    "unevaluatedItems", "unevaluatedProperties", "contentSchema", "items",
  ])("repairs the single-schema %s position", async (keyword) => {
    const tools = await getTools(toolWith("nested", { required: 5, [keyword]: { required: 5 } }));
    expect(tools.map((tool) => tool.parameters)).toEqual([{ [keyword]: {} }]);
  });

  it.each(["allOf", "anyOf", "oneOf", "prefixItems"])("repairs schemas in %s arrays", async (keyword) => {
    const tools = await getTools(toolWith("nested", { [keyword]: [{ required: 5 }, true] }));
    expect(tools.map((tool) => tool.parameters)).toEqual([{ [keyword]: [{}, true] }]);
  });

  it.each(["properties", "patternProperties", "$defs", "dependentSchemas", "dependencies"])("repairs values in %s maps", async (keyword) => {
    const tools = await getTools(toolWith("nested", { required: 5, [keyword]: { required: { required: 5 } } }));
    expect(tools.map((tool) => tool.parameters)).toEqual([{ [keyword]: { required: {} } }]);
  });

  it("keeps references outside moved locations, including a property named definitions", async () => {
    const tools = await getTools(toolWith("references", {
      required: 5,
      properties: { definitions: { type: "string" }, row: { items: [false, { required: 5 }] } },
      $ref: "#/properties/definitions",
      $dynamicRef: "#/properties/row",
    }));
    expect(tools.map((tool) => tool.parameters)).toEqual([{
      properties: { definitions: { type: "string" }, row: { prefixItems: [false, {}] } },
      $ref: "#/properties/definitions",
      $dynamicRef: "#/properties/row",
    }]);
  });

  it.each([5, null, [], "not-a-schema"])("drops a malformed parameters root %j", async (schema) => {
    expect(await getTools(toolWith("malformed", schema as unknown as Record<string, unknown>))).toEqual([]);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tuple", { properties: { arr: { items: [{ type: "string" }] } }, $ref: "#/properties/arr/items/0" }],
    ["definitions root", { required: 5, definitions: {}, $ref: "#/definitions" }],
    ["tuple within definitions", { definitions: { Row: { items: [{ type: "string" }] } }, $ref: "#/definitions/Row/items/0" }],
    ["dynamic definitions", { required: 5, definitions: { X: {} }, $dynamicRef: "#/definitions/X" }],
    ["nested definitions ref", { required: 5, properties: { x: {} }, $ref: "#/properties/x/definitions/X" }],
    ["decoded tuple", { properties: { "a/b~c": { items: [{}] } }, $ref: "#/%70roperties/a~1b~0c/%69tems/0" }],
    ["encoded definitions", { required: 5, definitions: { X: {} }, $ref: "#/%64efinitions/X" }],
    ["moved bound", { minimum: 2, exclusiveMinimum: true, $ref: "#/minimum" }],
  ])("drops repairs that would strand a %s reference", async (_name, schema) => {
    expect(await getTools(toolWith("referenced", schema))).toEqual([]);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["conflicting tuple", { items: [{ type: "string" }], prefixItems: [{ type: "number" }] }],
    ["additional tuple items", { items: [{ type: "string" }], additionalItems: false }],
    ["conflicting definitions", { required: 5, definitions: {}, $defs: {} }],
    ["nested definitions", { required: 5, properties: { x: { definitions: {} } } }],
    ["missing bound", { required: 5, exclusiveMinimum: true }],
    ["nested id", { required: 5, properties: { x: { $id: "nested" } } }],
    ["empty tuple", { items: [] }],
  ])("drops ambiguous or unrepairable %s schemas", async (_name, schema) => {
    expect(await getTools(toolWith("ambiguous", schema))).toEqual([]);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it("converts boolean exclusive bounds without changing unrelated inclusive bounds", async () => {
    const tools = await getTools(toolWith("bounds", {
      properties: {
        low: { type: "number", minimum: 0, exclusiveMinimum: true },
        high: { type: "number", maximum: 10, exclusiveMaximum: true },
        inclusive: { minimum: 2, maximum: 8, exclusiveMinimum: false, exclusiveMaximum: false },
      },
    }));
    expect(tools.map((tool) => tool.parameters)).toEqual([{
      properties: {
        low: { type: "number", exclusiveMinimum: 0 },
        high: { type: "number", exclusiveMaximum: 10 },
        inclusive: { minimum: 2, maximum: 8 },
      },
    }]);
  });

  it("repairs nested tuple items to prefixItems", async () => {
    const tools = await getTools(toolWith("tuple", {
      type: "object",
      properties: { row: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
    }));
    expect(tools.map((tool) => tool.parameters)).toEqual([{
      type: "object",
      properties: { row: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] } },
    }]);
  });

  it("relocates root definitions and their refs when another keyword needs repair", async () => {
    const schema = {
      required: 5,
      definitions: { Row: { type: "string" } },
      properties: { row: { $ref: "#/definitions/Row" } },
    };
    expect((await getTools(toolWith("legacy", schema))).map((tool) => tool.parameters)).toEqual([{
      $defs: { Row: { type: "string" } },
      properties: { row: { $ref: "#/$defs/Row" } },
    }]);
    expect(schema).toEqual({ required: 5, definitions: { Row: { type: "string" } }, properties: { row: { $ref: "#/definitions/Row" } } });
  });

  it("repairs nested schemas while preserving keyword-like property names and data", async () => {
    const schema = {
      required: "broken",
      properties: {
        required: { type: "string" },
        items: { type: "string" },
        definitions: { type: "string" },
      },
      dependentSchemas: { x: { required: false } },
      dependencies: { x: { required: "x" }, y: ["x"] },
      enum: [{ required: false, items: [], definitions: {}, $id: "data" }],
      default: { required: false, exclusiveMinimum: true },
      const: { items: [] },
      examples: [{ required: 5 }],
      custom: { required: 5, $id: "custom-data" },
    };
    expect((await getTools(toolWith("nested", schema))).map((tool) => tool.parameters)).toEqual([{
      properties: {
        required: { type: "string" },
        items: { type: "string" },
        definitions: { type: "string" },
      },
      dependentSchemas: { x: {} },
      dependencies: { x: {}, y: ["x"] },
      enum: [{ required: false, items: [], definitions: {}, $id: "data" }],
      default: { required: false, exclusiveMinimum: true },
      const: { items: [] },
      examples: [{ required: 5 }],
      custom: { required: 5, $id: "custom-data" },
    }]);
  });

  it("removes a non-array required and legacy root dialect only during repair", async () => {
    const schema = { $schema: "http://json-schema.org/draft-04/schema#", type: "object", required: "value" };
    const tools = await getTools(toolWith("repairable", schema));
    expect(tools.map((tool) => tool.parameters)).toEqual([{ type: "object" }]);
    expect(schema).toEqual({ $schema: "http://json-schema.org/draft-04/schema#", type: "object", required: "value" });
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("keeps valid legacy schemas unchanged, including a repeated root id", async () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.test/tool",
      type: "object",
      definitions: { Text: { type: "string" } },
      properties: { value: { $ref: "#/definitions/Text" } },
    };
    expect(validateToolParameters(schema)).toEqual({ ok: true, schema });
    const result = validateToolParameters(schema);
    expect(result.ok && result.schema).toBe(schema);
    expect((await getTools(toolWith("legacy", schema)))[0].parameters).toEqual(schema);
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("drops an invalid tool, warns without its schema, and keeps siblings in order", async () => {
    const first = toolWith("first", { type: "object" });
    const last = toolWith("last", { type: ["string", "null"] });
    const tools = await getTools(first, toolWith("broken", { type: 5, description: "private-schema" }), last);

    expect(tools).toEqual([first, last]);
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith("Dropping extension tool with invalid parameters", {
      agentId: "cira",
      extensionId: "mcp",
      toolName: "broken",
      reason: "/type must be equal to one of the allowed values",
    });
  });

  it("strips regex pattern keywords but keeps properties named pattern", async () => {
    const execute = async () => "ok";
    const tools = await getExtensionAgentTools(
      { id: "cira" } as AgentConfig,
      {} as GatewayConfig,
      runtimeWith([
        {
          extensionId: "mcp",
          name: "mcp__claap__get_user",
          description: "Get a user",
          parameters: {
            type: "object",
            properties: {
              email: {
                type: "string",
                format: "email",
                pattern: "^(?!\\.)(?!.*\\.\\.)[^@]+@[^@]+$",
              },
              pattern: { type: "string", description: "Glob to match" },
              tags: {
                type: "array",
                items: { type: "string", pattern: "^(?=x).*$" },
              },
            },
            required: ["email", "pattern"],
          },
          execute,
        },
      ])
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ extensionId: "mcp", name: "mcp__claap__get_user", execute });
    expect(tools[0].parameters).toEqual({
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        pattern: { type: "string", description: "Glob to match" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["email", "pattern"],
    });
  });
});
