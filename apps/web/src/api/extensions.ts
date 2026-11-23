import { API_BASE, apiFetch as fetch } from "./core";
import { fetchOAuthStatus } from "./oauth";
import { gatewayApiPath, type GatewayName } from "./gateway";

type ExtensionConfigTier = "auto-form" | "bespoke-route" | "toggle-only";

export type ExtensionCatalogEntry = {
  id: string;
  displayName: string;
  description: string;
  builtIn: boolean;
  enabled: boolean;
  configured: boolean;
  missingConfig: string[];
  configurable: boolean;
  managedAtRoot: boolean;
  teamOnly?: boolean;
  configJsonSchema: Record<string, unknown> | null;
  requiredSecrets: string[];
  /** Present in multi-user mode; contains field names only. */
  personalSecretFields?: string[];
  /** Requester's own setting overrides (non-secret fields only). */
  personalConfigValues?: Record<string, unknown>;
  canConfigureTeam?: boolean;
  advancedConfigFields: string[];
  configValues: Record<string, unknown>;
  /**
   * Agent-resolved bespoke config route (`:agentId` substituted) when the
   * extension self-registers one, else null. The hub redirects here on enable
   * for `bespoke-route` extensions.
   */
  configRoutePath: string | null;
  oauth: {
    provider: string;
    /** Scopes for the whole team connection. */
    scopes: string[];
    /** Scopes for the requester's own connection, with their personal settings applied. */
    personalScopes?: string[];
  } | null;
  /** OAuth extensions: requester's personal or the team connection exists. */
  oauthConnected?: boolean;
  tier: ExtensionConfigTier;
  /** Optional data: URI for the extension's icon, when the catalog provides one. */
  iconDataUri?: string;
};

/**
 * Client route to an extension's details page for one agent, where clicking an
 * extension card on the Edit-Agent hub navigates; it shows settings inline.
 */
export function detailsPath(agentId: string, extensionId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(
    extensionId
  )}`;
}

// Staff and same-team members may read the extension catalog for an agent
// (built-in + runtime scanned), including enabled state and config metadata.
export async function fetchAgentExtensions(
  agentId: string,
  gateway?: GatewayName
): Promise<ExtensionCatalogEntry[]> {
  const res = await fetch(
    gatewayApiPath(gateway, `${API_BASE}/agents/${encodeURIComponent(agentId)}/extensions`)
  );
  if (!res.ok) throw new Error("Failed to fetch extension catalog");
  const data = (await res.json()) as { extensions: ExtensionCatalogEntry[] };
  return data.extensions;
}

export type ExtensionConfigPatch = {
  credentialScope?: "personal" | "team";
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

// Staff and same-team members may update an agent's per-extension config
// (enable/disable, config fields, secrets). Returns the refreshed catalog.
// Unset an extension's whole-team credentials (admin); settings stay. Returns the refreshed catalog.
export async function removeTeamExtensionCredentials(
  agentId: string,
  extensionId: string,
  gateway?: GatewayName
): Promise<ExtensionCatalogEntry[]> {
  const res = await fetch(
    gatewayApiPath(gateway, `${API_BASE}/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(extensionId)}/credentials`),
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error("Failed to remove team credentials");
  const data = (await res.json()) as { extensions: ExtensionCatalogEntry[] };
  return data.extensions;
}

export async function patchAgentExtension(
  agentId: string,
  extensionId: string,
  patch: ExtensionConfigPatch,
  gateway?: GatewayName
): Promise<ExtensionCatalogEntry[]> {
  const res = await fetch(
    gatewayApiPath(gateway, `${API_BASE}/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(
      extensionId
    )}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) throw new Error("Failed to update extension");
  const data = (await res.json()) as { extensions: ExtensionCatalogEntry[] };
  return data.extensions;
}

export type OAuthScopeState = "connected" | "needs_reconnect" | "disconnected";

/** OAuth connection state for one scope (the signed-in user's own grant, or the team's). */
export async function fetchOAuthScopeState(
  agentId: string,
  provider: string,
  scope: "personal" | "team",
  gateway?: GatewayName
): Promise<OAuthScopeState> {
  const data = await fetchOAuthStatus(agentId, provider, scope, gateway);
  return data.state ?? (data.connected ? "connected" : "disconnected");
}
