import path from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { GatewayConfig, ValidationResult } from "@yoplai/shared";
import { CONFIG_DIR } from "../config/index.js";

export interface ModelRoutingCatalog {
  hasChatModel(provider: string, model: string): boolean;
  hasClassifierModel(provider: string, model: string): boolean;
  supportedEfforts(provider: string, model: string): readonly string[];
}

export async function createModelRoutingCatalog(): Promise<ModelRoutingCatalog> {
  const runtime = await ModelRuntime.create({
    authPath: path.join(CONFIG_DIR, "auth.json"),
    modelsPath: path.join(CONFIG_DIR, "models.json"),
    allowModelNetwork: false,
  });
  return {
    hasChatModel: (provider, model) => runtime.getModel(provider, model) !== undefined,
    hasClassifierModel: (provider, model) => runtime.getModelOfType("classifier", provider, model) !== undefined,
    supportedEfforts: (provider, model) => {
      const chatModel = runtime.getModel(provider, model);
      return chatModel ? getSupportedThinkingLevels(chatModel) : [];
    },
  };
}

export function validateModelRouting(
  config: Pick<GatewayConfig, "modelRouting" | "agents">,
  catalog: ModelRoutingCatalog
): ValidationResult {
  const routing = config.modelRouting;
  if (!routing || routing.mode === "off") return { valid: true, errors: [] };
  const errors: string[] = [];
  if (routing.table.length === 0) {
    errors.push("modelRouting.table must not be empty when routing is active");
    return { valid: false, errors };
  }
  if (!catalog.hasClassifierModel(routing.classifier.provider, routing.classifier.model)) {
    errors.push(`modelRouting.classifier references unknown classifier model "${routing.classifier.provider}/${routing.classifier.model}"`);
  }
  for (const row of routing.table) {
    for (const column of ["claude", "chatgpt"] as const) {
      const pick = row[column];
      const label = `modelRouting.table category "${row.id}" ${column}`;
      if (!catalog.hasChatModel(pick.provider, pick.model)) {
        errors.push(`${label} references unknown chat model "${pick.provider}/${pick.model}"`);
      } else if (!catalog.supportedEfforts(pick.provider, pick.model).includes(pick.effort)) {
        errors.push(`${label} effort "${pick.effort}" is unsupported by "${pick.provider}/${pick.model}"`);
      }
    }
  }
  const ids = new Set(routing.table.map((row) => row.id));
  for (const id of routing.floor) {
    if (!ids.has(id)) errors.push(`modelRouting.floor references unknown category "${id}"`);
  }
  for (const agent of config.agents) {
    if (!agent.modelRouting?.enabled) continue;
    const categories = agent.modelRouting.categories ?? [...ids];
    for (const id of categories) {
      if (!ids.has(id)) errors.push(`Agent "${agent.id}" modelRouting.categories references unknown category "${id}"`);
    }
    const eligible = new Set([...categories, ...routing.floor].filter((id) => ids.has(id)));
    if (eligible.size < 2) {
      errors.push(`Agent "${agent.id}" modelRouting must retain at least two categories after adding the floor`);
    }
  }
  return { valid: errors.length === 0, errors };
}
