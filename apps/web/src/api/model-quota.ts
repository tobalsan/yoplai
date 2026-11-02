import { API_BASE, apiFetch as fetch } from "./core";

type QuotaWindow = { usedPercent: number; resetAt: number };
export type QuotaLogin = {
  provider: string;
  accountRef: string;
  plan?: string;
  source: string | null;
  updatedAt: number | null;
  stale: boolean;
  error: string | null;
  fiveHour: QuotaWindow | null;
  weekly: QuotaWindow | null;
  weeklyPace: number | null;
  fiveHourState: "ok" | "exhausted" | "absent" | "unknown";
};
export type ModelQuota = { generatedAt: number; pollingEnabled: boolean; logins: QuotaLogin[] };

export async function fetchModelQuota(signal?: AbortSignal): Promise<ModelQuota> {
  const res = await fetch(`${API_BASE}/admin/model-quota`, { signal });
  if (res.status === 403) throw new Error("Only the superadmin can view model quota.");
  if (!res.ok) throw new Error("Unable to load quota.");
  return res.json() as Promise<ModelQuota>;
}
