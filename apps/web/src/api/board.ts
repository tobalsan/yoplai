import type { SubagentRun } from "@yoplai/shared/types";
import type {
  AreaSummary,
  BoardActivityResponse,
  BoardProject,
  BoardProjectsResponse,
  ProjectLifecycleCounts,
  TaskboardItemResponse,
  TaskboardResponse,
} from "./types";
import { API_BASE, apiFetch as fetch } from "./core";

// Taskboard API functions
export type TaskboardResult =
  | { ok: true; data: TaskboardResponse }
  | { ok: false; error: string };

export async function fetchTaskboard(): Promise<TaskboardResult> {
  const res = await fetch(`${API_BASE}/taskboard`);
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to fetch taskboard" }));
    return { ok: false, error: data.error ?? "Failed to fetch taskboard" };
  }
  const data = await res.json();
  return { ok: true, data };
}

export type TaskboardItemResult =
  | { ok: true; data: TaskboardItemResponse }
  | { ok: false; error: string };

export async function fetchTaskboardItem(
  type: "todo" | "project",
  id: string,
  companion?: string
): Promise<TaskboardItemResult> {
  const url = companion
    ? `${API_BASE}/taskboard/${type}/${id}?companion=${encodeURIComponent(companion)}`
    : `${API_BASE}/taskboard/${type}/${id}`;
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to fetch item" }));
    return { ok: false, error: data.error ?? "Failed to fetch item" };
  }
  const data = await res.json();
  return { ok: true, data };
}

export async function fetchBoardProjects(
  includeDone = false
): Promise<BoardProjectsResponse> {
  const url = includeDone
    ? `${API_BASE}/board/projects?include=done`
    : `${API_BASE}/board/projects`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch board projects");
  const data = (await res.json()) as {
    items?: BoardProject[];
    lifecycleCounts?: Partial<ProjectLifecycleCounts>;
  };
  const projects = data.items ?? [];
  const fallbackCounts: ProjectLifecycleCounts = {
    triage: 0,
    shaping: 0,
    active: 0,
    ready_to_merge: 0,
    done: 0,
    cancelled: 0,
    archived: 0,
  };
  for (const project of projects) {
    fallbackCounts[project.lifecycleStatus] += 1;
  }
  return {
    projects,
    lifecycleCounts: {
      ...fallbackCounts,
      ...data.lifecycleCounts,
    },
  };
}

export type MoveBoardProjectResult =
  | { ok: true; status: string; previousStatus: string }
  | { ok: false; error: string; code: string };

export async function moveBoardProject(
  projectId: string,
  status: string
): Promise<MoveBoardProjectResult> {
  const res = await fetch(
    `${API_BASE}/board/projects/${encodeURIComponent(projectId)}/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      ok: false,
      error: typeof data.error === "string" ? data.error : "Move failed",
      code: typeof data.code === "string" ? data.code : "unknown",
    };
  }
  return {
    ok: true,
    status: typeof data.status === "string" ? data.status : status,
    previousStatus:
      typeof data.previousStatus === "string" ? data.previousStatus : "",
  };
}

export async function fetchAreaSummaries(): Promise<AreaSummary[]> {
  const res = await fetch(`${API_BASE}/board/areas`);
  if (!res.ok) throw new Error("Failed to fetch area summaries");
  const data = (await res.json()) as { items?: AreaSummary[] };
  return data.items ?? [];
}

export async function toggleAreaHidden(
  areaId: string,
  hidden: boolean,
): Promise<void> {
  const res = await fetch(`${API_BASE}/board/areas/${encodeURIComponent(areaId)}/hidden`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden }),
  });
  if (!res.ok) throw new Error("Failed to update area visibility");
}

export async function updateAreaLoop(
  areaId: string,
  date: string,
  body: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/board/areas/${encodeURIComponent(areaId)}/loop`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, body }),
  });
  if (!res.ok) throw new Error("Failed to update area loop");
}

export async function fetchBoardActivity(opts?: {
  projectId?: string;
  limit?: number;
}): Promise<BoardActivityResponse> {
  const params = new URLSearchParams();
  if (opts?.projectId) params.set("projectId", opts.projectId);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await fetch(`${API_BASE}/board/activity${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch board activity");
  return res.json();
}

// ── Board agents (live runs view) ────────────────────────────────────────────

export type BoardAgentsResponse = {
  runs: SubagentRun[];
};

export async function fetchBoardAgents(): Promise<BoardAgentsResponse> {
  const res = await fetch(`${API_BASE}/board/agents`);
  if (!res.ok) throw new Error("Failed to fetch board agents");
  return res.json() as Promise<BoardAgentsResponse>;
}

export type KillBoardAgentResult =
  | { ok: true; runId: string; status: string }
  | { ok: false; error: string };

export async function killBoardAgent(
  runId: string
): Promise<KillBoardAgentResult> {
  const res = await fetch(
    `${API_BASE}/board/agents/${encodeURIComponent(runId)}/kill`,
    { method: "POST" }
  );
  if (!res.ok) {
    const data = await res
      .json()
      .catch(() => ({ error: "Failed to kill agent run" }));
    return {
      ok: false,
      error: (data as { error?: string }).error ?? "Failed to kill agent run",
    };
  }
  return res.json() as Promise<KillBoardAgentResult>;
}
