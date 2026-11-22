import { API_BASE, apiFetch } from "./core";

export type AgentConfigAccess = { create: boolean; edit: boolean };

export type AgentConfig = {
  id: string;
  name: string;
  description: string;
  globalSkills: boolean;
  /** Present when the requester may see the model and instructions. */
  model?: { provider: string | null; model: string };
  instructions?: string;
  access: AgentConfigAccess;
};

export type AgentConfigPatch = Partial<{
  name: string;
  description: string;
  model: { provider: string; model: string };
  instructions: string;
  globalSkills: boolean;
}>;

export type NewAgent = {
  requestId: string;
  name: string;
  purpose?: string;
  avatar: number;
  model: { provider: string; model: string };
};

export class AgentConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

async function failure(response: Response): Promise<AgentConfigError> {
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  return new AgentConfigError(body?.error ?? "request_failed", body?.message ?? "The request failed. Try again.");
}

export async function fetchAgentConfig(agentId: string): Promise<AgentConfig> {
  const response = await apiFetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/config`);
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function saveAgentConfig(agentId: string, patch: AgentConfigPatch): Promise<AgentConfig> {
  const response = await apiFetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export async function createAgent(body: NewAgent): Promise<{ id: string }> {
  const response = await apiFetch(`${API_BASE}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}
