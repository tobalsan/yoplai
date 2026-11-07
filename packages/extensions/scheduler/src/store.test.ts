import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ScheduleJob, ScheduleRun } from "@yoplai/shared";
import { PerAgentScheduleStore } from "./store.js";

function agent(id: string, workspace: string): AgentConfig {
  return {
    id,
    name: id,
    workspace,
    workspaceDir: workspace,
    model: { provider: "test", model: "test" },
    queueMode: "queue",
  };
}

describe("PerAgentScheduleStore", () => {
  let tmpDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function run(id: string, jobId = "job-1"): ScheduleRun {
    return {
      id, jobId, agentId: "alpha", firedAt: "2026-10-15T10:00:00.000Z",
      startedAt: "2026-10-15T10:00:00.000Z", status: "running",
      runKind: "woke_agent", prompt: "Digest", storageOwnerId: null,
    };
  }

  it("atomically replaces each run without losing concurrent sibling runs", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-runs-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace);
    const first = run("first");
    const second = run("second");
    await Promise.all([store.saveRun(first), store.saveRun(second)]);
    await store.saveRun({ ...first, status: "ok", finishedAt: "2026-10-15T10:01:00.000Z", outputPath: "cron/output/result.md" });
    expect(await store.listRuns("alpha", "job-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "first", status: "ok", outputPath: "cron/output/result.md" }), second,
    ]));
    expect(await fs.readdir(path.join(a.workspace, "cron/runs/job-1"))).toEqual(["first.json", "second.json"]);
    await store.deleteRun("alpha", "job-1", "first");
    expect(await store.listRuns("alpha", "job-1")).toEqual([second]);
    expect(await store.listRuns("alpha", "missing")).toEqual([]);
  });

  it("reconciles running records even for deleted jobs and preserves terminal records", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-runs-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace);
    const finished = { ...run("finished"), status: "ok" as const, finishedAt: "2026-10-15T10:01:00.000Z" };
    await store.saveRun(run("orphan", "deleted-job"));
    await store.saveRun(finished);
    await store.reconcileRunningRuns();
    expect(await store.listRuns("alpha", "deleted-job")).toEqual([
      expect.objectContaining({ id: "orphan", status: "interrupted", finishedAt: expect.any(String) }),
    ]);
    expect(await store.listRuns("alpha", "job-1")).toEqual([finished]);
  });

  it.each(["agent", "job", "run"])("continues reconciliation after an unreadable or unwritable %s", async (failure) => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-runs-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    const b = agent("beta", path.join(tmpDir, "beta"));
    const warn = vi.fn();
    const store = new PerAgentScheduleStore([a, b], (candidate) => candidate.workspace, tmpDir, warn);
    await store.saveRun(run("blocked"));
    await store.saveRun({ ...run("healthy"), agentId: "beta" });
    const error = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    if (failure === "agent") vi.spyOn(fs, "readdir").mockRejectedValueOnce(error);
    if (failure === "job") vi.spyOn(store, "listRuns").mockRejectedValueOnce(error);
    if (failure === "run") vi.spyOn(store, "saveRun").mockRejectedValueOnce(error);
    await store.reconcileRunningRuns();
    expect(warn).toHaveBeenCalled();
    expect(await store.listRuns("alpha", "job-1")).toEqual([expect.objectContaining({ id: "blocked", status: "running" })]);
    expect(await store.listRuns("beta", "job-1")).toEqual([expect.objectContaining({ id: "healthy", status: "interrupted" })]);
  });

  it("loads union and synthesizes agentId", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    const b = agent("beta", path.join(tmpDir, "beta"));
    await fs.mkdir(path.join(a.workspace, "cron"), { recursive: true });
    await fs.mkdir(path.join(b.workspace, "cron"), { recursive: true });
    const job = {
      id: "same-id",
      name: "Digest",
      enabled: true,
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: { message: "Run" },
    };
    await fs.writeFile(
      path.join(a.workspace, "cron/jobs.json"),
      JSON.stringify({ version: 1, jobs: [job] })
    );
    await fs.writeFile(
      path.join(b.workspace, "cron/jobs.json"),
      JSON.stringify({ version: 1, jobs: [job] })
    );

    const store = new PerAgentScheduleStore([a, b], (candidate) => candidate.workspace);
    const loaded = await store.load();

    expect(loaded.jobs.map((loadedJob) => `${loadedJob.agentId}/${loadedJob.id}`)).toEqual([
      "alpha/same-id",
      "beta/same-id",
    ]);
  });

  it("warns and treats malformed jobs file as empty", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    await fs.mkdir(path.join(a.workspace, "cron"), { recursive: true });
    await fs.writeFile(path.join(a.workspace, "cron/jobs.json"), "not json");
    const warn = vi.fn();

    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace, tmpDir, warn);
    const loaded = await store.load();

    expect(loaded.jobs).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("skips only the invalid job and keeps its siblings", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    await fs.mkdir(path.join(a.workspace, "cron"), { recursive: true });
    await fs.writeFile(
      path.join(a.workspace, "cron/jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "good",
            name: "Digest",
            schedule: { cron: "0 8 * * *", tz: "UTC" },
            payload: { message: "Run" },
          },
          // Legacy job written before payload.message had to be non-empty.
          {
            id: "legacy",
            name: "Empty",
            schedule: { cron: "0 9 * * *", tz: "UTC" },
            payload: { message: "" },
          },
        ],
      })
    );
    const warn = vi.fn();

    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace, tmpDir, warn);
    const loaded = await store.load();

    expect(loaded.jobs.map((job) => job.id)).toEqual(["good"]);
    expect(warn).toHaveBeenCalled();
  });

  it("loads job model overrides", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    await fs.mkdir(path.join(a.workspace, "cron"), { recursive: true });
    await fs.writeFile(
      path.join(a.workspace, "cron/jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            name: "Digest",
            enabled: true,
            schedule: { cron: "0 8 * * *", tz: "UTC" },
            model: { provider: "anthropic", model: "claude-sonnet-4" },
            payload: { message: "Run" },
          },
        ],
      })
    );

    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace);
    const loaded = await store.load();

    expect(loaded.jobs[0]?.model).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
  });

  it("loads job reasoning overrides", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    await fs.mkdir(path.join(a.workspace, "cron"), { recursive: true });
    await fs.writeFile(
      path.join(a.workspace, "cron/jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            name: "Digest",
            enabled: true,
            schedule: { cron: "0 8 * * *", tz: "UTC" },
            reasoning: "high",
            payload: { message: "Run" },
          },
        ],
      })
    );

    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace);
    const loaded = await store.load();

    expect(loaded.jobs[0]?.reasoning).toBe("high");
  });

  it("rejects partial job model overrides", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    await fs.mkdir(path.join(a.workspace, "cron"), { recursive: true });
    await fs.writeFile(
      path.join(a.workspace, "cron/jobs.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "job-1",
            name: "Digest",
            enabled: true,
            schedule: { cron: "0 8 * * *", tz: "UTC" },
            model: { provider: "anthropic" },
            payload: { message: "Run" },
          },
        ],
      })
    );
    const warn = vi.fn();

    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace, tmpDir, warn);
    const loaded = await store.load();

    expect(loaded.jobs).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("roundtrips refusal counts without runtime state and loads legacy jobs", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace);
    const job: ScheduleJob & { state: { lastError: string } } = {
      id: "counted", agentId: "alpha", name: "Calendar", enabled: true,
      schedule: { cron: "* * * * *", tz: "UTC" }, payload: { message: "Sync" },
      credentialRefusals: 2, state: { lastError: "runtime only" },
    };
    const legacy = { ...job };
    delete legacy.credentialRefusals;
    await store.saveAgentJobs("alpha", [job, { ...legacy, id: "legacy" }]);
    const persisted = JSON.parse(await fs.readFile(path.join(a.workspace, "cron/jobs.json"), "utf8"));
    expect(persisted.jobs[0]).toMatchObject({ credentialRefusals: 2 });
    expect(persisted.jobs[0]).not.toHaveProperty("state");
    const loaded = await store.load();
    expect(loaded.jobs[0]?.credentialRefusals).toBe(2);
    expect(loaded.jobs[1]?.credentialRefusals).toBeUndefined();
  });

  it("writes only target agent jobs", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    const b = agent("beta", path.join(tmpDir, "beta"));
    const store = new PerAgentScheduleStore([a, b], (candidate) => candidate.workspace, tmpDir);
    const job: ScheduleJob = {
      id: "job-1",
      name: "Digest",
      agentId: "alpha",
      enabled: true,
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      payload: { message: "Run" },
    };

    await store.saveAgentJobs("alpha", [job]);

    const alphaRaw = await fs.readFile(path.join(a.workspace, "cron/jobs.json"), "utf8");
    expect(JSON.parse(alphaRaw).jobs[0].agentId).toBeUndefined();
    await expect(fs.stat(path.join(b.workspace, "cron/jobs.json"))).rejects.toThrow();
  });

  it("preserves reasoning across an unrelated save", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-scheduler-store-"));
    const a = agent("alpha", path.join(tmpDir, "alpha"));
    const store = new PerAgentScheduleStore([a], (candidate) => candidate.workspace, tmpDir);
    const job: ScheduleJob = {
      id: "job-1",
      name: "Digest",
      agentId: "alpha",
      enabled: true,
      schedule: { cron: "0 8 * * *", tz: "UTC" },
      reasoning: "high",
      payload: { message: "Run" },
    };

    await store.saveAgentJobs("alpha", [job]);

    const alphaRaw = await fs.readFile(path.join(a.workspace, "cron/jobs.json"), "utf8");
    expect(JSON.parse(alphaRaw).jobs[0].reasoning).toBe("high");
  });
});
