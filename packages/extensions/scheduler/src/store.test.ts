import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, ScheduleJob } from "@yoplai/shared";
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
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
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
});
