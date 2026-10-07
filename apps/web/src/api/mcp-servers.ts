import { apiFetch as fetch } from "./core";

export type McpScope = "personal" | "team";
export type McpServer = {
  name: string;
  type: "http" | "stdio";
  url?: string;
  iconUrl?: string;
  auth: "oauth" | "none" | "static" | "stdio";
  state: "connected" | "disconnected" | "needs_reconnect";
  personalState?: McpServer["state"];
  teamState?: McpServer["state"];
  readOnly: boolean;
};

const endpoint = (agentId: string) => `/api/mcp/servers?agent=${encodeURIComponent(agentId)}`;

export async function fetchMcpServers(agentId: string): Promise<{ servers: McpServer[]; canConfigureTeam: boolean }> {
  const response = await fetch(endpoint(agentId), { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error("Failed to load MCP servers.");
  return response.json();
}

export async function addMcpServer(agentId: string, url: string, credentialScope: McpScope): Promise<{ server: McpServer; authorizationUrl?: string }> {
  const response = await fetch(endpoint(agentId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, credentialScope }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error((await response.text()) || "Failed to add MCP server.");
  return response.json();
}

export async function removeMcpServer(agentId: string, name: string): Promise<void> {
  const response = await fetch(`/api/mcp/servers/remove?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}`, { method: "POST" });
  if (!response.ok) throw new Error("Failed to remove MCP server.");
}

export async function disconnectMcpServer(agentId: string, name: string, scope: McpScope): Promise<void> {
  const response = await fetch(`/api/mcp/oauth/disconnect?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}&scope=${scope}`, { method: "POST" });
  if (!response.ok) throw new Error("Failed to disconnect MCP server.");
}
