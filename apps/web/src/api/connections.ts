import { API_BASE, apiFetch as fetch } from "./core";

export type AgentConnection = {
  kind: "oauth" | "extension" | "mcp";
  id: string;
  name: string;
  personal: boolean;
  team: boolean;
};

export async function fetchAgentConnections(agentId: string): Promise<AgentConnection[]> {
  const response = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/connections`);
  if (!response.ok) throw new Error("Failed to load connections");
  const data = (await response.json()) as { connections: AgentConnection[] };
  return data.connections;
}

export async function disconnectAgentConnection(
  agentId: string,
  kind: Exclude<AgentConnection["kind"], "mcp">,
  id: string,
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/connections/${kind}/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to disconnect personal connection");
}

type McpServerStatus = { name: string; auth: "oauth" | "static"; state: "connected" | "disconnected" | "needs_reconnect" | "static" };

async function fetchMcpStatus(agentId: string, scope: "team" | "personal"): Promise<McpServerStatus[]> {
  let response: Response;
  try {
    response = await fetch(`/api/mcp/oauth/status?agent=${encodeURIComponent(agentId)}&scope=${scope}`, {
      signal: AbortSignal.timeout(8_000),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new Error("MCP connection status timed out");
    }
    throw cause;
  }
  if (!response.ok) throw new Error("Failed to load MCP connection status");
  const data = (await response.json()) as { servers: McpServerStatus[] };
  return data.servers;
}

export async function fetchAgentMcpConnections(agentId: string, includePersonal: boolean): Promise<AgentConnection[]> {
  const [teamServers, personalServers] = await Promise.all([
    fetchMcpStatus(agentId, "team"),
    includePersonal ? fetchMcpStatus(agentId, "personal") : Promise.resolve([]),
  ]);
  const team = new Map(teamServers.map((server) => [server.name, server]));
  const personal = new Map(personalServers.map((server) => [server.name, server]));
  const names = new Set([...team.keys(), ...personal.keys()]);
  return [...names].flatMap((name) => {
    const teamServer = team.get(name);
    const personalServer = personal.get(name);
    if (teamServer?.auth !== "oauth" && personalServer?.auth !== "oauth") return [];
    return [{
      kind: "mcp" as const,
      id: name,
      name: `${name} (MCP)`,
      personal: personalServer?.state === "connected" || personalServer?.state === "needs_reconnect",
      team: teamServer?.state === "connected" || teamServer?.state === "needs_reconnect" || teamServer?.state === "static",
    }];
  });
}

export async function disconnectMcpConnection(agentId: string, server: string): Promise<void> {
  const response = await fetch(
    `/api/mcp/oauth/disconnect?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(server)}&scope=personal`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Failed to disconnect personal MCP connection");
}

export type SlackPairing = { workspaceId: string; slackUserId: string; pairedAt: number };

export async function fetchSlackPairings(): Promise<SlackPairing[]> {
  const response = await fetch(`${API_BASE}/slack/pairings`);
  if (!response.ok) throw new Error("Failed to load Slack pairings");
  const data = (await response.json()) as { pairings: SlackPairing[] };
  return data.pairings;
}

export async function unpairSlackAccount(pairing: SlackPairing): Promise<void> {
  const response = await fetch(
    `${API_BASE}/slack/pairings/${encodeURIComponent(pairing.workspaceId)}/${encodeURIComponent(pairing.slackUserId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to remove Slack pairing");
}
