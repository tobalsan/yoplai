import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

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
const runningChildren = new Map<ChildProcess, string | undefined>();

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
    readonly exitCode?: number
  ) {
    super(message);
  }
}

export type WakeAgentResult = {
  wake: boolean;
  context?: string;
};

/** Invalid containment, distinct from a missing or unlaunchable script. */
export class ScriptPathError extends Error {}

/**
 * Resolves a job's `script` path against `workspaceDir` and rejects anything
 * that could escape it: absolute paths, `..` segments, and symlink escapes
 * (checked via realpath containment). Returns the script's realpath.
 */
export async function resolveScriptPath(
  workspaceDir: string,
  script: string
): Promise<string> {
  if (path.isAbsolute(script)) {
    throw new ScriptPathError(`script path must be relative: ${script}`);
  }
  if (script.split(/[\\/]+/).includes("..")) {
    throw new ScriptPathError(`script path must not contain '..': ${script}`);
  }

  const resolved = path.resolve(workspaceDir, script);
  const workspaceReal = await fs.realpath(workspaceDir);

  let scriptReal: string;
  try {
    scriptReal = await fs.realpath(resolved);
  } catch {
    throw new Error(`script not found: ${resolved}`);
  }

  const relative = path.relative(workspaceReal, scriptReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ScriptPathError(`script path escapes workspace: ${script}`);
  }

  return scriptReal;
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
  const { workspaceDir, script, timeoutMs } = input;
  const scriptPath = await resolveScriptPath(workspaceDir, script);
  const stat = await fs.stat(scriptPath);
  if (!stat.isFile()) throw new Error(`script ${scriptPath} is not a file`);

  const ext = path.extname(scriptPath);
  let command: string;
  let args: string[];
  if (ext === ".sh" || ext === ".bash") {
    command = "bash";
    args = [scriptPath];
  } else {
    if ((stat.mode & 0o111) === 0) {
      throw new Error(`script ${scriptPath} is not executable`);
    }
    command = scriptPath;
    args = [];
  }

  const child = spawn(command, args, {
    cwd: workspaceDir,
    env: input.env === undefined ? undefined : { ...process.env, ...input.env },
    detached: process.platform !== "win32",
    stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  runningChildren.set(child, input.owner);

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
    ({ timedOut, code, signal } = await waitForExit(child, timeoutMs));
  } finally {
    runningChildren.delete(child);
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
export function terminateRunningScripts(owner?: string): void {
  for (const [child, childOwner] of runningChildren) {
    if (owner !== undefined && childOwner !== owner) continue;
    killScriptProcess(child);
    runningChildren.delete(child);
  }
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number
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
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killScriptProcess(child);
      // SIGKILL normally lands at once, but settle on a bounded grace anyway so
      // a child that never reports its exit cannot hang the job forever.
      killTimer = setTimeout(() => {
        if (settled) return;
        finish();
        resolve({ timedOut: true, code: null, signal: "SIGKILL" });
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);

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
 * serialized `context` value along when present.
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
  if (obj?.wakeAgent === false) return { wake: false };

  const context = obj?.context;
  return {
    wake: true,
    context: context !== undefined ? JSON.stringify(context) : undefined,
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
