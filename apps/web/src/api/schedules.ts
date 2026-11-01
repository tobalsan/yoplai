import type { ScheduleJob as StoredScheduleJob, ScheduleRun, ScheduleRunTrace } from "@yoplai/shared/types";
import { API_BASE, apiFetch } from "./core";

export type ScheduleJob = StoredScheduleJob & { createdByDisplayName?: string; ownerDisplayName?: string; state?: { runningForMs?: number } };

export async function fetchScheduleRunTrace(agentId: string, jobId: string, runId: string): Promise<ScheduleRunTrace> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(
      `${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/trace`,
      { signal: controller.signal }
    );
    if (!res.ok) throw new Error("Failed to load run trace.");
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Loading run trace timed out. Try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchScheduleRuns(agentId: string, jobId: string): Promise<ScheduleRun[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(
      `${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}/runs`,
      { signal: controller.signal }
    );
    if (!res.ok) throw new Error("Failed to load run history.");
    const data: { runs: ScheduleRun[] } = await res.json();
    return data.runs;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Loading run history timed out. Try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSchedules(agentId: string): Promise<ScheduleJob[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(`${API_BASE}/schedules?agent=${encodeURIComponent(agentId)}`, { signal: controller.signal });
    if (!res.ok) throw new Error("Failed to fetch scheduled jobs");
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Loading scheduled jobs timed out. Try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function updateSchedule(
  agentId: string,
  jobId: string,
  patch: { credentialMode?: "owner" | "team"; enabled?: boolean }
): Promise<ScheduleJob> {
  const res = await apiFetch(`${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 403 && (await res.json().catch(() => ({}))).error === "team_requires_admin") {
    throw new Error("Only admins can pause or resume Team jobs.");
  }
  if (!res.ok) throw new Error("Failed to update scheduled job");
  return res.json();
}

export async function deleteSchedule(agentId: string, jobId: string): Promise<void> {
  const res = await apiFetch(`${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
  if (res.status === 403 && (await res.json().catch(() => ({}))).error === "team_requires_admin") {
    throw new Error("Only admins can delete Team jobs.");
  }
  if (!res.ok) throw new Error("Failed to delete scheduled job");
}
