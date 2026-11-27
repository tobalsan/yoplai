import type { AgentMemory } from "@yoplai/shared/types";
import { API_BASE, apiFetch } from "./core";

export type DurableThread = {
  id: string;
  title: string;
  preview: string;
  createdAt: number;
  lastActivityAt: number;
  closed: boolean;
  generation: number;
  dashboardId?: string;
  forkedFrom?: string;
};

async function request<T>(agentId: string, path: string, body?: object, timeout = 15_000): Promise<T> {
  const response = await apiFetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}${path}`, {
    signal: AbortSignal.timeout(timeout),
    ...(body && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(typeof error?.error === "string" ? error.error : "The request failed. Try again.");
  }
  return response.json();
}

export const fetchThreads = (agentId: string) => request<DurableThread[]>(agentId, "/threads");
export const startThread = (agentId: string, messageId?: string) => request<DurableThread>(agentId, "/threads", messageId ? { messageId } : {});
export const closeThread = (agentId: string, { id, generation }: DurableThread) =>
  request<DurableThread>(agentId, `/threads/${encodeURIComponent(id)}/close`, { generation });
export const reopenThread = (agentId: string, id: string) =>
  request<DurableThread>(agentId, `/threads/${encodeURIComponent(id)}/reopen`, {});
export const sendThreadMessage = (agentId: string, threadId: string, message: string, clientSendId: string) =>
  request<unknown>(agentId, "/messages", { sessionId: "thread:" + threadId, clientSendId, message }, 5 * 60_000);
export const fetchMemory = (agentId: string) => request<AgentMemory>(agentId, "/memory");
