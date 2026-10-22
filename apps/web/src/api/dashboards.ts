import { API_BASE, apiFetch } from "./core";

export type DashboardShare =
  | { kind: "user"; id: string; mode: "read" | "write" }
  | { kind: "all"; mode: "read" | "write" };

export type DashboardRow = {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  slug: string;
  link: string;
  params: string[];
  linksTo: string[];
  updatedAt: string | null;
  publishedAt: string | null;
  legacy: boolean;
  isOwner: boolean;
  shared: boolean;
  ownerName: string | null;
  mode: "read" | "write";
  shares?: DashboardShare[];
  pinned?: boolean;
};

export type DashboardRecipient = { id: string; name: string; email: string; image?: string | null };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${API_BASE}/dashboards${path}`, { signal: AbortSignal.timeout(15_000), ...init });
  if (!response.ok) throw new Error(`Dashboard request failed (${response.status})`);
  return response.json();
}

export function fetchDashboards() {
  return request<{ owned: DashboardRow[]; shared: DashboardRow[] }>("");
}

export function setDashboardPinned(id: string, pinned: boolean) {
  return request<{ ok: true; pinned: boolean }>(`/${encodeURIComponent(id)}/pin`, { method: pinned ? "PUT" : "DELETE" });
}

export function fetchDashboardRecipients() {
  return request<{ users: DashboardRecipient[] }>("/recipients");
}

export function saveDashboardShares(id: string, shares: DashboardShare[]) {
  return request<{ dashboard: DashboardRow }>(`/${encodeURIComponent(id)}/sharing`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ shares }),
  });
}

export function claimDashboard(id: string) {
  return request<{ dashboard: DashboardRow }>(`/${encodeURIComponent(id)}/claim`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
}

export function deleteDashboard(id: string) {
  return request<{ ok: true }>(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}
