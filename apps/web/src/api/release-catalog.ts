import type { ReleaseCatalogRow, ReleaseCatalogView } from "@yoplai/shared";
import { apiFetch } from "./core";
import { gatewayApiPath, type GatewayName } from "./gateway";
import { refusalMessage } from "./oauth";

const path = "/api/admin/extension-catalog";

export async function fetchReleaseCatalog(gateway: GatewayName, refresh = false): Promise<ReleaseCatalogView | undefined> {
  const response = await apiFetch(gatewayApiPath(gateway, refresh ? `${path}/refresh` : path), { method: refresh ? "POST" : "GET" });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(await refusalMessage(response, "Could not read the catalog."));
  return response.json();
}

export async function changeReleaseCatalog(gateway: GatewayName, id: string, remove: boolean): Promise<ReleaseCatalogRow | undefined> {
  const target = `${path}/${encodeURIComponent(id)}${remove ? "" : "/install"}`;
  const response = await apiFetch(gatewayApiPath(gateway, target), { method: remove ? "DELETE" : "POST" });
  if (!response.ok) {
    const body: { error?: unknown } | undefined = await response.json().catch(() => undefined);
    throw new Error(typeof body?.error === "string" && body.error.trim() ? body.error : "The extension operation failed.");
  }
  if (!remove) return response.json();
}

export const releaseCatalogChanged = "yoplai:release-catalog-changed";
