import fs from "node:fs/promises";
import path from "node:path";

export type TestAgentConfig = {
  id: string;
  name?: string;
  model?: { provider: string; model: string };
  extraYaml?: string;
};

export async function writeTestAgent(
  homeDir: string,
  agent: TestAgentConfig
): Promise<string> {
  const agentDir = path.join(homeDir, "agents", agent.id);
  await fs.mkdir(agentDir, { recursive: true });
  const model = agent.model ?? { provider: "anthropic", model: "claude" };
  const extraYaml = agent.extraYaml ? `\n${agent.extraYaml.trim()}\n` : "";
  await fs.writeFile(
    path.join(agentDir, "agent.yaml"),
    `id: ${agent.id}\nname: ${agent.name ?? agent.id}\nmodel:\n  provider: ${model.provider}\n  model: ${model.model}\n${extraYaml}`
  );
  return agentDir;
}

export async function writeTestV3Config(
  homeDir: string,
  options: {
    agents?: TestAgentConfig[];
    extensions?: Record<string, unknown>;
    extraConfig?: Record<string, unknown>;
  } = {}
): Promise<string> {
  const configDir = homeDir;
  await fs.mkdir(configDir, { recursive: true });
  const agents = options.agents ?? [];
  const agentDirs = await Promise.all(
    agents.map((agent) => writeTestAgent(configDir, agent))
  );
  const config = {
    version: 3,
    agents: agentDirs,
    ...(options.extensions ? { extensions: options.extensions } : {}),
    ...(options.extraConfig ?? {}),
  };
  const configPath = path.join(configDir, "yoplai.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}
