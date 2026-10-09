import { apiFetch as fetch } from "./core";

export type McpScope = "personal" | "team";
export type McpServer = {
  name: string;
  /** Server-reported display name (initialize `serverInfo.title`), when known. */
  title?: string;
  /** Server-reported description (initialize `serverInfo.description`, or split from a sentence-like title). */
  description?: string;
  type: "http" | "stdio";
  url?: string;
  iconUrl?: string;
  auth: "oauth" | "none" | "static" | "stdio";
  state: "connected" | "disconnected" | "needs_reconnect";
  personalState?: McpServer["state"];
  teamState?: McpServer["state"];
  /** Email or name of the connected account per scope, when the provider reveals it. */
  personalAccount?: string;
  teamAccount?: string;
  readOnly: boolean;
  /** Catalog server (managed by a superadmin); `enabled` is this agent's opt-in. */
  shared?: boolean;
  enabled?: boolean;
  /** Manually set label on an agent-local server (wins over server-reported). */
  manualLabel?: { displayName?: string; description?: string };
};

/** Display label: server-reported title, else the capitalized key (e.g. "claap" → "Claap"). The key stays the identifier. */
export function mcpDisplayName(name: string, title?: string): string {
  return title || name.charAt(0).toUpperCase() + name.slice(1);
}

const endpoint = (agentId: string) => `/api/mcp/servers?agent=${encodeURIComponent(agentId)}`;

export type McpServerList = { servers: McpServer[]; canConfigureTeam: boolean; canEditLabels?: boolean };
const lastLists = new Map<string, McpServerList>();

/** Last list fetched for an agent; lets pages render instantly while live status refreshes. */
export function cachedMcpServers(agentId: string): McpServerList | undefined {
  return lastLists.get(agentId);
}

export async function fetchMcpServers(agentId: string): Promise<McpServerList> {
  const response = await fetch(endpoint(agentId), { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error("Failed to load MCP servers.");
  const list: McpServerList = await response.json();
  lastLists.set(agentId, list);
  return list;
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

/** True when the signed-in user already has a usable personal grant for this URL (shared from another agent). */
export async function fetchMcpPersonalStatus(agentId: string, url: string): Promise<{ connected: boolean }> {
  const response = await fetch(`/api/mcp/servers/personal-status?agent=${encodeURIComponent(agentId)}&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Failed to check MCP connection.");
  return response.json();
}

export async function removeMcpServer(agentId: string, name: string): Promise<void> {
  const response = await fetch(`/api/mcp/servers/remove?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}`, { method: "POST" });
  if (response.status === 403) throw new Error("Only admins can remove this MCP server.");
  if (!response.ok) throw new Error("Failed to remove MCP server.");
}

export async function disconnectMcpServer(agentId: string, name: string, scope: McpScope): Promise<void> {
  const response = await fetch(`/api/mcp/oauth/disconnect?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}&scope=${scope}`, { method: "POST" });
  if (!response.ok) throw new Error("Failed to disconnect MCP server.");
}

export type McpServerConfigView = {
  name: string;
  type: "http" | "stdio";
  /** False for stdio servers and when the caller cannot change the shared mcp.json. */
  editable: boolean;
  /** Server entry from mcp.json with header, env and OAuth client secret values masked. */
  config: Record<string, unknown>;
};

const configEndpoint = (agentId: string, name: string) => `/api/mcp/servers/config?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}`;

export async function fetchMcpServerConfig(agentId: string, name: string): Promise<McpServerConfigView> {
  const response = await fetch(configEndpoint(agentId, name));
  if (!response.ok) throw new Error((await response.text()) || "Failed to load MCP server config.");
  return response.json();
}

export async function saveMcpServerConfig(agentId: string, name: string, config: unknown): Promise<McpServerConfigView> {
  const response = await fetch(configEndpoint(agentId, name), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  if (!response.ok) throw new Error((await response.text()) || "Failed to save MCP server config.");
  return response.json();
}

export async function setSharedMcpServer(agentId: string, name: string, enabled: boolean): Promise<McpServer> {
  const response = await fetch(`/api/mcp/servers/shared?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error((await response.text()) || "Failed to update MCP server.");
  return (await response.json()).server;
}

/** Sets the manual name/description of an agent-local server; an empty value clears it. */
export async function saveMcpServerLabel(agentId: string, name: string, label: { displayName: string; description: string }): Promise<void> {
  const response = await fetch(`/api/mcp/servers/label?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(label),
  });
  if (!response.ok) throw new Error((await response.text()) || "Failed to save name and description.");
}

export type McpCatalogServer = { name: string; url: string; displayName?: string; description?: string; iconUrl?: string };

async function catalogRequest<T>(path: string, init: RequestInit | undefined, failure: string): Promise<T> {
  const response = await fetch(`/api/mcp/catalog${path}`, init);
  if (!response.ok) throw new Error((await response.text()) || failure);
  return response.json();
}
const jsonPost = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const fetchMcpCatalog = async (): Promise<McpCatalogServer[]> => (await catalogRequest<{ servers: McpCatalogServer[] }>("", undefined, "Failed to load MCP servers.")).servers;
export const addMcpCatalogServer = (input: { url: string; displayName?: string; description?: string }) => catalogRequest<{ server: McpCatalogServer }>("", jsonPost(input), "Failed to add MCP server.").then((result) => result.server);
export const updateMcpCatalogServer = (name: string, label: { displayName: string; description: string }) => catalogRequest<{ server: McpCatalogServer }>(`/update?server=${encodeURIComponent(name)}`, jsonPost(label), "Failed to save MCP server.").then((result) => result.server);
export const removeMcpCatalogServer = async (name: string): Promise<void> => { await catalogRequest(`/remove?server=${encodeURIComponent(name)}`, { method: "POST" }, "Failed to remove MCP server."); };
