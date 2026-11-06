import { API_BASE, apiFetch } from "./core";

export type ChatProject = { id: string; name: string; instructions?: string; createdAt: number; updatedAt: number };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${API_BASE}/chat-projects${path}`, {
    ...init,
    headers: { "Content-Type": "application/json" },
    signal: init?.signal ?? AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Unable to update projects. Try again.");
  return response.json();
}

export const fetchChatProjects = () => request<{ items: ChatProject[] }>("");
export const fetchChatProject = (id: string) => request<ChatProject>(`/${encodeURIComponent(id)}`);
export const createChatProject = (name: string) => request<ChatProject>("", { method: "POST", body: JSON.stringify({ name }) });
export const draftChatProjectInstructions = (id: string, purpose: string) => request<ChatProject>(`/${encodeURIComponent(id)}/instructions/draft`, { method: "POST", body: JSON.stringify({ purpose }), signal: AbortSignal.timeout(45000) });
export const renameChatProject = (id: string, name: string) => request<ChatProject>(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
export const updateChatProjectInstructions = (id: string, instructions: string) => request<ChatProject>(`/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ instructions }) });
export const deleteChatProject = (id: string) => request<unknown>(`/${encodeURIComponent(id)}`, { method: "DELETE" });

export async function moveChatToProject(agentId: string, sessionId: string, projectId: string | null): Promise<void> {
  const response = await apiFetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Unable to move chat. Try again.");
}

export type ChatProjectFile = { id: string; name: string; size: number; mimeType: string; extracted?: boolean; extractionError?: string; extractionNote?: string };
export const fetchChatProjectFiles = (id: string) => request<{ items: ChatProjectFile[] }>(`/${encodeURIComponent(id)}/files`);
export const deleteChatProjectFile = (id: string, fileId: string) => request<unknown>(`/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}`, { method: "DELETE" });
export async function uploadChatProjectFile(id: string, file: File): Promise<void> {
  const body = new FormData();
  body.append("file", file);
  const response = await apiFetch(`${API_BASE}/chat-projects/${encodeURIComponent(id)}/files`, { method: "POST", body, signal: AbortSignal.timeout(90000) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unable to upload file. Try again." }));
    throw new Error(error.error || "Unable to upload file. Try again.");
  }
}

export type ChatProjectReference = { id: string; title: string; description: string; createdAt: number };
export const fetchChatProjectReferences = (id: string) => request<{ items: ChatProjectReference[] }>(`/${encodeURIComponent(id)}/references`);
export const deleteChatProjectReference = (id: string, referenceId: string) => request<unknown>(`/${encodeURIComponent(id)}/references/${encodeURIComponent(referenceId)}`, { method: "DELETE" });
export const fetchChatProjectNotes = (id: string) => request<{ text: string }>(`/${encodeURIComponent(id)}/notes`);
export const updateChatProjectNotes = (id: string, text: string) => request<{ text: string }>(`/${encodeURIComponent(id)}/notes`, { method: "PUT", body: JSON.stringify({ text }) });
