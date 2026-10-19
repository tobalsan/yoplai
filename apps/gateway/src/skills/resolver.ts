import type { SkillAccessPolicy } from "./access.js";
import type { SkillStore } from "./store.js";

export type ResolvedRunSkills = {
  skills: { id: string; name: string; directory: string }[];
  diagnostics: { id: string; name: string; winnerId: string }[];
};

export async function resolveRunSkills(store: SkillStore, options: { agentId: string; userId?: string; multiUser: boolean; policy: SkillAccessPolicy; ignoreAgentRestrictions?: boolean }): Promise<ResolvedRunSkills> {
  let userId = options.multiUser ? options.userId : "local";
  if (options.multiUser && userId && !await options.policy.options.getEligibleAccount?.(userId)) userId = undefined;
  const state = userId ? await store.getState(userId) : { enabled: [], disabledDefaults: [] };
  const defaults = (await store.defaults()).filter((skill) => !state.disabledDefaults.includes(skill.name) && (options.ignoreAgentRestrictions || !skill.agents || skill.agents.includes(options.agentId)));
  const candidates: ResolvedRunSkills["skills"] = defaults;
  if (userId) {
    const enabled = (await store.list()).filter((row) => state.enabled.includes(row.id) && !row.disabledByAdmin && (row.ownerId === userId || row.shares.some((share) => share.kind === "all" || share.id === userId)));
    enabled.sort((a, b) => Number(b.ownerId === userId) - Number(a.ownerId === userId) || a.ownerId.localeCompare(b.ownerId) || a.name.localeCompare(b.name));
    for (const row of enabled) {
      if (await options.policy.canRead(row, { userId })) candidates.push({ id: row.id, name: row.name, directory: store.directory(row) });
    }
  }
  const winners = new Map<string, string>();
  const result: ResolvedRunSkills = { skills: [], diagnostics: [] };
  for (const skill of candidates) {
    const winnerId = winners.get(skill.name);
    if (winnerId) result.diagnostics.push({ id: skill.id, name: skill.name, winnerId });
    else { winners.set(skill.name, skill.id); result.skills.push(skill); }
  }
  return result;
}
