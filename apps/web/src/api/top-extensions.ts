import { API_BASE, apiFetch as fetch } from "./core";

export type TopExtensions = { extensions: string[]; mcp: string[] };

export type TopExtensionCandidates = {
  extensions: { id: string; displayName: string; description: string; iconDataUri?: string }[];
  mcp: { url: string; displayName: string; agentCount: number; iconUrl?: string }[];
};

export type AdminTopExtensions = TopExtensions & { candidates: TopExtensionCandidates };

export const EMPTY_TOP_EXTENSIONS: TopExtensions = { extensions: [], mcp: [] };

/** Admin-flagged Top extension ids and normalized MCP URLs; any signed-in user may read them. */
export async function fetchTopExtensions(): Promise<TopExtensions> {
  const res = await fetch(`${API_BASE}/top-extensions`);
  if (!res.ok) throw new Error("Failed to fetch top extensions");
  return res.json() as Promise<TopExtensions>;
}

/** Same lists plus every flaggable candidate; superadmin only. */
export async function fetchAdminTopExtensions(): Promise<AdminTopExtensions> {
  const res = await fetch(`${API_BASE}/admin/top-extensions`);
  if (res.status === 403) throw new Error("Only the superadmin can manage top extensions.");
  if (!res.ok) throw new Error("Failed to fetch top extensions");
  return res.json() as Promise<AdminTopExtensions>;
}

export async function saveTopExtensions(next: TopExtensions): Promise<TopExtensions> {
  const res = await fetch(`${API_BASE}/admin/top-extensions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(next),
  });
  if (res.status === 403) throw new Error("Only the superadmin can manage top extensions.");
  if (!res.ok) throw new Error("Failed to save top extensions");
  return res.json() as Promise<TopExtensions>;
}
