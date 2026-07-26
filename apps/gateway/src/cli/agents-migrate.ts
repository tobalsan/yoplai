import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import yaml from "js-yaml";
import lockfile from "proper-lockfile";
import { expandHomePlaceholder, resolveConfigPath, resolveHomeDir } from "@yoplai/shared";
import { logError } from "../logging.js";

const LEGACY_SYSTEM_FILE_ORDER = [
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "BOOTSTRAP.md",
] as const;

type LegacyAgent = Record<string, unknown> & {
  id?: unknown;
  workspace?: unknown;
};

type LegacyScheduleJob = Record<string, unknown> & {
  id?: unknown;
  agentId?: unknown;
  schedule?: unknown;
  payload?: unknown;
};

type MigrationSummary = {
  migrated: boolean;
  message: string;
  agents: Array<{ id: string; workspaceDir: string; yamlPath: string }>;
  scheduleCounts: Record<string, number>;
  orphanCount: number;
  configBackup?: string;
  schedulesBackup?: string;
};

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function resolvePathFromConfig(input: string, configDir: string, homeDir: string): string {
  const expanded = input.startsWith("~")
    ? path.join(os.homedir(), input.slice(1))
    : expandHomePlaceholder(input, homeDir);
  return path.isAbsolute(expanded) ? expanded : path.resolve(configDir, expanded);
}

function defaultWorkspaceForAgent(agentId: string, homeDir: string): string {
  return path.join(homeDir, "agents", agentId);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeLocked(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const release = await lockfile.lock(path.dirname(filePath), {
    retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
    realpath: false,
  });
  try {
    const tmpPath = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fs.writeFile(tmpPath, content, "utf8");
    await fs.rename(tmpPath, filePath);
  } finally {
    await release();
  }
}

async function backupFile(filePath: string, suffix: string): Promise<string> {
  const backupPath = `${filePath}.${suffix}.${timestamp()}.bak`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function detectSystemFiles(workspaceDir: string): Promise<string[]> {
  const present: string[] = [];
  for (const name of LEGACY_SYSTEM_FILE_ORDER) {
    if (await fileExists(path.join(workspaceDir, name))) present.push(name);
  }
  return present;
}

function migrateAgentYaml(agent: LegacyAgent, systemFiles: string[]): Record<string, unknown> {
  const yamlAgent = { ...agent };
  delete yamlAgent.workspace;
  delete yamlAgent.workspaceDir;
  if (systemFiles.length > 0) {
    yamlAgent.system_files = systemFiles;
  }
  return yamlAgent;
}

function getLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function intervalMinutesToCron(everyMinutes: number, schedule: unknown): string {
  if (!Number.isInteger(everyMinutes) || everyMinutes <= 0) {
    throw new Error(`Unsupported legacy interval schedule: ${JSON.stringify(schedule)}`);
  }
  if (everyMinutes < 60) return `*/${everyMinutes} * * * *`;
  if (everyMinutes === 60) return "0 * * * *";
  if (everyMinutes > 60 && everyMinutes < 1440 && everyMinutes % 60 === 0) {
    const hours = everyMinutes / 60;
    if (24 % hours === 0) return `0 */${hours} * * *`;
  }
  if (everyMinutes === 1440) return "0 0 * * *";
  if (everyMinutes === 10080) return "0 0 * * 0";
  throw new Error(`Unsupported legacy interval schedule: ${JSON.stringify(schedule)}`);
}

function toCronSchedule(schedule: unknown, defaultTz: string): { cron: string; tz: string; startAt?: string } {
  const value = (schedule && typeof schedule === "object" ? schedule : {}) as Record<string, unknown>;
  const tz =
    (typeof value.tz === "string" && value.tz.trim()) ||
    (typeof value.timezone === "string" && value.timezone.trim()) ||
    defaultTz;
  const startAt = typeof value.startAt === "string" ? value.startAt : undefined;

  if (typeof value.cron === "string" && value.cron.trim()) {
    return { cron: value.cron, tz, ...(startAt ? { startAt } : {}) };
  }

  const everyMinutes =
    numberFrom(value.everyMinutes) ??
    numberFrom(value.intervalMinutes) ??
    numberFrom(value.minutes) ??
    numberFrom(value.every);
  if (everyMinutes) {
    return { cron: intervalMinutesToCron(everyMinutes, schedule), tz, ...(startAt ? { startAt } : {}) };
  }

  const daily = (value.daily && typeof value.daily === "object" ? value.daily : value) as Record<string, unknown>;
  const dailyTz =
    (typeof daily.tz === "string" && daily.tz.trim()) ||
    (typeof daily.timezone === "string" && daily.timezone.trim()) ||
    tz;
  const time = typeof daily.time === "string" ? daily.time.match(/^(\d{2}):(\d{2})$/) : null;
  const hour = time ? numberFrom(time[1]) : numberFrom(daily.hour) ?? numberFrom(daily.hh);
  const minute = time ? numberFrom(time[2]) : numberFrom(daily.minute) ?? numberFrom(daily.mm) ?? 0;
  if (hour !== undefined && minute !== undefined) {
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`Unsupported legacy schedule shape: ${JSON.stringify(schedule)}`);
    }
    return { cron: `${minute} ${hour} * * *`, tz: dailyTz, ...(startAt ? { startAt } : {}) };
  }

  throw new Error(`Unsupported legacy schedule shape: ${JSON.stringify(schedule)}`);
}

function migratePayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return { message: "" };
  const next = { ...(payload as Record<string, unknown>) };
  if (typeof next.message !== "string" && typeof next.prompt === "string") {
    next.message = next.prompt;
    delete next.prompt;
  }
  if (typeof next.message !== "string") next.message = "";
  return next;
}

function migrateScheduleJob(job: LegacyScheduleJob, defaultTz: string): Record<string, unknown> {
  const rest = { ...job };
  delete rest.agentId;
  delete rest.state;
  return {
    ...rest,
    schedule: toCronSchedule(job.schedule, defaultTz),
    payload: migratePayload(job.payload),
  };
}

async function validateSchedules(params: {
  homeDir: string;
  agentsById: Map<string, string>;
  defaultTz: string;
}): Promise<void> {
  const schedulesPath = path.join(params.homeDir, "schedules.json");
  if (!fsSync.existsSync(schedulesPath)) return;

  const raw = JSON.parse(await fs.readFile(schedulesPath, "utf8")) as unknown;
  const jobs = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown }).jobs)
      ? (raw as { jobs: unknown[] }).jobs
      : [];

  for (const item of jobs) {
    const job = item as LegacyScheduleJob;
    const agentId = typeof job.agentId === "string" ? job.agentId : undefined;
    if (!agentId || !params.agentsById.has(agentId)) continue;
    migrateScheduleJob(job, params.defaultTz);
  }
}

async function migrateSchedules(params: {
  homeDir: string;
  agentsById: Map<string, string>;
  defaultTz: string;
}): Promise<Pick<MigrationSummary, "scheduleCounts" | "orphanCount" | "schedulesBackup">> {
  const schedulesPath = path.join(params.homeDir, "schedules.json");
  const scheduleCounts: Record<string, number> = {};
  if (!fsSync.existsSync(schedulesPath)) {
    return { scheduleCounts, orphanCount: 0 };
  }

  const raw = JSON.parse(await fs.readFile(schedulesPath, "utf8")) as unknown;
  const jobs = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { jobs?: unknown }).jobs)
      ? (raw as { jobs: unknown[] }).jobs
      : [];

  const grouped = new Map<string, LegacyScheduleJob[]>();
  const orphanJobs: LegacyScheduleJob[] = [];
  for (const item of jobs) {
    const job = item as LegacyScheduleJob;
    const agentId = typeof job.agentId === "string" ? job.agentId : undefined;
    if (!agentId || !params.agentsById.has(agentId)) {
      orphanJobs.push(job);
      continue;
    }
    const list = grouped.get(agentId) ?? [];
    list.push(job);
    grouped.set(agentId, list);
  }

  for (const [agentId, agentJobs] of grouped) {
    const workspaceDir = params.agentsById.get(agentId)!;
    const jobsPath = path.join(workspaceDir, "cron", "jobs.json");
    const migratedJobs = agentJobs.map((job) => migrateScheduleJob(job, params.defaultTz));
    await writeLocked(jobsPath, `${JSON.stringify({ version: 1, jobs: migratedJobs }, null, 2)}\n`);
    scheduleCounts[agentId] = migratedJobs.length;
  }

  if (orphanJobs.length > 0) {
    const orphanPath = path.join(params.homeDir, "orphan-schedules.json");
    await writeLocked(orphanPath, `${JSON.stringify({ version: 1, jobs: orphanJobs }, null, 2)}\n`);
  }

  const schedulesBackup = await backupFile(schedulesPath, "v2");
  await fs.rm(schedulesPath);
  return { scheduleCounts, orphanCount: orphanJobs.length, schedulesBackup };
}

export async function migrateAgentsConfig(configPath = resolveConfigPath()): Promise<MigrationSummary> {
  const resolvedConfigPath = path.resolve(configPath);
  const homeDir = resolveHomeDir();
  const configDir = path.dirname(resolvedConfigPath);
  const rawConfig = JSON.parse(await fs.readFile(resolvedConfigPath, "utf8")) as Record<string, unknown>;

  const legacyAgents = rawConfig.agents;
  const isV3 = rawConfig.version === 3 && !(
    Array.isArray(legacyAgents) && legacyAgents.some((agent) => typeof agent === "object" && agent !== null)
  );
  if (isV3) {
    return {
      migrated: false,
      message: "yoplai.json is already version 3; nothing to migrate.",
      agents: [],
      scheduleCounts: {},
      orphanCount: 0,
    };
  }

  if (!Array.isArray(legacyAgents) || !legacyAgents.every((agent) => typeof agent === "object" && agent !== null)) {
    throw new Error("Expected v2 yoplai.json with agents array. Cannot migrate this config.");
  }

  const plannedAgents: Array<{ agent: LegacyAgent & { id: string }; workspaceDir: string; yamlPath: string }> = [];
  const agentsById = new Map<string, string>();

  for (const agent of legacyAgents as LegacyAgent[]) {
    if (typeof agent.id !== "string" || !agent.id.trim()) {
      throw new Error("Cannot migrate agent without string id.");
    }
    const workspaceDir =
      typeof agent.workspace === "string" && agent.workspace.trim()
        ? resolvePathFromConfig(agent.workspace, configDir, homeDir)
        : defaultWorkspaceForAgent(agent.id, homeDir);
    if (path.basename(workspaceDir) !== agent.id) {
      throw new Error(
        `Cannot migrate agent "${agent.id}": workspace folder basename must match agent id for v3 (${workspaceDir}).`
      );
    }
    plannedAgents.push({ agent: agent as LegacyAgent & { id: string }, workspaceDir, yamlPath: path.join(workspaceDir, "agent.yaml") });
    agentsById.set(agent.id, workspaceDir);
  }

  const defaultTz = getLocalTimezone();
  await validateSchedules({ homeDir, agentsById, defaultTz });

  const configBackup = await backupFile(resolvedConfigPath, "v2");
  const agents: MigrationSummary["agents"] = [];

  for (const { agent, workspaceDir, yamlPath } of plannedAgents) {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "cron", "output"), { recursive: true });

    const systemFiles = await detectSystemFiles(workspaceDir);
    const yamlContent = yaml.dump(migrateAgentYaml(agent, systemFiles), {
      noRefs: true,
      lineWidth: 100,
      sortKeys: false,
    });
    await writeLocked(yamlPath, yamlContent);
    agents.push({ id: agent.id, workspaceDir, yamlPath });
  }

  const globalConfig = { ...rawConfig };
  delete globalConfig.agents;
  const v3Config = {
    ...globalConfig,
    version: 3,
    agents: agents.map((agent) => agent.workspaceDir),
  };
  await writeLocked(resolvedConfigPath, `${JSON.stringify(v3Config, null, 2)}\n`);

  const scheduleResult = await migrateSchedules({
    homeDir,
    agentsById,
    defaultTz,
  });

  return {
    migrated: true,
    message: `Migrated ${agents.length} agent(s) to agent.yaml. Default timezone for migrated schedules: ${defaultTz}.`,
    agents,
    configBackup,
    ...scheduleResult,
  };
}

export function registerAgentsMigrateCommands(program: Command): void {
  const agents = program.command("agents").description("Manage agent folders");
  agents
    .command("migrate")
    .description("Migrate v2 centralized agent config to v3 agent.yaml folders")
    .action(async () => {
      try {
        const result = await migrateAgentsConfig();
        console.log(result.message);
        if (!result.migrated) return;
        if (result.configBackup) console.log(`Config backup: ${result.configBackup}`);
        for (const agent of result.agents) {
          console.log(`- ${agent.id}: ${agent.workspaceDir} -> ${agent.yamlPath}`);
        }
        if (result.schedulesBackup) {
          console.log(`Schedules backup: ${result.schedulesBackup}`);
          for (const [agentId, count] of Object.entries(result.scheduleCounts)) {
            console.log(`- ${agentId}: ${count} schedule(s) migrated`);
          }
          if (result.orphanCount > 0) {
            console.log(`Orphan schedules: ${result.orphanCount} written to ${path.join(resolveHomeDir(), "orphan-schedules.json")}`);
          }
        }
      } catch (error) {
        logError("Migration failed", error);
        process.exit(1);
      }
    });
}
