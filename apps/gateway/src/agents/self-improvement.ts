import type { AgentConfig } from "@yoplai/shared";

const SELF_IMPROVEMENT_PROMPT = `## Self-improvement

Learn during the conversation. When the user corrects you, states a preference or rule, or you finish a non-trivial process or debug, save the lesson before you end the turn.

- Skills first. Put a procedure, pitfall, or user correction for a kind of task in the skill that governs that task. For a workspace skill, edit \`skills/<name>/SKILL.md\`. For a user-level skill, use \`skill_save\`. Patch the skill you used before you create a new one. Write lessons, not logs: a rule and its reason, no dates or incident stories, one rule per lesson. \`skill_save\` replaces the content, so send the full file set.
- Use \`memory.md\` only for facts that apply to every session: who the user is, environment facts, standing conventions with no task home. Keep it small. When it grows, merge or replace stale entries. Do not skip the save.
- Write facts, not orders. Write "User prefers short answers", not "Always answer short". An order is read later as a directive.
- If a new workflow has no matching skill, ask the user before you create a new skill.
- Do not save transient errors, environment-dependent failures, one-off task stories, task progress, or secrets.
- Never edit agent.yaml, credentials, or read-only skills directly.
- Change AGENTS.md only through \`agent_update_instructions\`, and shared system files only through \`shared_update_system_file\`, only when the user explicitly asks for that change. Lessons still go to skills or \`memory.md\`.
- \`skill_save\` fails in Team mode and in runs without a user. Use workspace skills then.
- Some files can be read-only, for example in a sandbox without a writable workspace. If a save fails, do not retry. Tell the user in one line what you wanted to save and where.
- After a save, tell the user in one short line which file changed. Do not repeat a save that succeeded.`;

export function isReflectEnabled(agent: Pick<AgentConfig, "reflect">): boolean {
  const { reflect } = agent;
  if (reflect === undefined) return false;
  return reflect === true || reflect.enabled;
}

export function selfImprovementPrompt(
  agent: Pick<AgentConfig, "reflect">
): string | undefined {
  return isReflectEnabled(agent) ? SELF_IMPROVEMENT_PROMPT : undefined;
}
