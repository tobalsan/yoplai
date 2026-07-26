import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { AgentConfig, ScheduleJob } from "@yoplai/shared";
import { ScheduleJobFileSchema } from "@yoplai/shared";
import { z } from "zod";

export type ScheduleStore = {
  version: number;
  jobs: ScheduleJob[];
};

const JobsFileSchema = z.object({
  version: z.literal(1).optional().default(1),
  jobs: z.array(ScheduleJobFileSchema).optional().default([]),
});

export function getAgentJobsPath(workspaceDir: string): string {
  return path.join(workspaceDir, "cron", "jobs.json");
}

export function getCronOutputDir(workspaceDir: string): string {
  return path.join(workspaceDir, "cron", "output");
}

export class PerAgentScheduleStore {
  constructor(
    private readonly agents: AgentConfig[],
    private readonly resolveWorkspaceDir: (agent: AgentConfig) => string,
    private readonly dataDir: string = "",
    private readonly warn: (message: string) => void = console.warn
  ) {}

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
      return parsed.data.jobs.map((job) => ({ ...job, agentId: agent.id }));
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

export function getTempDir(): string {
  return os.tmpdir();
}
