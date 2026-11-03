import { readFile } from "node:fs/promises";
import {
  getSupportedThinkingLevels,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ModelRoutingConfigSchema } from "@yoplai/shared/types";
import { expect, it } from "vitest";
import { validateModelRouting, type ModelRoutingCatalog } from "./validate.js";

it("accepts the documented 13-category seed against the isolated offline Pi catalog", async () => {
  const example = JSON.parse(
    await readFile(
      new URL("../../../../docs/examples/model-routing.json", import.meta.url),
      "utf8"
    )
  );
  const routing = ModelRoutingConfigSchema.parse(example.modelRouting);
  expect(routing.mode).toBe("off");
  expect(routing.table.map((row) => row.id).sort()).toEqual([
    "customer_support_reply",
    "edit_agent_dashboard",
    "general_assistant",
    "hard_reasoning",
    "lead_contact_lookup",
    "office_deliverable",
    "orchestrate_long_task",
    "saas_workflow",
    "single_tool_call",
    "summarize",
    "trivial_chat",
    "web_research",
    "writing_marketing",
  ]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const catalog: ModelRoutingCatalog = {
    hasChatModel: (provider, model) =>
      runtime.getModel(provider, model) !== undefined,
    hasClassifierModel: (provider, model) =>
      runtime.getModelOfType("classifier", provider, model) !== undefined,
    supportedEfforts: (provider, model) => {
      const pick = runtime.getModel(provider, model);
      return pick ? getSupportedThinkingLevels(pick) : [];
    },
  };
  expect(
    validateModelRouting(
      { agents: [], modelRouting: { ...routing, mode: "shadow" } },
      catalog
    )
  ).toEqual({ valid: true, errors: [] });
});
