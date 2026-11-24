import path from "node:path";

export function durableStorePath(home: string, agentId: string): string {
  return path.join(home, "agents", agentId, "durable", "agent.sqlite");
}
