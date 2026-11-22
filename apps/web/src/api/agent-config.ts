import { API_BASE, apiFetch as fetch } from "./core";

export type AgentModelOption = { provider: string; model: string };

export type AgentConfigDetail = {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  model: AgentModelOption | null;
  reasoning: string | null;
  queueMode: "queue" | "interrupt";
  globalSkills: boolean;
  instructions: string;
  skills: { name: string; description: string }[];
  canEdit: boolean;
};

export type AgentConfigPatch = {
  name?: string;
  description?: string | null;
  avatar?: string;
  model?: AgentModelOption;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  queueMode?: "queue" | "interrupt";
  globalSkills?: boolean;
  instructions?: string;
};

async function readError(res: Response): Promise<Error> {
  const data = (await res.json().catch(() => null)) as {
    error?: string;
    message?: string;
  } | null;
  const error = new Error(data?.message ?? data?.error ?? "Request failed") as Error & {
    status?: number;
    code?: string;
  };
  error.status = res.status;
  error.code = data?.error;
  return error;
}

export async function fetchAgentModels(): Promise<AgentModelOption[]> {
  const res = await fetch(`${API_BASE}/agents/models`);
  if (!res.ok) throw await readError(res);
  const data = (await res.json()) as { models?: AgentModelOption[] };
  return data.models ?? [];
}

export async function createAgent(input: {
  requestId: string;
  name: string;
  purpose?: string;
  avatar: number;
  model: AgentModelOption;
}): Promise<{ id: string; instructions: string }> {
  const res = await fetch(`${API_BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function fetchAgentConfig(
  agentId: string
): Promise<AgentConfigDetail> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/config`
  );
  if (!res.ok) throw await readError(res);
  return res.json();
}

export async function saveAgentConfig(
  agentId: string,
  patch: AgentConfigPatch
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/config`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
  if (!res.ok) throw await readError(res);
}
