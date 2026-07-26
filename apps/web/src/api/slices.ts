import type {
  CreateSlicePayload,
  ProjectThreadEntry,
  SliceListResponse,
  SliceRecord,
  UpdateSlicePayload,
} from "./types";
import { API_BASE, apiFetch as fetch } from "./core";

// ── Slice API ──────────────────────────────────────────────────────────────

export async function fetchSlices(projectId: string): Promise<SliceRecord[]> {
  const res = await fetch(`${API_BASE}/projects/${encodeURIComponent(projectId)}/slices`);
  if (!res.ok) throw new Error("Failed to fetch slices");
  const data = (await res.json()) as SliceListResponse;
  return data.slices;
}

export async function fetchSlice(
  projectId: string,
  sliceId: string
): Promise<SliceRecord> {
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/slices/${encodeURIComponent(sliceId)}`
  );
  if (!res.ok) throw new Error("Failed to fetch slice");
  return res.json();
}

export async function createSlice(
  projectId: string,
  payload: CreateSlicePayload
): Promise<SliceRecord> {
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/slices`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to create slice" }));
    throw new Error((data as { error?: string }).error ?? "Failed to create slice");
  }
  return res.json();
}

export async function updateSlice(
  projectId: string,
  sliceId: string,
  payload: UpdateSlicePayload
): Promise<SliceRecord> {
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/slices/${encodeURIComponent(sliceId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Failed to update slice" }));
    throw new Error((data as { error?: string }).error ?? "Failed to update slice");
  }
  return res.json();
}

export async function addSliceComment(
  projectId: string,
  sliceId: string,
  message: string,
  author = "Yoplai"
): Promise<ProjectThreadEntry> {
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/slices/${encodeURIComponent(sliceId)}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author, message }),
    }
  );
  if (!res.ok) throw new Error("Failed to add comment");
  return res.json();
}
