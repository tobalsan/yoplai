import type {
  Agent,
  AgentStatusResponse,
  CapabilitiesResponse,
  FullHistoryMessage,
  ThinkLevel,
} from "./types";
import type { Suggestion, WsActiveTurnSnapshot } from "@yoplai/shared/types";
import { API_BASE, apiFetch as fetch } from "./core";
import type { DashboardRow } from "./dashboards";

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch(`${API_BASE}/agents`);
  if (!res.ok) throw new Error("Failed to fetch agents");
  return res.json();
}

export async function fetchPool(): Promise<Agent[]> {
  const res = await fetch(`${API_BASE}/pool`);
  if (!res.ok) throw new Error("Failed to fetch pool");
  return res.json();
}

export function selectDefaultProjectManagerAgent(
  agents: Agent[],
  preferredAgentId?: string | null
): Agent | undefined {
  if (preferredAgentId) {
    const preferred = agents.find((agent) => agent.id === preferredAgentId);
    if (preferred) return preferred;
  }

  return agents.find((agent) => agent.isDefaultProjectManager) ?? agents[0];
}

export async function fetchAgent(agentId: string): Promise<Agent> {
  const res = await fetch(`${API_BASE}/agents/${agentId}`);
  if (!res.ok) throw new Error("Failed to fetch agent");
  return res.json();
}

export type AgentDashboard = DashboardRow;

export async function fetchAgentDashboards(agentId: string): Promise<AgentDashboard[]> {
  const res = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/dashboards`);
  if (!res.ok) throw new Error("Failed to fetch dashboards");
  return res.json();
}

export async function fetchAgentSuggestions(agentId: string): Promise<Suggestion[]> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/suggestions`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchCapabilities(): Promise<CapabilitiesResponse> {
  const res = await fetch(`${API_BASE}/capabilities`);
  if (!res.ok) {
    const error = new Error("Failed to fetch capabilities") as Error & {
      status?: number;
    };
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export type ActiveTurn = {
  userText: string | null;
  userTimestamp: number;
  startedAt: number;
  thinking: string;
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: unknown;
    parentToolCallId?: string;
    status: "running" | "done" | "error";
  }>;
  toolResults?: WsActiveTurnSnapshot["toolResults"];
};

export type HistoryResponse<T> = {
  messages: T[];
  sessionId?: string;
  thinkingLevel?: ThinkLevel;
  isStreaming?: boolean;
  activeTurn?: ActiveTurn | null;
  nextCursor?: string;
  historyOffset?: number;
  activeContextUsage?: { inputTokens: number; model?: string };
};

function historyQuery(
  view: "simple" | "full",
  sessionKey: string,
  sessionId?: string
): string {
  const params = new URLSearchParams({ view });
  if (sessionId) params.set("sessionId", sessionId);
  else params.set("sessionKey", sessionKey);
  return params.toString();
}

export async function fetchFullHistory(
  agentId: string,
  sessionKey: string,
  sessionId?: string,
  page?: { limit: number; before?: string }
): Promise<HistoryResponse<FullHistoryMessage>> {
  const query = new URLSearchParams(historyQuery("full", sessionKey, sessionId));
  if (page) {
    query.set("limit", String(page.limit));
    if (page.before) query.set("before", page.before);
  }
  const res = await fetch(
    `${API_BASE}/agents/${agentId}/history?${query}`
  );
  if (!res.ok) {
    if (page?.before) throw new Error("Failed to fetch history");
    return { messages: [] };
  }
  const data = await res.json();
  return {
    messages: data.messages ?? [],
    sessionId: data.sessionId,
    thinkingLevel: data.thinkingLevel,
    isStreaming: data.isStreaming,
    activeTurn: data.activeTurn ?? null,
    nextCursor: data.nextCursor,
    historyOffset: data.historyOffset,
    activeContextUsage: data.activeContextUsage,
  };
}

export async function fetchAgentStatuses(): Promise<AgentStatusResponse> {
  const res = await fetch(`${API_BASE}/agents/status`);
  if (!res.ok) throw new Error("Failed to fetch agent statuses");
  return res.json();
}

export type AvatarStyles = { default: string; styles: { id: string; label: string }[] };

export async function fetchAvatarStyles(): Promise<AvatarStyles> {
  const res = await fetch(`${API_BASE}/avatars/styles`);
  if (!res.ok) throw new Error("Failed to fetch avatar styles");
  return res.json();
}

/** Generate, save and select a new avatar. Takes up to a couple of minutes. */
export async function generateAgentAvatar(agentId: string, style: string): Promise<{ avatar: string; style: string }> {
  const res = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/avatar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ style }),
  });
  const body = (await res.json().catch(() => ({}))) as { avatar?: string; style?: string; error?: string };
  if (!res.ok || !body.avatar) throw new Error(body.error ?? "Avatar generation failed");
  return { avatar: body.avatar, style: body.style ?? style };
}
