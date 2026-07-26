import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expandHomePlaceholder, resolveConfigPath, resolveHomeDir } from "../packages/shared/src/config-path.js";

const args = process.argv.slice(2);
const fetchAll = args.includes("--all");

type OpenRouterModel = { id: string; context_length: number };
type ModelsDevProvider = {
  models?: Record<string, { id?: string; limit?: { context?: number } }>;
};

function addModelsFromAgents(
  configuredModels: Set<string>,
  agents: unknown
): void {
  if (!Array.isArray(agents)) return;
  for (const agent of agents) {
    if (!agent || typeof agent !== "object") continue;
    const model = (agent as { model?: { model?: unknown } }).model?.model;
    if (typeof model === "string" && model) configuredModels.add(model);

    const subagents = (agent as { subagents?: unknown }).subagents;
    if (Array.isArray(subagents)) {
      for (const sub of subagents) {
        if (!sub || typeof sub !== "object") continue;
        const subModel = (sub as { model?: unknown }).model;
        if (typeof subModel === "string" && subModel) {
          configuredModels.add(subModel);
        }
      }
    }
  }
}

export function collectConfiguredModels(
  config: unknown,
  modelsConfig?: unknown,
  agentConfigs?: unknown[]
): Set<string> {
  const configuredModels = new Set<string>();

  if (config && typeof config === "object") {
    addModelsFromAgents(
      configuredModels,
      (config as { agents?: unknown }).agents
    );
  }
  addModelsFromAgents(configuredModels, agentConfigs);

  if (modelsConfig && typeof modelsConfig === "object") {
    const providers = (modelsConfig as { providers?: unknown }).providers;
    if (providers && typeof providers === "object") {
      for (const provider of Object.values(providers)) {
        if (!provider || typeof provider !== "object") continue;
        const models = (provider as { models?: unknown }).models;
        if (Array.isArray(models)) {
          for (const model of models) {
            if (typeof model === "string" && model) configuredModels.add(model);
            if (!model || typeof model !== "object") continue;
            const id = (model as { id?: unknown }).id;
            if (typeof id === "string" && id) configuredModels.add(id);
          }
        }

        const modelOverrides = (provider as { modelOverrides?: unknown })
          .modelOverrides;
        if (modelOverrides && typeof modelOverrides === "object") {
          for (const key of Object.keys(modelOverrides)) {
            if (key) configuredModels.add(key);
          }
        }
      }
    }
  }

  return configuredModels;
}

function resolveAgentPath(pattern: string, configDir: string): string {
  const expanded = expandHomePlaceholder(pattern, resolveHomeDir());
  return isAbsolute(expanded) ? expanded : resolve(configDir, expanded);
}

function resolveAgentDirs(pattern: string, configDir: string): string[] {
  const resolved = resolveAgentPath(pattern, configDir);
  if (!pattern.includes("*")) return [resolved];
  if (!resolved.endsWith("*")) return [];
  const parent = dirname(resolved);
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

function parseScalar(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

export function readAgentYamlModelConfig(content: string): unknown {
  const lines = content.split(/\r?\n/);
  let inModelBlock = false;
  let inSubagentsBlock = false;
  let inSubagentItem = false;
  let model: string | undefined;
  const subagents: Array<{ model: string }> = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    if (indent === 0) {
      inModelBlock = trimmed === "model:";
      inSubagentsBlock = trimmed === "subagents:";
      inSubagentItem = false;
      const inlineSubagentModel = trimmed.match(/^-\s*model:\s*(.+)$/);
      if (inlineSubagentModel) {
        subagents.push({ model: parseScalar(inlineSubagentModel[1] ?? "") });
      }
      continue;
    }

    if (inModelBlock && indent > 0) {
      const match = trimmed.match(/^model:\s*(.+)$/);
      if (match) model = parseScalar(match[1] ?? "");
      continue;
    }

    if (inSubagentsBlock && trimmed.startsWith("-")) {
      inSubagentItem = true;
    }

    const subagentModel = trimmed.match(/^-\s*model:\s*(.+)$/);
    if (subagentModel) {
      subagents.push({ model: parseScalar(subagentModel[1] ?? "") });
      continue;
    }

    if (inSubagentsBlock && inSubagentItem) {
      const nestedSubagentModel = trimmed.match(/^model:\s*(.+)$/);
      if (nestedSubagentModel) {
        subagents.push({ model: parseScalar(nestedSubagentModel[1] ?? "") });
      }
    }
  }

  return { model: model ? { model } : undefined, subagents };
}

function readAgentYamlConfigs(config: unknown, configPath: string): unknown[] {
  if (!config || typeof config !== "object") return [];
  const agents = (config as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return [];
  const configDir = dirname(configPath);
  const result: unknown[] = [];

  for (const agent of agents) {
    if (typeof agent !== "string" || !agent) continue;
    if (agent.includes("?") || agent.includes("[")) {
      continue;
    }
    for (const agentDir of resolveAgentDirs(agent, configDir)) {
      const agentPath = join(agentDir, "agent.yaml");
      if (!existsSync(agentPath)) continue;
      result.push(readAgentYamlModelConfig(readFileSync(agentPath, "utf-8")));
    }
  }

  return result;
}

export function contextFromModelsConfig(
  modelsConfig: unknown
): Record<string, number> {
  const result: Record<string, number> = {};
  if (!modelsConfig || typeof modelsConfig !== "object") return result;

  const providers = (modelsConfig as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object") return result;

  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object") continue;

    const models = (provider as { models?: unknown }).models;
    if (Array.isArray(models)) {
      for (const model of models) {
        if (!model || typeof model !== "object") continue;
        const id = (model as { id?: unknown }).id;
        const contextWindow = (model as { contextWindow?: unknown })
          .contextWindow;
        if (
          typeof id === "string" &&
          id &&
          typeof contextWindow === "number" &&
          contextWindow > 0
        ) {
          result[id] = contextWindow;
        }
      }
    }

    const modelOverrides = (provider as { modelOverrides?: unknown })
      .modelOverrides;
    if (modelOverrides && typeof modelOverrides === "object") {
      for (const [id, override] of Object.entries(modelOverrides)) {
        if (!override || typeof override !== "object") continue;
        const contextWindow = (override as { contextWindow?: unknown })
          .contextWindow;
        if (id && typeof contextWindow === "number" && contextWindow > 0) {
          result[id] = contextWindow;
        }
      }
    }
  }

  return result;
}

export function contextFromOpenRouter(
  models: OpenRouterModel[],
  configuredModels: Set<string>,
  includeAll: boolean
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const model of models) {
    if (!includeAll && !configuredModels.has(model.id)) continue;
    if (typeof model.context_length === "number" && model.context_length > 0) {
      result[model.id] = model.context_length;
    }
  }
  return result;
}

export function addMissingFromModelsDev(
  result: Record<string, number>,
  modelsDevData: Record<string, ModelsDevProvider>,
  configuredModels: Set<string>,
  includeAll: boolean
): Record<string, number> {
  const next = { ...result };
  const fallbackContexts = new Map<string, number>();
  for (const provider of Object.values(modelsDevData)) {
    const models = provider.models ?? {};
    for (const [key, model] of Object.entries(models)) {
      const id = model.id ?? key;
      const context = model.limit?.context;
      if (!id || typeof context !== "number" || context <= 0) continue;
      fallbackContexts.set(
        id,
        Math.max(fallbackContexts.get(id) ?? 0, context)
      );
      fallbackContexts.set(
        key,
        Math.max(fallbackContexts.get(key) ?? 0, context)
      );
    }
  }

  const targetIds = includeAll
    ? [...fallbackContexts.keys()]
    : [...configuredModels];
  for (const id of targetIds) {
    if (next[id] != null) continue;
    const suffix = id.split("/").at(-1) ?? id;
    const context = fallbackContexts.get(id) ?? fallbackContexts.get(suffix);
    if (context != null) next[id] = context;
  }

  if (includeAll) {
    for (const [id, context] of fallbackContexts) {
      if (next[id] == null) next[id] = context;
    }
  }
  return next;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function mergeContextData(
  existing: Record<string, number>,
  discovered: Record<string, number>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries({ ...existing, ...discovered }).sort(([left], [right]) =>
      left.localeCompare(right)
    )
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function main() {
  const configPath = resolveConfigPath();
  const modelsPath = resolve(resolveHomeDir(), "models.json");
  let configuredModels = new Set<string>();
  let modelsConfig: unknown;

  try {
    modelsConfig = readJsonFile(modelsPath);
  } catch {
    modelsConfig = undefined;
  }

  if (!fetchAll) {
    try {
      const config = readJsonFile(configPath);
      configuredModels = collectConfiguredModels(
        config,
        modelsConfig,
        readAgentYamlConfigs(config, configPath)
      );
    } catch {
      console.error(
        "Could not read yoplai.json. Use --all to fetch all models."
      );
      process.exit(1);
    }
  }

  console.log(
    fetchAll
      ? "Fetching all OpenRouter models..."
      : `Fetching ${configuredModels.size} configured models: ${[...configuredModels].join(", ")}`
  );

  const data = await fetchJson<{ data: OpenRouterModel[] }>(
    "https://openrouter.ai/api/v1/models"
  );
  let result = {
    ...contextFromOpenRouter(data.data, configuredModels, fetchAll),
    ...contextFromModelsConfig(modelsConfig),
  };

  const missingCount = fetchAll
    ? 0
    : [...configuredModels].filter((model) => result[model] == null).length;
  if (fetchAll || missingCount > 0) {
    const modelsDevData = await fetchJson<Record<string, ModelsDevProvider>>(
      "https://models.dev/api.json"
    );
    result = addMissingFromModelsDev(
      result,
      modelsDevData,
      configuredModels,
      fetchAll
    );
  }

  const outPath = resolve(
    import.meta.dirname ?? "",
    "..",
    "packages",
    "shared",
    "src",
    "model-context-data.json"
  );
  let existingContextData: Record<string, number> = {};
  try {
    existingContextData = readJsonFile(outPath) as Record<string, number>;
  } catch {
    existingContextData = {};
  }
  result = mergeContextData(existingContextData, result);
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(result).length} models to ${outPath}`);
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
