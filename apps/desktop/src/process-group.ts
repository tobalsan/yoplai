import { spawn, type ChildProcess } from "node:child_process";

export const STOP_GRACE_MS = 10_000;

export interface GroupChild {
  name: string;
  child: ChildProcess;
}

export interface StartGroupOptions {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLine: (line: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/** Start a child in its own process group. Output goes to onLine. */
export function startGroup(options: StartGroupOptions): GroupChild {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    let partial = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) options.onLine(`[${options.name}] ${line}`);
    });
    stream?.on("end", () => {
      if (partial) options.onLine(`[${options.name}] ${partial}`);
    });
  }
  child.on("error", (err) => options.onLine(`[${options.name}] ${err.message}`));
  child.on("exit", options.onExit);
  return { name: options.name, child };
}

export interface StopGroupDeps {
  /** Send a signal to a process group (negative pid). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** True while any process of the group is alive. */
  isGroupAlive?: (pgid: number) => boolean;
  graceMs?: number;
  pollMs?: number;
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultIsGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGTERM the group. After graceMs, SIGKILL the group if still alive. */
export async function stopGroup(pgid: number, deps: StopGroupDeps = {}): Promise<"terminated" | "killed"> {
  const kill = deps.kill ?? defaultKill;
  const isAlive = deps.isGroupAlive ?? defaultIsGroupAlive;
  const graceMs = deps.graceMs ?? STOP_GRACE_MS;
  const pollMs = deps.pollMs ?? 100;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      kill(-pgid, signal);
    } catch {
      // Group already gone.
    }
  };
  signalGroup("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (isAlive(pgid)) {
    if (Date.now() >= deadline) {
      signalGroup("SIGKILL");
      return "killed";
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return "terminated";
}
