import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addMissingFromModelsDev,
  collectConfiguredModels,
  contextFromModelsConfig,
  contextFromOpenRouter,
  mergeContextData,
  readAgentYamlConfigs,
  readAgentYamlModelConfig,
} from "./update-models.js";

const AGENT_YAML = `id: {id}
model:
  provider: zai
  model: {model}
`;

function writeAgentYaml(dir: string, id: string, model: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent.yaml"),
    AGENT_YAML.replace("{id}", id).replace("{model}", model)
  );
}

describe("update-models helpers", () => {
  const originalHome = process.env.YOPLAI_HOME;
  const cleanupDirs: string[] = [];

  afterEach(() => {
    if (originalHome === undefined) delete process.env.YOPLAI_HOME;
    else process.env.YOPLAI_HOME = originalHome;
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });


  it("collects models from yoplai.json and models.json providers", () => {
    const models = collectConfiguredModels(
      {
        agents: [
          {
            model: { model: "openrouter-model" },
            subagents: [{ model: "subagent-model" }],
          },
        ],
      },
      {
        providers: {
          custom: {
            models: [
              {
                id: "custom-array-model",
                displayName: "Custom",
                contextWindow: 321_000,
              },
            ],
          },
          overrides: {
            modelOverrides: {
              "override-model": { contextWindow: 654_000 },
            },
          },
        },
      },
      [
        {
          model: { model: "agent-yaml-model" },
          subagents: [{ model: "agent-yaml-subagent-model" }],
        },
      ]
    );

    expect([...models].sort()).toEqual([
      "agent-yaml-model",
      "agent-yaml-subagent-model",
      "custom-array-model",
      "openrouter-model",
      "override-model",
      "subagent-model",
    ]);
  });

  it("uses context windows defined in models.json", () => {
    expect(
      contextFromModelsConfig({
        providers: {
          custom: {
            models: [{ id: "custom-model", contextWindow: 321_000 }],
            modelOverrides: {
              "override-model": { contextWindow: 654_000 },
            },
          },
        },
      })
    ).toEqual({
      "custom-model": 321_000,
      "override-model": 654_000,
    });
  });

  it("reads agent and subagent models from agent.yaml content", () => {
    expect(
      readAgentYamlModelConfig(`
id: devagent
model:
  provider: zai
  model: glm-5.1
subagents:
  - name: Worker
    cli: codex
    model: gpt-5.3-codex
  - name: Reviewer
    model: gpt-5.5
`)
    ).toEqual({
      model: { model: "glm-5.1" },
      subagents: [{ model: "gpt-5.3-codex" }, { model: "gpt-5.5" }],
    });
  });

  it("fills only missing configured models from models.dev fallback", () => {
    const configured = new Set([
      "openrouter-model",
      "fallback-model",
      "router/kimi-k2.5",
    ]);
    const openRouterResult = contextFromOpenRouter(
      [
        { id: "openrouter-model", context_length: 123_000 },
        { id: "unconfigured-model", context_length: 456_000 },
      ],
      configured,
      false
    );

    const result = addMissingFromModelsDev(
      openRouterResult,
      {
        provider: {
          models: {
            "openrouter-model": {
              id: "openrouter-model",
              limit: { context: 999_000 },
            },
            "fallback-model": {
              id: "fallback-model",
              limit: { context: 789_000 },
            },
            "kimi-k2.5": {
              id: "kimi-k2.5",
              limit: { context: 262_000 },
            },
          },
        },
      },
      configured,
      false
    );

    expect(result).toEqual({
      "fallback-model": 789_000,
      "openrouter-model": 123_000,
      "router/kimi-k2.5": 262_000,
    });
  });

  it("merges discovered models over existing context data", () => {
    expect(
      mergeContextData(
        {
          "existing-model": 111_000,
          "updated-model": 222_000,
        },
        {
          "updated-model": 333_000,
          "new-model": 444_000,
        }
      )
    ).toEqual({
      "existing-model": 111_000,
      "new-model": 444_000,
      "updated-model": 333_000,
    });
  });

  it("discovers agents from $YOPLAI_HOME/agents/* when agents is unset", () => {
    const home = mkdtempSync(join(tmpdir(), "yoplai-home-"));
    cleanupDirs.push(home);
    process.env.YOPLAI_HOME = home;
    writeAgentYaml(join(home, "agents", "devagent"), "devagent", "default-model");

    const configs = readAgentYamlConfigs({}, join(home, "yoplai.json"));

    expect(configs).toEqual([
      { model: { model: "default-model" }, subagents: [] },
    ]);
  });

  it("does not fall back to the default agents dir when pool is configured", () => {
    const home = mkdtempSync(join(tmpdir(), "yoplai-home-"));
    cleanupDirs.push(home);
    process.env.YOPLAI_HOME = home;
    writeAgentYaml(join(home, "agents", "devagent"), "devagent", "default-model");
    writeAgentYaml(join(home, "pool", "poolagent"), "poolagent", "pool-model");

    const configs = readAgentYamlConfigs(
      { pool: ["$YOPLAI_HOME/pool/*"] },
      join(home, "yoplai.json")
    );

    expect(configs).toEqual([
      { model: { model: "pool-model" }, subagents: [] },
    ]);
  });

  it("collects models from top-level subagents config", () => {
    const models = collectConfiguredModels({
      subagents: [
        { name: "Worker", cli: "codex", model: "top-level-subagent-model" },
      ],
    });

    expect([...models]).toEqual(["top-level-subagent-model"]);
  });
});
