import { API_BASE, apiFetch as fetch } from "./core";

export type ExtensionConfigTier = "auto-form" | "bespoke-route" | "toggle-only";

export type ExtensionCatalogEntry = {
  id: string;
  displayName: string;
  description: string;
  builtIn: boolean;
  enabled: boolean;
  configurable: boolean;
  configJsonSchema: Record<string, unknown> | null;
  requiredSecrets: string[];
  advancedConfigFields: string[];
  configValues: Record<string, unknown>;
  /**
   * Agent-resolved bespoke config route (`:agentId` substituted) when the
   * extension self-registers one, else null. The hub redirects here on enable
   * for `bespoke-route` extensions.
   */
  configRoutePath: string | null;
  tier: ExtensionConfigTier;
  /** Optional data: URI for the extension's icon, when the catalog provides one. */
  iconDataUri?: string;
};

/**
 * Client route to the schema-driven auto-form for one extension on one agent.
 * The renderer itself lands in ALG-355; the hub links here so enabling an
 * auto-form extension surfaces its config form path today.
 */
export function autoFormPath(agentId: string, extensionId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(
    extensionId
  )}/config`;
}

/**
 * Client route to an extension's read-only details page for one agent.
 * Distinct from `autoFormPath` (no `/config` suffix) — this is where clicking
 * an extension card on the Edit-Agent hub navigates.
 */
export function detailsPath(agentId: string, extensionId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(
    extensionId
  )}`;
}

// Staff and same-team members may read the extension catalog for an agent
// (built-in + runtime scanned), including enabled state and config metadata.
export async function fetchAgentExtensions(
  agentId: string
): Promise<ExtensionCatalogEntry[]> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/extensions`
  );
  if (!res.ok) throw new Error("Failed to fetch extension catalog");
  const data = (await res.json()) as { extensions: ExtensionCatalogEntry[] };
  return data.extensions;
}

// Fetch one accessible extension's catalog entry for an agent (the schema +
// requiredSecrets the auto-form renderer draws from). Returns null when the
// extension id is not present in the agent's catalog.
export async function fetchAgentExtension(
  agentId: string,
  extensionId: string
): Promise<ExtensionCatalogEntry | null> {
  const all = await fetchAgentExtensions(agentId);
  return all.find((entry) => entry.id === extensionId) ?? null;
}

export type ExtensionConfigPatch = {
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
};

// Staff and same-team members may update an agent's per-extension config
// (enable/disable, config fields, secrets). Returns the refreshed catalog.
export async function patchAgentExtension(
  agentId: string,
  extensionId: string,
  patch: ExtensionConfigPatch
): Promise<ExtensionCatalogEntry[]> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/extensions/${encodeURIComponent(
      extensionId
    )}`,
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
