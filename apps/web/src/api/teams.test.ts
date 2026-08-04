import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addTeamMember,
  fetchTeamAgents,
  fetchTeamMembers,
  removeForkFromTeam,
  removeTeamMember,
  setForkTeams,
} from "./teams";

type FetchResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

describe("teams membership api client", () => {
  const fetchMock = vi.fn<() => Promise<FetchResponse>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches team members from the global route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        teamId: "team-1",
        members: [{ id: "user-1", name: "User One", email: "u1@example.com" }],
      }),
    });

    const members = await fetchTeamMembers("team-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team-1/members", {
      credentials: "include",
    });
    expect(members).toEqual([
      { id: "user-1", name: "User One", email: "u1@example.com" },
    ]);
  });

  it("adds a member via the admin route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        teamId: "team-1",
        members: [{ id: "user-1", name: "User One", email: "u1@example.com" }],
      }),
    });

    const result = await addTeamMember("team-1", "user-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/teams/team-1/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1" }),
      credentials: "include",
    });
    expect(result).toEqual([
      { id: "user-1", name: "User One", email: "u1@example.com" },
    ]);
  });

  it("removes a member via the admin route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ teamId: "team-1", members: [] }),
    });

    const result = await removeTeamMember("team-1", "user-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/teams/team-1/members/user-1",
      { method: "DELETE", credentials: "include" }
    );
    expect(result).toEqual([]);
  });

  it("lists a team's agents from the global route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        teamId: "team-1",
        forks: [{ sourcePoolId: "scribe", forkAgentId: "scribe" }],
      }),
    });

    const forks = await fetchTeamAgents("team-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/teams/team-1/agents", {
      credentials: "include",
    });
    expect(forks).toEqual([
      { sourcePoolId: "scribe", forkAgentId: "scribe" },
    ]);
  });

  it("sets explicit teams via the admin route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ fork: { sourcePoolId: "scribe", teamId: "team-1" } }),
    });

    await setForkTeams("scribe", { mode: "list", teamIds: ["team-1"] });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/forks/scribe/teams", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "list", teamIds: ["team-1"] }),
      credentials: "include",
    });
  });

  it("sets all teams via the admin route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ fork: { sourcePoolId: "scribe", teamId: "team-2" } }),
    });

    await setForkTeams("scribe", { mode: "all" });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/forks/scribe/teams", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "all" }),
      credentials: "include",
    });
  });

  it("removes an explicit team link via the team-scoped admin route", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ fork: { sourcePoolId: "scribe", teamId: null } }),
    });

    await removeForkFromTeam("scribe", "team-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/teams/team-1/agents/scribe", {
      method: "DELETE",
      credentials: "include",
    });
  });
});
