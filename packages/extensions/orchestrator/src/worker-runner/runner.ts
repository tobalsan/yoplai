import { spawn, type ChildProcess } from "node:child_process";
import type { SubagentRuntimeProfile } from "@yoplai/shared";
import type { LinearIssue, ProjectDescriptor, WorkflowConfig } from "../types.js";
import { ClaudeRpcRunner } from "./claude-rpc.js";
import { CodexAppServerRunner } from "./codex-app-server.js";
import { PiRpcRunner } from "./pi-rpc.js";
import { runnerForWorkflow } from "./thinking.js";
import { sanitizedWorkerEnv } from "./env.js";

export type WorkerRunnerKind = "fake" | "cli" | "codex" | "pi" | "claude";

export type WorkerRunnerStatus = {
  status: "running" | "done" | "error" | "interrupted";
  exitCode?: number;
  raw?: unknown;
};

export type WorkerRunnerStartInput = {
  runId: string;
  project: ProjectDescriptor;
  issue: LinearIssue;
  workspace: string;
  prompt: string;
  label: string;
  profile: SubagentRuntimeProfile;
  workflow: WorkflowConfig;
  emitEvent?: (type: string, payload: unknown) => void;
};

export type WorkerRunnerHandle = {
  id: string;
  kind: WorkerRunnerKind;
  pid?: number;
  raw?: unknown;
};

export interface WorkerRunner {
  start(input: WorkerRunnerStartInput): Promise<WorkerRunnerHandle>;
  status(handle: WorkerRunnerHandle): Promise<WorkerRunnerStatus | undefined>;
  abort(handle: WorkerRunnerHandle): Promise<void>;
  shutdown?(): Promise<void>;
}

export function terminalWorkerStatus(status: unknown): WorkerRunnerStatus | undefined {
  if (!status || typeof status !== "object") return undefined;
  const record = status as Record<string, unknown>;
  const value = record.status;
  if (value !== "done" && value !== "error" && value !== "interrupted") return undefined;
  return {
    status: value,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
    raw: status,
  };
}

export class FakeWorkerRunner implements WorkerRunner {
  async start(input: WorkerRunnerStartInput): Promise<WorkerRunnerHandle> {
    return { id: `fake:${input.runId}`, kind: "fake", raw: { status: "done" } };
  }

  async status(): Promise<WorkerRunnerStatus> {
    return { status: "done", exitCode: 0 };
  }

  async abort(): Promise<void> {}
}

export class CliWorkerRunner implements WorkerRunner {
  private readonly processes = new Map<string, { child: ChildProcess; status: WorkerRunnerStatus }>();

  async start(input: WorkerRunnerStartInput): Promise<WorkerRunnerHandle> {
    const command = input.workflow.agent.command;
    if (!command) throw new Error("agent.command is required for cli runner");
    const [cmd, ...args] = Array.isArray(command) ? command : [command];
    if (!cmd) throw new Error("agent.command is required for cli runner");
    const child = spawn(cmd, args, {
      cwd: input.workspace,
      env: sanitizedWorkerEnv({
        YOPLAI_RUN_ID: input.runId,
        YOPLAI_PROJECT_ID: input.project.id,
        YOPLAI_ISSUE_ID: input.issue.id,
        YOPLAI_ISSUE_IDENTIFIER: input.issue.identifier,
        YOPLAI_WORKER_PROMPT: input.prompt,
        YOPLAI_WORKER_MODEL: input.workflow.agent.model,
      }),
      stdio: "ignore",
      detached: false,
    });
    const handle: WorkerRunnerHandle = { id: `cli:${input.runId}:${child.pid ?? "unknown"}`, kind: "cli", pid: child.pid, raw: { pid: child.pid } };
    const record: { child: ChildProcess; status: WorkerRunnerStatus } = { child, status: { status: "running", raw: { pid: child.pid } } };
    this.processes.set(handle.id, record);
    child.once("error", (error) => {
      record.status = { status: "error", raw: { message: error.message, code: (error as NodeJS.ErrnoException).code } };
    });
    child.once("exit", (code, signal) => {
      record.status = signal === "SIGTERM" || signal === "SIGINT"
        ? { status: "interrupted", exitCode: code ?? undefined, raw: { code, signal } }
        : code === 0
          ? { status: "done", exitCode: 0, raw: { code, signal } }
          : { status: "error", exitCode: code ?? undefined, raw: { code, signal } };
    });
    return handle;
  }

  async status(handle: WorkerRunnerHandle): Promise<WorkerRunnerStatus | undefined> {
    return this.processes.get(handle.id)?.status;
  }

  async abort(handle: WorkerRunnerHandle): Promise<void> {
    const record = this.processes.get(handle.id);
    if (!record || record.status.status !== "running") return;
    record.child.kill("SIGTERM");
  }
}

export class WorkflowWorkerRunner implements WorkerRunner {
  private readonly fake = new FakeWorkerRunner();
  private readonly cli = new CliWorkerRunner();
  private readonly codex = new CodexAppServerRunner({ idleSettleMs: 15_000 });
  private readonly pi = new PiRpcRunner();
  private readonly claude = new ClaudeRpcRunner();

  constructor() {}

  private runner(kind: WorkerRunnerKind): WorkerRunner {
    if (kind === "fake") return this.fake;
    if (kind === "cli") return this.cli;
    if (kind === "codex") return this.codex;
    if (kind === "pi") return this.pi;
    if (kind === "claude") return this.claude;
    return this.pi;
  }

  start(input: WorkerRunnerStartInput): Promise<WorkerRunnerHandle> {
    return this.runner(runnerForWorkflow(input)).start(input);
  }

  status(handle: WorkerRunnerHandle): Promise<WorkerRunnerStatus | undefined> {
    return this.runner(handle.kind).status(handle);
  }

  abort(handle: WorkerRunnerHandle): Promise<void> {
    return this.runner(handle.kind).abort(handle);
  }

  async shutdown(): Promise<void> {
    await this.codex.shutdown();
    await this.pi.shutdown();
    await this.claude.shutdown();
  }
}
