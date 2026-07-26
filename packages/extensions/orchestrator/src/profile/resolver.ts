import type { SubagentRuntimeProfile } from "@yoplai/shared";
import type { WorkflowFrontmatter } from "../types.js";

export type ProfileResolution =
  | { profile: SubagentRuntimeProfile }
  | { park: { reason: string } };

export function resolveProfile(input: {
  workflow: WorkflowFrontmatter;
  profilesConfig: SubagentRuntimeProfile[];
}): ProfileResolution {
  const runner = input.workflow.agent?.runner ?? input.workflow.agent?.kind ?? "pi";
  const name = input.workflow.agent?.profile ?? runner;
  const profile = new Map(input.profilesConfig.map((item) => [item.name, item])).get(name);
  if (!profile) {
    if (input.workflow.agent?.profile && input.profilesConfig.length > 0) return { park: { reason: `Configured orchestrator profile not found: ${name}` } };
    if (runner === "codex" || runner === "claude" || runner === "pi") return { profile: { name, cli: runner, provider: input.workflow.agent?.provider, model: input.workflow.agent?.model } };
    return { profile: { name, cli: "codex", provider: input.workflow.agent?.provider, model: input.workflow.agent?.model } };
  }
  return { profile };
}
