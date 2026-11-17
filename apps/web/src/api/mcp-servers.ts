import { apiFetch as fetch } from "./core";
import { gatewayApiPath, gatewayKey, type GatewayName } from "./gateway";

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
  state: "connected" | "disconnected" | "needs_reconnect" | "unreachable";
  status?: "pending";
  personalState?: Exclude<McpServer["state"], "unreachable">;
  teamState?: Exclude<McpServer["state"], "unreachable">;
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

const endpoint = (agentId: string, gateway?: GatewayName) => gatewayApiPath(gateway, `/api/mcp/servers?agent=${encodeURIComponent(agentId)}`);
const agentPath = (gateway: GatewayName, path: string, agentId: string, name: string) =>
  gatewayApiPath(gateway, `${path}?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}`);

export type McpServerList = { servers: McpServer[]; canConfigureTeam: boolean; canEditLabels?: boolean };
const lastLists = new Map<string, McpServerList>();
const statusRequests = new Map<string, object>();

/** Last list fetched for an agent; lets pages render instantly while live status refreshes. */
export function cachedMcpServers(agentId: string, gateway?: GatewayName): McpServerList | undefined {
  return lastLists.get(gatewayKey(gateway, agentId));
}

export async function fetchMcpServers(agentId: string, gateway?: GatewayName): Promise<McpServerList> {
  const response = await fetch(endpoint(agentId, gateway), { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error("Failed to load MCP servers.");
  const list: McpServerList = await response.json();
  lastLists.set(gatewayKey(gateway, agentId), list);
  return list;
}

/** Configuration and credential presence only; never waits for MCP discovery. */
export async function fetchMcpServersFast(agentId: string, name?: string, gateway?: GatewayName): Promise<McpServerList> {
  const response = await fetch(`${endpoint(agentId, gateway)}&live=0${name === undefined ? "" : `&server=${encodeURIComponent(name)}`}`, { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error("Failed to load MCP servers.");
  const list: McpServerList = await response.json();
  if (name === undefined) lastLists.set(gatewayKey(gateway, agentId), list);
  return list;
}

/** Live status for one details page; leave the full agent-list cache intact. */
export async function fetchMcpServer(agentId: string, name: string, gateway?: GatewayName): Promise<McpServerList> {
  const key = gatewayKey(gateway, agentId, name);
  const request = {};
  statusRequests.set(key, request);
  const response = await fetch(`${endpoint(agentId, gateway)}&server=${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error("Failed to load MCP server.");
  const list: McpServerList = await response.json();
  const listKey = gatewayKey(gateway, agentId);
  const cached = lastLists.get(listKey);
  if (cached && statusRequests.get(key) === request) lastLists.set(listKey, { ...cached, servers: cached.servers.map((server) => list.servers.find((item) => item.name === server.name) ?? server) });
  return list;
}

export type McpIconRefreshStatus = "updated" | "unchanged" | "not_connected" | "not_saved" | "unreachable" | "save_failed";

/** Maps a refresh result to a truthful message; a timeout/unreachable server is an error even if the status says "unchanged". */
export function iconRefreshOutcome(result: { status: McpIconRefreshStatus; error?: string; server?: { name: string; state?: string; error?: string } }, notConnected: string): { message: string } | { error: string } {
  const error = result.error ?? result.server?.error;
  if (result.status === "save_failed") return { error: `Couldn't save the new icon${error ? `: ${error}` : ""}. Kept the current icon.` };
  if (result.status === "unreachable" || result.server?.state === "unreachable" || error) return { error: `The server didn't respond: ${error ?? "it could not be reached"}. Kept the current icon.` };
  if (result.status === "not_connected") return { message: notConnected };
  if (result.status === "not_saved") return { message: "This server is edited by hand, so its icon isn't saved." };
  return { message: result.status === "updated" ? "Icon updated" : "No new icon found; kept the current one" };
}

export async function refreshMcpServerIcon(agentId: string, name: string, gateway?: GatewayName): Promise<{ status: McpIconRefreshStatus; error?: string; server: McpServer }> {
  const key = gatewayKey(gateway, agentId, name);
  const request = {};
  statusRequests.set(key, request);
  const response = await fetch(agentPath(gateway, "/api/mcp/servers/icon/refresh", agentId, name), { method: "POST", signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error((await response.text()) || "Failed to refresh MCP server icon.");
  const result: { status: McpIconRefreshStatus; error?: string; server: McpServer } = await response.json();
  const listKey = gatewayKey(gateway, agentId);
  const cached = lastLists.get(listKey);
  if (cached && statusRequests.get(key) === request) lastLists.set(listKey, { ...cached, servers: cached.servers.map((server) => server.name === result.server.name ? { ...server, ...result.server } : server) });
  return result;
}

/** A remote add sends no return path: the remote callback must not load a local page. */
export async function addMcpServer(agentId: string, url: string, credentialScope: McpScope, returnTo?: string, gateway?: GatewayName): Promise<{ server: McpServer; authorizationUrl?: string }> {
  const response = await fetch(endpoint(agentId, gateway), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(gateway === undefined ? { url, credentialScope, returnTo } : { url, credentialScope }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error((await response.text()) || "Failed to add MCP server.");
  return response.json();
}

export async function removeMcpServer(agentId: string, name: string, gateway?: GatewayName): Promise<void> {
  const response = await fetch(agentPath(gateway, "/api/mcp/servers/remove", agentId, name), { method: "POST" });
  if (response.status === 403) throw new Error("Only admins can remove this MCP server.");
  if (!response.ok) throw new Error("Failed to remove MCP server.");
}

export async function disconnectMcpServer(agentId: string, name: string, scope: McpScope, gateway?: GatewayName): Promise<void> {
  const response = await fetch(gatewayApiPath(gateway, `/api/mcp/oauth/disconnect?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(name)}&scope=${scope}`), { method: "POST" });
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

const configEndpoint = (agentId: string, name: string, gateway?: GatewayName) => agentPath(gateway, "/api/mcp/servers/config", agentId, name);

export async function fetchMcpServerConfig(agentId: string, name: string, gateway?: GatewayName): Promise<McpServerConfigView> {
  const response = await fetch(configEndpoint(agentId, name, gateway));
  if (!response.ok) throw new Error((await response.text()) || "Failed to load MCP server config.");
  return response.json();
}

export async function saveMcpServerConfig(agentId: string, name: string, config: unknown, gateway?: GatewayName): Promise<McpServerConfigView> {
  const response = await fetch(configEndpoint(agentId, name, gateway), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config }),
  });
  if (!response.ok) throw new Error((await response.text()) || "Failed to save MCP server config.");
  return response.json();
}

export async function setSharedMcpServer(agentId: string, name: string, enabled: boolean, gateway?: GatewayName): Promise<McpServer> {
  const response = await fetch(agentPath(gateway, "/api/mcp/servers/shared", agentId, name), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error((await response.text()) || "Failed to update MCP server.");
  return (await response.json()).server;
}

/** Sets the manual name/description of an agent-local server; an empty value clears it. */
export async function saveMcpServerLabel(agentId: string, name: string, label: { displayName: string; description: string }, gateway?: GatewayName): Promise<void> {
  const response = await fetch(agentPath(gateway, "/api/mcp/servers/label", agentId, name), {
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
export const refreshMcpCatalogIcon = (name: string) => catalogRequest<{ status: McpIconRefreshStatus; error?: string; server: McpCatalogServer }>(`/icon/refresh?server=${encodeURIComponent(name)}`, { method: "POST", signal: AbortSignal.timeout(35_000) }, "Failed to refresh MCP server icon.");
