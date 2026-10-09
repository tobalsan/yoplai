import type { ScheduleJob as StoredScheduleJob } from "@yoplai/shared/types";
import { API_BASE, apiFetch } from "./core";

export type ScheduleJob = StoredScheduleJob & { createdByDisplayName?: string };

export async function fetchSchedules(agentId: string): Promise<ScheduleJob[]> {
  const res = await apiFetch(`${API_BASE}/schedules?agent=${encodeURIComponent(agentId)}`);
  if (!res.ok) throw new Error("Failed to fetch scheduled jobs");
  return res.json();
}

export async function updateSchedule(
  agentId: string,
  jobId: string,
  credentialMode: "owner" | "team"
): Promise<ScheduleJob> {
  const res = await apiFetch(`${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credentialMode }),
  });
  if (!res.ok) throw new Error("Failed to update scheduled job");
  return res.json();
}
