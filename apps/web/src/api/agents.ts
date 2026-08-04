import type {
  Agent,
  AgentStatusResponse,
  CapabilitiesResponse,
  FullHistoryMessage,
  SimpleHistoryMessage,
  ThinkLevel,
} from "./types";
import type { Suggestion } from "@yoplai/shared/types";
import { API_BASE, apiFetch as fetch } from "./core";

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
    status: "running" | "done" | "error";
  }>;
};

export type HistoryResponse<T> = {
  messages: T[];
  sessionId?: string;
  thinkingLevel?: ThinkLevel;
  isStreaming?: boolean;
  activeTurn?: ActiveTurn | null;
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

export async function fetchSimpleHistory(
  agentId: string,
  sessionKey: string,
  sessionId?: string
): Promise<HistoryResponse<SimpleHistoryMessage>> {
  const res = await fetch(
    `${API_BASE}/agents/${agentId}/history?${historyQuery("simple", sessionKey, sessionId)}`
  );
  if (!res.ok) return { messages: [] };
  const data = await res.json();
  return {
    messages: data.messages ?? [],
    sessionId: data.sessionId,
    thinkingLevel: data.thinkingLevel,
    isStreaming: data.isStreaming,
    activeTurn: data.activeTurn ?? null,
  };
}

export async function fetchFullHistory(
  agentId: string,
  sessionKey: string,
  sessionId?: string
): Promise<HistoryResponse<FullHistoryMessage>> {
  const res = await fetch(
    `${API_BASE}/agents/${agentId}/history?${historyQuery("full", sessionKey, sessionId)}`
  );
  if (!res.ok) return { messages: [] };
  const data = await res.json();
  return {
    messages: data.messages ?? [],
    sessionId: data.sessionId,
    thinkingLevel: data.thinkingLevel,
    isStreaming: data.isStreaming,
    activeTurn: data.activeTurn ?? null,
  };
}

export async function fetchAgentStatuses(): Promise<AgentStatusResponse> {
  const res = await fetch(`${API_BASE}/agents/status`);
  if (!res.ok) throw new Error("Failed to fetch agent statuses");
  return res.json();
}
