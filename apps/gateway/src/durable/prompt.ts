import { DURABLE_MAIN_SESSION_ID, PI_SYSTEM_PROMPT, codemodeGuidance, type AgentConfig, type GatewayConfig } from "@yoplai/shared";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import { selfImprovementPrompt } from "../agents/self-improvement.js";
import { ensureWorkspaceFiles, FIRST_RUN_BOOTSTRAP_PROMPT } from "../agents/workspace.js";
import { resolveWorkspaceDir } from "../config/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { durableExtensionEnv } from "./env.js";
import type { mainPrincipal } from "./principal.js";

const turnPlanInstructions = [
  "## Turn plan",
  "Call `turn_plan` directly before the first action of a multi-step task (edits plus commands, or three or more steps). Use a top-level call outside Code Mode.",
  "Send the full checklist on each update. Keep exactly one step `in_progress` while working and leave none `in_progress` at the end.",
  "Add a short step `note` when a mid-task user message changes that step. If a step may be unfinished, for example after a restart, set it to `attention` with a short note and leave it out of completed steps.",
  "Single-command answers and plain conversation need no plan. Use `plan_update` for long-lived goals and `turn_plan` for this turn's steps.",
].join("\n");

export async function durableInstructions(
  agent: AgentConfig,
  config: GatewayConfig,
  principal: Omit<ReturnType<typeof mainPrincipal>, "conversationFiles"> &
    Partial<Pick<ReturnType<typeof mainPrincipal>, "conversationFiles">> & { room?: boolean },
  runtime: ExtensionRuntime,
  deferralSummary?: string,
) {
  const workspaceDir = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
  const firstRun = !principal.room && await ensureWorkspaceFiles(workspaceDir);
  const [files, contributions] = await Promise.all([
    resolveSystemFiles({ workspaceDir, systemFiles: agent.system_files }),
    runtime.getPromptContributions(agent, config, principal.userId, { ...principal, env: durableExtensionEnv(agent, config) }),
  ]);
  return [
    PI_SYSTEM_PROMPT,
    ...files.map(({ content }) => content),
    firstRun && FIRST_RUN_BOOTSTRAP_PROMPT,
    ...contributions,
    !principal.room && selfImprovementPrompt(agent),
    principal.conversationFiles && `Conversation files: ${principal.conversationFiles.runtimePath}. Download and edit files here; use send_file to share the result with the user.`,
    !principal.room && agent.codemode && codemodeGuidance(),
    deferralSummary,
    principal.sessionId === DURABLE_MAIN_SESSION_ID && turnPlanInstructions,
    "User messages carry a [from <name> via web] header.",
  ].filter(Boolean).join("\n\n");
}
