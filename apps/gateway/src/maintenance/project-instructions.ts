import { MaintenanceCompletion } from "./completion.js";
import { completeInstructionBlocks } from "./instruction-blocks.js";

const INSTRUCTIONS_PROMPT =
  "You write starting instructions for a chat project that AI agents read before working in it. " +
  "Given the user's description of the project's purpose, draft concise, agent-facing instructions: " +
  "the goal, what good output looks like, and any constraints implied by the description. " +
  "Do not invent facts. Markdown is fine. Reply in the same language as the user's description. " +
  "Return only the instructions, no preamble.";
const INSTRUCTIONS_TIMEOUT_MS = 30_000;
// Reasoning models spend output tokens on thinking before the text; leave headroom.
const INSTRUCTIONS_MAX_TOKENS = 1024;

type ProjectInstructionsDeps = {
  complete?: typeof MaintenanceCompletion.complete;
};

let testDeps: ProjectInstructionsDeps = {};

export function setProjectInstructionsDepsForTests(deps: ProjectInstructionsDeps): void {
  testDeps = deps;
}

export function resetProjectInstructionsDepsForTests(): void {
  testDeps = {};
}

/**
 * Draft project instructions from a purpose statement. Never throws: on any
 * failure the raw purpose is returned so saving instructions cannot fail here.
 * `agentId` only matters when no `maintenance` model is configured.
 */
export async function draftProjectInstructions(
  purpose: string,
  agentId: string,
  projectId: string,
  deps: ProjectInstructionsDeps = {}
): Promise<string> {
  const trimmed = purpose.trim();
  if (!trimmed) return "";
  const complete = { ...testDeps, ...deps }.complete ?? MaintenanceCompletion.complete;
  try {
    const drafted = await complete({
      agentId,
      sessionId: `chat-project-${projectId}`,
      system: INSTRUCTIONS_PROMPT,
      prompt: trimmed,
      maxTokens: INSTRUCTIONS_MAX_TOKENS,
      timeoutMs: INSTRUCTIONS_TIMEOUT_MS,
      onLength: completeInstructionBlocks,
    });
    return drafted?.trim() || trimmed;
  } catch {
    return trimmed;
  }
}
