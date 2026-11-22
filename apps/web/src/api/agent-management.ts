import { API_BASE, apiFetch } from "./core";

export type ManagementModel = { provider: string; model: string; name: string; source: string; default: boolean; ready: boolean };
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentConfigDetail = {
  id: string; name: string; description: string; role: string; avatar: string | null;
  model: { provider: string; model: string }; reasoning: ThinkingLevel | null; instructions: string; disabledSkills: string[];
};
export type AgentConfigPatch = Partial<{
  name: string; description: string; role: string; avatar: number;
  model: { provider: string; model: string }; reasoning: ThinkingLevel | null; instructions: string;
  skills: { disabled: string[] };
}>;
/** `gateway` skills are always on. `agent` skills (workspace) are on by default. `user` skills are off by default. */
export type ConfigSkill = { level: "gateway" | "agent" | "user"; id?: string; name: string; description: string; enabled: boolean; locked: boolean };
export type ConfigSkills = { canEditAgent: boolean; skills: ConfigSkill[] };

export class AgentManagementError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code.replaceAll("_", " "));
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(`${API_BASE}/agent-management${path}`, {
    ...init,
    ...(init?.body ? { headers: { "content-type": "application/json" } } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new AgentManagementError(response.status, body.error ?? "request_failed", body.message);
  }
  return response.json();
}

const agentPath = (id: string, suffix = "") => `/agents/${encodeURIComponent(id)}${suffix}`;
export const fetchManagementModels = async () => (await request<{ models: ManagementModel[] }>("/models")).models;
/** Quick create: the gateway picks the model and an avatar when the body leaves them out. */
export const createManagedAgent = (body: { name: string; description?: string }) => request<{ id: string }>("/agents", { method: "POST", body: JSON.stringify(body) });
export const fetchAgentConfig = (id: string) => request<AgentConfigDetail>(agentPath(id));
export const saveAgentConfig = (id: string, patch: AgentConfigPatch) => request<{ ok: true }>(agentPath(id), { method: "PATCH", body: JSON.stringify(patch) });
export const fetchAgentConfigSkills = (id: string) => request<ConfigSkills>(agentPath(id, "/skills"));
/** The requester's own user skills that apply to this agent. Any user with access to the agent can set them. */
export const saveUserSkills = (id: string, enabled: string[]) => request<{ ok: true }>(agentPath(id, "/user-skills"), { method: "PUT", body: JSON.stringify({ enabled }) });
