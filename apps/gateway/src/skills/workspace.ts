import path from "node:path";

export async function readWorkspaceSkills(agent: { id: string; name: string; directory: string }) {
  const { loadSkillsFromDir } = await import("@earendil-works/pi-coding-agent");
  return loadSkillsFromDir({ dir: agent.directory, source: "workspace" }).skills.map((skill) => {
    const relative = path.relative(agent.directory, path.basename(skill.filePath) === "SKILL.md" ? skill.baseDir : skill.filePath).split(path.sep).join("/");
    return {
      id: `agent:${agent.id}:${relative}`, name: skill.name, description: skill.description,
      directory: skill.baseDir, skillFile: skill.filePath, agentId: agent.id, agentName: agent.name,
    };
  });
}
