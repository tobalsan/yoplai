import type {
  GatewayConfig,
  SubagentRuntimeCli,
  SubagentRuntimeProfile,
} from "@yoplai/shared";

export type SubagentProfileValidationResult =
  | { valid: true; errors: [] }
  | { valid: false; errors: string[] };

export type ResolvedCliProfileOptions =
  | {
      ok: true;
      data: {
        model: string;
        reasoningEffort?: string;
        thinking?: string;
      };
    }
  | { ok: false; error: string };

export type NormalizedRunMode = "main-run" | "worktree" | "clone" | "none";

const CODEX_MODELS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2",
];
const CLAUDE_MODELS = ["opus", "sonnet", "haiku"];
const PI_MODELS = [
  "qwen3.5-plus",
  "qwen3-max-2026-01-23",
  "MiniMax-M2.5",
  "glm-5",
  "kimi-k2.5",
];
const CODEX_REASONING = ["xhigh", "high", "medium", "low"];
const CLAUDE_EFFORT = ["high", "medium", "low"];
const PI_THINKING = ["off", "low", "medium", "high", "xhigh"];

const RUN_MODES: NormalizedRunMode[] = [
  "main-run",
  "worktree",
  "clone",
  "none",
];

export function mergeProfiles(
  extension: SubagentRuntimeProfile[],
  legacy: SubagentRuntimeProfile[]
): SubagentRuntimeProfile[] {
  return [
    ...extension,
    ...legacy.filter(
      (legacyProfile) =>
        !extension.some((profile) => profile.name === legacyProfile.name)
    ),
  ];
}

export function legacyRuntimeProfiles(
  config: GatewayConfig
): SubagentRuntimeProfile[] {
  return (config.subagents ?? []).map((profile) => ({
    name: profile.name,
    cli: profile.cli,
    model: profile.model,
    reasoningEffort: profile.reasoning,
    type: profile.type,
    labelPrefix: profile.name,
    runMode: profile.runMode,
  }));
}

export function runtimeProfiles(
  config: GatewayConfig
): SubagentRuntimeProfile[] {
  return mergeProfiles(
    config.extensions?.subagents?.profiles ?? [],
    legacyRuntimeProfiles(config)
  );
}

export function resolveProfile(
  config: GatewayConfig,
  name: string
): SubagentRuntimeProfile | undefined {
  return runtimeProfiles(config).find((profile) => profile.name === name);
}

export class SubagentProfileResolver {
  constructor(private readonly config: GatewayConfig) {}

  runtimeProfiles(): SubagentRuntimeProfile[] {
    return runtimeProfiles(this.config);
  }

  resolveProfile(name: string): SubagentRuntimeProfile | undefined {
    return resolveProfile(this.config, name);
  }
}

export function normalizeRunMode(
  value: string | undefined
): NormalizedRunMode | undefined {
  if (value && RUN_MODES.includes(value as NormalizedRunMode)) {
    return value as NormalizedRunMode;
  }
  return undefined;
}

export function normalizeRunModeOrClone(value: string): NormalizedRunMode {
  return normalizeRunMode(value) ?? "clone";
}

export function resolveCliProfileOptions(
  cli: SubagentRuntimeCli,
  model?: string,
  reasoningEffort?: string,
  thinking?: string
): ResolvedCliProfileOptions {
  if (cli === "codex") {
    const resolvedModel = model || "gpt-5.3-codex";
    if (!CODEX_MODELS.includes(resolvedModel)) {
      return {
        ok: false,
        error: `Invalid codex model: ${resolvedModel}. Allowed: ${CODEX_MODELS.join(", ")}`,
      };
    }
    const resolvedEffort = reasoningEffort || "high";
    if (!CODEX_REASONING.includes(resolvedEffort)) {
      return {
        ok: false,
        error: `Invalid codex reasoning effort: ${resolvedEffort}. Allowed: ${CODEX_REASONING.join(", ")}`,
      };
    }
    if (thinking) {
      return { ok: false, error: "thinking is only valid for pi CLI" };
    }
    return {
      ok: true,
      data: { model: resolvedModel, reasoningEffort: resolvedEffort },
    };
  }

  if (cli === "claude") {
    const resolvedModel = model || "sonnet";
    if (!CLAUDE_MODELS.includes(resolvedModel)) {
      return {
        ok: false,
        error: `Invalid claude model: ${resolvedModel}. Allowed: ${CLAUDE_MODELS.join(", ")}`,
      };
    }
    const resolvedEffort = reasoningEffort || "high";
    if (!CLAUDE_EFFORT.includes(resolvedEffort)) {
      return {
        ok: false,
        error: `Invalid claude effort: ${resolvedEffort}. Allowed: ${CLAUDE_EFFORT.join(", ")}`,
      };
    }
    if (thinking) {
      return { ok: false, error: "thinking is only valid for pi CLI" };
    }
    return {
      ok: true,
      data: { model: resolvedModel, reasoningEffort: resolvedEffort },
    };
  }

  const resolvedModel = model || "qwen3.5-plus";
  if (!PI_MODELS.includes(resolvedModel)) {
    return {
      ok: false,
      error: `Invalid pi model: ${resolvedModel}. Allowed: ${PI_MODELS.join(", ")}`,
    };
  }
  const resolvedThinking = thinking || "medium";
  if (!PI_THINKING.includes(resolvedThinking)) {
    return {
      ok: false,
      error: `Invalid pi thinking: ${resolvedThinking}. Allowed: ${PI_THINKING.join(", ")}`,
    };
  }
  if (reasoningEffort) {
    return {
      ok: false,
      error: "reasoningEffort is only valid for codex and claude CLIs",
    };
  }
  return { ok: true, data: { model: resolvedModel, thinking: resolvedThinking } };
}

export function validateProfile(
  profile: SubagentRuntimeProfile
): SubagentProfileValidationResult {
  const errors: string[] = [];
  if (!profile.name.trim()) errors.push("name is required");
  if (profile.runMode && !normalizeRunMode(profile.runMode)) {
    errors.push(
      `Invalid runMode: ${profile.runMode}. Allowed: ${RUN_MODES.join(", ")}`
    );
  }
  const resolved = resolveCliProfileOptions(
    profile.cli,
    profile.model,
    profile.reasoningEffort ?? profile.reasoning,
    undefined
  );
  if (!resolved.ok) errors.push(resolved.error);
  return errors.length === 0
    ? { valid: true, errors: [] }
    : { valid: false, errors };
}
