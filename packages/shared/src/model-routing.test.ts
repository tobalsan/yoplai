import { describe, expect, it } from "vitest";
import { AgentConfigSchema, AgentYamlConfigSchema, GatewayConfigSchema, GatewayRootConfigSchema, ModelRoutingConfigSchema } from "./types.js";

const pick = { provider: "anthropic", model: "claude-sonnet", effort: "high" };
const row = {
  id: "customer_support_reply", definition: "A customer support reply", examples: ["Reply to the customer"],
  claude: pick, chatgpt: { provider: "openai", model: "gpt-6", effort: "medium" }, pool: "either",
};

describe("model routing configuration", () => {
  it("defaults routing off in both root and resolved configurations", () => {
    const expected = {
      mode: "off",
      version: "unversioned",
      classifier: { provider: "openai", model: "gpt-6-luna" },
      thresholds: { score: 0.8, pace: 1.15 },
      budgets: { predicateMs: 2000, categoryMs: 4000 },
      maxRetries: 1,
      floor: ["customer_support_reply", "office_deliverable", "writing_marketing", "single_tool_call"],
      table: [],
    };
    expect(GatewayRootConfigSchema.parse({}).modelRouting).toEqual(expected);
    expect(GatewayConfigSchema.parse({ agents: [] }).modelRouting).toEqual(expected);
  });

  it("preserves valid rows and rejects malformed category identities, content, and picks", () => {
    expect(ModelRoutingConfigSchema.parse({ table: [row] }).table).toEqual([row]);
    for (const invalid of [
      { table: [{ ...row, id: "Bad-id" }] },
      { table: [row, row] },
      { table: [{ ...row, definition: "  " }] },
      { table: [{ ...row, examples: [] }] },
      { table: [{ ...row, examples: [""] }] },
      { table: [{ ...row, claude: { provider: "anthropic", model: "claude-sonnet" } }] },
      { table: [{ ...row, claude: { ...pick, effort: "ultra" } }] },
      { table: [{ ...row, claude: { ...pick, auth_token: "forbidden" } }] },
      { table: [{ ...row, pool: "unknown" }] },
      { apiKey: "forbidden" },
    ]) {
      expect(ModelRoutingConfigSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("preserves Pi routing opt-in while rejecting enabled routing on other SDKs", () => {
    const agent = { id: "main", name: "Main", workspace: "/tmp/main", model: { provider: "openai", model: "gpt-6" }, modelRouting: { enabled: true, categories: ["customer_support_reply"] } };
    for (const schema of [AgentConfigSchema, AgentYamlConfigSchema]) {
      expect(schema.parse(agent).modelRouting).toEqual({ enabled: true, categories: ["customer_support_reply"] });
      expect(schema.parse({ ...agent, sdk: "pi" }).modelRouting?.enabled).toBe(true);
      for (const sdk of ["claude", "openclaw"]) {
        expect(schema.safeParse({ ...agent, sdk }).success).toBe(false);
        expect(schema.safeParse({ ...agent, sdk, modelRouting: { enabled: false } }).success).toBe(true);
      }
      expect(schema.safeParse({ ...agent, modelRouting: { enabled: true, categories: ["Bad-id"] } }).success).toBe(false);
    }
  });

  it("rejects unbounded thresholds, nonpositive budgets, and retry counts outside zero to two", () => {
    for (const invalid of [
      { thresholds: { score: 0 } }, { thresholds: { score: 1.01 } },
      { thresholds: { pace: 0 } }, { thresholds: { pace: Infinity } },
      { budgets: { predicateMs: 0 } }, { budgets: { predicateMs: 1.5 } },
      { budgets: { categoryMs: -1 } }, { budgets: { categoryMs: Infinity } },
      { maxRetries: -1 }, { maxRetries: 3 }, { maxRetries: 0.5 },
    ]) {
      expect(ModelRoutingConfigSchema.safeParse(invalid).success).toBe(false);
    }
    expect(ModelRoutingConfigSchema.parse({ maxRetries: 0 }).maxRetries).toBe(0);
    expect(ModelRoutingConfigSchema.parse({ maxRetries: 2 }).maxRetries).toBe(2);
  });
});
