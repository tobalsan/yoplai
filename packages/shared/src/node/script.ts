import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { getAgentDataDir } from "../config-path.js";
import type { AgentConfig } from "../types.js";

const MAX_OUTPUT_BYTES = 64 * 1024;
// The head cap above throws away the tail of a chatty stream, but the wakeAgent
// gate line is the *last* line of stdout, so a small rolling tail is kept too.
const TAIL_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n[output truncated]";
// Bounded waits after the child is observed to exit or is killed, so a script
// that leaves a background process holding its stdout pipe cannot wedge a run.
const STDIO_DRAIN_MS = 2_000;
const KILL_GRACE_MS = 5_000;

// Scripts are spawned detached (own process group), so nothing else would clean
// them up when the gateway shuts down; see `terminateRunningScripts`.
const runningScripts = new Map<() => void | Promise<void>, string | undefined>();

export type RunScriptInput = {
  workspaceDir: string;
  script: string;
  timeoutMs: number;
  stdin?: string;
  env?: Record<string, string>;
  owner?: string;
};

export type RunScriptResult = {
  stdout: string;
  stderr: string;
  finalStdoutLine?: string;
};

export class ScriptExecutionError extends Error {
  constructor(
    message: string,
    readonly reason: "exit" | "timeout" | "signal" | "spawn",
    readonly stderrTail: string,
    readonly exitCode?: number,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export type WakeAgentResult = {
  wake: boolean;
  context?: string;
  sessionScope?: string;
  abort?: boolean;
};

/** Invalid containment, distinct from a missing or unlaunchable script. */
export class ScriptPathError extends Error {}

export type ScriptMounts = {
  dataDir: string;
  shadowedPaths?: readonly string[];
};

export function getScriptMounts(agent: AgentConfig, homeDir: string): ScriptMounts | undefined {
  if (!agent.sandbox?.enabled) return undefined;
  return {
    dataDir: getAgentDataDir(homeDir, agent.id),
    shadowedPaths: agent.sandbox.mounts?.map((mount) => mount.container),
  };
}

/**
 * Resolves a job's `script` path against `workspaceDir` and rejects anything
 * that could escape it: absolute paths, `..` segments, and symlink escapes
 * (checked via realpath containment). Returns the script's realpath.
 */
export async function resolveScriptPath(
  workspaceDir: string,
  script: string,
  mounts?: ScriptMounts
): Promise<string> {
  return (await resolveScriptTarget(workspaceDir, script, mounts)).hostPath;
}

async function resolveScriptTarget(workspaceDir: string, script: string, mounts?: ScriptMounts) {
  if (path.isAbsolute(script)) {
    throw new ScriptPathError(`script path must be relative: ${script}`);
  }
  if (script.split(/[\\/]+/).includes("..")) {
    throw new ScriptPathError(`script path must not contain '..': ${script}`);
  }

  const parts = path.normalize(script).split(path.sep);
  const inData = !!mounts && parts[0] === "data";
  const root = inData ? mounts.dataDir : workspaceDir;
  const resolved = path.resolve(root, ...(inData ? parts.slice(1) : parts));
  const isShadowed = (target: string) => target === "/workspace/.env" ||
    mounts?.shadowedPaths?.some((mount) => isAtOrUnder(target, path.posix.resolve(mount)));
  if (mounts && isShadowed(path.posix.join("/workspace", ...parts))) {
    throw new ScriptPathError(`script path resolves to a shadowed workspace path: ${script}`);
  }

  const rootReal = await fs.realpath(root);
  let scriptReal: string;
  try {
    scriptReal = await fs.realpath(resolved);
  } catch {
    throw new Error(`script not found: ${resolved}`);
  }

  const relative = path.relative(rootReal, scriptReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ScriptPathError(`script path escapes workspace: ${script}`);
  }

  if (!mounts) return { hostPath: scriptReal };

  const containerPath = path.posix.join(
    inData ? "/workspace/data" : "/workspace",
    ...relative.split(path.sep)
  );
  if (!inData && isAtOrUnder(containerPath, "/workspace/data")) {
    const dataReal = await fs.realpath(mounts.dataDir).catch(() => undefined);
    if (dataReal !== path.join(rootReal, "data")) {
      throw new ScriptPathError(`script path resolves to a shadowed workspace path: ${script}`);
    }
  }
  if (isShadowed(containerPath)) {
    throw new ScriptPathError(`script path resolves to a shadowed workspace path: ${script}`);
  }
  return { hostPath: scriptReal, containerPath };
}

function isAtOrUnder(target: string, root: string): boolean {
  return target === root || target.startsWith(root === "/" ? root : `${root}/`);
}

/**
 * Resolves `script` (see `resolveScriptPath`) and checks it can be launched:
 * a regular file, run under `bash` when `.sh`/`.bash`, otherwise spawned
 * directly and so required to be executable. Used both at spawn time and when
 * a job is saved, so the two can't disagree on what is runnable.
 */
export async function resolveScriptLaunch(
  workspaceDir: string,
  script: string,
  mounts?: ScriptMounts
): Promise<{ command: string; args: string[]; containerPath?: string }> {
  const { hostPath: scriptPath, containerPath } = await resolveScriptTarget(workspaceDir, script, mounts);
  const stat = await fs.stat(scriptPath);
  if (!stat.isFile()) throw new Error(`script ${scriptPath} is not a file`);

  const ext = path.extname(scriptPath);
  if (ext === ".sh" || ext === ".bash") {
    return { command: "bash", args: [scriptPath], ...(containerPath && { containerPath }) };
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(
      `script ${scriptPath} is not executable: add a shebang (e.g. #!/usr/bin/env python3) and chmod +x it`
    );
  }
  return { command: scriptPath, args: [], ...(containerPath && { containerPath }) };
}

/**
 * Runs a job script as a subprocess and captures its output. `.sh`/`.bash`
 * scripts run under `bash`; anything else must already be executable and is
 * spawned directly. Output is capped at 64 KiB per stream while streaming so
 * a chatty script can't buffer unbounded output, and a timed-out run kills
 * the whole process group so no foreground grandchild lingers.
 */
export async function runScript(
  input: RunScriptInput
): Promise<RunScriptResult> {
  try {
    return await executeScript(input);
  } catch (error) {
    if (error instanceof ScriptExecutionError) throw error;
    const failure = new ScriptExecutionError(
      error instanceof Error ? error.message : String(error), "spawn", ""
    );
    if (error instanceof Error) failure.stack = error.stack;
    throw failure;
  }
}

async function executeScript(input: RunScriptInput): Promise<RunScriptResult> {
  const { workspaceDir, script } = input;
  const { command, args } = await resolveScriptLaunch(workspaceDir, script);
  return runScriptProcess(command, args, input, {
    cwd: workspaceDir,
    env: input.env === undefined ? undefined : { ...process.env, ...input.env },
    track: true,
  });
}

/** Runs a launch command with the same bounded output and timeouts as a host script. */
export async function runScriptProcess(
  command: string,
  args: string[],
  input: Pick<RunScriptInput, "timeoutMs" | "stdin" | "owner">,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; track?: boolean } = {}
): Promise<RunScriptResult> {
  const { timeoutMs } = input;
  if (options.signal?.aborted) {
    if (isTimeoutAbort(options.signal)) {
      throw new ScriptExecutionError(`script exceeded the ${timeoutMs}ms timeout and was killed`, "timeout", "");
    }
    throw new ScriptExecutionError("script failed (exit signal)", "signal", "");
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const untrack = options.track ? trackRunningScript(input.owner, () => killScriptProcess(child)) : undefined;

  const stdoutCap = createOutputCap();
  const stderrCap = createOutputCap();
  child.stdout?.on("data", (chunk: Buffer) => stdoutCap.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderrCap.push(chunk));
  if (input.stdin !== undefined) {
    // A gate may close stdin immediately; its exit status still decides success.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input.stdin);
  }

  let timedOut: boolean;
  let code: number | null;
  let signal: NodeJS.Signals | null;
  try {
    ({ timedOut, code, signal } = await waitForExit(child, timeoutMs, options.signal));
  } finally {
    untrack?.();
  }
  await drainStdio(child, STDIO_DRAIN_MS);

  const stdout = stdoutCap.text();
  const stderr = stderrCap.text();
  const stderrTail = stderrCap.tail();

  if (timedOut) {
    throw new ScriptExecutionError(
      `script exceeded the ${timeoutMs}ms timeout and was killed\nstderr:\n${stderr}\nstdout:\n${stdout}`,
      "timeout", stderrTail
    );
  }
  if (signal) {
    throw new ScriptExecutionError(
      `script failed (exit signal)\nstderr:\n${stderr}\nstdout:\n${stdout}`,
      "signal", stderrTail
    );
  }
  if (code !== 0) {
    throw new ScriptExecutionError(
      `script failed (exit ${code})\nstderr:\n${stderr}\nstdout:\n${stdout}`,
      "exit", stderrTail, code ?? undefined
    );
  }

  return { stdout, stderr, finalStdoutLine: stdoutCap.lastLine() };
}

/**
 * Kills tracked scripts, optionally scoped to one extension's owner tag.
 * With no owner, shutdown retains the scheduler's process-wide cleanup.
 */
export function trackRunningScript(owner: string | undefined, terminate: () => void | Promise<void>): () => void {
  runningScripts.set(terminate, owner);
  return () => runningScripts.delete(terminate);
}

export async function terminateRunningScripts(owner?: string): Promise<void> {
  const pending = [];
  for (const [terminate, scriptOwner] of runningScripts) {
    if (owner !== undefined && scriptOwner !== owner) continue;
    pending.push(terminate());
  }
  const results = await Promise.allSettled(pending);
  const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (failures.length) throw new AggregateError(failures, "Could not terminate all scripts");
}

function isTimeoutAbort(signal: AbortSignal | undefined): boolean {
  return signal?.reason instanceof Error && signal.reason.name === "TimeoutError";
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<{
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;

    const finish = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    const kill = () => {
      if (killTimer !== undefined) return;
      killScriptProcess(child);
      // SIGKILL normally lands at once, but settle on a bounded grace anyway so
      // a child that never reports its exit cannot hang the job forever.
      killTimer = setTimeout(() => {
        if (settled) return;
        finish();
        resolve({ timedOut, code: null, signal: "SIGKILL" });
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => {
      timedOut ||= isTimeoutAbort(abortSignal);
      kill();
    };

    child.on("error", (error) => {
      if (settled) return;
      finish();
      reject(error);
    });

    // `exit`, not `close`: `close` also waits for every stdio pipe to close, so
    // a script that backgrounds a process inheriting stdout would never be seen
    // as finished and would be reported as a timeout despite exiting 0.
    child.on("exit", (exitCode, exitSignal) => {
      if (settled) return;
      finish();
      resolve({ timedOut, code: exitCode, signal: exitSignal });
    });
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
  });
}

/**
 * Waits (briefly) for whatever the child already wrote to reach the capture
 * buffers. Bounded because a backgrounded grandchild can hold the pipes open
 * long after the script itself exited.
 */
async function drainStdio(
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  const streams = [child.stdout, child.stderr].filter(
    (stream): stream is Readable =>
      stream !== null && !stream.readableEnded && !stream.destroyed
  );
  if (streams.length === 0) return;

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), timeoutMs);
    timer.unref?.();
  });
  const ended = Promise.all(
    streams.map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.once("end", () => resolve());
          stream.once("close", () => resolve());
          stream.once("error", () => resolve());
        })
    )
  );

  await Promise.race([ended, deadline]);
  clearTimeout(timer);
}

/**
 * Parses a script's final stdout line as the wakeAgent gate signal.
 * `{"wakeAgent": false}` silences the tick; anything else (including
 * missing/non-JSON/empty input) defaults to waking the agent, carrying the
 * serialized `context` value along when present. A nonblank string scope is
 * preserved verbatim; only a scoped, exactly-true `abort` requests a stop.
 */
export function parseWakeAgent(
  finalLine: string | undefined
): WakeAgentResult {
  if (finalLine === undefined) return { wake: true };

  let value: unknown;
  try {
    value = JSON.parse(finalLine);
  } catch {
    return { wake: true };
  }

  const obj =
    value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  const sessionScope =
    typeof obj?.sessionScope === "string" && obj.sessionScope.trim()
      ? obj.sessionScope
      : undefined;
  const sessionControl = {
    ...(sessionScope !== undefined ? { sessionScope } : {}),
    ...(sessionScope !== undefined && obj?.abort === true ? { abort: true } : {}),
  };
  if (obj?.wakeAgent === false) return { wake: false, ...sessionControl };

  const context = obj?.context;
  return {
    wake: true,
    context: context !== undefined ? JSON.stringify(context) : undefined,
    ...sessionControl,
  };
}

function killScriptProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  // Already reaped: signalling a stale pid could hit an unrelated process group
  // if the OS recycled it.
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Negative pid signals the whole process group (set up via `detached`
    // on POSIX), so a shell script's foreground child dies too.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function createOutputCap() {
  const chunks: Buffer[] = [];
  let length = 0;
  let truncated = false;
  let tail = Buffer.alloc(0);
  return {
    push(chunk: Buffer): void {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TAIL_BYTES) {
        tail = tail.subarray(tail.length - TAIL_BYTES);
      }
      if (length >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const remaining = MAX_OUTPUT_BYTES - length;
      if (chunk.length > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        length += remaining;
        truncated = true;
      } else {
        chunks.push(chunk);
        length += chunk.length;
      }
    },
    text(): string {
      const text = Buffer.concat(chunks).toString("utf8");
      return truncated ? text + TRUNCATION_MARKER : text;
    },
    tail(): string {
      const lines = tail.toString("utf8").replace(/\n$/, "").split("\n").slice(-20).join("\n");
      const bytes = Buffer.from(lines);
      let start = Math.max(0, bytes.length - 2 * 1024);
      while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
      return bytes.subarray(start).toString("utf8");
    },
    // Read from the rolling tail, never from `text()`: the truncation marker
    // would otherwise become the final line and swallow the wakeAgent verdict.
    lastLine(): string | undefined {
      return lastNonEmptyLine(tail.toString("utf8"));
    },
  };
}
