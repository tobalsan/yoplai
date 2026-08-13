import * as fs from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { expandPath } from "@yoplai/shared";
import type {
  SubagentChangedEvent,
  SubagentLogEvent,
  SubagentParent,
  SubagentRun,
  SubagentRunStatus,
  SubagentRuntimeCli,
} from "@yoplai/shared";

export const SUPPORTED_SUBAGENT_CLIS = ["claude", "codex", "pi"] as const;

export type StartSubagentInput = {
  cli: SubagentRuntimeCli;
  cwd: string;
  prompt: string;
  label: string;
  parent?: SubagentParent;
  projectId?: string;
  sliceId?: string;
  model?: string;
  reasoningEffort?: string;
};

export type ResumeSubagentInput = {
  prompt: string;
};

type StoredConfig = {
  id: string;
  label: string;
  parent?: SubagentParent;
  projectId?: string;
  sliceId?: string;
  cli: SubagentRuntimeCli;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  createdAt: string;
  archived?: boolean;
};

type StoredState = {
  pid?: number;
  cliSessionId?: string;
  piSessionFile?: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  status: SubagentRunStatus;
  lastError?: string;
};

type StoredProgress = {
  lastActiveAt?: string;
  latestOutput?: string;
};

type RuntimeOptions = {
  dataDir: string;
  emit: (event: SubagentChangedEvent) => void;
};

export type LiveSubagentRunSummary = {
  runId: string;
  label: string;
  cli: SubagentRuntimeCli;
  cwd: string;
  status: SubagentRunStatus;
  startedAt: string;
  updatedAt: string;
};

type RunPaths = {
  dir: string;
  config: string;
  state: string;
  progress: string;
  logs: string;
  history: string;
  piSession: string;
};

const activeChildren = new Map<string, ChildProcess>();
const liveRunsById = new Map<string, LiveSubagentRunSummary>();
const startReservations = new Map<string, Promise<void>>();

function runsRoot(dataDir: string): string {
  return path.join(dataDir, "sessions", "subagents", "runs");
}

function runPaths(dataDir: string, runId: string): RunPaths {
  const dir = path.join(runsRoot(dataDir), runId);
  return {
    dir,
    config: path.join(dir, "config.json"),
    state: path.join(dir, "state.json"),
    progress: path.join(dir, "progress.json"),
    logs: path.join(dir, "logs.jsonl"),
    history: path.join(dir, "history.jsonl"),
    piSession: path.join(dir, "pi-session.jsonl"),
  };
}

function parentKey(parent?: SubagentParent): string {
  return parent ? `${parent.type}:${parent.id}` : "";
}

async function canonicalPath(rawPath: string): Promise<string> {
  const expanded = expandPath(rawPath);
  try {
    return await fs.realpath(expanded);
  } catch {
    return path.resolve(expanded);
  }
}

function parseParent(value: string | undefined): SubagentParent | undefined {
  if (!value) return undefined;
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  return { type: value.slice(0, separator), id: value.slice(separator + 1) };
}

function createRunId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `sar_${Date.now().toString(36)}${random}`;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number | undefined, startedAt?: string): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!startedAt) return true;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return true;
  return Date.now() >= started;
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  return fs
    .stat(filePath)
    .then((st) => {
      if (st.isDirectory()) return false;
      if (os.platform() === "win32") return true;
      return (st.mode & 0o111) !== 0;
    })
    .catch(() => false);
}

async function resolveFromPath(execName: string): Promise<string | null> {
  for (const part of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!part) continue;
    const candidate = path.join(part, execName);
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

function commonCandidatePaths(execName: string): string[] {
  const home = homedir();
  const candidates = [path.join(path.dirname(process.execPath), execName)];
  if (home) {
    if (execName === "claude") {
      candidates.push(
        path.join(home, ".claude", "local", "claude"),
        path.join(home, ".claude", "local", "bin", "claude")
      );
    }
    if (execName === "codex") {
      candidates.push(path.join(home, ".cargo", "bin", "codex"));
    }
    candidates.push(
      path.join(home, ".local", "bin", execName),
      path.join(home, "bin", execName),
      path.join(home, ".cargo", "bin", execName)
    );
  }
  if (os.platform() === "darwin") {
    candidates.push(
      path.join("/opt", "homebrew", "bin", execName),
      path.join("/usr", "local", "bin", execName)
    );
  } else {
    candidates.push(path.join("/usr", "local", "bin", execName));
  }
  return Array.from(new Set(candidates));
}

async function resolveCliCommand(
  execName: string,
  args: string[]
): Promise<{ command: string; args: string[] }> {
  if (
    (execName.includes("/") || execName.includes("\\")) &&
    (await isExecutableFile(execName))
  ) {
    return { command: execName, args };
  }
  const fromPath = await resolveFromPath(execName);
  if (fromPath) return { command: fromPath, args };
  for (const candidate of commonCandidatePaths(execName)) {
    if (await isExecutableFile(candidate)) return { command: candidate, args };
  }
  throw new Error(`${execName} not found`);
}

function buildArgs(
  cli: SubagentRuntimeCli,
  prompt: string,
  options: {
    sessionId?: string;
    sessionFile?: string;
    model?: string;
    reasoningEffort?: string;
  }
): string[] {
  switch (cli) {
    case "claude": {
      const args = [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
      ];
      if (options.model) args.push("--model", options.model);
      if (options.reasoningEffort)
        args.push("--effort", options.reasoningEffort);
      return options.sessionId ? ["-r", options.sessionId, ...args] : args;
    }
    case "codex": {
      const args = [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
      ];
      if (options.model) args.push("-m", options.model);
      if (options.reasoningEffort) {
        args.push("-c", `reasoning_effort=${options.reasoningEffort}`);
      }
      return options.sessionId
        ? [...args, "resume", options.sessionId, prompt]
        : [...args, prompt];
    }
    case "pi": {
      if (!options.sessionFile) throw new Error("Missing Pi session file path");
      const args = ["--mode", "json", "--session", options.sessionFile];
      if (options.model) args.push("--model", options.model);
      args.push(prompt);
      return args;
    }
  }
  const unsupported: never = cli;
  throw new Error(`Unsupported CLI: ${unsupported}`);
}

function extractTextFromRawLine(line: string): string {
  const trimmed = line.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.text === "string") return parsed.text;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.content === "string") return parsed.content;
    const item = parsed.item as Record<string, unknown> | undefined;
    if (typeof item?.text === "string") return item.text;
    if (typeof item?.content === "string") return item.content;
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      return content
        .map((part) =>
          part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : ""
        )
        .filter(Boolean)
        .join("\n");
    }
  } catch {
    return trimmed;
  }
  return "";
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNoisyStderr(text: string): boolean {
  return (
    text === "Reading additional input from stdin..." ||
    /\b(?:WARN|ERROR) codex_/.test(text) ||
    text.includes("Failed to terminate MCP process group")
  );
}

function shouldHideParsedLog(parsed: Record<string, unknown>): boolean {
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (
    type === "system" ||
    type === "rate_limit_event" ||
    type === "thread.started" ||
    type === "turn.started" ||
    type === "turn.completed" ||
    type === "agent_start" ||
    type === "agent_settled" ||
    type === "turn_start" ||
    type === "message_start" ||
    type === "message_update" ||
    type === "message_end" ||
    type === "text_start" ||
    type === "text_delta" ||
    type === "text_end" ||
    type === "thinking_start" ||
    type === "thinking_delta" ||
    type === "thinking_end" ||
    type === "thinking" ||
    type === "toolcall_start" ||
    type === "toolcall_delta" ||
    type === "toolcall_end" ||
    type === "tool_execution_start" ||
    type === "tool_execution_update"
  ) {
    return true;
  }
  if (type !== "item.started" && type !== "item.completed") return false;

  const item = getRecord(parsed.item);
  const itemType = typeof item?.type === "string" ? item.type : "";
  if (itemType === "command_execution") return false;
  if (itemType !== "agent_message") return true;
  if (!item) return true;
  return typeof item.text !== "string" || item.text.trim().length === 0;
}

function extractTextFromContentBlocks(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const block = part as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string"
        ? block.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function firstContentBlock(
  content: unknown,
  blockType: string
): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.map(getRecord).find((block) => block?.type === blockType);
}

function normalizeParsedLog(
  parsed: Record<string, unknown>,
  raw: string
): SubagentLogEvent | null {
  if (shouldHideParsedLog(parsed)) return null;
  const type = typeof parsed.type === "string" ? parsed.type : "message";
  if (type === "stderr") {
    const text = extractTextFromRawLine(raw);
    if (isNoisyStderr(text || raw)) return null;
    return { type, text: text || raw };
  }
  if (type === "result") {
    const text = typeof parsed.result === "string" ? parsed.result : "";
    return { type: "result", text };
  }
  if (type === "assistant") {
    const message = getRecord(parsed.message);
    const content = message?.content;
    const text = extractTextFromContentBlocks(content);
    if (text) return { type: "assistant", text };
    const toolUse = firstContentBlock(content, "tool_use");
    if (!toolUse) return null;
    const name = typeof toolUse.name === "string" ? toolUse.name : "";
    const id = typeof toolUse.id === "string" ? toolUse.id : "";
    const input = toolUse.input;
    const inputText =
      input && typeof input === "object" ? JSON.stringify(input, null, 2) : "";
    return { type: "tool_call", text: inputText || name, tool: { name, id } };
  }
  if (type === "user") {
    const message = getRecord(parsed.message);
    const toolResult = firstContentBlock(message?.content, "tool_result");
    if (!toolResult) return null;
    const content = toolResult.content;
    const text =
      typeof content === "string"
        ? content
        : extractTextFromContentBlocks(content);
    const id =
      typeof toolResult.tool_use_id === "string" ? toolResult.tool_use_id : "";
    return text ? { type: "tool_output", text, tool: { id } } : null;
  }
  if (type === "turn_end") {
    const message = getRecord(parsed.message);
    if (message?.role !== "assistant") return null;
    const text = extractTextFromContentBlocks(message.content);
    return text ? { type: "assistant", text } : null;
  }
  if (type === "agent_end") {
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = getRecord(messages[i]);
      if (message?.role !== "assistant") continue;
      const text = extractTextFromContentBlocks(message.content);
      if (text) return { type: "assistant", text };
    }
    return null;
  }
  if (type === "event_msg") {
    const payload = getRecord(parsed.payload);
    const payloadType = typeof payload?.type === "string" ? payload.type : "";
    const message = typeof payload?.message === "string" ? payload.message : "";
    if (payloadType === "user_message" && message) {
      return { type: "user", text: message };
    }
    if (payloadType === "agent_message" && message) {
      return { type: "assistant", text: message };
    }
    return null;
  }

  const text = extractTextFromRawLine(raw);
  return { type, text: text || raw };
}

function normalizeLogLine(line: string): SubagentLogEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return normalizeParsedLog(parsed, trimmed);
  } catch {
    return { type: "stdout", text: trimmed };
  }
}

function visibleOutputText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || isNoisyStderr(trimmed)) return undefined;
  try {
    return normalizeLogLine(trimmed)?.text?.trim() || undefined;
  } catch {
    return trimmed;
  }
}

async function latestOutputFromLogs(
  logsPath: string
): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(logsPath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-50).reverse();
    for (const line of lines) {
      const text = normalizeLogLine(line)?.text?.trim();
      if (text) return text.slice(0, 500);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function toRun(
  dataDir: string,
  runId: string
): Promise<SubagentRun | null> {
  const paths = runPaths(dataDir, runId);
  const config = await readJson<StoredConfig>(paths.config);
  if (!config) return null;
  const state = await readJson<StoredState>(paths.state);
  const progress = await readJson<StoredProgress>(paths.progress);
  let status = state?.status ?? "done";
  if (status === "running" && !isProcessAlive(state?.pid, state?.startedAt)) {
    status = state?.exitCode === 0 ? "done" : "error";
  }
  return {
    id: config.id,
    label: config.label,
    parent: config.parent,
    projectId: config.projectId,
    sliceId: config.sliceId,
    cli: config.cli,
    cwd: config.cwd,
    prompt: config.prompt,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    status,
    pid: state?.pid,
    cliSessionId: state?.cliSessionId,
    startedAt: state?.startedAt ?? config.createdAt,
    lastActiveAt: progress?.lastActiveAt,
    latestOutput:
      visibleOutputText(progress?.latestOutput ?? "") ??
      (await latestOutputFromLogs(paths.logs)),
    finishedAt: state?.finishedAt,
    exitCode: state?.exitCode ?? undefined,
    lastError: state?.lastError,
    archived: config.archived ?? false,
  };
}

async function notifyChanged(
  options: RuntimeOptions,
  runId: string,
  status: SubagentRunStatus
): Promise<void> {
  const run = await toRun(options.dataDir, runId);
  options.emit({
    type: "subagent_changed",
    runId,
    parent: run?.parent,
    status,
  });
}

export function parseSubagentParent(
  value: string | undefined
): SubagentParent | undefined {
  return parseParent(value);
}

export function isSupportedSubagentCli(
  value: string
): value is SubagentRuntimeCli {
  return (SUPPORTED_SUBAGENT_CLIS as readonly string[]).includes(value);
}

export function getUnsupportedSubagentCliError(value: string): string {
  return `Unsupported CLI: ${value}. Supported CLIs: ${SUPPORTED_SUBAGENT_CLIS.join(", ")}.`;
}

export function getLiveSubagentRunsByCwd(): Map<
  string,
  LiveSubagentRunSummary
> {
  const byCwd = new Map<string, LiveSubagentRunSummary>();
  for (const run of liveRunsById.values()) {
    byCwd.set(run.cwd, run);
  }
  return byCwd;
}

export async function listSubagentRuns(
  options: RuntimeOptions,
  filters: {
    parent?: SubagentParent;
    status?: SubagentRunStatus;
    includeArchived?: boolean;
    cwd?: string;
    projectId?: string;
    sliceId?: string;
  } = {}
): Promise<SubagentRun[]> {
  await fs.mkdir(runsRoot(options.dataDir), { recursive: true });
  const entries = await fs.readdir(runsRoot(options.dataDir), {
    withFileTypes: true,
  });
  const runs: SubagentRun[] = [];
  const cwd = filters.cwd ? await canonicalPath(filters.cwd) : undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const run = await toRun(options.dataDir, entry.name);
    if (!run) continue;
    if (!filters.includeArchived && run.archived) continue;
    if (filters.parent && parentKey(run.parent) !== parentKey(filters.parent)) {
      continue;
    }
    if (filters.status && run.status !== filters.status) continue;
    if (cwd && (await canonicalPath(run.cwd)) !== cwd) continue;
    if (filters.projectId && run.projectId !== filters.projectId) continue;
    if (filters.sliceId && run.sliceId !== filters.sliceId) continue;
    runs.push(run);
  }
  return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function getSubagentRun(
  options: RuntimeOptions,
  runId: string
): Promise<SubagentRun | null> {
  return toRun(options.dataDir, runId);
}

export async function startSubagentRun(
  options: RuntimeOptions,
  input: StartSubagentInput
): Promise<SubagentRun> {
  const reservationKey = `${path.resolve(options.dataDir)}:${parentKey(input.parent)}`;
  const previous = startReservations.get(reservationKey) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  startReservations.set(reservationKey, queued);

  await previous;
  try {
    return await startSubagentRunReserved(options, input);
  } finally {
    release();
    if (startReservations.get(reservationKey) === queued) {
      startReservations.delete(reservationKey);
    }
  }
}

async function startSubagentRunReserved(
  options: RuntimeOptions,
  input: StartSubagentInput
): Promise<SubagentRun> {
  if (!isSupportedSubagentCli(input.cli)) {
    throw new Error(getUnsupportedSubagentCliError(input.cli));
  }
  const cwd = path.resolve(input.cwd);
  if (!(await isDirectory(cwd))) throw new Error(`cwd does not exist: ${cwd}`);
  if (!input.prompt.trim()) throw new Error("prompt is required");
  if (!input.label.trim()) throw new Error("label is required");

  const runs = await listSubagentRuns(options, {
    parent: input.parent,
    includeArchived: true,
  });
  if (runs.some((run) => run.label === input.label)) {
    throw new Error(`Subagent label already exists for parent: ${input.label}`);
  }

  const runId = createRunId();
  const paths = runPaths(options.dataDir, runId);
  await fs.mkdir(paths.dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const config: StoredConfig = {
    id: runId,
    label: input.label.trim(),
    parent: input.parent,
    projectId: input.projectId,
    sliceId: input.sliceId,
    cli: input.cli,
    cwd,
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    createdAt: startedAt,
    archived: false,
  };
  await writeJson(paths.config, config);
  await appendJsonl(paths.history, {
    ts: startedAt,
    type: "subagent.started",
    data: { cli: input.cli, label: config.label },
  });

  await spawnRunProcess(options, runId, input.prompt, undefined);
  const run = await toRun(options.dataDir, runId);
  if (!run) throw new Error("Failed to read created subagent run");
  return run;
}

export async function resumeSubagentRun(
  options: RuntimeOptions,
  runId: string,
  input: ResumeSubagentInput
): Promise<SubagentRun> {
  const run = await toRun(options.dataDir, runId);
  if (!run) throw new Error(`Subagent not found: ${runId}`);
  if (run.status === "running" || run.status === "starting") {
    throw new Error(
      "Subagent run is active; interrupt or wait before resuming."
    );
  }
  if (!input.prompt.trim()) throw new Error("prompt is required");
  await spawnRunProcess(options, runId, input.prompt, run.cliSessionId);
  const resumed = await toRun(options.dataDir, runId);
  if (!resumed) throw new Error(`Subagent not found: ${runId}`);
  return resumed;
}

async function spawnRunProcess(
  options: RuntimeOptions,
  runId: string,
  prompt: string,
  sessionId: string | undefined
): Promise<void> {
  const paths = runPaths(options.dataDir, runId);
  const config = await readJson<StoredConfig>(paths.config);
  if (!config) throw new Error(`Subagent config missing: ${runId}`);
  const existingState = await readJson<StoredState>(paths.state);
  const sessionFile = existingState?.piSessionFile ?? paths.piSession;
  const args = buildArgs(config.cli, prompt, {
    sessionId,
    sessionFile,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
  const resolved = await resolveCliCommand(config.cli, args);
  const startedAt = new Date().toISOString();
  const state: StoredState = {
    pid: undefined,
    cliSessionId: sessionId,
    piSessionFile: config.cli === "pi" ? sessionFile : undefined,
    startedAt,
    status: "starting",
  };
  await writeJson(paths.state, state);
  await writeJson(paths.progress, { lastActiveAt: startedAt });
  liveRunsById.set(runId, {
    runId,
    label: config.label,
    cli: config.cli,
    cwd: config.cwd,
    status: "starting",
    startedAt,
    updatedAt: startedAt,
  });
  await appendJsonl(paths.logs, {
    type: "event_msg",
    payload: { type: "user_message", message: prompt },
  });

  const child = spawn(resolved.command, resolved.args, {
    cwd: config.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.set(runId, child);
  await writeJson(paths.state, {
    ...state,
    pid: child.pid,
    status: "running",
  } satisfies StoredState);
  liveRunsById.set(runId, {
    runId,
    label: config.label,
    cli: config.cli,
    cwd: config.cwd,
    status: "running",
    startedAt,
    updatedAt: new Date().toISOString(),
  });
  await notifyChanged(options, runId, "running");

  let outputNotifyAt = 0;
  const updateProgress = async (text: string): Promise<void> => {
    const latestOutput = text
      .split(/\r?\n/)
      .map((line) => normalizeLogLine(line)?.text?.trim() ?? "")
      .filter(Boolean)
      .at(-1);
    const lastActiveAt = new Date().toISOString();
    const currentLive = liveRunsById.get(runId);
    if (currentLive) {
      liveRunsById.set(runId, { ...currentLive, updatedAt: lastActiveAt });
    }
    const current = await readJson<StoredProgress>(paths.progress);
    await writeJson(paths.progress, {
      lastActiveAt,
      latestOutput: latestOutput?.slice(0, 500) ?? current?.latestOutput,
    } satisfies StoredProgress);
    const now = Date.now();
    if (now - outputNotifyAt > 1000) {
      outputNotifyAt = now;
      await notifyChanged(options, runId, "running");
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    void fs
      .appendFile(paths.logs, text, "utf8")
      .then(() => updateProgress(text))
      .catch((error: unknown) => {
        console.warn(
          `[subagents] failed to record stdout progress for ${runId}:`,
          error
        );
      });
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const ev = JSON.parse(line) as {
          type?: string;
          thread_id?: string;
          session_id?: string;
          id?: string;
        };
        const nextSessionId =
          config.cli === "codex" && ev.type === "thread.started"
            ? ev.thread_id
            : config.cli === "claude" && ev.type === "system"
              ? ev.session_id
              : config.cli === "pi" && ev.type === "session"
                ? ev.id
                : undefined;
        if (nextSessionId) {
          void readJson<StoredState>(paths.state)
            .then((current) =>
              writeJson(paths.state, {
                ...(current ?? state),
                cliSessionId: nextSessionId,
              } satisfies StoredState)
            )
            .catch((error: unknown) => {
              console.warn(
                `[subagents] failed to record session id for ${runId}:`,
                error
              );
            });
        }
      } catch {
        // ignore non-json output
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    const lines = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.stringify({ type: "stderr", text: line }))
      .join("\n");
    if (!lines) return;
    void fs
      .appendFile(paths.logs, `${lines}\n`, "utf8")
      .then(() => updateProgress(text))
      .catch((error: unknown) => {
        console.warn(
          `[subagents] failed to record stderr progress for ${runId}:`,
          error
        );
      });
  });

  child.on("error", (error) => {
    void finishRun(options, runId, {
      status: "error",
      exitCode: null,
      signal: null,
      lastError: error.message,
    });
  });

  child.on("exit", (exitCode, signal) => {
    activeChildren.delete(runId);
    void finishRun(options, runId, {
      status: exitCode === 0 ? "done" : "error",
      exitCode,
      signal,
      lastError:
        exitCode === 0
          ? undefined
          : `process exited (code ${exitCode ?? "null"})`,
    });
  });
}

async function finishRun(
  options: RuntimeOptions,
  runId: string,
  patch: Pick<StoredState, "status" | "exitCode" | "signal" | "lastError">
): Promise<void> {
  const paths = runPaths(options.dataDir, runId);
  const current = await readJson<StoredState>(paths.state);
  if (current?.status === "interrupted" && patch.status === "error") return;
  const finishedAt = new Date().toISOString();
  const currentLive = liveRunsById.get(runId);
  if (currentLive) {
    liveRunsById.set(runId, {
      ...currentLive,
      status: patch.status,
      updatedAt: finishedAt,
    });
  }
  await writeJson(paths.state, {
    ...(current ?? { startedAt: finishedAt }),
    ...patch,
    finishedAt,
  } satisfies StoredState);
  await appendJsonl(paths.history, {
    ts: finishedAt,
    type: "subagent.finished",
    data: patch,
  });
  await notifyChanged(options, runId, patch.status);
  liveRunsById.delete(runId);
}

export async function interruptSubagentRun(
  options: RuntimeOptions,
  runId: string
): Promise<SubagentRun> {
  const run = await toRun(options.dataDir, runId);
  if (!run) throw new Error(`Subagent not found: ${runId}`);
  const child = activeChildren.get(runId);
  if (child && !child.killed) child.kill("SIGTERM");
  else if (run.pid) {
    try {
      process.kill(run.pid, "SIGTERM");
    } catch {
      // Already stopped.
    }
  }
  await finishRun(options, runId, {
    status: "interrupted",
    exitCode: null,
    signal: "SIGTERM",
    lastError: undefined,
  });
  const interrupted = await toRun(options.dataDir, runId);
  if (!interrupted) throw new Error(`Subagent not found: ${runId}`);
  return interrupted;
}

export async function setSubagentArchived(
  options: RuntimeOptions,
  runId: string,
  archived: boolean
): Promise<SubagentRun> {
  const paths = runPaths(options.dataDir, runId);
  const config = await readJson<StoredConfig>(paths.config);
  if (!config) throw new Error(`Subagent not found: ${runId}`);
  await writeJson(paths.config, { ...config, archived } satisfies StoredConfig);
  const run = await toRun(options.dataDir, runId);
  if (!run) throw new Error(`Subagent not found: ${runId}`);
  await notifyChanged(options, runId, run.status);
  return run;
}

export async function deleteSubagentRun(
  options: RuntimeOptions,
  runId: string
): Promise<void> {
  const run = await toRun(options.dataDir, runId);
  if (!run) throw new Error(`Subagent not found: ${runId}`);
  if (run.status === "running") {
    await interruptSubagentRun(options, runId);
  }
  await fs.rm(runPaths(options.dataDir, runId).dir, {
    recursive: true,
    force: true,
  });
  options.emit({
    type: "subagent_changed",
    runId,
    parent: run.parent,
    status: run.status,
  });
}

export async function getSubagentLogs(
  options: RuntimeOptions,
  runId: string,
  since: number
): Promise<{ cursor: number; events: SubagentLogEvent[] }> {
  const paths = runPaths(options.dataDir, runId);
  let stat;
  try {
    stat = await fs.stat(paths.logs);
  } catch {
    return { cursor: 0, events: [] };
  }
  const cursor = Math.min(since, stat.size);
  const handle = await fs.open(paths.logs, "r");
  try {
    const length = stat.size - cursor;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, cursor);
    const events = buffer
      .toString("utf8")
      .split(/\r?\n/)
      .map(normalizeLogLine)
      .filter((event): event is SubagentLogEvent => event !== null);
    return { cursor: stat.size, events };
  } finally {
    await handle.close();
  }
}
