import type { SubagentRuntimeProfile } from "@yoplai/shared";
import type { WorkflowConfig } from "../types.js";

type AgentConfig = WorkflowConfig["agent"];
type RunnerKind = NonNullable<AgentConfig["runner"]>;
const PI_THINKING = ["off", "low", "medium", "high", "xhigh"];
const CODEX_REASONING = ["xhigh", "high", "medium", "low"];
const CLAUDE_EFFORT = ["low", "medium", "high", "xhigh", "max"];

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function workflowAgentThinking(agent: AgentConfig): string | undefined {
  const aliases = agent as AgentConfig & {
    thinking?: unknown;
    reasoning?: unknown;
    reasoningEffort?: unknown;
    reasoning_effort?: unknown;
  };
  return readText(aliases.thinking)
    ?? readText(aliases.reasoningEffort)
    ?? readText(aliases.reasoning_effort)
    ?? readText(aliases.reasoning);
}

export function runnerForWorkflow(input: { workflow: WorkflowConfig; profile: SubagentRuntimeProfile }): RunnerKind {
  const runner = input.workflow.agent.runner ?? input.workflow.agent.kind ?? input.profile.cli;
  if (runner === "fake" || runner === "cli" || runner === "codex" || runner === "pi" || runner === "claude") return runner;
  return "pi";
}

export function validateWorkflowThinkingForRunner(runner: RunnerKind | undefined, agent: AgentConfig): void {
  const thinking = workflowAgentThinking(agent);
  if (!thinking) return;
  const allowed = runner === "pi"
    ? PI_THINKING
    : runner === "codex"
      ? CODEX_REASONING
      : runner === "claude"
        ? CLAUDE_EFFORT
        : undefined;
  if (allowed && !allowed.includes(thinking)) throw new Error(`Invalid agent.thinking for ${runner}: ${thinking}. Allowed: ${allowed.join(", ")}`);
}

export function reasoningEffortForRunner(input: { workflow: WorkflowConfig; profile: SubagentRuntimeProfile }): string | undefined {
  const workflowThinking = workflowAgentThinking(input.workflow.agent);
  const runner = runnerForWorkflow(input);
  validateWorkflowThinkingForRunner(runner, input.workflow.agent);
  if (runner === "codex" || runner === "claude") return workflowThinking ?? input.profile.reasoningEffort ?? input.profile.reasoning;
  return input.profile.reasoningEffort ?? input.profile.reasoning;
}

export function piThinkingForRunner(input: { workflow: WorkflowConfig; profile: SubagentRuntimeProfile }): string | undefined {
  const workflowThinking = workflowAgentThinking(input.workflow.agent);
  const runner = runnerForWorkflow(input);
  validateWorkflowThinkingForRunner(runner, input.workflow.agent);
  if (runner === "pi") return workflowThinking ?? input.profile.thinking;
  return input.profile.thinking;
}
