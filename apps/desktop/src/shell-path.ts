import { spawn } from "node:child_process";
import path from "node:path";

const START_MARKER = "__YOPLAI_PATH_START__";
const END_MARKER = "__YOPLAI_PATH_END__";
export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const FALLBACK_DIRECTORIES = ["/opt/homebrew/bin", "/usr/local/bin"];

/** The PATH between the two markers. Noise from the shell startup files is ignored. */
export function parseProbedPath(output: string): string | undefined {
  const start = output.indexOf(START_MARKER);
  if (start === -1) return undefined;
  const end = output.indexOf(END_MARKER, start + START_MARKER.length);
  if (end === -1) return undefined;
  const value = output.slice(start + START_MARKER.length, end).trim();
  return value || undefined;
}

/** When the probe fails: the PATH of the app plus the Homebrew folders. */
export function fallbackPath(parentPath: string | undefined): string {
  const entries = [...FALLBACK_DIRECTORIES, ...(parentPath ?? "").split(path.delimiter)];
  return [...new Set(entries.filter(Boolean))].join(path.delimiter);
}

/** $SHELL when it is an absolute path, else /bin/zsh. */
export function probeShell(shell: string | undefined): string {
  return shell && path.isAbsolute(shell) ? shell : "/bin/zsh";
}

export interface ProbeOptions {
  shell?: string;
  parentEnv: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Ask the login shell for its PATH once. A Finder launch has a short PATH, and the user tools live in the shell
 * startup files. The shell runs in its own group with a time limit and an output limit. The group dies on timeout.
 */
export function probeShellPath(options: ProbeOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const maxBytes = options.maxOutputBytes ?? PROBE_MAX_OUTPUT_BYTES;
  const fallback = fallbackPath(options.parentEnv.PATH);
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(
      probeShell(options.shell ?? options.parentEnv.SHELL),
      ["-ilc", `printf '${START_MARKER}%s${END_MARKER}' "$PATH"`],
      { detached: true, stdio: ["ignore", "pipe", "ignore"], env: options.parentEnv }
    );
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve(value ?? fallback);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > maxBytes) finish(undefined);
    });
    child.once("error", () => finish(undefined));
    child.once("close", () => finish(parseProbedPath(output)));
  });
}
