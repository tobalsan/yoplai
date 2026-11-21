import { API_BASE, apiFetch as fetch } from "./core";
import { fetchMcpServersFast } from "./mcp-servers";
import { gatewayApiPath, type GatewayName } from "./gateway";

export type AgentConnection = {
  kind: "oauth" | "extension" | "mcp";
  id: string;
  name: string;
  personal: boolean;
  team: boolean;
  /** Cached server icon, for MCP connections only. */
  iconUrl?: string;
};

export async function fetchAgentConnections(agentId: string, gateway?: GatewayName): Promise<AgentConnection[]> {
  const response = await fetch(gatewayApiPath(gateway, `${API_BASE}/agents/${encodeURIComponent(agentId)}/connections`));
  if (!response.ok) throw new Error("Failed to load connections");
  const data = (await response.json()) as { connections: AgentConnection[] };
  return data.connections;
}

export async function disconnectAgentConnection(
  agentId: string,
  kind: Exclude<AgentConnection["kind"], "mcp">,
  id: string,
  gateway?: GatewayName,
): Promise<void> {
  const response = await fetch(
    gatewayApiPath(gateway, `${API_BASE}/agents/${encodeURIComponent(agentId)}/connections/${kind}/${encodeURIComponent(id)}`),
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to disconnect personal connection");
}

export type McpServerStatus = { name: string; auth: "oauth" | "static"; state: "connected" | "disconnected" | "needs_reconnect" | "static" };

export async function fetchMcpStatus(agentId: string, scope: "team" | "personal", gateway?: GatewayName, signal?: AbortSignal): Promise<McpServerStatus[]> {
  let response: Response;
  try {
    response = await fetch(gatewayApiPath(gateway, `/api/mcp/oauth/status?agent=${encodeURIComponent(agentId)}&scope=${scope}`), {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
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

export async function fetchAgentMcpConnections(agentId: string, includePersonal: boolean, gateway?: GatewayName): Promise<AgentConnection[]> {
  const [teamServers, personalServers, icons] = await Promise.all([
    fetchMcpStatus(agentId, "team", gateway),
    includePersonal ? fetchMcpStatus(agentId, "personal", gateway) : Promise.resolve([]),
    // Icons are cosmetic: a failed fast list keeps the letter fallback.
    fetchMcpServersFast(agentId, undefined, gateway).then(
      (list) => new Map(list.servers.flatMap((server) => server.iconUrl ? [[server.name, server.iconUrl] as const] : [])),
      () => new Map<string, string>(),
    ),
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
      ...(icons.has(name) ? { iconUrl: icons.get(name) } : {}),
    }];
  });
}

export async function disconnectMcpConnection(agentId: string, server: string, gateway?: GatewayName): Promise<void> {
  const response = await fetch(
    gatewayApiPath(gateway, `/api/mcp/oauth/disconnect?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(server)}&scope=personal`),
    { method: "POST" },
  );
  if (!response.ok) throw new Error("Failed to disconnect personal MCP connection");
}

export type SlackPairing = { workspaceId: string; slackUserId: string; pairedAt: number };

/** A failed pairing call. `status` and `code` come from the answer, and the message is a fixed text. */
export class PairingApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined) {
    super(message);
    this.name = "PairingApiError";
  }
}

/**
 * True when a list read says that the gateway cannot hold Slack pairings at all:
 * the Slack extension is absent, Slack is not running, or the gateway has no multi-user sign-in.
 * Any other failure, also another 404, is a real error.
 */
export function isSlackPairingUnavailable(error: unknown): boolean {
  if (!(error instanceof PairingApiError)) return false;
  return (error.status === 404 && error.code === "extension_disabled")
    || (error.status === 503 && error.code === "slack_unavailable")
    || (error.status === 409 && error.code === "multi_user_required");
}

/** The error of a failed pairing call. A fixed text per case, never the body of a remote answer. */
async function pairingFailure(response: Response, fallback: string, gateway: GatewayName | undefined): Promise<PairingApiError> {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error : undefined;
  const fail = (message: string) => new PairingApiError(message, response.status, code);
  if (code === "multi_user_required") return fail(gateway === undefined ? "This gateway has no multi-user sign-in, so it cannot hold Slack pairings." : "The remote gateway has no multi-user sign-in, so it cannot hold Slack pairings.");
  if (code === "gateway_offline") return fail("The remote gateway is offline.");
  if (code === "slack_unavailable") return fail("Slack is not available on that gateway.");
  if (gateway !== undefined && (response.status === 401 || response.status === 403)) return fail("The remote gateway refused this action.");
  return fail(fallback);
}

export async function fetchSlackPairings(gateway?: GatewayName): Promise<SlackPairing[]> {
  const response = await fetch(gatewayApiPath(gateway, `${API_BASE}/slack/pairings`));
  if (!response.ok) throw await pairingFailure(response, "Failed to load Slack pairings", gateway);
  const data = (await response.json()) as { pairings: SlackPairing[] };
  return data.pairings;
}

export async function unpairSlackAccount(pairing: SlackPairing, gateway?: GatewayName): Promise<void> {
  const response = await fetch(
    gatewayApiPath(gateway, `${API_BASE}/slack/pairings/${encodeURIComponent(pairing.workspaceId)}/${encodeURIComponent(pairing.slackUserId)}`),
    { method: "DELETE" },
  );
  if (!response.ok) throw await pairingFailure(response, "Failed to remove Slack pairing", gateway);
}

export type SurfaceLink = {
  id: string;
  surface: "threadit" | "mattermost";
  scope: string;
  externalId: string;
  username: string;
  linkedAt: number;
};

/**
 * True when a linked gateway cannot hold Threadit and Mattermost links: the extension is off, the gateway has no
 * multi-user sign-in, or it has no surface-links route (a plain 404 with no error code).
 */
export function isSurfaceLinkUnavailable(error: unknown): boolean {
  if (!(error instanceof PairingApiError)) return false;
  return (error.status === 404 && (error.code === "extension_disabled" || error.code === undefined))
    || (error.status === 409 && error.code === "multi_user_required");
}

/** The error of a failed surface-link call. A fixed text per case, never the body of a remote answer. */
async function surfaceLinkFailure(response: Response, fallback: string, gateway: GatewayName | undefined): Promise<PairingApiError> {
  const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error : undefined;
  const fail = (message: string) => new PairingApiError(message, response.status, code);
  if (gateway === undefined) return fail(fallback);
  if (code === "gateway_offline") return fail("The remote gateway is offline.");
  if (response.status === 401 || response.status === 403) return fail("The remote gateway refused this action.");
  return fail(fallback);
}

export async function fetchSurfaceLinks(gateway?: GatewayName): Promise<SurfaceLink[]> {
  const response = await fetch(gatewayApiPath(gateway, `${API_BASE}/surface-links`), { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw await surfaceLinkFailure(response, "Failed to load linked accounts", gateway);
  const data = (await response.json()) as { links: SurfaceLink[] };
  return data.links;
}

export async function unlinkSurfaceAccount(id: string, gateway?: GatewayName): Promise<void> {
  const response = await fetch(gatewayApiPath(gateway, `${API_BASE}/surface-links/${encodeURIComponent(id)}`), {
    method: "DELETE",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw await surfaceLinkFailure(response, "Failed to unlink account", gateway);
}
