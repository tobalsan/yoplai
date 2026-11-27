import { API_BASE, apiFetch } from "./core";
import type { DurableThread } from "./durable";
import type { FullHistoryMessage } from "./types";

type LegacyChat = {
  agentId: string;
  sessionId: string;
  title: string;
  archived: boolean;
  messages: FullHistoryMessage[];
};

function legacyChatUrl(agentId: string, sessionId: string) {
  return `${API_BASE}/agents/${encodeURIComponent(agentId)}/legacy-sessions/${encodeURIComponent(sessionId)}`;
}

export async function fetchLegacyChat(agentId: string, sessionId: string, signal: AbortSignal): Promise<LegacyChat | null> {
  const response = await apiFetch(legacyChatUrl(agentId, sessionId), { signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not load older chat.");
  return response.json();
}

export async function continueLegacyChat(agentId: string, sessionId: string, signal: AbortSignal): Promise<DurableThread> {
  const response = await apiFetch(legacyChatUrl(agentId, sessionId) + "/continue", { method: "POST", signal });
  if (!response.ok) throw new Error("Could not continue older chat.");
  return response.json();
}
