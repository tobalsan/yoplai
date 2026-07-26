import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCapabilities,
  fetchProjects,
  fetchProjectBranches,
  fetchProjectChanges,
  fetchProjectSpace,
  integrateSpaceEntries,
  rebaseSpaceOntoMain,
  integrateProjectSpace,
  fixSpaceRebaseConflict,
  mergeSpaceIntoMain,
  skipSpaceEntries,
  commitProjectChanges,
  archiveRuntimeSubagent,
  deleteRuntimeSubagent,
  fetchAllSubagents,
  fetchRuntimeSubagents,
  fetchRuntimeSubagentLogs,
  fetchSubagents,
  fetchSubagentLogs,
  spawnSubagent,
  interruptSubagent,
  archiveSubagent,
  unarchiveSubagent,
  createArea,
  updateArea,
} from "./client";

type FetchResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

const fetchMock = vi.fn<() => Promise<FetchResponse>>();

function expectFetchCall(url: string, init?: RequestInit) {
  expect(fetchMock).toHaveBeenCalledWith(url, {
    ...init,
    credentials: "include",
  });
}

describe("api client (projects/subagents)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches subagents list", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ slug: "main", status: "running" }] }),
    });

    const res = await fetchSubagents("PRO-1");

    expectFetchCall("/api/projects/PRO-1/subagents");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items[0]?.slug).toBe("main");
    }
  });

  it("fetches all projects without area filter", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "PRO-1" }],
    });

    const res = await fetchProjects();

    expectFetchCall("/api/projects");
    expect(res.length).toBe(1);
  });

  it("fetches capabilities", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 2,
        extensions: { projects: true },
        agents: ["main"],
        multiUser: false,
        agentFab: false,
      }),
    });

    const res = await fetchCapabilities();

    expectFetchCall("/api/capabilities");
    expect(res.extensions.projects).toBe(true);
  });

  it("fetches projects with area filter", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ id: "PRO-2" }],
    });

    const res = await fetchProjects("yoplai");

    expectFetchCall("/api/projects?area=yoplai");
    expect(res[0]?.id).toBe("PRO-2");
  });

  it("updates area with patch payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "yoplai", title: "Yoplai Updated" }),
    });

    const res = await updateArea("yoplai", {
      title: "Yoplai Updated",
      color: "#123456",
    });

    expectFetchCall("/api/areas/yoplai", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Yoplai Updated", color: "#123456" }),
    });
    expect(res.title).toBe("Yoplai Updated");
  });

  it("creates area with payload", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "ops", title: "Ops", color: "#123456" }),
    });

    const res = await createArea({
      id: "ops",
      title: "Ops",
      color: "#123456",
      repo: "~/code/ops",
    });

    expectFetchCall("/api/areas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "ops",
        title: "Ops",
        color: "#123456",
        repo: "~/code/ops",
      }),
    });
    expect(res.id).toBe("ops");
  });

  it("fetches subagents list with archived", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ slug: "main", status: "running", archived: true }],
      }),
    });

    const res = await fetchSubagents("PRO-1", true);

    expectFetchCall("/api/projects/PRO-1/subagents?includeArchived=true");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.items[0]?.archived).toBe(true);
    }
  });

  it("fetches all subagents", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ projectId: "PRO-1", slug: "main", status: "idle" }],
      }),
    });

    const res = await fetchAllSubagents();

    expectFetchCall("/api/subagents");
    expect(res.items[0]?.projectId).toBe("PRO-1");
  });

  it("fetches runtime subagent logs", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        cursor: 42,
        events: [{ type: "stdout", text: "hi" }],
      }),
    });

    const res = await fetchRuntimeSubagentLogs("sar_1", 12);

    expectFetchCall("/api/subagents/sar_1/logs?since=12");
    expect(res.cursor).toBe(42);
  });

  it("fetches runtime subagents with cwd filters", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await fetchRuntimeSubagents({
      cwd: "/tmp/worktrees/worker",
      includeArchived: true,
    });

    expectFetchCall(
      "/api/subagents?includeArchived=1&cwd=%2Ftmp%2Fworktrees%2Fworker"
    );
  });

  it("fetches runtime subagents with project and slice filters", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    });

    await fetchRuntimeSubagents({
      projectId: "PRO-1",
      sliceId: "PRO-1-S01",
    });

    expectFetchCall("/api/subagents?projectId=PRO-1&sliceId=PRO-1-S01");
  });

  it("archives runtime subagent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "sar_1", archived: true }),
    });

    const res = await archiveRuntimeSubagent("sar_1");

    expectFetchCall("/api/subagents/sar_1/archive", { method: "POST" });
    expect(res.ok).toBe(true);
  });

  it("deletes runtime subagent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });

    const res = await deleteRuntimeSubagent("sar_1");

    expectFetchCall("/api/subagents/sar_1", { method: "DELETE" });
    expect(res.ok).toBe(true);
  });

  it("fetches subagent logs", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        cursor: 10,
        events: [{ type: "stdout", text: "hi" }],
      }),
    });

    const res = await fetchSubagentLogs("PRO-1", "main", 5);

    expectFetchCall("/api/projects/PRO-1/subagents/main/logs?since=5");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.cursor).toBe(10);
      expect(res.data.events[0]?.type).toBe("stdout");
    }
  });

  it("fetches project branches", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ branches: ["main", "dev"] }),
    });

    const res = await fetchProjectBranches("PRO-9");

    expectFetchCall("/api/projects/PRO-9/branches");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.branches).toContain("main");
    }
  });

  it("fetches project changes", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        branch: "feature/x",
        baseBranch: "main",
        files: [{ path: "src/a.ts", status: "modified", staged: false }],
        diff: "diff --git a/src/a.ts b/src/a.ts",
        stats: { filesChanged: 1, insertions: 2, deletions: 1 },
      }),
    });

    const res = await fetchProjectChanges("PRO-9");

    expectFetchCall("/api/projects/PRO-9/changes");
    expect(res.branch).toBe("feature/x");
    expect(res.stats.filesChanged).toBe(1);
  });

  it("fetches project space", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        projectId: "PRO-9",
        branch: "space/PRO-9",
        worktreePath: "/tmp/space",
        baseBranch: "main",
        integrationBlocked: false,
        queue: [],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    });

    const res = await fetchProjectSpace("PRO-9");

    expectFetchCall("/api/projects/PRO-9/space");
    expect(res.branch).toBe("space/PRO-9");
  });

  it("posts project space integrate", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        projectId: "PRO-9",
        branch: "space/PRO-9",
        worktreePath: "/tmp/space",
        baseBranch: "main",
        integrationBlocked: false,
        queue: [],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    });

    const res = await integrateProjectSpace("PRO-9");

    expectFetchCall("/api/projects/PRO-9/space/integrate", {
      method: "POST",
    });
    expect(res.projectId).toBe("PRO-9");
  });

  it("posts project space rebase", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        projectId: "PRO-9",
        branch: "space/PRO-9",
        worktreePath: "/tmp/space",
        baseBranch: "main",
        integrationBlocked: false,
        queue: [],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    });

    const res = await rebaseSpaceOntoMain("PRO-9");

    expectFetchCall("/api/projects/PRO-9/space/rebase", {
      method: "POST",
    });
    expect(res.projectId).toBe("PRO-9");
  });

  it("posts fix space rebase conflict", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ slug: "space-rebase-reviewer" }),
    });

    const res = await fixSpaceRebaseConflict("PRO-9");

    expectFetchCall("/api/projects/PRO-9/space/rebase/fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.slug).toBe("space-rebase-reviewer");
  });

  it("throws project space integrate error from API response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "integration blocked" }),
    });

    await expect(integrateProjectSpace("PRO-9")).rejects.toThrow(
      "integration blocked"
    );
  });

  it("skips selected project space entries", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        projectId: "PRO-9",
        branch: "space/PRO-9",
        worktreePath: "/tmp/space",
        baseBranch: "main",
        integrationBlocked: false,
        queue: [],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    });

    const res = await skipSpaceEntries("PRO-9", ["alpha:1", "alpha:2"]);

    expectFetchCall("/api/projects/PRO-9/space/entries/skip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: ["alpha:1", "alpha:2"] }),
    });
    expect(res.projectId).toBe("PRO-9");
  });

  it("integrates selected project space entries", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: 1,
        projectId: "PRO-9",
        branch: "space/PRO-9",
        worktreePath: "/tmp/space",
        baseBranch: "main",
        integrationBlocked: false,
        queue: [],
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    });

    const res = await integrateSpaceEntries("PRO-9", ["alpha:1", "alpha:2"]);

    expectFetchCall("/api/projects/PRO-9/space/entries/integrate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryIds: ["alpha:1", "alpha:2"] }),
    });
    expect(res.projectId).toBe("PRO-9");
  });

  it("posts merge space into main with cleanup enabled by default", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        merge: {
          afterSha: "abc1234",
          cleanup: {
            workerWorktreesRemoved: 3,
            workerBranchesDeleted: 3,
            spaceWorktreeRemoved: true,
            spaceBranchDeleted: true,
          },
        },
      }),
    });

    const res = await mergeSpaceIntoMain("PRO-9");

    expectFetchCall("/api/projects/PRO-9/space/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cleanup: true }),
    });
    expect(res.mergedCommitSha).toBe("abc1234");
    expect(res.cleanupSummary).toContain("worktrees removed: 3");
  });

  it("posts merge space into main with cleanup disabled", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        merge: {
          afterSha: "def5678",
        },
      }),
    });

    const result = await mergeSpaceIntoMain("PRO-9", { cleanup: false });

    expectFetchCall("/api/projects/PRO-9/space/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cleanup: false }),
    });
    expect(result.mergedCommitSha).toBe("def5678");
  });

  it("commits project changes", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, sha: "abc123", message: "test commit" }),
    });

    const res = await commitProjectChanges("PRO-9", "test commit");

    expectFetchCall("/api/projects/PRO-9/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "test commit" }),
    });
    expect(res.ok).toBe(true);
    expect(res.sha).toBe("abc123");
  });

  it("spawns subagent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ slug: "alpha" }),
    });

    const res = await spawnSubagent("PRO-2", {
      slug: "alpha",
      cli: "claude",
      name: "Worker A",
      prompt: "hello",
      model: "sonnet",
      reasoningEffort: "medium",
      mode: "worktree",
      baseBranch: "main",
      resume: true,
    });

    expectFetchCall("/api/projects/PRO-2/subagents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "alpha",
        cli: "claude",
        name: "Worker A",
        prompt: "hello",
        model: "sonnet",
        reasoningEffort: "medium",
        mode: "worktree",
        baseBranch: "main",
        resume: true,
      }),
    });
    expect(res.ok).toBe(true);
  });

  it("interrupts subagent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ slug: "main" }),
    });

    const res = await interruptSubagent("PRO-3", "main");

    expectFetchCall("/api/projects/PRO-3/subagents/main/interrupt", {
      method: "POST",
    });
    expect(res.ok).toBe(true);
  });

  it("archives subagent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ slug: "main", archived: true }),
    });

    const res = await archiveSubagent("PRO-3", "main");

    expectFetchCall("/api/projects/PRO-3/subagents/main/archive", {
      method: "POST",
    });
    expect(res.ok).toBe(true);
  });

  it("unarchives subagent", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ slug: "main", archived: false }),
    });

    const res = await unarchiveSubagent("PRO-3", "main");

    expectFetchCall("/api/projects/PRO-3/subagents/main/unarchive", {
      method: "POST",
    });
    expect(res.ok).toBe(true);
  });
});
