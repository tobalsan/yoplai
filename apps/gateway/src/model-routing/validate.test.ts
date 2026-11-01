import { describe, expect, it } from "vitest";
import { GatewayConfigSchema } from "@yoplai/shared";
import { validateModelRouting, type ModelRoutingCatalog } from "./validate.js";

const catalog: ModelRoutingCatalog = {
  hasChatModel: (provider, model) => provider === "fixture" && model === "chat",
  hasClassifierModel: (provider, model) => provider === "fixture" && model === "classifier",
  supportedEfforts: () => ["off", "high"],
};
const pick = { provider: "fixture", model: "chat", effort: "high" };
const rows = ["one", "two"].map((id) => ({ id, definition: `Category ${id}`, examples: [`Do ${id}`], claude: pick, chatgpt: pick, pool: "either" }));
const routing = { mode: "shadow", floor: ["one", "two"], classifier: { provider: "fixture", model: "classifier" }, table: rows };

describe("model routing validation", () => {
  it("requires a nonempty routing table only while routing is active", () => {
    expect(validateModelRouting(GatewayConfigSchema.parse({ agents: [] }), catalog)).toEqual({ valid: true, errors: [] });
    expect(validateModelRouting(GatewayConfigSchema.parse({ agents: [], modelRouting: { mode: "shadow" } }), catalog)).toEqual({ valid: false, errors: ["modelRouting.table must not be empty when routing is active"] });
    expect(validateModelRouting(GatewayConfigSchema.parse({ agents: [], modelRouting: routing }), catalog)).toEqual({ valid: true, errors: [] });
  });

  it("rejects unknown chat picks, unsupported effort, and non-classifier models", () => {
    const config = GatewayConfigSchema.parse({ agents: [], modelRouting: {
      ...routing, classifier: { provider: "fixture", model: "chat" },
      table: [{ ...rows[0], claude: { ...pick, model: "classifier" }, chatgpt: { ...pick, effort: "max" } }, rows[1]],
    } });
    expect(validateModelRouting(config, catalog)).toEqual({ valid: false, errors: [
      'modelRouting.classifier references unknown classifier model "fixture/chat"',
      'modelRouting.table category "one" claude references unknown chat model "fixture/classifier"',
      'modelRouting.table category "one" chatgpt effort "max" is unsupported by "fixture/chat"',
    ] });
    config.modelRouting!.mode = "off";
    expect(validateModelRouting(config, catalog)).toEqual({ valid: true, errors: [] });
  });

  it("checks floor and opted-in agent category references and keeps at least two eligible categories", () => {
    const agent = { id: "main", name: "Main", workspace: "/tmp/main", model: { provider: "fixture", model: "chat" }, modelRouting: { enabled: true } };
    const valid = GatewayConfigSchema.parse({ agents: [agent], modelRouting: routing });
    expect(validateModelRouting(valid, catalog)).toEqual({ valid: true, errors: [] });
    const invalid = GatewayConfigSchema.parse({ agents: [{ ...agent, modelRouting: { enabled: true, categories: ["missing"] } }], modelRouting: { ...routing, floor: ["one", "unknown"] } });
    expect(validateModelRouting(invalid, catalog)).toEqual({ valid: false, errors: [
      'modelRouting.floor references unknown category "unknown"',
      'Agent "main" modelRouting.categories references unknown category "missing"',
      'Agent "main" modelRouting must retain at least two categories after adding the floor',
    ] });
    const repaired = GatewayConfigSchema.parse({ agents: [{ ...agent, modelRouting: { enabled: true, categories: [] } }], modelRouting: routing });
    expect(validateModelRouting(repaired, catalog)).toEqual({ valid: true, errors: [] });
    const disabled = GatewayConfigSchema.parse({ agents: [{ ...agent, modelRouting: { enabled: false, categories: ["missing"] } }], modelRouting: routing });
    expect(validateModelRouting(disabled, catalog)).toEqual({ valid: true, errors: [] });
  });
});
