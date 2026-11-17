import { API_BASE, apiFetch } from "./core";
import type { FullHistoryMessage } from "./types";

export type ChatShare = { shared: boolean; token?: string };
export type SharedChatData = { agentId: string; agentName: string; title: string; messages: FullHistoryMessage[] };

async function request<T>(path: string, method = "GET"): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await apiFetch(`${API_BASE}${path}`, { method, signal: controller.signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Could not load sharing. Try again.");
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Sharing took too long. Try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function chatShare(agentId: string, sessionId: string, method: "GET" | "PUT" | "DELETE" = "GET") {
  return request<ChatShare>(`/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/share`, method);
}

export function fetchSharedChat(token: string) {
  return request<SharedChatData>(`/shared-chats/${encodeURIComponent(token)}`);
}
