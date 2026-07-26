import type {
  ActivityResponse,
  ArchiveProjectResponse,
  Area,
  DeleteProjectResponse,
  ProjectDetail,
  ProjectListItem,
  ProjectThreadEntry,
  ProjectUpdatePayload,
  Task,
  TasksResponse,
  UnarchiveProjectResponse,
} from "./types";
import { API_BASE, apiFetch as fetch } from "./core";

// Projects API functions
export async function fetchProjects(area?: string): Promise<ProjectListItem[]> {
  const params = new URLSearchParams();
  if (typeof area === "string" && area.trim().length > 0) {
    params.set("area", area.trim());
  }
  const query = params.toString();
  const url = query ? `${API_BASE}/projects?${query}` : `${API_BASE}/projects`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch projects");
  return res.json();
}

export async function fetchArchivedProjects(): Promise<ProjectListItem[]> {
  const res = await fetch(`${API_BASE}/projects/archived`);
  if (!res.ok) throw new Error("Failed to fetch archived projects");
  return res.json();
}

export async function fetchAreas(): Promise<Area[]> {
  const res = await fetch(`${API_BASE}/areas`);
  if (!res.ok) throw new Error("Failed to fetch areas");
  return res.json();
}

export async function createArea(payload: Area): Promise<Area> {
  const res = await fetch(`${API_BASE}/areas`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to create area" }));
    throw new Error(data.error ?? "Failed to create area");
  }
  return res.json();
}

export async function updateArea(
  id: string,
  payload: Partial<Area>
): Promise<Area> {
  const res = await fetch(`${API_BASE}/areas/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to update area" }));
    throw new Error(data.error ?? "Failed to update area");
  }
  return res.json();
}

export async function fetchActivity(
  offset = 0,
  limit = 20
): Promise<ActivityResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
  });
  const res = await fetch(`${API_BASE}/activity?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch activity");
  return res.json();
}

export type CreateProjectInput = {
  title: string;
  pitch?: string;
  status?: string;
  area?: string;
  repo?: string;
};

export type CreateProjectResult =
  | { ok: true; data: ProjectDetail }
  | { ok: false; error: string };

export async function createProject(
  input: CreateProjectInput
): Promise<CreateProjectResult> {
  const res = await fetch(`${API_BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to create project" }));
    return { ok: false, error: data.error ?? "Failed to create project" };
  }
  const data = (await res.json()) as ProjectDetail;
  return { ok: true, data };
}

export async function validateProjectRepo(
  repo: string
): Promise<{ valid: boolean }> {
  const res = await fetch(`${API_BASE}/projects/validate-repo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo }),
  });
  if (!res.ok) throw new Error("Failed to validate repo");
  return res.json();
}

export async function fetchProject(id: string): Promise<ProjectDetail> {
  const res = await fetch(`${API_BASE}/projects/${id}`);
  if (!res.ok) throw new Error("Failed to fetch project");
  return res.json();
}

export async function fetchTasks(projectId: string): Promise<TasksResponse> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/tasks`);
  if (!res.ok) throw new Error("Failed to fetch tasks");
  return res.json();
}

export async function updateTask(
  projectId: string,
  order: number,
  patch: { checked?: boolean; status?: Task["status"]; agentId?: string | null }
): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/tasks/${order}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error("Failed to update task");
}

export async function createTask(
  projectId: string,
  input: { title: string; description?: string; status?: Task["status"] }
): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error("Failed to create task");
}

export async function fetchSpec(
  projectId: string
): Promise<{ content: string }> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/spec`);
  if (!res.ok) throw new Error("Failed to fetch spec");
  return res.json();
}

export async function saveSpec(
  projectId: string,
  content: string
): Promise<void> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/spec`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error("Failed to save spec");
}

export async function updateProject(
  id: string,
  payload: ProjectUpdatePayload
): Promise<ProjectDetail> {
  const res = await fetch(`${API_BASE}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to update project" }));
    throw new Error(data.error ?? "Failed to update project");
  }
  return res.json();
}

export type DeleteProjectResult =
  | { ok: true; data: DeleteProjectResponse }
  | { ok: false; error: string };

export async function deleteProject(id: string): Promise<DeleteProjectResult> {
  const res = await fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to delete project" }));
    return { ok: false, error: data.error ?? "Failed to delete project" };
  }
  const data = (await res.json()) as DeleteProjectResponse;
  return { ok: true, data };
}

export type ArchiveProjectResult =
  | { ok: true; data: ArchiveProjectResponse }
  | { ok: false; error: string };

export async function archiveProject(
  id: string
): Promise<ArchiveProjectResult> {
  const res = await fetch(`${API_BASE}/projects/${id}/archive`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to archive project" }));
    return { ok: false, error: data.error ?? "Failed to archive project" };
  }
  const data = (await res.json()) as ArchiveProjectResponse;
  return { ok: true, data };
}

export type UnarchiveProjectResult =
  | { ok: true; data: UnarchiveProjectResponse }
  | { ok: false; error: string };

export async function unarchiveProject(
  id: string
): Promise<UnarchiveProjectResult> {
  const res = await fetch(`${API_BASE}/projects/${id}/unarchive`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to unarchive project" }));
    return { ok: false, error: data.error ?? "Failed to unarchive project" };
  }
  const data = (await res.json()) as UnarchiveProjectResponse;
  return { ok: true, data };
}

export async function addProjectComment(
  projectId: string,
  message: string,
  author = "Yoplai"
): Promise<ProjectThreadEntry> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ author, message }),
  });
  if (!res.ok) throw new Error("Failed to add comment");
  return res.json();
}

export async function updateProjectComment(
  projectId: string,
  index: number,
  body: string
): Promise<ProjectThreadEntry> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/comments/${index}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) throw new Error("Failed to update comment");
  return res.json();
}

export async function deleteProjectComment(
  projectId: string,
  index: number
): Promise<{ index: number }> {
  const res = await fetch(
    `${API_BASE}/projects/${projectId}/comments/${index}`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) throw new Error("Failed to delete comment");
  return res.json();
}

export type StartProjectRunResult =
  | { ok: true; type: "native" | "cli"; slug?: string; runMode?: string }
  | { ok: false; error: string };

export type StartProjectRunInput = {
  customPrompt?: string;
  runAgent?: string;
  template?: "lead" | "custom";
  promptRole?: "coordinator" | "worker" | "reviewer" | "legacy";
  includeDefaultPrompt?: boolean;
  includeRoleInstructions?: boolean;
  includePostRun?: boolean;
  runMode?: string;
  baseBranch?: string;
  slug?: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
};

export async function startProjectRun(
  projectId: string,
  input?: StartProjectRunInput
): Promise<StartProjectRunResult> {
  const res = await fetch(`${API_BASE}/projects/${projectId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
  });
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to start run" }));
    return { ok: false, error: data.error ?? "Failed to start run" };
  }
  return res.json();
}
