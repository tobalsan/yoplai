import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { OrchestratorSource } from "@yoplai/shared";
import { dirExists } from "../util/fs.js";
import { migrateLegacySessions } from "./migrate.js";

export type SubagentRunStatus = "running" | "replied" | "error" | "idle";

export type SubagentRunConfig = {
  type?: "subagent";
  cli?: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  runMode?: string;
  projectId?: string;
  sliceId?: string;
  baseBranch?: string;
  source?: OrchestratorSource;
  created?: string;
  archived?: boolean;
  replaces?: string[];
} & Record<string, unknown>;

export type SubagentRunState = {
  supervisor_pid?: number;
  last_error?: string;
  cli?: string;
  run_mode?: string;
  project_id?: string;
  slice_id?: string;
  worktree_path?: string;
  base_branch?: string;
  started_at?: string;
  outcome?: string;
  finished_at?: string;
  interrupt_requested_at?: string;
  session_id?: string;
  session_file?: string;
} & Record<string, unknown>;

export type SubagentRunProgress = {
  last_active?: string;
} & Record<string, unknown>;

export type SubagentRunSummary = {
  slug: string;
  type?: "subagent";
  cli?: string;
  name?: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  runMode?: string;
  projectId?: string;
  sliceId?: string;
  status: SubagentRunStatus;
  lastActive?: string;
  startedAt?: string;
  finishedAt?: string;
  baseBranch?: string;
  worktreePath?: string;
  source?: OrchestratorSource;
  lastError?: string;
  archived?: boolean;
};

export type SubagentRunDetail = SubagentRunSummary & {
  runDir: string;
  config: SubagentRunConfig | null;
  state: SubagentRunState | null;
  progress: SubagentRunProgress | null;
};

export type SubagentRunStore = {
  locate(projectDir: string, runId: string): string;
  list(
    projectDir: string,
    options?: { includeArchived?: boolean }
  ): Promise<SubagentRunSummary[]>;
  read(projectDir: string, runId: string): Promise<SubagentRunDetail | null>;
  appendHistory(
    projectDir: string,
    runId: string,
    events: Record<string, unknown>[]
  ): Promise<void>;
  updateState(
    projectDir: string,
    runId: string,
    state: Record<string, unknown>
  ): Promise<void>;
  archive(projectDir: string, runId: string): Promise<void>;
  unarchive(projectDir: string, runId: string): Promise<void>;
  delete(projectDir: string, runId: string): Promise<void>;
  deriveStatus(runDir: string): Promise<SubagentRunStatus>;
  migrate(projectDir: string, runId: string): Promise<void>;
  migrateProject(
    root: string,
    projectId: string,
    projectDir: string
  ): Promise<void>;
};

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(
  filePath: string,
  data: unknown
): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function sessionsRoot(projectDir: string): string {
  return path.join(projectDir, "sessions");
}

async function readLastOutcome(
  historyPath: string
): Promise<"replied" | "error" | null> {
  try {
    const raw = await fs.readFile(historyPath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      try {
        const ev = JSON.parse(line) as {
          type?: string;
          data?: { outcome?: string };
        };
        if (ev.type === "worker.finished") {
          if (ev.data?.outcome === "replied") return "replied";
          if (ev.data?.outcome === "error") return "error";
        }
      } catch {
        // ignore parse errors
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isProcessAlive(pid: number | undefined, startedAt?: string): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!startedAt) return true;
  const subagentStart = Date.parse(startedAt);
  if (Number.isNaN(subagentStart)) return true;
  try {
    const psOutput = execSync(`ps -o lstart= -p ${pid}`, {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    const procStart = Date.parse(psOutput);
    if (Number.isNaN(procStart)) return true;
    return procStart <= subagentStart + 5000;
  } catch {
    return true;
  }
}

function summaryFromDetail(detail: SubagentRunDetail): SubagentRunSummary {
  return {
    slug: detail.slug,
    type: detail.config?.type ?? "subagent",
    cli: detail.config?.cli ?? detail.state?.cli,
    name: detail.config?.name,
    model: detail.config?.model,
    reasoningEffort: detail.config?.reasoningEffort,
    thinking: detail.config?.thinking,
    runMode: detail.config?.runMode ?? detail.state?.run_mode,
    projectId: detail.config?.projectId ?? detail.state?.project_id,
    sliceId: detail.config?.sliceId ?? detail.state?.slice_id,
    status: detail.status,
    lastActive: detail.progress?.last_active,
    startedAt: detail.state?.started_at,
    finishedAt: detail.state?.finished_at,
    baseBranch: detail.config?.baseBranch ?? detail.state?.base_branch,
    worktreePath: detail.state?.worktree_path,
    source: detail.config?.source ?? "manual",
    lastError: detail.state?.last_error,
    archived: detail.config?.archived ?? false,
  };
}

export class FileSystemSubagentRunStore implements SubagentRunStore {
  locate(projectDir: string, runId: string): string {
    return path.join(sessionsRoot(projectDir), runId);
  }

  async list(
    projectDir: string,
    options: { includeArchived?: boolean } = {}
  ): Promise<SubagentRunSummary[]> {
    const root = sessionsRoot(projectDir);
    if (!(await dirExists(root))) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const items: SubagentRunSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const detail = await this.read(projectDir, entry.name);
      if (!detail) continue;
      if (detail.archived && !options.includeArchived) continue;
      items.push(summaryFromDetail(detail));
    }
    return items;
  }

  async read(
    projectDir: string,
    runId: string
  ): Promise<SubagentRunDetail | null> {
    const runDir = this.locate(projectDir, runId);
    if (!(await dirExists(runDir))) return null;
    const [config, state, progress, status] = await Promise.all([
      readJsonFile<SubagentRunConfig>(path.join(runDir, "config.json")),
      readJsonFile<SubagentRunState>(path.join(runDir, "state.json")),
      readJsonFile<SubagentRunProgress>(path.join(runDir, "progress.json")),
      this.deriveStatus(runDir),
    ]);
    const detail: SubagentRunDetail = {
      slug: runId,
      runDir,
      config,
      state,
      progress,
      status,
    };
    return { ...detail, ...summaryFromDetail(detail) };
  }

  async appendHistory(
    projectDir: string,
    runId: string,
    events: Record<string, unknown>[]
  ): Promise<void> {
    const historyPath = path.join(
      this.locate(projectDir, runId),
      "history.jsonl"
    );
    const lines = events.map((event) => JSON.stringify(event)).join("\n");
    if (!lines) return;
    try {
      await fs.appendFile(historyPath, `${lines}\n`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  async updateState(
    projectDir: string,
    runId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    const statePath = path.join(this.locate(projectDir, runId), "state.json");
    const current =
      (await readJsonFile<Record<string, unknown>>(statePath)) ?? {};
    await writeJsonFile(statePath, { ...current, ...state });
  }

  async archive(projectDir: string, runId: string): Promise<void> {
    await this.updateArchived(projectDir, runId, true);
  }

  async unarchive(projectDir: string, runId: string): Promise<void> {
    await this.updateArchived(projectDir, runId, false);
  }

  async delete(projectDir: string, runId: string): Promise<void> {
    await fs.rm(this.locate(projectDir, runId), {
      recursive: true,
      force: true,
    });
    try {
      const root = sessionsRoot(projectDir);
      const remaining = await fs.readdir(root);
      if (remaining.length === 0) await fs.rmdir(root);
    } catch {
      // ignore
    }
  }

  async deriveStatus(runDir: string): Promise<SubagentRunStatus> {
    const state = await readJsonFile<SubagentRunState>(
      path.join(runDir, "state.json")
    );
    if (state?.last_error && state.last_error.trim()) return "error";
    const isTerminal = state?.outcome === "done" || state?.finished_at;
    if (
      !isTerminal &&
      isProcessAlive(state?.supervisor_pid, state?.started_at)
    ) {
      return "running";
    }
    const outcome = await readLastOutcome(path.join(runDir, "history.jsonl"));
    if (outcome === "error") return "error";
    if (outcome === "replied") return "replied";
    return "idle";
  }

  async migrate(_projectDir: string, _runId: string): Promise<void> {
    return;
  }

  async migrateProject(
    root: string,
    projectId: string,
    projectDir: string
  ): Promise<void> {
    await migrateLegacySessions(root, projectId, projectDir);
  }

  private async updateArchived(
    projectDir: string,
    runId: string,
    archived: boolean
  ): Promise<void> {
    const configPath = path.join(this.locate(projectDir, runId), "config.json");
    if (!(await pathExists(configPath))) return;
    const config =
      (await readJsonFile<Record<string, unknown>>(configPath)) ?? {};
    await fs.writeFile(
      configPath,
      JSON.stringify({ ...config, archived }, null, 2)
    );
  }
}

export class InMemorySubagentRunStore implements SubagentRunStore {
  private runs = new Map<string, SubagentRunDetail>();
  readonly history = new Map<string, Record<string, unknown>[]>();

  locate(projectDir: string, runId: string): string {
    return path.join(projectDir, "sessions", runId);
  }

  async list(
    projectDir: string,
    options: { includeArchived?: boolean } = {}
  ): Promise<SubagentRunSummary[]> {
    const items: SubagentRunSummary[] = [];
    for (const run of this.runs.values()) {
      if (!run.runDir.startsWith(path.join(projectDir, "sessions"))) continue;
      if (run.archived && !options.includeArchived) continue;
      items.push(summaryFromDetail(run));
    }
    return items;
  }

  async read(
    projectDir: string,
    runId: string
  ): Promise<SubagentRunDetail | null> {
    return this.runs.get(this.key(projectDir, runId)) ?? null;
  }

  async appendHistory(
    projectDir: string,
    runId: string,
    events: Record<string, unknown>[]
  ): Promise<void> {
    const key = this.key(projectDir, runId);
    this.history.set(key, [...(this.history.get(key) ?? []), ...events]);
    const detail = this.runs.get(key);
    if (!detail) return;
    detail.status = await this.deriveStatus(detail.runDir);
    Object.assign(detail, summaryFromDetail(detail));
  }

  async updateState(
    projectDir: string,
    runId: string,
    state: Record<string, unknown>
  ): Promise<void> {
    const detail = this.ensure(projectDir, runId);
    detail.state = { ...(detail.state ?? {}), ...state };
    detail.status = await this.deriveStatus(detail.runDir);
    Object.assign(detail, summaryFromDetail(detail));
  }

  async archive(projectDir: string, runId: string): Promise<void> {
    this.setArchived(projectDir, runId, true);
  }

  async unarchive(projectDir: string, runId: string): Promise<void> {
    this.setArchived(projectDir, runId, false);
  }

  async delete(projectDir: string, runId: string): Promise<void> {
    this.runs.delete(this.key(projectDir, runId));
  }

  async deriveStatus(runDir: string): Promise<SubagentRunStatus> {
    const run = [...this.runs.values()].find((item) => item.runDir === runDir);
    if (!run) return "idle";
    if (run.state?.last_error?.trim()) return "error";
    const events = this.history.get(this.keyFromRunDir(runDir)) ?? [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== "worker.finished") continue;
      const data = event.data as { outcome?: string } | undefined;
      if (data?.outcome === "error") return "error";
      if (data?.outcome === "replied") return "replied";
    }
    return "idle";
  }

  async migrate(_projectDir: string, _runId: string): Promise<void> {
    return;
  }

  async migrateProject(
    _root: string,
    _projectId: string,
    _projectDir: string
  ): Promise<void> {
    return;
  }

  seed(projectDir: string, runId: string, detail: Partial<SubagentRunDetail>) {
    const base: SubagentRunDetail = {
      slug: runId,
      runDir: this.locate(projectDir, runId),
      config: null,
      state: null,
      progress: null,
      status: "idle",
      ...detail,
    };
    this.runs.set(this.key(projectDir, runId), {
      ...base,
      ...summaryFromDetail(base),
    });
  }

  private ensure(projectDir: string, runId: string): SubagentRunDetail {
    const key = this.key(projectDir, runId);
    const existing = this.runs.get(key);
    if (existing) return existing;
    this.seed(projectDir, runId, {});
    return this.runs.get(key)!;
  }

  private setArchived(projectDir: string, runId: string, archived: boolean) {
    const detail = this.ensure(projectDir, runId);
    detail.config = { ...(detail.config ?? {}), archived };
    Object.assign(detail, summaryFromDetail(detail));
  }

  private key(projectDir: string, runId: string): string {
    return `${projectDir}\0${runId}`;
  }

  private keyFromRunDir(runDir: string): string {
    const projectDir = path.dirname(path.dirname(runDir));
    const runId = path.basename(runDir);
    return this.key(projectDir, runId);
  }
}

export const subagentRunStore = new FileSystemSubagentRunStore();
