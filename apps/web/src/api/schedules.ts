import type { ScheduleAlert, ScheduleJob as StoredScheduleJob, ScheduleRun, ScheduleRunTrace } from "@yoplai/shared/types";
import { API_BASE, apiFetch } from "./core";
import { gatewayApiPath, type GatewayName } from "./gateway";

export type ScheduleJob = StoredScheduleJob & { createdByDisplayName?: string; ownerDisplayName?: string; state?: { runningForMs?: number } };

export async function fetchScheduleAlerts(gateway?: GatewayName): Promise<ScheduleAlert[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(gatewayApiPath(gateway, `${API_BASE}/schedule-alerts`), { signal: controller.signal });
    if (!res.ok) throw Object.assign(new Error("Failed to load schedule alerts."), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchScheduleRunTrace(agentId: string, jobId: string, runId: string, gateway?: GatewayName): Promise<ScheduleRunTrace> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(
      gatewayApiPath(gateway, `${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/trace`),
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

export async function fetchScheduleRuns(agentId: string, jobId: string, gateway?: GatewayName): Promise<ScheduleRun[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(
      gatewayApiPath(gateway, `${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}/runs`),
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

export async function fetchSchedules(agentId: string, gateway?: GatewayName): Promise<ScheduleJob[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(gatewayApiPath(gateway, `${API_BASE}/schedules?agent=${encodeURIComponent(agentId)}`), { signal: controller.signal });
    if (!res.ok) throw new Error("Failed to fetch scheduled jobs");
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Loading scheduled jobs timed out. Try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const OWNER_REQUIRES_USER_MESSAGE = "Owner credentials need a signed-in user. This gateway did not confirm one for you.";

export async function updateSchedule(
  agentId: string,
  jobId: string,
  patch: { credentialMode?: "owner" | "team"; enabled?: boolean },
  gateway?: GatewayName
): Promise<ScheduleJob> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await apiFetch(gatewayApiPath(gateway, `${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      signal: controller.signal,
    });
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}));
      if (body.error === "team_requires_admin") throw new Error("Only admins can pause or resume Team jobs.");
      // The gateway sends a fixed safe message for this refusal.
      if (body.error === "owner_requires_user") throw new Error(OWNER_REQUIRES_USER_MESSAGE);
    }
    if (!res.ok) throw new Error("Failed to update scheduled job");
    return await res.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Updating scheduled job timed out. Try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function deleteSchedule(agentId: string, jobId: string, gateway?: GatewayName): Promise<void> {
  const res = await apiFetch(gatewayApiPath(gateway, `${API_BASE}/schedules/${encodeURIComponent(agentId)}/${encodeURIComponent(jobId)}`), {
    method: "DELETE",
  });
  if (res.status === 403 && (await res.json().catch(() => ({}))).error === "team_requires_admin") {
    throw new Error("Only admins can delete Team jobs.");
  }
  if (!res.ok) throw new Error("Failed to delete scheduled job");
}
