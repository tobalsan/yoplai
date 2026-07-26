import { describe, expect, it } from "vitest";
import type { GatewayConfig, SubagentRuntimeProfile } from "@yoplai/shared";
import {
  mergeProfiles,
  normalizeRunMode,
  normalizeRunModeOrClone,
  resolveCliProfileOptions,
  resolveProfile,
  runtimeProfiles,
  validateProfile,
} from "./resolver.js";

function configWithProfiles(
  extension: SubagentRuntimeProfile[],
  legacy: NonNullable<GatewayConfig["subagents"]>
): GatewayConfig {
  return {
    agents: [],
    extensions: { subagents: { profiles: extension } },
    subagents: legacy,
  };
}

describe("SubagentProfileResolver", () => {
  it("merges extension profiles before legacy profiles by name", () => {
    const extension = [
      { name: "Worker", cli: "codex" as const, model: "gpt-5.4" },
    ];
    const legacy = [
      {
        name: "Worker",
        cli: "claude" as const,
        model: "sonnet",
        reasoning: "high",
        type: "worker",
        runMode: "worktree",
      },
      {
        name: "Reviewer",
        cli: "pi" as const,
        model: "qwen3.5-plus",
        reasoning: "medium",
        type: "reviewer",
        runMode: "none",
      },
    ];

    expect(mergeProfiles(extension, legacy)).toEqual([
      extension[0],
      {
        name: "Reviewer",
        cli: "pi",
        model: "qwen3.5-plus",
        reasoning: "medium",
        type: "reviewer",
        runMode: "none",
      },
    ]);
  });

  it("maps legacy subagents to runtime profiles", () => {
    const config = configWithProfiles(
      [{ name: "Worker", cli: "codex", model: "gpt-5.4" }],
      [
        {
          name: "Worker",
          cli: "claude",
          model: "sonnet",
          reasoning: "medium",
          type: "worker",
          runMode: "worktree",
        },
        {
          name: "Reviewer",
          cli: "codex",
          model: "gpt-5.3-codex",
          reasoning: "low",
          type: "reviewer",
          runMode: "none",
        },
      ]
    );

    expect(runtimeProfiles(config)).toEqual([
      { name: "Worker", cli: "codex", model: "gpt-5.4" },
      {
        name: "Reviewer",
        cli: "codex",
        model: "gpt-5.3-codex",
        reasoningEffort: "low",
        type: "reviewer",
        labelPrefix: "Reviewer",
        runMode: "none",
      },
    ]);
    expect(resolveProfile(config, "Worker")?.cli).toBe("codex");
  });

  it("normalizes run modes with clone fallback when requested", () => {
    expect(normalizeRunMode("main-run")).toBe("main-run");
    expect(normalizeRunMode("main")).toBeUndefined();
    expect(normalizeRunModeOrClone("main")).toBe("clone");
  });

  it("applies CLI model and reasoning defaults", () => {
    expect(resolveCliProfileOptions("codex")).toEqual({
      ok: true,
      data: { model: "gpt-5.3-codex", reasoningEffort: "high" },
    });
    expect(resolveCliProfileOptions("claude")).toEqual({
      ok: true,
      data: { model: "sonnet", reasoningEffort: "high" },
    });
    expect(resolveCliProfileOptions("pi")).toEqual({
      ok: true,
      data: { model: "qwen3.5-plus", thinking: "medium" },
    });
  });

  it("validates CLI-specific fields", () => {
    expect(
      resolveCliProfileOptions("codex", "not-a-model", undefined, undefined)
    ).toEqual({
      ok: false,
      error:
        "Invalid codex model: not-a-model. Allowed: gpt-5.4, gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.2",
    });
    expect(resolveCliProfileOptions("pi", undefined, "high")).toEqual({
      ok: false,
      error: "reasoningEffort is only valid for codex and claude CLIs",
    });
    expect(resolveCliProfileOptions("claude", undefined, undefined, "high"))
      .toEqual({
        ok: false,
        error: "thinking is only valid for pi CLI",
      });
  });

  it("validates complete profile configuration", () => {
    expect(validateProfile({ name: "Worker", cli: "codex" })).toEqual({
      valid: true,
      errors: [],
    });
    expect(
      validateProfile({
        name: "Bad",
        cli: "claude",
        reasoningEffort: "xhigh",
        runMode: "main",
      })
    ).toEqual({
      valid: false,
      errors: [
        "Invalid runMode: main. Allowed: main-run, worktree, clone, none",
        "Invalid claude effort: xhigh. Allowed: high, medium, low",
      ],
    });
  });
});
