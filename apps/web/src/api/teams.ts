import { gatewayApiPath, type GatewayName } from "./gateway";

export type Team = {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  allUsers: boolean;
  private: boolean;
  memberCount: number;
  /** True when the caller may edit this team and its members/agents. */
  canManage?: boolean;
  createdBy: string;
  createdAt: string;
};

export type TeamInput = {
  name: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  private?: boolean;
};

export type TeamMemberProfile = { id: string; name: string | null; email: string | null; image?: string | null };
export type TeamlessUser = TeamMemberProfile & { approved: boolean; role: string };

export type TeamMembersResponse = {
  teamId: string;
  allUsers: boolean;
  members: TeamMemberProfile[];
  // The latent roster from before the team switched to All users; present
  // (possibly empty) only when `allUsers` is true.
  savedMembers?: TeamMemberProfile[];
};

export type DeleteTeamResult = {
  deleted: boolean;
  teamlessUsers: string[];
  teamlessAgents: string[];
};

export type DeleteTeamPreview = { teamlessUsers: string[] };

// An agent's access record and current team links.
export type AgentFork = {
  sourcePoolId: string;
  forkAgentId: string;
  teamId: string | null;
  createdBy: string;
  createdAt: string;
  assignedBy: string | null;
  assignedAt: string | null;
  public: boolean;
  assignment: { mode: "list"; teamIds: string[] };
};

async function request<T>(path: string, init?: RequestInit, gateway?: GatewayName): Promise<T> {
  const res = await globalThis.fetch(gatewayApiPath(gateway, path), {
    ...init,
    credentials: "include",
  });
  if (!res.ok) {
    const error = await res
      .json()
      .catch(() => ({ error: `Request failed (${res.status})` }));
    throw new Error(
      typeof error?.error === "string"
        ? error.error
        : `Request failed (${res.status})`
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export async function fetchTeams(gateway?: GatewayName): Promise<Team[]> {
  const data = await request<{ teams: Team[] }>("/api/teams", undefined, gateway);
  return data.teams;
}

export async function createTeam(input: TeamInput): Promise<Team> {
  const data = await request<{ team: Team }>("/api/admin/teams", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return data.team;
}

export async function updateTeam(
  id: string,
  input: Partial<TeamInput>
): Promise<Team> {
  const data = await request<{ team: Team }>(
    `/api/admin/teams/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }
  );
  return data.team;
}

export async function deleteTeam(id: string): Promise<DeleteTeamResult> {
  return request<DeleteTeamResult>(
    `/api/admin/teams/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

export async function fetchDeleteTeamPreview(
  id: string
): Promise<DeleteTeamPreview> {
  return request<DeleteTeamPreview>(
    `/api/admin/teams/${encodeURIComponent(id)}/delete-preview`
  );
}

// Any authenticated user can read a team's members (global visibility).
export async function fetchTeamMembers(
  teamId: string
): Promise<TeamMembersResponse> {
  return request<TeamMembersResponse>(
    `/api/teams/${encodeURIComponent(teamId)}/members`
  );
}

export async function setTeamMembers(
  teamId: string,
  membership: { mode: "all" } | { mode: "list"; userIds: string[] }
): Promise<TeamMembersResponse> {
  return request<TeamMembersResponse>(
    `/api/admin/teams/${encodeURIComponent(teamId)}/members`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(membership),
    }
  );
}

export async function fetchTeamlessUsers(): Promise<TeamlessUser[]> {
  const data = await request<{ users: TeamlessUser[] }>("/api/admin/users/no-team");
  return data.users;
}

export async function addTeamMember(teamId: string, userId: string): Promise<TeamMembersResponse> {
  return request<TeamMembersResponse>(
    `/api/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
    { method: "POST" }
  );
}

// Admin-only: remove a user from a team.
export async function removeTeamMember(
  teamId: string,
  userId: string
): Promise<TeamMembersResponse> {
  return request<TeamMembersResponse>(
    `/api/admin/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" }
  );
}

// Admin-only: agent access records.
export async function fetchForks(gateway?: GatewayName): Promise<AgentFork[]> {
  const data = await request<{ forks: AgentFork[] }>("/api/admin/forks", undefined, gateway);
  return data.forks;
}

// Any authenticated user can list a team's agents (global visibility).
export async function fetchTeamAgents(teamId: string): Promise<AgentFork[]> {
  const data = await request<{ teamId: string; forks: AgentFork[] }>(
    `/api/teams/${encodeURIComponent(teamId)}/agents`
  );
  return data.forks;
}

/** Replace an agent's explicit team set. */
export async function setForkTeams(
  agentId: string,
  assignment: AgentFork["assignment"],
  gateway?: GatewayName
): Promise<AgentFork | null> {
  const data = await request<{ fork: AgentFork | null }>(
    `/api/admin/forks/${encodeURIComponent(agentId)}/teams`,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(assignment) },
    gateway
  );
  return data.fork;
}

export async function setForkVisibility(agentId: string, isPublic: boolean, gateway?: GatewayName): Promise<AgentFork> {
  const data = await request<{ fork: AgentFork }>(
    `/api/admin/forks/${encodeURIComponent(agentId)}/visibility`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ public: isPublic }) },
    gateway
  );
  return data.fork;
}

export async function removeForkFromTeam(agentId: string, teamId: string): Promise<AgentFork> {
  const data = await request<{ fork: AgentFork }>(
    `/api/admin/teams/${encodeURIComponent(teamId)}/agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE" }
  );
  return data.fork;
}

// Admin-only: move an existing fork to a different team.
