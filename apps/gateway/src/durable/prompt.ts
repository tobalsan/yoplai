import { PI_SYSTEM_PROMPT, codemodeGuidance, type AgentConfig, type GatewayConfig } from "@yoplai/shared";
import { resolveSystemFiles } from "@yoplai/shared/node/system-files";
import { selfImprovementPrompt } from "../agents/self-improvement.js";
import { ensureWorkspaceFiles, FIRST_RUN_BOOTSTRAP_PROMPT } from "../agents/workspace.js";
import { resolveWorkspaceDir } from "../config/index.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { durableExtensionEnv } from "./env.js";
import type { mainPrincipal } from "./principal.js";

export async function durableInstructions(
  agent: AgentConfig,
  config: GatewayConfig,
  principal: ReturnType<typeof mainPrincipal>,
  runtime: ExtensionRuntime,
  deferralSummary?: string,
) {
  const workspaceDir = resolveWorkspaceDir(agent.workspaceDir ?? agent.workspace);
  const firstRun = await ensureWorkspaceFiles(workspaceDir);
  const [files, contributions] = await Promise.all([
    resolveSystemFiles({ workspaceDir, systemFiles: agent.system_files }),
    runtime.getPromptContributions(agent, config, principal.userId, { ...principal, env: durableExtensionEnv(agent, config) }),
  ]);
  return [
    PI_SYSTEM_PROMPT,
    ...files.map(({ content }) => content),
    firstRun && FIRST_RUN_BOOTSTRAP_PROMPT,
    ...contributions,
    selfImprovementPrompt(agent),
    `Conversation files: ${principal.conversationFiles.runtimePath}. Download and edit files here; use send_file to share the result with the user.`,
    agent.codemode && codemodeGuidance(),
    deferralSummary,
    "User messages carry a [from <name> via web] header.",
  ].filter(Boolean).join("\n\n");
}
