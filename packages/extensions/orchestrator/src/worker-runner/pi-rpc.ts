import { spawn, type ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import type { WorkerRunner, WorkerRunnerHandle, WorkerRunnerStartInput, WorkerRunnerStatus } from "./runner.js";
import { piThinkingForRunner, validateWorkflowThinkingForRunner } from "./thinking.js";
import { sanitizedWorkerEnv } from "./env.js";
import { resolveSessionDir } from "./session-dir.js";

type PiCommandResponse = {
  id?: string | number | null;
  type?: "response" | string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: unknown;
  message?: string;
};

type PendingRequest = {
  resolve: (value: PiCommandResponse) => void;
  reject: (error: Error) => void;
};

type PiSession = {
  key: string;
  child: ChildProcess;
  nextId: number;
  pending: Map<string, PendingRequest>;
  status: WorkerRunnerStatus;
  state?: Record<string, unknown>;
  active: boolean;
  emit: (type: string, payload: unknown) => void;
  stdoutBuffer: string;
  turnTimeoutMs: number;
  turnTimer?: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
  retentionTimer?: NodeJS.Timeout;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageRole(event: Record<string, unknown>): string | undefined {
  return typeof objectValue(event.message)?.role === "string" ? objectValue(event.message)?.role as string : undefined;
}

function commandParts(input: WorkerRunnerStartInput): [string, ...string[]] {
  const command = input.workflow.agent.command;
  if (command) {
    const [cmd, ...args] = Array.isArray(command) ? command : [command];
    if (cmd) return [cmd, ...runnerArgs(input, args)];
  }
  return ["pi", ...runnerArgs(input, ["--mode", "rpc", "--name", input.label], resolveSessionDir(input.workspace, "pi-sessions"))];
}

function runnerArgs(input: WorkerRunnerStartInput, args: string[], sessionDir?: string): string[] {
  const next = [...args];
  const provider = input.workflow.agent.provider ?? input.profile.provider;
  const model = input.workflow.agent.model ?? input.profile.model;
  if (provider) next.push("--provider", provider);
  if (model) next.push("--model", model);
  const thinking = piThinkingForRunner(input);
  if (thinking) next.push("--thinking", thinking);
  if (sessionDir) next.push("--session-dir", sessionDir);
  return next;
}

export class PiRpcRunner implements WorkerRunner {
  private readonly sessions = new Map<string, PiSession>();

  constructor(private readonly options: { idleCleanupMs?: number; terminalRetentionMs?: number; abortTimeoutMs?: number; requestTimeoutMs?: number } = {}) {}

  async start(input: WorkerRunnerStartInput): Promise<WorkerRunnerHandle> {
    validateWorkflowThinkingForRunner("pi", input.workflow.agent);
    const key = `${input.project.id}:${input.issue.id}:${input.workspace}`;
    const existing = this.sessions.get(key);
    if (existing && this.canReuse(existing)) {
      this.cancelCleanup(existing);
      try {
        await this.continueRun(existing, input);
      } catch (error) {
        this.removeSession(existing, "continue_failed");
        throw error;
      }
      return this.handle(input, existing);
    }

    const session = this.spawnSession(key, input);
    this.sessions.set(key, session);
    try {
      await this.prompt(session, input.prompt);
      await this.refreshState(session).catch((error: Error) => session.emit("worker.pi.state.error", { error: error.message }));
    } catch (error) {
      this.removeSession(session, "start_failed");
      throw error;
    }
    return this.handle(input, session);
  }

  async status(handle: WorkerRunnerHandle): Promise<WorkerRunnerStatus | undefined> {
    const session = this.sessionFromHandle(handle);
    if (!session) return undefined;
    return session.status;
  }

  async abort(handle: WorkerRunnerHandle): Promise<void> {
    const session = this.sessionFromHandle(handle);
    if (!session || session.status.status !== "running") return;
    this.clearTurnTimer(session);
    const aborted = await Promise.race([
      this.request(session, "abort", {})
        .then(() => true)
        .catch((error: Error) => {
          session.emit("worker.pi.abort.error", { error: error.message });
          return false;
        }),
      sleep(this.options.abortTimeoutMs ?? 5_000).then(() => false),
    ]);
    if (!aborted) session.emit("worker.pi.abort.timeout", { state: session.state });
    if (aborted && session.status.status === "running") {
      session.active = false;
      session.status = { status: "interrupted", raw: { reason: "abort", state: session.state } };
      this.scheduleIdleCleanup(session);
    } else if (session.status.status === "running") {
      session.child.kill("SIGTERM");
      session.status = { status: "interrupted", raw: { reason: "abort", state: session.state } };
    }
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.cancelCleanup(session);
      for (const pending of session.pending.values()) pending.reject(new Error("Pi RPC runner shut down"));
      session.pending.clear();
      if (session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) {
        session.child.stdin?.end();
        session.child.kill("SIGTERM");
      }
      this.sessions.delete(session.key);
      session.emit("worker.pi.session.removed", { state: session.state, reason: "shutdown" });
    }
  }

  private spawnSession(key: string, input: WorkerRunnerStartInput): PiSession {
    const sessionDir = resolveSessionDir(input.workspace, "pi-sessions");
    fsSync.mkdirSync(sessionDir, { recursive: true });
    const [cmd, ...args] = commandParts(input);
    const child = spawn(cmd, args, {
      cwd: input.workspace,
      env: sanitizedWorkerEnv({
        YOPLAI_RUN_ID: input.runId,
        YOPLAI_PROJECT_ID: input.project.id,
        YOPLAI_ISSUE_ID: input.issue.id,
        YOPLAI_ISSUE_IDENTIFIER: input.issue.identifier,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    const session: PiSession = {
      key,
      child,
      nextId: 1,
      pending: new Map(),
      status: { status: "running", raw: { pid: child.pid } },
      active: false,
      emit: input.emitEvent ?? (() => undefined),
      stdoutBuffer: "",
      turnTimeoutMs: input.workflow.agent.turn_timeout_ms ?? 3_600_000,
    };
    child.once("error", (error) => {
      session.status = { status: "error", raw: { message: error.message, code: (error as NodeJS.ErrnoException).code, state: session.state } };
      session.emit("worker.pi.process.error", session.status.raw);
    });
    child.once("exit", (code, signal) => {
      this.clearTurnTimer(session);
      if (session.status.status === "running") {
        session.status = signal === "SIGTERM" || signal === "SIGINT"
          ? { status: "interrupted", exitCode: code ?? undefined, raw: { code, signal, state: session.state } }
          : code === 0
            ? { status: "done", exitCode: 0, raw: { code, signal, state: session.state } }
            : { status: "error", exitCode: code ?? undefined, raw: { code, signal, state: session.state } };
      }
      for (const pending of session.pending.values()) pending.reject(new Error(`Pi RPC process exited before responding (${signal ?? code ?? "unknown"})`));
      session.pending.clear();
      this.cancelCleanup(session);
      if (this.sessions.get(session.key) === session) this.scheduleRetentionCleanup(session);
      session.emit("worker.pi.process.exit", { status: session.status.status, exitCode: session.status.exitCode, raw: session.status.raw });
    });
    child.stderr?.on("data", (chunk: Buffer) => session.emit("worker.pi.stderr", { text: chunk.toString("utf8") }));
    child.stdout?.on("data", (chunk: Buffer) => this.receiveChunk(session, chunk.toString("utf8")));
    session.emit("worker.pi.started", { pid: child.pid, command: [cmd, ...args] });
    return session;
  }

  private async prompt(session: PiSession, message: string): Promise<void> {
    session.status = { status: "running", raw: { pid: session.child.pid, state: session.state } };
    await this.request(session, "prompt", { message });
    session.active = true;
    this.startTurnTimer(session);
    session.emit("worker.pi.prompt.accepted", { state: session.state });
  }

  private async continueRun(session: PiSession, input: WorkerRunnerStartInput): Promise<void> {
    const guidance = `Continue the active orchestrator work for ${input.issue.identifier}. Reuse the current Pi session context and continue from the latest state.`;
    if (session.active || session.status.status === "running") {
      await this.request(session, "follow_up", { message: guidance });
      session.emit("worker.pi.continued", { mode: "follow_up", state: session.state });
      return;
    }
    await this.prompt(session, guidance);
    session.emit("worker.pi.continued", { mode: "prompt", state: session.state });
  }

  private async refreshState(session: PiSession): Promise<void> {
    const response = await this.request(session, "get_state", {});
    const state = objectValue(response.data);
    if (state) {
      session.state = state;
      session.status = { ...session.status, raw: { ...(objectValue(session.status.raw) ?? {}), state } };
      session.emit("worker.pi.state", state);
    }
  }

  private request(session: PiSession, type: string, params: Record<string, unknown>): Promise<PiCommandResponse> {
    const id = `req-${session.nextId++}`;
    const payload = JSON.stringify({ id, type, ...params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`Pi RPC ${type} timed out`));
      }, this.options.requestTimeoutMs ?? 30_000);
      session.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      session.child.stdin?.write(`${payload}\n`, (error) => {
        if (!error) return;
        session.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private receiveChunk(session: PiSession, chunk: string): void {
    session.stdoutBuffer += chunk;
    for (;;) {
      const index = session.stdoutBuffer.indexOf("\n");
      if (index === -1) return;
      const line = session.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      session.stdoutBuffer = session.stdoutBuffer.slice(index + 1);
      this.receiveLine(session, line);
    }
  }

  private receiveLine(session: PiSession, line: string): void {
    if (!line.trim()) return;
    let message: PiCommandResponse & Record<string, unknown>;
    try {
      message = JSON.parse(line) as PiCommandResponse & Record<string, unknown>;
    } catch (error) {
      session.emit("worker.pi.protocol.error", { error: error instanceof Error ? error.message : String(error), line });
      return;
    }
    if ((typeof message.id === "string" || typeof message.id === "number") && message.type === "response") {
      const id = String(message.id);
      const pending = session.pending.get(id);
      if (pending) {
        session.pending.delete(id);
        if (message.success === false) pending.reject(new Error(this.responseError(message)));
        else pending.resolve(message);
        return;
      }
    }
    this.handleEvent(session, message);
  }

  private responseError(message: PiCommandResponse): string {
    const error = objectValue(message.error);
    if (typeof error?.message === "string") return error.message;
    if (typeof message.message === "string") return message.message;
    if (typeof message.error === "string") return message.error;
    return `Pi RPC ${message.command ?? "command"} failed`;
  }

  private handleEvent(session: PiSession, event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "unknown";
    if (type === "agent_start") {
      session.active = true;
      session.status = { status: "running", raw: { ...(objectValue(session.status.raw) ?? {}), state: session.state } };
    } else if (type === "agent_end") {
      this.clearTurnTimer(session);
      session.active = false;
      if (session.status.status === "running") session.status = { status: "done", exitCode: 0, raw: { event, state: session.state } };
      this.scheduleIdleCleanup(session);
    } else if (type === "extension_error") {
      this.clearTurnTimer(session);
      session.active = false;
      if (session.status.status === "running") session.status = { status: "error", raw: { event, state: session.state } };
      this.scheduleIdleCleanup(session);
    } else if (type === "auto_retry_start" || type === "auto_retry_end") {
      session.emit("worker.pi.retry", event);
    } else if (type === "queue_update") {
      session.emit("worker.pi.queue", event);
    }

    const assistantEvent = objectValue(event.assistantMessageEvent);
    if (type === "message_update" && assistantEvent) {
      this.handleMessageUpdate(session, event, assistantEvent);
      return;
    }
    if (type === "message_start" || type === "message_end" || type === "turn_end" || type === "agent_end") {
      if (messageRole(event) === "assistant") session.emit("worker.pi.message", event);
      session.emit(`worker.pi.${type}`, event);
      return;
    }
    if (type.startsWith("tool_execution_")) {
      session.emit("worker.pi.tool", event);
      session.emit(`worker.pi.${type}`, event);
      return;
    }
    if (type === "compaction_start" || type === "compaction_end") {
      session.emit("worker.pi.compaction", event);
      session.emit(`worker.pi.${type}`, event);
      return;
    }
    session.emit(`worker.pi.${type}`, event);
  }

  private handleMessageUpdate(session: PiSession, event: Record<string, unknown>, assistantEvent: Record<string, unknown>): void {
    const deltaType = typeof assistantEvent.type === "string" ? assistantEvent.type : "unknown";
    if (deltaType.startsWith("toolcall_")) {
      session.emit("worker.pi.tool", event);
    } else if (deltaType === "error") {
      this.clearTurnTimer(session);
      const reason = typeof assistantEvent.reason === "string" ? assistantEvent.reason : undefined;
      session.active = false;
      if (session.status.status === "running") {
        session.status = reason === "aborted"
          ? { status: "interrupted", raw: { event, state: session.state } }
          : { status: "error", raw: { event, state: session.state } };
      }
      this.scheduleIdleCleanup(session);
    }
  }

  private handle(input: WorkerRunnerStartInput, session: PiSession): WorkerRunnerHandle {
    return {
      id: `pi:${input.runId}:${String(session.state?.sessionId ?? session.child.pid ?? "unknown")}`,
      kind: "pi",
      pid: session.child.pid,
      raw: { pid: session.child.pid, state: session.state },
    };
  }

  private sessionFromHandle(handle: WorkerRunnerHandle): PiSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.child.pid === handle.pid) return session;
      const sessionId = session.state?.sessionId;
      if (typeof sessionId === "string" && handle.id.includes(sessionId)) return session;
    }
    return undefined;
  }

  private canReuse(session: PiSession): boolean {
    return session.child.exitCode === null && session.child.signalCode === null && !session.child.killed && (session.status.status === "running" || session.status.status === "done");
  }

  private scheduleIdleCleanup(session: PiSession): void {
    if (session.cleanupTimer) return;
    session.cleanupTimer = setTimeout(() => {
      session.child.stdin?.end();
      if (session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) {
        session.child.kill("SIGTERM");
      } else {
        this.scheduleRetentionCleanup(session);
      }
    }, this.options.idleCleanupMs ?? 30_000);
  }

  private scheduleRetentionCleanup(session: PiSession): void {
    if (session.retentionTimer) return;
    session.retentionTimer = setTimeout(() => {
      this.sessions.delete(session.key);
      session.emit("worker.pi.session.removed", { state: session.state });
    }, this.options.terminalRetentionMs ?? 300_000);
  }

  private cancelCleanup(session: PiSession): void {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session.retentionTimer) clearTimeout(session.retentionTimer);
    session.cleanupTimer = undefined;
    session.retentionTimer = undefined;
  }

  private removeSession(session: PiSession, reason: string): void {
    this.clearTurnTimer(session);
    this.cancelCleanup(session);
    for (const pending of session.pending.values()) pending.reject(new Error(`Pi RPC session removed: ${reason}`));
    session.pending.clear();
    if (session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) {
      session.child.stdin?.end();
      session.child.kill("SIGTERM");
    }
    this.sessions.delete(session.key);
    session.emit("worker.pi.session.removed", { state: session.state, reason });
  }

  private startTurnTimer(session: PiSession): void {
    this.clearTurnTimer(session);
    session.turnTimer = setTimeout(() => {
      session.turnTimer = undefined;
      if (session.status.status !== "running") return;
      session.active = false;
      session.status = { status: "interrupted", raw: { reason: "turn_timeout", turnTimeoutMs: session.turnTimeoutMs, state: session.state } };
      session.emit("worker.pi.turn.timeout", { turnTimeoutMs: session.turnTimeoutMs, state: session.state });
      Promise.race([
        this.request(session, "abort", {}).then(() => true).catch(() => false),
        sleep(this.options.abortTimeoutMs ?? 5_000).then(() => false),
      ]).then((aborted) => {
        if (!aborted && session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) {
          session.child.kill("SIGTERM");
        }
        this.scheduleIdleCleanup(session);
      }).catch(() => undefined);
    }, session.turnTimeoutMs);
  }

  private clearTurnTimer(session: PiSession): void {
    if (session.turnTimer) {
      clearTimeout(session.turnTimer);
      session.turnTimer = undefined;
    }
  }
}
