import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateAgentsConfig } from "./agents-migrate.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("agents migrate", () => {
  let tmpDir: string;
  const oldHomeDir = process.env.YOPLAI_HOME;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yoplai-migrate-"));
    process.env.YOPLAI_HOME = tmpDir;
  });

  afterEach(async () => {
    process.env.YOPLAI_HOME = oldHomeDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("no-ops for v3 config", async () => {
    const configPath = path.join(tmpDir, "yoplai.json");
    await fs.writeFile(configPath, JSON.stringify({ version: 3, agents: [] }), "utf8");

    const result = await migrateAgentsConfig(configPath);

    expect(result.migrated).toBe(false);
    expect(result.message).toContain("already version 3");
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      version: 3,
      agents: [],
    });
  });

  it("migrates agents, legacy system files, and schedules", async () => {
    const alphaDir = path.join(tmpDir, "agents", "alpha");
    const betaDir = path.join(tmpDir, "custom", "beta");
    await fs.mkdir(alphaDir, { recursive: true });
    await fs.mkdir(betaDir, { recursive: true });
    await fs.writeFile(path.join(alphaDir, "AGENTS.md"), "prime");
    await fs.writeFile(path.join(alphaDir, "SOUL.md"), "soul");
    await fs.writeFile(path.join(alphaDir, "USER.md"), "user");
    await fs.writeFile(path.join(alphaDir, "BOOTSTRAP.md"), "bootstrap");
    await fs.writeFile(path.join(betaDir, "SOUL.md"), "soul");

    const configPath = path.join(tmpDir, "yoplai.json");
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          version: 2,
          gateway: { port: 4123 },
          extensions: { scheduler: { enabled: true } },
          agents: [
            {
              id: "alpha",
              name: "Alpha",
              workspace: "./agents/alpha",
              model: { provider: "test", model: "one" },
              heartbeat: { every: "30m", ackMaxChars: 100 },
            },
            {
              id: "beta",
              name: "Beta",
              workspace: betaDir,
              model: { provider: "test", model: "two" },
            },
          ],
        },
        null,
        2
      ),
      "utf8"
    );
    await fs.writeFile(
      path.join(tmpDir, "schedules.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "half-hour",
            name: "Half hour",
            agentId: "alpha",
            enabled: true,
            schedule: { type: "interval", everyMinutes: 30, startAt: "2026-05-19T08:00:00Z" },
            payload: { prompt: "Ping" },
          },
          {
            id: "daily",
            name: "Daily",
            agentId: "beta",
            schedule: { type: "daily", time: "09:05", timezone: "Europe/Paris" },
            payload: { message: "Digest" },
          },
          {
            id: "hourly",
            name: "Hourly",
            agentId: "alpha",
            schedule: { type: "interval", everyMinutes: 60 },
            payload: { message: "Hourly" },
          },
          {
            id: "daily-interval",
            name: "Daily interval",
            agentId: "alpha",
            schedule: { type: "interval", everyMinutes: 1440 },
            payload: { message: "Daily interval" },
          },
          {
            id: "weekly-interval",
            name: "Weekly interval",
            agentId: "alpha",
            schedule: { type: "interval", everyMinutes: 10080 },
            payload: { message: "Weekly interval" },
          },
          {
            id: "orphan",
            name: "Orphan",
            agentId: "missing",
            schedule: { everyMinutes: 15 },
            payload: { prompt: "Lost" },
          },
        ],
      }),
      "utf8"
    );

    const result = await migrateAgentsConfig(configPath);

    expect(result.migrated).toBe(true);
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(["alpha", "beta"]);
    expect(result.scheduleCounts).toEqual({ alpha: 4, beta: 1 });
    expect(result.orphanCount).toBe(1);
    expect(await exists(path.join(tmpDir, "schedules.json"))).toBe(false);

    const migratedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(migratedConfig).toMatchObject({
      version: 3,
      gateway: { port: 4123 },
      extensions: { scheduler: { enabled: true } },
    });
    expect(migratedConfig.agents).toEqual([alphaDir, betaDir]);
    expect(await exists(result.configBackup!)).toBe(true);
    expect(await exists(result.schedulesBackup!)).toBe(true);

    const alphaYaml = yaml.load(await fs.readFile(path.join(alphaDir, "agent.yaml"), "utf8")) as Record<string, unknown>;
    expect(alphaYaml.workspace).toBeUndefined();
    expect(alphaYaml).toMatchObject({
      id: "alpha",
      name: "Alpha",
      heartbeat: { every: "30m", ackMaxChars: 100 },
      system_files: ["SOUL.md", "USER.md", "BOOTSTRAP.md"],
    });
    expect(alphaYaml.system_files).not.toContain("AGENTS.md");

    const alphaJobs = JSON.parse(await fs.readFile(path.join(alphaDir, "cron", "jobs.json"), "utf8"));
    expect(alphaJobs.jobs).toHaveLength(4);
    expect(alphaJobs.jobs[0]).toMatchObject({
      id: "half-hour",
      schedule: { cron: "*/30 * * * *", startAt: "2026-05-19T08:00:00Z" },
      payload: { message: "Ping" },
    });
    expect(alphaJobs.jobs[1]).toMatchObject({ id: "hourly", schedule: { cron: "0 * * * *" } });
    expect(alphaJobs.jobs[2]).toMatchObject({ id: "daily-interval", schedule: { cron: "0 0 * * *" } });
    expect(alphaJobs.jobs[3]).toMatchObject({ id: "weekly-interval", schedule: { cron: "0 0 * * 0" } });
    expect(alphaJobs.jobs[0].agentId).toBeUndefined();
    expect(alphaJobs.jobs[0].schedule.tz).toBeTruthy();

    const betaJobs = JSON.parse(await fs.readFile(path.join(betaDir, "cron", "jobs.json"), "utf8"));
    expect(betaJobs.jobs[0]).toMatchObject({
      id: "daily",
      schedule: { cron: "5 9 * * *", tz: "Europe/Paris" },
      payload: { message: "Digest" },
    });

    const orphans = JSON.parse(await fs.readFile(path.join(tmpDir, "orphan-schedules.json"), "utf8"));
    expect(orphans.jobs.map((job: { id: string }) => job.id)).toEqual(["orphan"]);
    expect(await exists(path.join(alphaDir, "cron", "output"))).toBe(true);
    expect(await exists(path.join(betaDir, "cron", "output"))).toBe(true);
  });

  it("does not partially migrate when schedule conversion fails", async () => {
    const agentDir = path.join(tmpDir, "agents", "alpha");
    await fs.mkdir(agentDir, { recursive: true });
    const configPath = path.join(tmpDir, "yoplai.json");
    const originalConfig = {
      version: 2,
      agents: [
        {
          id: "alpha",
          name: "Alpha",
          workspace: "./agents/alpha",
          model: { provider: "test", model: "one" },
        },
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(originalConfig, null, 2), "utf8");
    await fs.writeFile(
      path.join(tmpDir, "schedules.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "bad",
            name: "Bad",
            agentId: "alpha",
            schedule: { type: "daily", time: "99:99" },
            payload: { message: "Bad" },
          },
        ],
      }),
      "utf8"
    );

    await expect(migrateAgentsConfig(configPath)).rejects.toThrow("Unsupported legacy schedule shape");

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(originalConfig);
    expect(await exists(path.join(agentDir, "agent.yaml"))).toBe(false);
    expect(await exists(path.join(agentDir, "cron", "jobs.json"))).toBe(false);
    expect(await exists(path.join(tmpDir, "schedules.json"))).toBe(true);
  });

  it("does not partially migrate unsupported long intervals", async () => {
    const agentDir = path.join(tmpDir, "agents", "alpha");
    await fs.mkdir(agentDir, { recursive: true });
    const configPath = path.join(tmpDir, "yoplai.json");
    const originalConfig = {
      version: 2,
      agents: [
        {
          id: "alpha",
          name: "Alpha",
          workspace: "./agents/alpha",
          model: { provider: "test", model: "one" },
        },
      ],
    };
    await fs.writeFile(configPath, JSON.stringify(originalConfig, null, 2), "utf8");
    await fs.writeFile(
      path.join(tmpDir, "schedules.json"),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: "bad-interval",
            name: "Bad interval",
            agentId: "alpha",
            schedule: { type: "interval", everyMinutes: 90 },
            payload: { message: "Bad" },
          },
        ],
      }),
      "utf8"
    );

    await expect(migrateAgentsConfig(configPath)).rejects.toThrow("Unsupported legacy interval schedule");

    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(originalConfig);
    expect(await exists(path.join(agentDir, "agent.yaml"))).toBe(false);
    expect(await exists(path.join(agentDir, "cron", "jobs.json"))).toBe(false);
    expect(await exists(path.join(tmpDir, "schedules.json"))).toBe(true);
  });
});
