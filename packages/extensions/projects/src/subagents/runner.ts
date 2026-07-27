import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  readEnv,
  type GatewayConfig,
  type OrchestratorSource,
} from "@yoplai/shared";
import { parseMarkdownFile } from "../taskboard/parser.js";
import { findProjectLocation } from "../projects/store.js";
import { dirExists } from "../util/fs.js";
import { getProjectsRoot, getProjectsWorktreeRoot } from "../util/paths.js";
import { getSubagentHarnessAdapter } from "./harness-adapter.js";
import { subagentRunStore, writeJsonFile as writeJson } from "./run-store.js";
import {
  getSubagentWorkspaceAdapter,
  resolveProjectRepo,
  validateWorkspaceRepo,
} from "./workspace-adapter.js";

export const SUPPORTED_SUBAGENT_CLIS = ["claude", "codex", "pi"] as const;
export type SubagentCli = (typeof SUPPORTED_SUBAGENT_CLIS)[number];
export type SubagentMode = "main-run" | "worktree" | "clone" | "none";

export type SpawnSubagentInput = {
  projectId: string;
  sliceId?: string;
  slug: string;
  cli: SubagentCli;
  name?: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  thinking?: string;
  mode?: SubagentMode;
  baseBranch?: string;
  source?: OrchestratorSource;
  resume?: boolean;
  replaces?: string[];
  attachments?: Array<{ path: string; mimeType: string; filename?: string }>;
};

export type SpawnSubagentResult =
  | { ok: true; data: { slug: string } }
  | { ok: false; error: string };

export type InterruptSubagentResult =
  | { ok: true; data: { slug: string } }
  | { ok: false; error: string };

export type KillSubagentResult =
  | { ok: true; data: { slug: string } }
  | { ok: false; error: string };

type SubagentState = {
  session_id: string;
  session_file?: string;
  project_id?: string;
  slice_id?: string;
  supervisor_pid: number;
  started_at: string;
  finished_at?: string;
  interrupt_requested_at?: string;
  last_error: string;
  outcome?: "done";
  cli: SubagentCli;
  run_mode: SubagentMode;
  worktree_path: string;
  base_branch: string;
  start_head_sha: string;
  end_head_sha: string;
  commit_range: string;
};

export function isSupportedSubagentCli(value: string): value is SubagentCli {
  return (SUPPORTED_SUBAGENT_CLIS as readonly string[]).includes(value);
}

export function getUnsupportedSubagentCliError(value: string): string {
  return `Unsupported CLI: ${value}. Supported CLIs: ${SUPPORTED_SUBAGENT_CLIS.join(", ")}.`;
}

function buildProjectSummary(
  title: string,
  status: string,
  projectPath: string,
  content: string
): string {
  const lines = [
    "Let's tackle the following project:",
    "",
    title,
    status,
    `Project folder: ${projectPath}`,
    content,
  ];
  return lines.join("\n").trimEnd();
}

function parsePromptLimitEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizeReplaces(input: string[] | undefined): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

export async function spawnSubagent(
  config: GatewayConfig,
  input: SpawnSubagentInput
): Promise<SpawnSubagentResult> {
  if (!isSupportedSubagentCli(input.cli)) {
    return { ok: false, error: getUnsupportedSubagentCliError(input.cli) };
  }
  const cli = input.cli;

  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, input.projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${input.projectId}` };
  }

  const projectDir = path.join(location.baseRoot, location.dirName);
  const sessionDir = subagentRunStore.locate(projectDir, input.slug);
  let frontmatter: Record<string, unknown> = {};
  let summary = "";
  if (!input.resume) {
    const readmePath = path.join(projectDir, "README.md");
    const {
      frontmatter: parsedFrontmatter,
      title,
      content,
    } = await parseMarkdownFile(readmePath);
    frontmatter = parsedFrontmatter;
    let threadContent = "";
    try {
      const parsedThread = await parseMarkdownFile(
        path.join(projectDir, "THREAD.md")
      );
      threadContent = parsedThread.content.trim();
    } catch {
      // ignore missing thread
    }

    // Gather content from all markdown files
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const mdFiles = entries
      .filter(
        (e) => e.isFile() && e.name.endsWith(".md") && e.name !== "THREAD.md"
      )
      .map((e) => e.name)
      .sort((a, b) => {
        if (a.toUpperCase() === "README.MD") return -1;
        if (b.toUpperCase() === "README.MD") return 1;
        return a.localeCompare(b);
      });

    let fullContent = content ?? "";
    if (threadContent) {
      fullContent += `\n\n## THREAD\n\n${threadContent}`;
    }
    for (const file of mdFiles) {
      if (file.toUpperCase() === "README.MD") continue;
      try {
        const parsed = await parseMarkdownFile(path.join(projectDir, file));
        if (parsed.content) {
          const label = file.replace(/\.md$/i, "");
          fullContent += `\n\n## ${label}\n\n${parsed.content}`;
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    const resolvedTitle =
      typeof frontmatter.title === "string" ? frontmatter.title : (title ?? "");
    const status =
      typeof frontmatter.status === "string" ? frontmatter.status : "";
    summary = buildProjectSummary(
      resolvedTitle,
      status,
      projectDir,
      fullContent
    );
  }
  const repo = await resolveProjectRepo(
    config,
    input.projectId,
    projectDir,
    input.sliceId,
    frontmatter
  );

  let mode: SubagentMode = input.mode ?? "clone";
  if (input.resume) {
    const existingStatePath = path.join(sessionDir, "state.json");
    try {
      const raw = await fs.readFile(existingStatePath, "utf8");
      const state = JSON.parse(raw) as { run_mode?: string };
      if (
        state.run_mode === "main-run" ||
        state.run_mode === "worktree" ||
        state.run_mode === "clone" ||
        state.run_mode === "none"
      ) {
        mode = state.run_mode;
      }
    } catch {
      // ignore
    }
  }

  if (mode !== "none" && !repo) {
    return { ok: false, error: "Project repo not set" };
  }

  const repoError = await validateWorkspaceRepo(mode, repo);
  if (repoError) return { ok: false, error: repoError };
  const sessionExists = await dirExists(sessionDir);
  if (sessionExists && !input.resume) {
    return { ok: false, error: `Subagent already exists: ${input.slug}` };
  }
  if (!sessionExists) {
    await fs.mkdir(sessionDir, { recursive: true });
  }

  const baseBranch = input.baseBranch ?? "main";
  const workspaceAdapter = getSubagentWorkspaceAdapter(mode);
  let workspace;
  try {
    workspace = await workspaceAdapter.prepare({
      config,
      projectId: input.projectId,
      sliceId: input.sliceId,
      slug: input.slug,
      projectDir,
      repo,
      mode,
      baseBranch,
    });
  } catch (error) {
    if (!sessionExists) {
      await fs.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
    }
    await workspaceAdapter
      .cleanup({
        config,
        projectId: input.projectId,
        sliceId: input.sliceId,
        slug: input.slug,
        projectDir,
        repo,
        mode,
        baseBranch,
      })
      .catch(() => {});
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to initialize subagent workspace",
    };
  }
  const worktreePath = workspace.worktreePath;

  const statePath = path.join(sessionDir, "state.json");
  const progressPath = path.join(sessionDir, "progress.json");
  const logsPath = path.join(sessionDir, "logs.jsonl");
  const configPath = path.join(sessionDir, "config.json");
  const piSessionFilePath = path.join(sessionDir, "pi-session.jsonl");

  let existingSessionId: string | undefined;
  let existingSessionFile: string | undefined;
  if (input.resume) {
    try {
      const raw = await fs.readFile(statePath, "utf8");
      const state = JSON.parse(raw) as {
        session_id?: string;
        session_file?: string;
      };
      if (state.session_id) existingSessionId = state.session_id;
      if (state.session_file) existingSessionFile = state.session_file;
    } catch {
      // ignore
    }
  }

  let prompt = input.prompt;
  if (!input.resume) {
    prompt = summary ? `${summary}\n\n${input.prompt}` : input.prompt;
    if (mode === "worktree" || mode === "clone") {
      const worktreeLine =
        mode === "worktree"
          ? `Worktree path: ${worktreePath}`
          : `Clone path: ${worktreePath}`;
      if (prompt.includes("Repo path:")) {
        prompt = prompt.replace(
          /\n\nRepo path:[^\n]*(\n|$)/,
          `\n\n${worktreeLine}\n`
        );
      } else {
        prompt = `${prompt}\n\n${worktreeLine}`;
      }
      prompt = prompt.trimEnd();
    } else if (mode === "main-run") {
      prompt = `${prompt}\n\nSpace path: ${worktreePath}`.trimEnd();
    }
  }
  if (input.attachments && input.attachments.length > 0) {
    const paths = input.attachments.map((a) => a.path).join(", ");
    prompt = `${prompt}\n\n[Attached images: ${paths}]`;
  }
  const resumeLimit = parsePromptLimitEnv(
    "YOPLAI_SUBAGENT_RESUME_MAX_PROMPT_BYTES",
    32768
  );
  const startLimit = parsePromptLimitEnv(
    "YOPLAI_SUBAGENT_MAX_PROMPT_BYTES",
    262144
  );
  const promptLimit = input.resume ? resumeLimit : startLimit;
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes > promptLimit) {
    const modeLabel = input.resume ? "resume" : "start/spawn";
    await workspace.releaseLease();
    return {
      ok: false,
      error: `Prompt too large for ${modeLabel}: ${promptBytes} > ${promptLimit} bytes`,
    };
  }
  const piSessionFile =
    cli === "pi" ? (existingSessionFile ?? piSessionFilePath) : undefined;
  const harness = getSubagentHarnessAdapter(cli);
  const args = harness.buildArgs({
    prompt,
    sessionId: existingSessionId,
    sessionFile: piSessionFile,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    thinking: input.thinking,
  });
  let resolved;
  try {
    resolved = await harness.resolveCommand(args);
  } catch (err) {
    await workspace.releaseLease();
    return {
      ok: false,
      error: err instanceof Error ? err.message : "CLI not found",
    };
  }
  let state!: SubagentState;
  let stateWrite = Promise.resolve();
  const persistState = async (nextState: SubagentState): Promise<void> => {
    state = nextState;
    const snapshot = { ...nextState };
    stateWrite = stateWrite.then(async () => {
      await subagentRunStore.updateState(projectDir, input.slug, snapshot);
    });
    await stateWrite;
  };
  const child = spawn(resolved.command, resolved.args, {
    cwd: worktreePath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let markIoReady!: () => void;
  const ioReady = new Promise<void>((resolve) => {
    markIoReady = resolve;
  });
  let stdoutProcessing = Promise.resolve();

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutProcessing = stdoutProcessing.then(async () => {
      await ioReady;
      try {
        const text = chunk.toString("utf8");
        await fs.appendFile(logsPath, text, "utf8");
        await writeJson(progressPath, {
          last_active: new Date().toISOString(),
          tool_calls: 0,
        });

        const lines = text
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0);
        for (const line of lines) {
          const nextSessionId = harness.extractSessionId(line);
          if (nextSessionId) {
            await persistState({ ...state, session_id: nextSessionId });
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    });
  });

  child.stderr?.on("data", async (chunk: Buffer) => {
    await ioReady;
    try {
      const text = chunk.toString("utf8");
      const lines = text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);
      if (lines.length === 0) return;
      const stamped = lines
        .map((line) => JSON.stringify({ type: "stderr", text: line }))
        .join("\n");
      await fs.appendFile(logsPath, `${stamped}\n`, "utf8");
      await writeJson(progressPath, {
        last_active: new Date().toISOString(),
        tool_calls: 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  });
  const startHeadSha = workspace.startHeadSha;

  child.on("error", async (err) => {
    const finishedAt = new Date().toISOString();
    await subagentRunStore.appendHistory(projectDir, input.slug, [
      {
        ts: finishedAt,
        type: "worker.finished",
        data: {
          run_id: `${Date.now()}`,
          outcome: "error",
          error_message:
            err instanceof Error
              ? `spawn failed: ${err.message}`
              : "spawn failed",
        },
      },
    ]);
    await workspace.releaseLease();
  });

  const startedAt = new Date().toISOString();
  let createdAt = startedAt;
  let archived = false;
  let existingSource: OrchestratorSource | undefined;
  const persistedReplaces = normalizeReplaces(input.replaces);
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const existing = JSON.parse(raw) as {
      created?: string;
      archived?: boolean;
      replaces?: string[];
      source?: OrchestratorSource;
    };
    if (
      typeof existing.created === "string" &&
      existing.created.trim().length > 0
    ) {
      createdAt = existing.created;
    }
    if (typeof existing.archived === "boolean") {
      archived = existing.archived;
    }
    if (existing.source === "manual" || existing.source === "orchestrator") {
      existingSource = existing.source;
    }
  } catch {
    // ignore
  }
  state = {
    session_id:
      cli === "pi" ? (piSessionFile ?? "") : (existingSessionId ?? ""),
    session_file: cli === "pi" ? (piSessionFile ?? "") : undefined,
    project_id: input.projectId,
    slice_id: input.sliceId,
    supervisor_pid: child.pid ?? 0,
    started_at: startedAt,
    last_error: "",
    cli,
    run_mode: mode,
    worktree_path: worktreePath,
    base_branch: baseBranch,
    start_head_sha: startHeadSha ?? "",
    end_head_sha: "",
    commit_range: "",
  };
  await writeJson(configPath, {
    name: input.name,
    cli,
    projectId: input.projectId,
    sliceId: input.sliceId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    thinking: input.thinking,
    runMode: mode,
    baseBranch,
    source: input.source ?? existingSource ?? "manual",
    replaces: persistedReplaces,
    created: createdAt,
    archived,
  });
  await persistState(state);
  await writeJson(progressPath, { last_active: startedAt, tool_calls: 0 });
  await fs.appendFile(logsPath, "", "utf8");
  if (input.prompt.trim().length > 0) {
    const userLine = JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: input.prompt },
    });
    await fs.appendFile(logsPath, `${userLine}\n`, "utf8");
  }
  markIoReady();
  await subagentRunStore.appendHistory(projectDir, input.slug, [
    {
      ts: startedAt,
      type: "worker.started",
      data: {
        action: input.resume ? "follow_up" : "started",
        harness: cli,
        session_id: state.session_id,
      },
    },
  ]);

  child.on("exit", async (code, signal) => {
    await stdoutProcessing;
    const finishedAt = new Date().toISOString();
    const outcome: "replied" | "error" = code === 0 ? "replied" : "error";
    const exitMessage =
      code !== null && code !== 0
        ? `process exited (code ${code})`
        : signal
          ? `process exited (signal ${signal})`
          : "process exited";
    const data: Record<string, unknown> = {
      run_id: `${Date.now()}`,
      duration_ms: 0,
      tool_calls: 0,
      outcome,
    };
    if (outcome === "error") {
      data.error_message = exitMessage;
    }
    await subagentRunStore.appendHistory(projectDir, input.slug, [
      {
        ts: finishedAt,
        type: "worker.finished",
        data,
      },
    ]);
    if (outcome === "error") {
      let interruptRequestedAt: string | undefined;
      try {
        const raw = await fs.readFile(statePath, "utf8");
        const current = JSON.parse(raw) as { interrupt_requested_at?: string };
        if (typeof current.interrupt_requested_at === "string") {
          interruptRequestedAt = current.interrupt_requested_at;
        }
      } catch {
        // ignore
      }
      await persistState({
        ...state,
        interrupt_requested_at: interruptRequestedAt,
        last_error: exitMessage,
      });
      await workspace.releaseLease();
      await workspace.prune();
      return;
    }

    await persistState({ ...state, finished_at: finishedAt, outcome: "done" });

    if (startHeadSha) {
      await persistState({
        ...state,
        end_head_sha: "",
        commit_range: "",
      });
      let replacesFromConfig: string[] | undefined;
      try {
        const raw = await fs.readFile(configPath, "utf8");
        const parsed = JSON.parse(raw) as { replaces?: string[] };
        replacesFromConfig = normalizeReplaces(parsed.replaces);
      } catch {
        replacesFromConfig = undefined;
      }
      const delivery = await workspace.recordDelivery({
        config,
        projectId: input.projectId,
        slug: input.slug,
        startHeadSha,
        replaces: replacesFromConfig,
      });
      if (delivery) {
        await persistState({
          ...state,
          end_head_sha: delivery.endHeadSha,
          commit_range: delivery.commitRange,
        });
      }
    }
    await workspace.releaseLease();
    await workspace.prune();
  });

  return { ok: true, data: { slug: input.slug } };
}

export async function interruptSubagent(
  config: GatewayConfig,
  projectId: string,
  slug: string
): Promise<InterruptSubagentResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const projectDir = path.join(location.baseRoot, location.dirName);
  const sessionDir = subagentRunStore.locate(projectDir, slug);
  const statePath = path.join(sessionDir, "state.json");

  try {
    const raw = await fs.readFile(statePath, "utf8");
    const state = JSON.parse(raw) as Record<string, unknown> & {
      supervisor_pid?: number;
      outcome?: string;
      finished_at?: string;
    };
    // Don't try to interrupt a run that already completed – the PID may have
    // been recycled by the OS and could belong to an unrelated process.
    if (state.outcome === "done" || state.finished_at) {
      return { ok: false, error: `Subagent not running: ${slug}` };
    }
    if (state.supervisor_pid) {
      await subagentRunStore.updateState(projectDir, slug, {
        interrupt_requested_at: new Date().toISOString(),
      });
      process.kill(state.supervisor_pid, "SIGTERM");
      await subagentRunStore.appendHistory(projectDir, slug, [
        {
          ts: new Date().toISOString(),
          type: "worker.interrupt",
          data: {
            action: "requested",
            signal: "SIGTERM",
            supervisor_pid: state.supervisor_pid,
          },
        },
      ]);
      return { ok: true, data: { slug } };
    }
  } catch {
    // ignore
  }

  return { ok: false, error: `Subagent not running: ${slug}` };
}

export async function killSubagent(
  config: GatewayConfig,
  projectId: string,
  slug: string
): Promise<KillSubagentResult> {
  const root = getProjectsRoot(config);
  const location = await findProjectLocation(root, projectId);
  if (!location) {
    return { ok: false, error: `Project not found: ${projectId}` };
  }

  const projectDir = path.join(location.baseRoot, location.dirName);
  const sessionDir = subagentRunStore.locate(projectDir, slug);
  if (!(await dirExists(sessionDir))) {
    return { ok: false, error: `Subagent not found: ${slug}` };
  }

  const statePath = path.join(sessionDir, "state.json");
  let state: {
    supervisor_pid?: number;
    run_mode?: string;
    worktree_path?: string;
    slice_id?: string;
  } | null = null;
  try {
    const raw = await fs.readFile(statePath, "utf8");
    state = JSON.parse(raw) as {
      supervisor_pid?: number;
      run_mode?: string;
      worktree_path?: string;
      slice_id?: string;
    };
  } catch {
    state = null;
  }

  if (state?.supervisor_pid) {
    try {
      process.kill(state.supervisor_pid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      // ignore
    }
  }

  const workspacesRoot = path.join(getProjectsWorktreeRoot(config), projectId);
  const worktreeDir = path.join(workspacesRoot, slug);
  const worktreePath =
    typeof state?.worktree_path === "string" ? state.worktree_path : "";
  let runMode = typeof state?.run_mode === "string" ? state.run_mode : "";
  if (!runMode) {
    const worktreeHasGitDir = await fs
      .stat(path.join(worktreeDir, ".git"))
      .then(() => true)
      .catch(() => false);
    const worktreeHasGit = worktreePath
      ? await fs
          .stat(path.join(worktreePath, ".git"))
          .then(() => true)
          .catch(() => false)
      : false;
    if (
      worktreePath &&
      path.resolve(worktreePath).startsWith(path.resolve(workspacesRoot)) &&
      (await dirExists(worktreePath)) &&
      worktreeHasGit
    ) {
      runMode = "worktree";
    } else if (worktreeHasGitDir) {
      runMode = "worktree";
    }
  }
  if (!runMode) runMode = "main-run";

  if (
    runMode === "worktree" ||
    runMode === "clone" ||
    runMode === "main-run" ||
    runMode === "none"
  ) {
    const repo = await resolveProjectRepo(
      config,
      projectId,
      projectDir,
      state?.slice_id
    );
    if (runMode === "worktree" && !repo) {
      return { ok: false, error: "Project repo not set" };
    }
    try {
      await getSubagentWorkspaceAdapter(runMode).cleanup({
        config,
        projectId,
        sliceId: state?.slice_id,
        slug,
        projectDir,
        repo,
        mode: runMode,
        baseBranch: "main",
        worktreePath,
      });
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof Error ? err.message : "git worktree remove failed",
      };
    }
  }

  await subagentRunStore.delete(projectDir, slug);

  // Remove parent folder (PRO-XX) if empty
  try {
    const remaining = await fs.readdir(workspacesRoot);
    if (remaining.length === 0) {
      await fs.rmdir(workspacesRoot);
    }
  } catch {
    // ignore - folder may not exist or already removed
  }

  return { ok: true, data: { slug } };
}
