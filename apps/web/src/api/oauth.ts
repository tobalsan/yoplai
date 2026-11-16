import { apiFetch as fetch } from "./core";
import { gatewayApiPath, type GatewayName } from "./gateway";

export type OAuthConnectionState = "connected" | "needs_reconnect" | "disconnected";

export type OAuthStatus = {
  state?: OAuthConnectionState;
  connected: boolean;
  provider: string;
  account?: string;
  scopes?: string[];
  /** Time of the stored grant, when the gateway reports it. */
  connectedAt?: number;
  canConfigureTeam?: boolean;
};

export type OAuthScope = "personal" | "team";

/** Host OAuth status for one scope; a non-OK response reads as disconnected. */
export async function fetchOAuthStatus(
  agentId: string,
  provider: string,
  scope: OAuthScope,
  gateway?: GatewayName
): Promise<OAuthStatus> {
  const res = await fetch(
    gatewayApiPath(gateway, `/api/oauth/${encodeURIComponent(provider)}/status?agent=${encodeURIComponent(agentId)}&scope=${scope}`)
  );
  return res.ok ? ((await res.json()) as OAuthStatus) : { connected: false, provider };
}

/**
 * Status that keeps a failed read apart from a disconnected grant. A remote
 * flow must never read a refusal or an offline gateway as "not connected".
 */
export async function readOAuthStatus(
  agentId: string,
  provider: string,
  scope: OAuthScope,
  gateway: GatewayName,
  signal?: AbortSignal
): Promise<OAuthStatus> {
  const res = await fetch(
    gatewayApiPath(gateway, `/api/oauth/${encodeURIComponent(provider)}/status?agent=${encodeURIComponent(agentId)}&scope=${scope}`),
    { signal }
  );
  if (!res.ok) throw new Error(`OAuth status failed (${res.status})`);
  return (await res.json()) as OAuthStatus;
}

/** Host OAuth disconnect; like the original card call, the HTTP status is not checked. */
export async function disconnectOAuth(
  agentId: string,
  provider: string,
  scope: OAuthScope,
  gateway?: GatewayName
): Promise<void> {
  const res = await fetch(
    gatewayApiPath(gateway, `/api/oauth/${encodeURIComponent(provider)}/disconnect?agent=${encodeURIComponent(agentId)}&scope=${scope}`),
    { method: "POST" }
  );
  // A remote refusal must show. The local call keeps its unchecked status.
  if (gateway !== undefined && !res.ok) throw new Error(await refusalMessage(res, "Failed to disconnect."));
}

/** The local error text of a relay refusal, or the fallback. */
export async function refusalMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const code = typeof body?.error === "string" ? body.error : undefined;
  if (code === "gateway_offline") return "The remote gateway is offline.";
  if (res.status === 401 || res.status === 403) return "The remote gateway refused this action.";
  return fallback;
}

export type OAuthStartTarget =
  | { kind: "core"; provider: string; scopes?: string[] }
  | { kind: "mcp"; server: string };

/**
 * Starts a remote grant through the local relay. The remote keeps the bearer,
 * the state, and the callback. The response holds only the provider URL.
 */
export async function startRemoteOAuth(
  gateway: string,
  agentId: string,
  scope: OAuthScope,
  target: OAuthStartTarget,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch("/api/relay/oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gateway, agentId, scope, ...target }),
    signal,
  });
  if (!res.ok) throw new Error(await refusalMessage(res, "Failed to start the connection."));
  const body = (await res.json().catch(() => undefined)) as { authorizationUrl?: unknown } | undefined;
  if (typeof body?.authorizationUrl !== "string" || !body.authorizationUrl) throw new Error("The remote gateway returned no authorization address.");
  return body.authorizationUrl;
}

/** Authorize URL for host OAuth. `scopes` are the provider scopes to request. */
export function oauthAuthorizeUrl(
  agentId: string,
  provider: string,
  scope: OAuthScope,
  scopes: string[],
  returnTo?: string
): string {
  const query = new URLSearchParams({ agent: agentId });
  if (scopes.length) query.set("scopes", scopes.join(","));
  query.set("scope", scope);
  if (returnTo) query.set("returnTo", returnTo);
  return `/api/oauth/${encodeURIComponent(provider)}/authorize?${query.toString()}`;
}
