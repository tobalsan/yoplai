import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { WorkerRunner, WorkerRunnerHandle, WorkerRunnerStartInput, WorkerRunnerStatus } from "./runner.js";
import { reasoningEffortForRunner, validateWorkflowThinkingForRunner } from "./thinking.js";
import { sanitizedWorkerEnv } from "./env.js";

type JsonRpcMessage = {
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer?: NodeJS.Timeout;
};

type CodexSession = {
  key: string;
  child: ChildProcess;
  nextId: number;
  pending: Map<string | number, PendingRequest>;
  status: WorkerRunnerStatus;
  threadId?: string;
  turnId?: string;
  activeTurn: boolean;
  initialized: Promise<void>;
  emit: (type: string, payload: unknown) => void;
  turnTimeoutMs: number;
  turnTimer?: NodeJS.Timeout;
  idleSettleMs?: number;
  settleTimer?: NodeJS.Timeout;
  pendingTurnStatus?: WorkerRunnerStatus;
  activeItemIds: Set<string>;
  itemWatchdogs: Map<string, NodeJS.Timeout>;
  cleanupTimer?: NodeJS.Timeout;
  retentionTimer?: NodeJS.Timeout;
  removed?: boolean;
};

function commandParts(command: string | string[] | undefined): [string, ...string[]] {
  const [cmd, ...args] = Array.isArray(command) ? command : command ? [command] : [];
  if (!cmd) return ["codex", "app-server"];
  return [cmd, ...args];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textFromInput(input: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: input }];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codexApprovalPolicy(input: WorkerRunnerStartInput): unknown {
  return input.workflow.agent.settings?.approvalPolicy ?? input.workflow.agent.settings?.approval_policy ?? "never";
}

function codexSandboxPolicy(input: WorkerRunnerStartInput): unknown {
  const configured = input.workflow.agent.settings?.sandboxPolicy ?? input.workflow.agent.settings?.sandbox_policy;
  if (configured) return configured;
  const sandbox = input.workflow.agent.settings?.sandbox ?? input.workflow.agent.settings?.sandboxMode ?? input.workflow.agent.settings?.sandbox_mode;
  if (sandbox === "danger-full-access" || sandbox === "dangerFullAccess") return { type: "dangerFullAccess" };
  if (sandbox === "workspace-write" || sandbox === "workspaceWrite") return { type: "workspaceWrite", writableRoots: [input.workspace], networkAccess: true };
  if (sandbox === "read-only" || sandbox === "readOnly") return { type: "readOnly" };
  return { type: "dangerFullAccess" };
}

function codexThreadSandbox(input: WorkerRunnerStartInput): string | undefined {
  const policy = codexSandboxPolicy(input);
  if (typeof policy === "string") return policy === "dangerFullAccess" ? "danger-full-access" : policy === "workspaceWrite" ? "workspace-write" : policy;
  const type = objectValue(policy)?.type;
  if (type === "dangerFullAccess") return "danger-full-access";
  if (type === "workspaceWrite") return "workspace-write";
  if (type === "readOnly") return "read-only";
  return typeof type === "string" ? type : undefined;
}

export class CodexAppServerRunner implements WorkerRunner {
  private readonly sessions = new Map<string, CodexSession>();

  constructor(private readonly options: { idleSettleMs?: number; maxItemAgeMs?: number; idleCleanupMs?: number; terminalRetentionMs?: number; interruptTimeoutMs?: number; requestTimeoutMs?: number } = {}) {}

  async start(input: WorkerRunnerStartInput): Promise<WorkerRunnerHandle> {
    validateWorkflowThinkingForRunner("codex", input.workflow.agent);
    const key = `${input.project.id}:${input.issue.id}:${input.workspace}`;
    const existing = this.sessions.get(key);
    if (existing && this.canReuse(existing)) {
      this.cancelCleanup(existing);
      try {
        await this.continueTurn(existing, input);
        return this.handle(input, existing);
      } catch (error) {
        this.removeSession(existing, "continue_failed");
        throw error;
      }
    }
    if (existing) this.removeSession(existing, "replaced");

    const session = this.spawnSession(key, input);
    this.sessions.set(key, session);
    try {
      await session.initialized;
      const thread = await this.request(session, "thread/start", {
        model: input.workflow.agent.model ?? input.profile.model,
        cwd: input.workspace,
        approvalPolicy: codexApprovalPolicy(input),
        sandbox: codexThreadSandbox(input),
        serviceName: "yoplai-orchestrator",
      });
      session.threadId = this.extractThreadId(thread);
      session.emit("worker.codex.thread.started", { threadId: session.threadId, raw: thread });
      await this.startTurn(session, input.prompt, input);
      return this.handle(input, session);
    } catch (error) {
      this.removeSession(session, "start_failed");
      throw error;
    }
  }

  async status(handle: WorkerRunnerHandle): Promise<WorkerRunnerStatus | undefined> {
    const session = this.sessionFromHandle(handle);
    return session?.status;
  }

  async abort(handle: WorkerRunnerHandle): Promise<void> {
    const session = this.sessionFromHandle(handle);
    if (!session || session.status.status !== "running") return;
    this.clearTurnTimer(session);
    this.cancelIdleSettle(session);
    if (session.threadId && session.turnId && session.activeTurn) {
      const interrupted = await Promise.race([
        this.request(session, "turn/interrupt", { threadId: session.threadId, turnId: session.turnId })
          .then(() => true)
          .catch((error: Error) => {
            session.emit("worker.codex.interrupt.error", { error: error.message });
            return false;
          }),
        sleep(this.options.interruptTimeoutMs ?? 5_000).then(() => false),
      ]);
      if (!interrupted) session.emit("worker.codex.interrupt.timeout", { threadId: session.threadId, turnId: session.turnId });
    }
    if (session.status.status === "running") {
      session.child.kill("SIGTERM");
      session.status = { status: "interrupted", raw: { reason: "abort" } };
    }
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.removeSession(session, "shutdown");
    }
  }

  private spawnSession(key: string, input: WorkerRunnerStartInput): CodexSession {
    const [cmd, ...args] = commandParts(input.workflow.agent.command);
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
    const session: CodexSession = {
      key,
      child,
      nextId: 1,
      pending: new Map(),
      status: { status: "running", raw: { pid: child.pid } },
      activeTurn: false,
      initialized: Promise.resolve(),
      emit: input.emitEvent ?? (() => undefined),
      turnTimeoutMs: input.workflow.agent.turn_timeout_ms ?? 3_600_000,
      idleSettleMs: typeof input.workflow.agent.idle_settle_ms === "number" ? input.workflow.agent.idle_settle_ms : this.options.idleSettleMs,
      activeItemIds: new Set(),
      itemWatchdogs: new Map(),
    };
    child.once("error", (error) => {
      session.status = { status: "error", raw: { message: error.message, code: (error as NodeJS.ErrnoException).code } };
      session.emit("worker.codex.process.error", session.status.raw);
    });
    child.once("exit", (code, signal) => {
      this.clearTurnTimer(session);
      if (session.status.status === "running") {
        session.status = signal === "SIGTERM" || signal === "SIGINT"
          ? { status: "interrupted", exitCode: code ?? undefined, raw: { code, signal } }
          : code === 0
            ? { status: "done", exitCode: 0, raw: { code, signal } }
            : { status: "error", exitCode: code ?? undefined, raw: { code, signal } };
      }
      this.rejectPending(session, new Error(`Codex app-server exited before responding (${signal ?? code ?? "unknown"})`));
      this.cancelCleanup(session);
      if (this.sessions.get(session.key) === session) this.scheduleRetentionCleanup(session);
      session.emit("worker.codex.process.exit", { status: session.status.status, exitCode: session.status.exitCode, raw: session.status.raw });
    });
    child.stderr?.on("data", (chunk: Buffer) => session.emit("worker.codex.stderr", { text: chunk.toString("utf8") }));
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => this.receive(session, line));
    session.initialized = this.initialize(session, input);
    return session;
  }

  private async initialize(session: CodexSession, input: WorkerRunnerStartInput): Promise<void> {
    await this.request(session, "initialize", {
      clientInfo: { name: "yoplai-orchestrator", version: "0.1.0" },
      capabilities: { experimentalApi: true },
      cwd: input.workspace,
    });
    this.notify(session, "initialized", {});
    session.emit("worker.codex.initialized", { pid: session.child.pid });
  }

  private async startTurn(session: CodexSession, prompt: string, input: WorkerRunnerStartInput): Promise<void> {
    if (!session.threadId) throw new Error("Codex thread was not started");
    session.status = { status: "running", raw: { pid: session.child.pid, threadId: session.threadId } };
    const result = await this.request(session, "turn/start", {
      threadId: session.threadId,
      input: textFromInput(prompt),
      cwd: input.workspace,
      model: input.workflow.agent.model ?? input.profile.model,
      approvalPolicy: codexApprovalPolicy(input),
      sandboxPolicy: codexSandboxPolicy(input),
      effort: reasoningEffortForRunner(input),
    });
    session.turnId = this.extractTurnId(result);
    this.startTurnTimer(session);
    session.emit("worker.codex.turn.started.request", { threadId: session.threadId, turnId: session.turnId, raw: result });
  }

  private async continueTurn(session: CodexSession, input: WorkerRunnerStartInput): Promise<void> {
    if (input.emitEvent !== undefined) session.emit = input.emitEvent;
    session.idleSettleMs = typeof input.workflow.agent.idle_settle_ms === "number" ? input.workflow.agent.idle_settle_ms : this.options.idleSettleMs;
    const guidance = `Continue the active orchestrator work for ${input.issue.identifier}. Reuse the current thread context and continue from the latest state.`;
    if (session.threadId && session.activeTurn && session.turnId) {
      await this.request(session, "turn/steer", { threadId: session.threadId, expectedTurnId: session.turnId, input: textFromInput(guidance) });
      session.emit("worker.codex.turn.continued", { mode: "steer", threadId: session.threadId, turnId: session.turnId });
      return;
    }
    await this.startTurn(session, guidance, input);
    session.emit("worker.codex.turn.continued", { mode: "new_turn", threadId: session.threadId, turnId: session.turnId });
  }

  private request(session: CodexSession, method: string, params: unknown): Promise<unknown> {
    const id = session.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject, method };
      const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
      pending.timer = setTimeout(() => {
        session.pending.delete(id);
        const error = new Error(`Codex app-server request timed out: ${method}`);
        session.emit("worker.codex.request.timeout", { method, id, timeoutMs });
        reject(error);
      }, timeoutMs);
      session.pending.set(id, pending);
      session.child.stdin?.write(`${payload}\n`, (error) => {
        if (!error) return;
        const pending = session.pending.get(id);
        if (pending?.timer) clearTimeout(pending.timer);
        session.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(session: CodexSession, method: string, params: unknown): void {
    session.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private respond(session: CodexSession, id: string | number, result: unknown): void {
    session.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  private rejectRequest(session: CodexSession, id: string | number, message: string): void {
    session.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`);
  }

  private receive(session: CodexSession, line: string): void {
    if (session.removed) return;
    if (!line.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      session.emit("worker.codex.protocol.error", { error: error instanceof Error ? error.message : String(error), line });
      return;
    }
    if ((typeof message.id === "string" || typeof message.id === "number") && session.pending.has(message.id)) {
      const pending = session.pending.get(message.id)!;
      session.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      else pending.resolve(message.result);
      return;
    }
    if ((typeof message.id === "string" || typeof message.id === "number") && message.method) {
      this.handleServerRequest(session, message.id, message);
      return;
    }
    if (message.method) this.handleNotification(session, message);
  }

  private handleServerRequest(session: CodexSession, id: string | number, message: JsonRpcMessage): void {
    session.emit("worker.codex.server_request", { id, method: message.method, params: message.params });
    if (message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval") {
      this.respond(session, id, "cancel");
      return;
    }
    this.rejectRequest(session, id, `Unsupported Codex app-server request: ${message.method ?? "unknown"}`);
  }

  private handleNotification(session: CodexSession, message: JsonRpcMessage): void {
    const method = message.method!;
    const params = objectValue(message.params);
    if (method === "turn/started") {
      const turn = objectValue(params?.turn);
      session.turnId = typeof turn?.id === "string" ? turn.id : session.turnId;
      session.activeTurn = true;
      this.cancelIdleSettle(session);
      this.startTurnTimer(session);
    } else if (method === "turn/completed") {
      this.clearTurnTimer(session);
      const turn = objectValue(params?.turn);
      const turnStatus = turn?.status;
      session.activeTurn = false;
      if (session.status.status === "running") {
        const terminalStatus: WorkerRunnerStatus = turnStatus === "completed"
          ? { status: "done", exitCode: 0, raw: message.params }
          : turnStatus === "interrupted"
            ? { status: "interrupted", raw: message.params }
            : { status: "error", raw: message.params };
        if (session.idleSettleMs !== undefined) {
          // Quiescence mode: defer done/error until activity is quiet for idleSettleMs.
          // Set via constructor option (global default) or idle_settle_ms in workflow agent config.
          this.scheduleIdleSettle(session, terminalStatus);
        } else {
          session.status = terminalStatus;
          this.scheduleIdleCleanup(session);
        }
      } else {
        this.scheduleIdleCleanup(session);
      }
    } else if (method === "error") {
      this.cancelIdleSettle(session);
      session.status = { status: "error", raw: message.params };
      const error = objectValue(params?.error);
      const codexErrorInfo = objectValue(error?.codexErrorInfo);
      if (codexErrorInfo?.type === "UsageLimitExceeded" || codexErrorInfo?.httpStatusCode === 429) session.emit("worker.codex.rate_limit", message.params);
    } else if (method === "thread/tokenUsage/updated") {
      // noisy heartbeat — do not reset settle timer
      session.emit("worker.codex.tokens", message.params);
      return;
    } else if (method === "turn/diff/updated") {
      this.resetIdleSettle(session);
      session.emit("worker.codex.tool", message.params);
      session.emit(`worker.codex.${method.replaceAll("/", ".")}`, message.params);
      return;
    }
    if (method.startsWith("item/")) {
      this.resetIdleSettle(session);
      const item = objectValue(objectValue(message.params)?.item);
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      if (itemId) {
        if (this.isItemStartMethod(method)) {
          session.activeItemIds.add(itemId);
          // Arm a per-item watchdog: if the terminal event is dropped, unblock settle after turnTimeoutMs.
          const watchdogMs = this.options.maxItemAgeMs ?? session.turnTimeoutMs;
          session.itemWatchdogs.set(itemId, setTimeout(() => {
            if (!session.activeItemIds.has(itemId)) return;
            session.activeItemIds.delete(itemId);
            session.itemWatchdogs.delete(itemId);
            session.emit("worker.codex.item.watchdog_expired", { itemId, watchdogMs });
            this.resetIdleSettle(session);
          }, watchdogMs));
        } else if (this.isItemTerminalMethod(method)) {
          session.activeItemIds.delete(itemId);
          const watchdog = session.itemWatchdogs.get(itemId);
          if (watchdog) {
            clearTimeout(watchdog);
            session.itemWatchdogs.delete(itemId);
          }
        }
      }
      session.emit(this.itemEventType(method, message.params), message.params);
      return;
    }
    session.emit(`worker.codex.${method.replaceAll("/", ".")}`, message.params);
  }

  private isItemStartMethod(method: string): boolean {
    return method === "item/started" || method.endsWith("/started") || method.endsWith("/created");
  }

  private isItemTerminalMethod(method: string): boolean {
    return method === "item/completed" || method.endsWith("/completed") || method.endsWith("/failed") || method.endsWith("/error");
  }

  private itemEventType(method: string, params: unknown): string {
    const item = objectValue(objectValue(params)?.item);
    const type = typeof item?.type === "string" ? item.type : "item";
    if (method.includes("agentMessage")) return "worker.codex.message";
    if (method.includes("commandExecution") || method.includes("tool")) return "worker.codex.tool";
    if (type === "agentMessage") return "worker.codex.message";
    if (type === "commandExecution" || type === "fileChange" || type === "mcpToolCall" || type === "dynamicToolCall" || type === "collabToolCall" || type === "webSearch") return "worker.codex.tool";
    if (type === "contextCompaction") return "worker.codex.compaction";
    return `worker.codex.${method.replaceAll("/", ".")}`;
  }

  private extractThreadId(result: unknown): string | undefined {
    const thread = objectValue(objectValue(result)?.thread);
    return typeof thread?.id === "string" ? thread.id : undefined;
  }

  private extractTurnId(result: unknown): string | undefined {
    const turn = objectValue(objectValue(result)?.turn);
    return typeof turn?.id === "string" ? turn.id : undefined;
  }

  private handle(input: WorkerRunnerStartInput, session: CodexSession): WorkerRunnerHandle {
    return {
      id: `codex:${input.runId}:${session.threadId ?? session.child.pid ?? "unknown"}`,
      kind: "codex",
      pid: session.child.pid,
      raw: { pid: session.child.pid, threadId: session.threadId, turnId: session.turnId },
    };
  }

  private sessionFromHandle(handle: WorkerRunnerHandle): CodexSession | undefined {
    for (const session of this.sessions.values()) {
      if (session.child.pid === handle.pid || handle.id.includes(session.threadId ?? "\u0000")) return session;
    }
    return undefined;
  }

  private canReuse(session: CodexSession): boolean {
    return Boolean(session.threadId) && session.child.exitCode === null && session.child.signalCode === null && !session.child.killed && (session.status.status === "running" || session.status.status === "done");
  }

  private scheduleIdleSettle(session: CodexSession, terminalStatus: WorkerRunnerStatus): void {
    if (session.removed) return;
    session.pendingTurnStatus = terminalStatus;
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.settleTimer = setTimeout(() => {
      session.settleTimer = undefined;
      const terminalStatus = session.pendingTurnStatus;
      if (!terminalStatus || session.removed || session.status.status !== "running") return;
      if (session.activeItemIds.size > 0) {
        // Items still in-flight — leave pendingTurnStatus set; resetIdleSettle re-arms when the next item/* arrives
        return;
      }
      session.pendingTurnStatus = undefined;
      session.status = terminalStatus;
      this.scheduleIdleCleanup(session);
    }, session.idleSettleMs!);
  }

  private resetIdleSettle(session: CodexSession): void {
    if (!session.pendingTurnStatus) return;
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.settleTimer = undefined;
    this.scheduleIdleSettle(session, session.pendingTurnStatus);
  }

  private cancelIdleSettle(session: CodexSession): void {
    if (session.settleTimer) clearTimeout(session.settleTimer);
    session.settleTimer = undefined;
    session.pendingTurnStatus = undefined;
    session.activeItemIds.clear();
    for (const timer of session.itemWatchdogs.values()) clearTimeout(timer);
    session.itemWatchdogs.clear();
  }

  private scheduleIdleCleanup(session: CodexSession): void {
    if (session.removed) return;
    if (session.cleanupTimer) return;
    session.cleanupTimer = setTimeout(() => {
      session.child.stdin?.end();
      if (session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) session.child.kill("SIGTERM");
      this.scheduleRetentionCleanup(session);
    }, this.options.idleCleanupMs ?? 30_000);
  }

  private scheduleRetentionCleanup(session: CodexSession): void {
    if (session.removed) return;
    if (session.retentionTimer) return;
    session.retentionTimer = setTimeout(() => {
      this.removeSession(session, "retention");
    }, this.options.terminalRetentionMs ?? 300_000);
  }

  private cancelCleanup(session: CodexSession): void {
    this.cancelIdleSettle(session);
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (session.retentionTimer) clearTimeout(session.retentionTimer);
    session.cleanupTimer = undefined;
    session.retentionTimer = undefined;
  }

  private removeSession(session: CodexSession, reason: string): void {
    if (session.removed) return;
    session.removed = true;
    this.clearTurnTimer(session);
    this.cancelCleanup(session);
    this.rejectPending(session, new Error(reason === "shutdown" ? "Codex app-server runner shut down" : `Codex app-server session removed: ${reason}`));
    if (session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) {
      session.child.stdin?.end();
      session.child.kill("SIGTERM");
    }
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
    session.emit("worker.codex.session.removed", { threadId: session.threadId, reason });
  }

  private rejectPending(session: CodexSession, error: Error): void {
    for (const pending of session.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    session.pending.clear();
  }

  private startTurnTimer(session: CodexSession): void {
    this.clearTurnTimer(session);
    session.turnTimer = setTimeout(() => {
      session.turnTimer = undefined;
      if (session.status.status !== "running") return;
      session.activeTurn = false;
      session.status = { status: "interrupted", raw: { reason: "turn_timeout", turnTimeoutMs: session.turnTimeoutMs } };
      session.emit("worker.codex.turn.timeout", { turnTimeoutMs: session.turnTimeoutMs, threadId: session.threadId, turnId: session.turnId });
      if (session.threadId && session.turnId) {
        Promise.race([
          this.request(session, "turn/interrupt", { threadId: session.threadId, turnId: session.turnId })
            .then(() => true)
            .catch((error: Error) => {
              session.emit("worker.codex.interrupt.error", { error: error.message });
              return false;
            }),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), this.options.interruptTimeoutMs ?? 5_000)),
        ]).then((interrupted) => {
          if (!interrupted) {
            session.emit("worker.codex.interrupt.timeout", { threadId: session.threadId, turnId: session.turnId });
            if (session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) session.child.kill("SIGTERM");
          }
          this.scheduleIdleCleanup(session);
        }).catch(() => undefined);
      } else {
        if (session.child.exitCode === null && session.child.signalCode === null && !session.child.killed) session.child.kill("SIGTERM");
        this.scheduleIdleCleanup(session);
      }
    }, session.turnTimeoutMs);
  }

  private clearTurnTimer(session: CodexSession): void {
    if (session.turnTimer) {
      clearTimeout(session.turnTimer);
      session.turnTimer = undefined;
    }
  }
}
