import type { SubagentRun, SubagentRunStatus } from "@yoplai/shared/types";
import type {
  FileAttachment,
  RuntimeSubagentListResponse,
  SubagentGlobalListResponse,
  SubagentListItem,
  SubagentListResponse,
  SubagentLogsResponse,
} from "./types";
import { API_BASE, apiFetch as fetch } from "./core";

export async function fetchAllSubagents(): Promise<SubagentGlobalListResponse> {
  const res = await fetch(`${API_BASE}/subagents`);
  if (!res.ok) throw new Error("Failed to fetch subagents");
  return res.json();
}

export async function fetchRuntimeSubagents(filters?: {
  parent?: string;
  status?: SubagentRunStatus;
  includeArchived?: boolean;
  cwd?: string;
  projectId?: string;
  sliceId?: string;
}): Promise<RuntimeSubagentListResponse> {
  const params = new URLSearchParams();
  if (filters?.parent) params.set("parent", filters.parent);
  if (filters?.status) params.set("status", filters.status);
  if (filters?.includeArchived) params.set("includeArchived", "1");
  if (filters?.cwd) params.set("cwd", filters.cwd);
  if (filters?.projectId) params.set("projectId", filters.projectId);
  if (filters?.sliceId) params.set("sliceId", filters.sliceId);
  const query = params.toString();
  const res = await fetch(`${API_BASE}/subagents${query ? `?${query}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch subagents");
  return res.json();
}

export async function fetchRuntimeSubagentLogs(
  runId: string,
  since: number
): Promise<SubagentLogsResponse> {
  const res = await fetch(
    `${API_BASE}/subagents/${encodeURIComponent(runId)}/logs?since=${since}`
  );
  if (!res.ok) throw new Error("Failed to fetch subagent logs");
  return res.json();
}

export type InterruptRuntimeSubagentResult =
  | { ok: true; data: SubagentRun }
  | { ok: false; error: string };

export async function interruptRuntimeSubagent(
  runId: string
): Promise<InterruptRuntimeSubagentResult> {
  const res = await fetch(
    `${API_BASE}/subagents/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to interrupt subagent" }));
    return { ok: false, error: data.error ?? "Failed to interrupt subagent" };
  }
  return { ok: true, data: (await res.json()) as SubagentRun };
}

export type ResumeRuntimeSubagentResult =
  | { ok: true; data: SubagentRun }
  | { ok: false; error: string };

export async function resumeRuntimeSubagent(
  runId: string,
  prompt: string
): Promise<ResumeRuntimeSubagentResult> {
  const res = await fetch(
    `${API_BASE}/subagents/${encodeURIComponent(runId)}/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to resume subagent" }));
    return { ok: false, error: data.error ?? "Failed to resume subagent" };
  }
  return { ok: true, data: (await res.json()) as SubagentRun };
}

export type ArchiveRuntimeSubagentResult =
  | { ok: true; data: SubagentRun }
  | { ok: false; error: string };

export async function archiveRuntimeSubagent(
  runId: string
): Promise<ArchiveRuntimeSubagentResult> {
  const res = await fetch(
    `${API_BASE}/subagents/${encodeURIComponent(runId)}/archive`,
    { method: "POST" }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to archive subagent" }));
    return { ok: false, error: data.error ?? "Failed to archive subagent" };
  }
  return { ok: true, data: (await res.json()) as SubagentRun };
}

export type DeleteRuntimeSubagentResult =
  | { ok: true }
  | { ok: false; error: string };

export async function deleteRuntimeSubagent(
  runId: string
): Promise<DeleteRuntimeSubagentResult> {
  const res = await fetch(
    `${API_BASE}/subagents/${encodeURIComponent(runId)}`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to delete subagent" }));
    return { ok: false, error: data.error ?? "Failed to delete subagent" };
  }
  return { ok: true };
}

export type SubagentListResult =
  | { ok: true; data: SubagentListResponse }
  | { ok: false; error: string };

export async function fetchSubagents(
  projectId: string,
  includeArchived = false
): Promise<SubagentListResult> {
  const query = includeArchived ? "?includeArchived=true" : "";
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents${query}`
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to fetch subagents" }));
    return { ok: false, error: data.error ?? "Failed to fetch subagents" };
  }
  const data = (await res.json()) as SubagentListResponse;
  return { ok: true, data };
}

export type RenameSubagentResult =
  | { ok: true; data: SubagentListItem }
  | { ok: false; error: string };

export async function renameSubagent(
  projectId: string,
  slug: string,
  name: string
): Promise<RenameSubagentResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents/${encodeURIComponent(slug)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to rename subagent" }));
    return { ok: false, error: data.error ?? "Failed to rename subagent" };
  }
  const data = (await res.json()) as SubagentListItem;
  return { ok: true, data };
}

export type SubagentLogsResult =
  | { ok: true; data: SubagentLogsResponse }
  | { ok: false; error: string };

export async function fetchSubagentLogs(
  projectId: string,
  slug: string,
  since: number
): Promise<SubagentLogsResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents/${slug}/logs?since=${since}`
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to fetch logs" }));
    return { ok: false, error: data.error ?? "Failed to fetch logs" };
  }
  const data = (await res.json()) as SubagentLogsResponse;
  return { ok: true, data };
}

export type AgentInfo = { id: string; name: string };
export type SubagentTemplateInfo = {
  name: string;
  description?: string;
  cli: string;
  model: string;
  reasoning: string;
  type: string;
  runMode: string;
};

export async function fetchSpawnOptions(): Promise<{
  agents: AgentInfo[];
  subagentTemplates: SubagentTemplateInfo[];
}> {
  const res = await fetch(`${API_BASE}/config/spawn-options`);
  if (!res.ok) return { agents: [], subagentTemplates: [] };
  return res.json();
}

export type SpawnSubagentInput = {
  slug: string;
  cli: string;
  name?: string;
  prompt: string;
  template?: "lead" | "custom";
  promptRole?: "coordinator" | "worker" | "reviewer" | "legacy";
  includeDefaultPrompt?: boolean;
  includeRoleInstructions?: boolean;
  includePostRun?: boolean;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  mode?: "main-run" | "worktree" | "clone" | "none";
  baseBranch?: string;
  resume?: boolean;
  attachments?: FileAttachment[];
  agentId?: string;
};

export type SpawnSubagentResult =
  | {
      ok: true;
      data: { slug: string; agentId?: string; sessionKey?: string };
    }
  | { ok: false; error: string };

export async function spawnSubagent(
  projectId: string,
  input: SpawnSubagentInput
): Promise<SpawnSubagentResult> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/subagents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to spawn subagent" }));
    return { ok: false, error: data.error ?? "Failed to spawn subagent" };
  }
  const data = (await res.json()) as {
    slug: string;
    agentId?: string;
    sessionKey?: string;
  };
  return { ok: true, data };
}

export type UpdateSubagentInput = {
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
};

export type UpdateSubagentResult =
  | {
      ok: true;
      data: {
        slug: string;
        name?: string;
        model?: string;
        reasoningEffort?: string;
        thinking?: string;
      };
    }
  | { ok: false; error: string };

export async function updateSubagent(
  projectId: string,
  slug: string,
  input: UpdateSubagentInput
): Promise<UpdateSubagentResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents/${slug}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to update subagent" }));
    return { ok: false, error: data.error ?? "Failed to update subagent" };
  }
  const data = (await res.json()) as {
    slug: string;
    name?: string;
    model?: string;
    reasoningEffort?: string;
    thinking?: string;
  };
  return { ok: true, data };
}

export type InterruptSubagentResult =
  | { ok: true; data: { slug: string } }
  | { ok: false; error: string };

export async function interruptSubagent(
  projectId: string,
  slug: string
): Promise<InterruptSubagentResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents/${slug}/interrupt`,
    {
      method: "POST",
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to interrupt subagent" }));
    return { ok: false, error: data.error ?? "Failed to interrupt subagent" };
  }
  const data = (await res.json()) as { slug: string };
  return { ok: true, data };
}

export type KillSubagentResult =
  | { ok: true; data: { slug: string } }
  | { ok: false; error: string };

export async function killSubagent(
  projectId: string,
  slug: string
): Promise<KillSubagentResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents/${slug}/kill`,
    {
      method: "POST",
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to kill subagent" }));
    return { ok: false, error: data.error ?? "Failed to kill subagent" };
  }
  const data = (await res.json()) as { slug: string };
  return { ok: true, data };
}

export type LeadSessionResult =
  | { ok: true; data: { ok: true; agentId: string; sessionKey?: string } }
  | { ok: false; error: string };

export async function removeLeadSession(
  projectId: string,
  agentId: string
): Promise<LeadSessionResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/lead-sessions/${encodeURIComponent(agentId)}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to remove lead session" }));
    return { ok: false, error: data.error ?? "Failed to remove lead session" };
  }
  return { ok: true, data: await res.json() };
}

export async function resetLeadSession(
  projectId: string,
  agentId: string
): Promise<LeadSessionResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/lead-sessions/${encodeURIComponent(agentId)}/reset`,
    { method: "POST" }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to reset lead session" }));
    return { ok: false, error: data.error ?? "Failed to reset lead session" };
  }
  return { ok: true, data: await res.json() };
}

export type ArchiveSubagentResult =
  | { ok: true; data: { slug: string; archived: boolean } }
  | { ok: false; error: string };

export async function archiveSubagent(
  projectId: string,
  slug: string
): Promise<ArchiveSubagentResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents/${slug}/archive`,
    {
      method: "POST",
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to archive subagent" }));
    return { ok: false, error: data.error ?? "Failed to archive subagent" };
  }
  const data = (await res.json()) as { slug: string; archived: boolean };
  return { ok: true, data };
}

export type UnarchiveSubagentResult =
  | { ok: true; data: { slug: string; archived: boolean } }
  | { ok: false; error: string };

export async function unarchiveSubagent(
  projectId: string,
  slug: string
): Promise<UnarchiveSubagentResult> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/subagents/${slug}/unarchive`,
    {
      method: "POST",
    }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to unarchive subagent" }));
    return { ok: false, error: data.error ?? "Failed to unarchive subagent" };
  }
  const data = (await res.json()) as { slug: string; archived: boolean };
  return { ok: true, data };
}
