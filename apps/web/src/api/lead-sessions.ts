import type {
  FileAttachment,
  FullHistoryMessage,
  LeadSession,
} from "@yoplai/shared/types";
import { API_BASE, apiFetch as fetch } from "./core";

export type LeadSessionsResponse = {
  items: LeadSession[];
};

export type LeadTranscriptResponse = {
  messages: FullHistoryMessage[];
};

export async function fetchLeadSessions(
  projectId: string,
  options: { archived?: boolean; sliceId?: string } = {}
): Promise<LeadSessionsResponse> {
  const params = new URLSearchParams();
  if (options.archived !== undefined) {
    params.set("archived", String(options.archived));
  }
  if (options.sliceId) params.set("sliceId", options.sliceId);
  const query = params.toString();
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/lead-sessions${
      query ? `?${query}` : ""
    }`
  );
  if (!res.ok) throw new Error("Failed to fetch lead sessions");
  return res.json();
}

export async function createLeadSession(
  projectId: string,
  input: { agentId: string; sliceId?: string }
): Promise<LeadSession> {
  const res = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(projectId)}/lead-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok) throw new Error("Failed to create lead session");
  return res.json();
}

export async function patchLeadSession(
  id: string,
  patch: { title?: string; archived?: boolean }
): Promise<LeadSession> {
  const res = await fetch(`${API_BASE}/lead-sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update lead session");
  return res.json();
}

export async function deleteLeadSession(id: string): Promise<{ ok: true }> {
  const res = await fetch(`${API_BASE}/lead-sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete lead session");
  return res.json();
}

export async function fetchLeadSessionTranscript(
  id: string
): Promise<LeadTranscriptResponse> {
  const res = await fetch(
    `${API_BASE}/lead-sessions/${encodeURIComponent(id)}/transcript`
  );
  if (!res.ok) throw new Error("Failed to fetch lead transcript");
  return res.json();
}

export async function sendLeadSessionMessage(
  id: string,
  input: { content: string; agentId?: string; files?: FileAttachment[] }
): Promise<{ session: LeadSession; result: unknown }> {
  const res = await fetch(
    `${API_BASE}/lead-sessions/${encodeURIComponent(id)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok) throw new Error("Failed to send lead session message");
  return res.json();
}
