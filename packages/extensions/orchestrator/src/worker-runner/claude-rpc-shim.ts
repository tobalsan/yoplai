#!/usr/bin/env node
import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { resolveSessionDir } from "./session-dir.js";

type RpcRequest = {
  id?: string | number;
  type?: string;
  message?: string;
};

type ShimOptions = {
  name: string;
  sessionDir: string;
  claudeCli: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
};

let activeChild: ChildProcess | undefined;
let active = false;
let currentSessionId: string | undefined;
const queuedMessages: string[] = [];
let pendingMessages = 0;
let aborted = false;
let activeRunFailed = false;

function parseArgs(argv: string[]): ShimOptions {
  const options: ShimOptions = { name: "claude", sessionDir: resolveSessionDir(process.cwd(), "claude-sessions"), claudeCli: "claude" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--name" && value) {
      options.name = value;
      index += 1;
    } else if (key === "--session-dir" && value) {
      options.sessionDir = value;
      index += 1;
    } else if (key === "--claude-cli" && value) {
      options.claudeCli = value;
      index += 1;
    } else if (key === "--model" && value) {
      options.model = value;
      index += 1;
    } else if (key === "--effort" && value) {
      options.effort = value;
      index += 1;
    } else if (key === "--permission-mode" && value) {
      options.permissionMode = value;
      index += 1;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
fsSync.mkdirSync(options.sessionDir, { recursive: true });

function write(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: string | number | undefined, command: string, success: boolean, extra: Record<string, unknown> = {}): void {
  if (id === undefined) return;
  write({ id, type: "response", command, success, ...extra });
}

function sessionFile(): string | undefined {
  return currentSessionId ? path.join(options.sessionDir, `${currentSessionId}.jsonl`) : undefined;
}

function saveEvent(event: Record<string, unknown>): void {
  const file = sessionFile();
  if (!file) return;
  fsSync.appendFileSync(file, `${JSON.stringify(event)}\n`);
}

function updateSessionId(event: Record<string, unknown>): void {
  const value = event.session_id ?? event.sessionId;
  if (typeof value === "string" && value.trim()) currentSessionId = value;
}

function claudeArgs(message: string): string[] {
  const args = ["--print", "--output-format", "stream-json", "--verbose"];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (currentSessionId) args.push("--resume", currentSessionId);
  args.push(message);
  return args;
}

function startClaude(message: string): void {
  aborted = false;
  activeRunFailed = false;
  active = true;
  pendingMessages = Math.max(0, pendingMessages - 1);
  write({ type: "queue_update", pendingMessageCount: pendingMessages });
  write({ type: "session_start", name: options.name, sessionId: currentSessionId });
  const child = spawn(options.claudeCli, claudeArgs(message), {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });
  activeChild = child;
  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    for (;;) {
      const index = stdoutBuffer.indexOf("\n");
      if (index === -1) return;
      const line = stdoutBuffer.slice(0, index).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
        const status = typeof event.status === "string" ? event.status : undefined;
        if (event.type === "error" || subtype === "error" || status === "error" || status === "failed" || event.is_error === true) activeRunFailed = true;
        updateSessionId(event);
        saveEvent(event);
        write(event);
      } catch (error) {
        write({ type: "protocol_warning", source: "claude_stdout", error: error instanceof Error ? error.message : String(error), line });
      }
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => write({ type: "stderr", text: chunk.toString("utf8") }));
  child.once("error", (error) => {
    active = false;
    activeChild = undefined;
    write({ type: "error", error: { message: error.message, code: (error as NodeJS.ErrnoException).code } });
  });
  child.once("exit", (code, signal) => {
    active = false;
    activeChild = undefined;
    if (aborted || signal === "SIGTERM" || signal === "SIGINT") {
      write({ type: "error", error: { message: "Claude run aborted", reason: "aborted" }, code, signal });
    } else if (code && code !== 0) {
      activeRunFailed = true;
      write({ type: "result", subtype: "error", code, signal });
    }
    if (activeRunFailed) {
      queuedMessages.length = 0;
      pendingMessages = 0;
      write({ type: "queue_update", pendingMessageCount: pendingMessages });
    } else if (!aborted && queuedMessages.length > 0) {
      const next = queuedMessages.shift()!;
      const delay = Number(process.env.MOCK_CLAUDE_QUEUE_DELAY_MS ?? "0");
      if (delay > 0) setTimeout(() => startClaude(next), delay);
      else startClaude(next);
    }
  });
}

function handle(request: RpcRequest): void {
  const id = request.id;
  const command = request.type ?? "unknown";
  if (command === "prompt" || command === "follow_up") {
    if (typeof request.message !== "string" || !request.message.trim()) {
      respond(id, command, false, { error: { message: `${command} requires message` } });
      return;
    }
    if (active) {
      queuedMessages.push(request.message);
      pendingMessages += 1;
      respond(id, command, true, { data: { queued: true, pendingMessageCount: pendingMessages } });
      write({ type: "queue_update", pendingMessageCount: pendingMessages });
      return;
    }
    pendingMessages += 1;
    respond(id, command, true);
    write({ type: "queue_update", pendingMessageCount: pendingMessages });
    startClaude(request.message);
    return;
  }
  if (command === "get_state") {
    respond(id, command, true, { data: { sessionId: currentSessionId, sessionFile: sessionFile(), isStreaming: active, pendingMessageCount: pendingMessages, queuedMessageCount: queuedMessages.length } });
    return;
  }
  if (command === "abort") {
    aborted = true;
    queuedMessages.length = 0;
    pendingMessages = 0;
    if (activeChild && active) activeChild.kill("SIGTERM");
    respond(id, command, true, { data: { sessionId: currentSessionId, isStreaming: active } });
    return;
  }
  respond(id, command, false, { error: { message: `Unsupported Claude RPC command: ${command}` } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line) as RpcRequest);
  } catch (error) {
    write({ type: "protocol_error", error: { message: error instanceof Error ? error.message : String(error) } });
  }
});
