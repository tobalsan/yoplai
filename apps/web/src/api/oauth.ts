import { apiFetch as fetch } from "./core";

export type OAuthConnectionState = "connected" | "needs_reconnect" | "disconnected";

export type OAuthStatus = {
  state?: OAuthConnectionState;
  connected: boolean;
  provider: string;
  account?: string;
  scopes?: string[];
  canConfigureTeam?: boolean;
};

export type OAuthScope = "personal" | "team";

/** Host OAuth status for one scope; a non-OK response reads as disconnected. */
export async function fetchOAuthStatus(
  agentId: string,
  provider: string,
  scope: OAuthScope
): Promise<OAuthStatus> {
  const res = await fetch(
    `/api/oauth/${encodeURIComponent(provider)}/status?agent=${encodeURIComponent(agentId)}&scope=${scope}`
  );
  return res.ok ? ((await res.json()) as OAuthStatus) : { connected: false, provider };
}

/** Host OAuth disconnect; like the original card call, the HTTP status is not checked. */
export async function disconnectOAuth(
  agentId: string,
  provider: string,
  scope: OAuthScope
): Promise<void> {
  await fetch(
    `/api/oauth/${encodeURIComponent(provider)}/disconnect?agent=${encodeURIComponent(agentId)}&scope=${scope}`,
    { method: "POST" }
  );
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
