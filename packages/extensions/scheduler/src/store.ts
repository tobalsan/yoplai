import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AgentConfig, ScheduleJob, ScheduleRun } from "@yoplai/shared";
import { ScheduleJobFileSchema } from "@yoplai/shared";
import { z } from "zod";

export type ScheduleStore = {
  version: number;
  jobs: ScheduleJob[];
};

// Jobs are validated one by one (below) rather than as a typed array, so a
// single unloadable job — e.g. a legacy entry with an empty message — cannot
// take every other job of that agent down with it.
const JobsFileSchema = z.object({
  version: z.literal(1).optional().default(1),
  jobs: z.array(z.unknown()).optional().default([]),
});

const RunSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  agentId: z.string(),
  sessionId: z.string().optional(),
  firedAt: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["running", "ok", "error", "interrupted"]),
  runKind: z.enum(["woke_agent", "silent_tick", "script_only"]),
  exitCode: z.number().optional(),
  gateOutput: z.string().optional(),
  error: z.string().optional(),
  errorCode: z.string().optional(),
  outputPath: z.string().optional(),
  prompt: z.string(),
  storageOwnerId: z.string().nullable(),
  pinnedSession: z.boolean().optional(),
});

export function getAgentJobsPath(workspaceDir: string): string {
  return path.join(workspaceDir, "cron", "jobs.json");
}

function getCronOutputDir(workspaceDir: string): string {
  return path.join(workspaceDir, "cron", "output");
}

export class PerAgentScheduleStore {
  constructor(
    private readonly agents: AgentConfig[],
    private readonly resolveWorkspaceDir: (agent: AgentConfig) => string,
    private readonly dataDir: string = "",
    private readonly warn: (message: string) => void = console.warn
  ) {}

  private runsDir(agentId: string, jobId?: string): string {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const dir = path.join(this.resolveWorkspaceDir(agent), "cron", "runs");
    return jobId === undefined ? dir : path.join(dir, jobId);
  }

  async saveRun(run: ScheduleRun): Promise<void> {
    const dir = this.runsDir(run.agentId, run.jobId);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${run.id}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    await fs.writeFile(tmpPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await fs.rename(tmpPath, path.join(dir, `${run.id}.json`));
  }

  async deleteRun(agentId: string, jobId: string, runId: string): Promise<void> {
    await fs.rm(path.join(this.runsDir(agentId, jobId), `${runId}.json`), { force: true });
  }

  async listRuns(agentId: string, jobId: string): Promise<ScheduleRun[]> {
    const dir = this.runsDir(agentId, jobId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const runs: ScheduleRun[] = [];
    for (const entry of entries.filter((entry) => entry.endsWith(".json"))) {
      try {
        const run = RunSchema.parse(JSON.parse(await fs.readFile(path.join(dir, entry), "utf8")));
        if (run.agentId === agentId && run.jobId === jobId && entry === `${run.id}.json`) runs.push(run);
      } catch (error) {
        this.warn(`[scheduler] Failed to read run ${path.join(dir, entry)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return runs;
  }

  async reconcileRunningRuns(): Promise<void> {
    for (const agent of this.agents) {
      let jobs: import("node:fs").Dirent[];
      try {
        jobs = await fs.readdir(this.runsDir(agent.id), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        this.warn(`[scheduler] Failed to reconcile runs for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      for (const job of jobs.filter((entry) => entry.isDirectory())) {
        let runs: ScheduleRun[];
        try {
          runs = await this.listRuns(agent.id, job.name);
        } catch (error) {
          this.warn(`[scheduler] Failed to reconcile runs for job ${agent.id}/${job.name}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        for (const run of runs) {
          if (run.status !== "running") continue;
          try {
            await this.saveRun({ ...run, status: "interrupted", finishedAt: new Date().toISOString() });
          } catch (error) {
            this.warn(`[scheduler] Failed to reconcile run ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }

  async load(): Promise<ScheduleStore> {
    const legacyPath = path.join(this.dataDir, "schedules.json");
    if (fsSync.existsSync(legacyPath)) {
      this.warn(
        `[scheduler] Found legacy schedules.json at ${legacyPath}; run \`yoplai agents migrate\` to split schedules into agent cron/jobs.json files.`
      );
    }

    const jobs: ScheduleJob[] = [];
    for (const agent of this.agents) {
      const workspaceDir = this.resolveWorkspaceDir(agent);
      const fileJobs = await this.loadAgentJobs(agent, workspaceDir);
      jobs.push(...fileJobs);
    }
    return { version: 1, jobs };
  }

  async saveAgentJobs(agentId: string, jobs: ScheduleJob[]): Promise<void> {
    const agent = this.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const workspaceDir = this.resolveWorkspaceDir(agent);
    const jobsPath = getAgentJobsPath(workspaceDir);
    await fs.mkdir(path.dirname(jobsPath), { recursive: true });

    const release = await lockfile.lock(path.dirname(jobsPath), {
      retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
      realpath: false,
    });
    try {
      const diskJobs = jobs.map((job) => {
        const diskJob: Record<string, unknown> = { ...job };
        delete diskJob.agentId;
        delete diskJob.state;
        return diskJob;
      });
      const content = `${JSON.stringify({ version: 1, jobs: diskJobs }, null, 2)}\n`;
      const tmpPath = path.join(
        path.dirname(jobsPath),
        `.jobs.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
      );
      await fs.writeFile(tmpPath, content, "utf8");
      await fs.rename(tmpPath, jobsPath);
    } finally {
      await release();
    }
  }

  private async loadAgentJobs(
    agent: AgentConfig,
    workspaceDir: string
  ): Promise<ScheduleJob[]> {
    const jobsPath = getAgentJobsPath(workspaceDir);
    try {
      const raw = await fs.readFile(jobsPath, "utf8");
      const parsed = JobsFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.warn(
          `[scheduler] Invalid ${jobsPath}; treating as empty: ${parsed.error.message}`
        );
        return [];
      }
      const jobs: ScheduleJob[] = [];
      for (const [index, raw] of parsed.data.jobs.entries()) {
        const job = ScheduleJobFileSchema.safeParse(raw);
        if (!job.success) {
          this.warn(
            `[scheduler] Skipping invalid job #${index} in ${jobsPath}: ${job.error.message}`
          );
          continue;
        }
        jobs.push({ ...job.data, credentialMode: job.data.credentialMode ?? "team", agentId: agent.id });
      }
      return jobs;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code === "ENOENT") return [];
      this.warn(
        `[scheduler] Failed to read ${jobsPath}; treating as empty: ${error instanceof Error ? error.message : String(error)}`
      );
      return [];
    }
  }
}

export async function readLatestOutputFile(
  workspaceDir: string,
  jobId: string
): Promise<{ path: string; content: string } | undefined> {
  const dir = path.join(getCronOutputDir(workspaceDir), jobId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const files = entries.filter((entry) => entry.endsWith(".md")).sort();
  const latest = files.at(-1);
  if (!latest) return undefined;
  const filePath = path.join(dir, latest);
  return { path: filePath, content: await fs.readFile(filePath, "utf8") };
}
