import type { ExtensionContext, SubagentRuntimeProfile } from "@yoplai/shared";
import { notify } from "@yoplai/shared";
import type { StateStore } from "../state/store.js";
import type {
  TrackerConfig,
  TrackerIssue,
  ProjectDescriptor,
  WorkflowSnapshot,
} from "../types.js";
import type { TrackerClient, TrackerClientFactory } from "../tracker/client.js";
import { trackerScopeKey } from "../tracker/client.js";
import { ClaimsRegistry } from "./claims.js";
import { ConcurrencyLimiter } from "../concurrency/limiter.js";
import { resolveProfile } from "../profile/resolver.js";
import { RetryPolicy } from "../retry/policy.js";
import { WorkspaceLayout } from "../workspace/layout.js";
import { WorkflowLoader } from "../workflow/loader.js";
import { runHook } from "../hooks/runner.js";
import { createHitlBurstBuffer } from "../notifications/hitl.js";
import { resolveProjects } from "../projects/registry.js";
import { WorkflowWorkerRunner, type WorkerRunner, type WorkerRunnerHandle } from "../worker-runner/runner.js";

export type OrchestratorConfig = {
  projects?: string[];
  concurrency?: { global?: number };
  validation?: { strict?: boolean };
  notifyChannel?: string;
};

export type OrchestratorNotifier = (message: string) => Promise<void>;

type RunMeta = {
  runId: string;
  project: ProjectDescriptor;
  issue: TrackerIssue;
  workspace: string;
  worker?: WorkerRunnerHandle;
  workflow: WorkflowSnapshot;
  afterRunFired?: boolean;
};

const WORKSPACE_CLEANUP_RELEASE_OUTCOMES = new Set([
  "terminal",
  "hook_failed",
  "dispatch_failed",
]);

function profileList(ctx: ExtensionContext): SubagentRuntimeProfile[] {
  const raw = ctx.getConfig().extensions?.subagents;
  return raw?.profiles ?? [];
}

function promptFor(
  project: ProjectDescriptor,
  issue: TrackerIssue,
  body: string,
  kind: TrackerConfig["kind"]
): string {
  const isPlane = kind === "plane";
  const toolLine = isPlane ? `Plane API tool calls must pass project: ${project.id}` : `Linear GraphQL tool calls must pass project: ${project.id}`;
  const workItemNoun = isPlane ? "Plane work item" : "Linear issue";
  return `${body.trim()}\n\n## Orchestrator context\nProject: ${project.id}\n${toolLine}\n\n## ${workItemNoun}\n${issue.identifier}: ${issue.title}\n\n${issue.description ?? ""}\n${issue.url ? `\n${issue.url}\n` : ""}`.trim();
}

function pendingBlockerIds(issue: TrackerIssue, terminalStates: string[]): string[] {
  return (issue.blocked_by ?? [])
    .filter(
      (blocker) => !blocker.state || !terminalStates.includes(blocker.state)
    )
    .map((blocker) => blocker.identifier ?? blocker.id)
    .filter((id): id is string => Boolean(id));
}

export class OrchestratorDaemon {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly runs = new Map<string, RunMeta>();
  private readonly retry = new RetryPolicy();
  private tickRunning = false;
  private tickPending = false;
  private readonly pendingProjectTicks = new Set<string | undefined>();
  private readonly hitl = createHitlBurstBuffer({
    flush: async (messages) => this.flushHitl(messages),
  });
  private projects: ProjectDescriptor[] = [];
  private watchers: Array<{ close: () => void }> = [];
  private readonly workflowLoader: WorkflowLoader;
  private readonly workerRunner: WorkerRunner;
  lastTickAt: string | undefined;
  rateLimitRemaining: number | undefined;

  constructor(
    private readonly deps: {
      ctx: ExtensionContext;
      client?: TrackerClient;
      store: StateStore;
      claims: ClaimsRegistry;
      getConfig: () => OrchestratorConfig;
      createTrackerClient?: TrackerClientFactory;
      workerRunner?: WorkerRunner;
      notify?: OrchestratorNotifier;
      workflowLoader?: WorkflowLoader;
    }
  ) {
    this.workflowLoader = this.deps.workflowLoader ?? new WorkflowLoader(this.deps.ctx.getDataDir());
    this.workerRunner = this.deps.workerRunner ?? new WorkflowWorkerRunner();
  }

  async start(): Promise<void> {
    this.projects = await resolveProjects({
      paths: this.deps.getConfig().projects ?? [],
      dataDir: this.deps.ctx.getDataDir(),
    });
    await this.validateTrackerScopes();
    await this.stopStaleOwnedWorkers();
    this.deps.store.markOpenRunsInterrupted("interrupted_gateway_restart");
    const loader = this.loader();
    this.watchers = this.projects.map((project) =>
      loader.watch(project.path, (event) =>
        this.deps.ctx.emit("orchestrator.workflow.changed", {
          project: project.id,
          ...event,
        })
      )
    );
    for (const project of this.projects) await this.scheduleProject(project);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const run of this.runs.values()) if (run.worker) await this.runner().abort(run.worker).catch(() => undefined);
    await this.runner().shutdown?.().catch(() => undefined);
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    this.deps.store.markActiveProcessStopped();
    await this.hitl.flush();
  }

  enqueueTick(projectId?: string): void {
    this.pendingProjectTicks.add(projectId);
    if (this.tickRunning) {
      this.tickPending = true;
      return;
    }
    void this.runQueuedTick();
  }

  private async runQueuedTick(): Promise<void> {
    this.tickRunning = true;
    try {
      do {
        this.tickPending = false;
        const projectIds = [...this.pendingProjectTicks];
        this.pendingProjectTicks.clear();
        if (projectIds.includes(undefined)) await this.tick();
        else for (const projectId of projectIds) await this.tick(projectId);
      } while (this.tickPending || this.pendingProjectTicks.size > 0);
    } finally {
      this.tickRunning = false;
    }
  }

  private loader(): WorkflowLoader { return this.workflowLoader; }
  private runner(): WorkerRunner { return this.workerRunner; }

  private async validateTrackerScopes(): Promise<void> {
    const seen = new Map<string, string>();
    for (const project of this.projects) {
      const workflow = await this.loader().loadProjectWorkflow({
        projectPath: project.path,
      });
      const key = trackerScopeKey(workflow.config.tracker);
      const existing = seen.get(key);
      if (existing)
        throw new Error(
          `duplicate tracker scope ${key}: ${existing}, ${project.id}`
        );
      seen.set(key, project.id);
    }
  }

  private async stopStaleOwnedWorkers(): Promise<void> {
    for (const row of this.deps.store.listOpenRuns()) {
      const pid = typeof row.pid === "number" ? row.pid : undefined;
      if (pid && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may have already exited between the pid check and kill; ignore.
        }
      }
    }
  }

  private async scheduleProject(project: ProjectDescriptor): Promise<void> {
    const workflow = await this.loader().loadProjectWorkflow({
      projectPath: project.path,
      allowStale: true,
    });
    const delay = workflow.config.polling.intervalMs;
    const jitter = workflow.config.polling.jitterMs;
    const next = Math.max(
      1_000,
      delay + Math.floor((Math.random() * 2 - 1) * jitter)
    );
    const previous = this.timers.get(project.id);
    if (previous) clearTimeout(previous);
    this.timers.set(
      project.id,
      setTimeout(() => {
        this.enqueueTick(project.id);
        void this.scheduleProject(project);
      }, next)
    );
  }

  async claimNow(
    idOrIdentifier: string,
    projectId?: string
  ): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    const targets = projectId
      ? this.projects.filter(
          (project) => project.id === projectId || project.path === projectId
        )
      : this.projects;
    for (const project of targets) {
      const workflow = await this.loader().loadProjectWorkflow({
        projectPath: project.path,
        allowStale: true,
      });
      const client = this.clientFor(project, workflow);
      const issue = await client
        .getIssue(idOrIdentifier)
        .catch(() => undefined);
      if (!issue) continue;
      if (this.deps.claims.get(issue.id, project.id))
        return { ok: false, status: 409, error: "issue already claimed" };
      return (await this.dispatch(project, workflow, issue, client))
        ? { ok: true }
        : { ok: false, status: 409, error: "issue was not dispatched" };
    }
    return { ok: false, status: 404, error: "issue not found" };
  }

  async tick(
    projectId?: string
  ): Promise<{ dispatched: number; skipped: number; released: number }> {
    this.lastTickAt = new Date().toISOString();
    this.deps.store.heartbeat();
    await this.detectStalls();

    let dispatched = 0;
    let skipped = 0;
    let released = 0;
    const completedThisTick = await this.observeSubagentCompletions();
    const projects = projectId
      ? this.projects.filter(
          (project) => project.id === projectId || project.path === projectId
        )
      : this.projects;
    const globalLimiter = new ConcurrencyLimiter(
      this.deps.getConfig().concurrency?.global ?? 3
    );
    for (const claim of this.deps.claims.list())
      globalLimiter.tryReserve({ issueId: claim.issueId });

    for (const project of projects) {
      const workflow = await this.loader().loadProjectWorkflow({
        projectPath: project.path,
        allowStale: true,
      });
      const client = this.clientFor(project, workflow);
      const states = workflow.config.tracker;
      const issues = await client.pollIssues({
        states: [
          ...new Set([
            ...states.activeStates,
            ...states.terminalStates,
            states.needsHuman,
          ]),
        ],
      });
      this.updateRateLimit(client.rateLimitRemaining);
      const projectLimiter = new ConcurrencyLimiter(
        workflow.config.agent.max_concurrent ?? 3
      );
      for (const claim of this.deps.claims.list({ projectId: project.id }))
        projectLimiter.tryReserve({ issueId: claim.issueId });

      for (const issue of issues) {
        const claim = this.deps.claims.get(issue.id, project.id);
        if (claim && issue.state === states.needsHuman) {
          await this.release(project.id, issue.id, "needs_human");
          released += 1;
          continue;
        }
        if (claim && states.terminalStates.includes(issue.state)) {
          await this.release(project.id, issue.id, "terminal");
          released += 1;
          continue;
        }
        if (
          completedThisTick.has(`${project.id}:${issue.id}`) ||
          !states.activeStates.includes(issue.state) ||
          claim
        ) {
          skipped += 1;
          continue;
        }
        const pendingBlockers = pendingBlockerIds(issue, states.terminalStates);
        if (pendingBlockers.length > 0) {
          this.logDispatchSkip(project, issue, "blocked_by_pending", {
            pendingBlockerIds: pendingBlockers,
          });
          skipped += 1;
          continue;
        }
        const next = this.retry.nextAttempt(
          `${project.id}:${issue.id}`,
          "dispatch"
        );
        if (next && next > Date.now()) {
          skipped += 1;
          continue;
        }
        const global = globalLimiter.tryReserve({ issueId: issue.id });
        const local = projectLimiter.tryReserve({ issueId: issue.id });
        if (!global.ok || !local.ok) {
          if (global.ok) global.release();
          if (local.ok) local.release();
          skipped += 1;
          continue;
        }
        const ok = await this.dispatch(project, workflow, issue, client);
        if (ok) dispatched += 1;
        else {
          global.release();
          local.release();
          skipped += 1;
        }
      }
    }
    return { dispatched, skipped, released };
  }

  private clientFor(
    project: ProjectDescriptor,
    workflow: WorkflowSnapshot
  ): TrackerClient {
    return (
      this.deps.createTrackerClient?.({ config: workflow.config.tracker }) ??
      this.deps.client!
    );
  }

  private updateRateLimit(remaining: number | undefined): void {
    if (remaining === undefined || Number.isNaN(remaining)) return;
    this.rateLimitRemaining =
      this.rateLimitRemaining === undefined
        ? remaining
        : Math.min(this.rateLimitRemaining, remaining);
  }

  private logDispatchSkip(
    project: ProjectDescriptor,
    issue: TrackerIssue,
    reason: string,
    extra: Record<string, unknown> = {}
  ): void {
    const payload = {
      type: "dispatch.skipped",
      reason,
      issueId: issue.id,
      identifier: issue.identifier,
      projectId: project.id,
      ...extra,
    };
    console.log(
      `[orchestrator] dispatch skipped ${issue.identifier}: ${reason}`
    );
    this.deps.ctx.emit("orchestrator.run.event", payload);
  }

  private async dispatch(
    project: ProjectDescriptor,
    workflow: WorkflowSnapshot,
    issue: TrackerIssue,
    client: TrackerClient
  ): Promise<boolean> {
    if (
      pendingBlockerIds(issue, workflow.config.tracker.terminalStates).length >
      0
    )
      return false;
    if (this.deps.claims.get(issue.id)) return false;
    const previousRuns = this.deps.store.countRunsByIssue(issue.id, project.id);
    const attempt = previousRuns === 0 ? null : previousRuns + 1;
    const resolvedWorkflow = await this.loader().loadProjectWorkflow({
      projectPath: project.path,
      issue,
      attempt,
      allowStale: true,
    });
    const profile = resolveProfile({
      workflow: resolvedWorkflow.frontmatter,
      profilesConfig: profileList(this.deps.ctx),
    });
    if ("park" in profile) {
      await this.park(
        client,
        issue,
        resolvedWorkflow.config.tracker.needsHuman,
        profile.park.reason
      );
      return false;
    }
    const maxActiveRuns = resolvedWorkflow.config.agent.max_active_runs ?? 3;
    const consecutiveCompleted = this.deps.store.countConsecutiveCompletedRuns(issue.id, project.id);
    if (consecutiveCompleted >= maxActiveRuns) {
      await this.park(
        client,
        issue,
        resolvedWorkflow.config.tracker.needsHuman,
        `issue completed ${consecutiveCompleted} consecutive run(s) without leaving active state (max_active_runs=${maxActiveRuns})`
      );
      this.deps.store.recordParkBarrier(issue.id, project.id);
      return false;
    }
    const runId = `orchestrator:${project.id}:${issue.id}:${Date.now()}`;
    const label = `${issue.identifier}-${runId.split(":").at(-1)}`;
    const claim = await this.deps.claims.tryClaim(issue.id, runId, project.id);
    if (!claim) return false;
    try {
      const workspace = await new WorkspaceLayout(
        resolvedWorkflow.config.workspace.root
      ).create({ identifier: issue.identifier });
      const env = this.hookEnv(issue, workspace.path, project.id);
      this.deps.store.claim(issue.id, runId, project.id);
      this.deps.store.insertRun({
        runId,
        projectId: project.id,
        issueId: issue.id,
        identifier: issue.identifier,
        workspace: workspace.path,
        profileJson: JSON.stringify(profile.profile),
        workflowPath: resolvedWorkflow.path,
        workflowSha: resolvedWorkflow.sha,
        pid: null,
        startedAt: new Date().toISOString(),
      });
      this.deps.store.appendEvent(
        runId,
        "run.claimed",
        {
          issueId: issue.id,
          identifier: issue.identifier,
          projectId: project.id,
        },
        project.id
      );
      this.deps.ctx.emit("orchestrator.run.claimed", claim);
      if (workspace.created) await runHook({ command: resolvedWorkflow.config.hooks?.after_create, phase: "after_create", cwd: workspace.path, runId, store: this.deps.store, env }).catch((error) => this.deps.store.appendEvent(runId, "hook.after_create.error", { error: error instanceof Error ? error.message : String(error) }, project.id));
      const before = await runHook({ command: resolvedWorkflow.config.hooks?.before_run, phase: "before_run", cwd: workspace.path, runId, store: this.deps.store, env });
      if (before !== 0) { this.deps.store.finishRun(runId, "hook_failed", before); await this.release(project.id, issue.id, "hook_failed"); return false; }
      const worker = await this.runner().start({
        runId,
        project,
        issue,
        workspace: workspace.path,
        prompt: promptFor(project, issue, resolvedWorkflow.body, resolvedWorkflow.config.tracker.kind),
        label,
        profile: profile.profile,
        workflow: resolvedWorkflow.config,
        emitEvent: (type, payload) => {
          this.deps.store.appendEvent(runId, type, payload, project.id);
          this.deps.claims.touch(issue.id, undefined, project.id);
          this.deps.ctx.emit("orchestrator.run.event", { type, runId, projectId: project.id, issueId: issue.id, payload });
        },
      });
      this.runs.set(`${project.id}:${issue.id}`, { runId, project, issue, workspace: workspace.path, worker, workflow: resolvedWorkflow });
      this.deps.store.setWorkerId(runId, worker.id);
      this.deps.store.setRunPid(runId, worker.pid);
      this.deps.store.appendEvent(runId, "worker.started", { id: worker.id, kind: worker.kind, raw: worker.raw }, project.id);
      this.deps.claims.touch(issue.id, undefined, project.id);
      this.retry.reset(`${project.id}:${issue.id}`, "dispatch");
      return true;
    } catch (error) {
      this.retry.register(`${project.id}:${issue.id}`, "dispatch");
      this.deps.store.appendEvent(
        runId,
        "dispatch.error",
        { error: error instanceof Error ? error.message : String(error) },
        project.id
      );
      this.deps.store.finishRun(runId, "dispatch_failed");
      await this.release(project.id, issue.id, "dispatch_failed");
      return false;
    }
  }

  private hookEnv(
    issue: TrackerIssue,
    workspace: string,
    projectId: string
  ): Record<string, string | undefined> {
    return {
      YOPLAI_PROJECT_ID: projectId,
      YOPLAI_ISSUE_ID: issue.id,
      YOPLAI_ISSUE_IDENTIFIER: issue.identifier,
      YOPLAI_WORKSPACE: workspace,
      LINEAR_API_KEY: undefined,
      PLANE_API_KEY: undefined,
      PLANE_OAUTH_TOKEN: undefined,
      PLANE_BOT_TOKEN: undefined,
    };
  }

  private async park(client: TrackerClient, issue: TrackerIssue, needsHuman: string, reason: string, options: { worker?: WorkerRunnerHandle } = {}): Promise<void> {
    await client.createComment(issue.id, `Orchestrator parked issue: ${reason}`).catch(() => undefined);
    await client.setIssueState(issue.id, needsHuman).catch(() => undefined);
    if (options.worker) await this.runner().abort(options.worker).catch(() => undefined);
    this.deps.ctx.emit("orchestrator.run.needs_human", { issueId: issue.id, reason });
    this.notifyHitl(`Orchestrator needs human for ${issue.identifier}: ${reason}`);
  }

  private async observeSubagentCompletions(): Promise<Set<string>> {
    const completed = new Set<string>();
    for (const [key, run] of this.runs) {
      if (!run.worker || run.afterRunFired) continue;
      const status = await this.runner().status(run.worker).catch(() => undefined);
      const claim = this.deps.claims.get(run.issue.id, run.project.id);
      if (status && claim) this.deps.store.appendEvent(claim.runId, "worker.status", { id: run.worker.id, kind: run.worker.kind, status: status.status, exitCode: status.exitCode, raw: status.raw }, run.project.id);
      const terminal = status && status.status !== "running" ? status : undefined;
      if (!terminal) continue;
      run.afterRunFired = true;
      if (!claim) continue;
      await runHook({
        command: run.workflow.config.hooks?.after_run,
        phase: "after_run",
        cwd: run.workspace,
        runId: claim.runId,
        store: this.deps.store,
        env: this.hookEnv(run.issue, run.workspace, run.project.id),
        exitCode: terminal.exitCode,
      }).catch((error) =>
        this.deps.store.appendEvent(
          claim.runId,
          "hook.after_run.error",
          { error: error instanceof Error ? error.message : String(error) },
          run.project.id
        )
      );
      this.runs.set(key, run);
      if (terminal.status === "error") {
        await this.park(this.clientFor(run.project, run.workflow), run.issue, run.workflow.config.tracker.needsHuman, `worker exited with error${terminal.exitCode === undefined ? "" : ` (exit ${terminal.exitCode})`}`, { worker: run.worker });
      }
      await this.release(
        run.project.id,
        run.issue.id,
        terminal.status === "done" ? "completed" : terminal.status
      );
      completed.add(key);
    }
    return completed;
  }

  private async detectStalls(): Promise<void> {
    const now = Date.now();
    for (const claim of this.deps.claims.list()) {
      const run = this.runs.get(`${claim.projectId}:${claim.issueId}`);
      const timeout = run?.workflow.config.agent.stall_timeout_ms ?? 300_000;
      if (now - Date.parse(claim.lastEventAt) <= timeout || !run) continue;
      const client = this.clientFor(run.project, run.workflow);
      await client.createComment(claim.issueId, `Orchestrator stalled: no events for ${timeout}ms`).catch(() => undefined);
      await client.setIssueState(claim.issueId, run.workflow.config.tracker.needsHuman).catch(() => undefined);
      if (run.worker) await this.runner().abort(run.worker).catch(() => undefined);
      const active = this.deps.claims.get(claim.issueId, claim.projectId);
      if (active) this.deps.store.appendEvent(active.runId, "worker.aborted", { id: run.worker?.id, reason: "stalled" }, claim.projectId);
      this.notifyHitl(`Orchestrator stalled: ${claim.issueId}`);
      await this.release(claim.projectId, claim.issueId, "stalled");
    }
  }

  async interruptWorker(issueId: string, projectId = "default"): Promise<void> {
    const run = this.runs.get(`${projectId}:${issueId}`) ?? [...this.runs.values()].find((item) => item.runId === issueId || item.issue.id === issueId || item.issue.identifier === issueId || item.worker?.id === issueId);
    if (run?.worker) await this.runner().abort(run.worker).catch(() => undefined);
  }

  async releaseRun(projectId: string, issueId: string, outcome = "released"): Promise<void> {
    await this.release(projectId, issueId, outcome);
  }

  private async release(
    projectId: string,
    issueId: string,
    outcome: string
  ): Promise<void> {
    const claim = this.deps.claims.get(issueId, projectId);
    if (!claim) return;
    const run = this.runs.get(`${projectId}:${issueId}`);
    if ((outcome === "terminal" || outcome === "needs_human") && run?.worker) {
      await this.runner().abort(run.worker).catch(() => undefined);
      this.deps.store.appendEvent(claim.runId, "worker.aborted", { id: run.worker.id, reason: outcome }, projectId);
    }
    if (run && !run.afterRunFired) {
      run.afterRunFired = true;
      await runHook({
        command: run.workflow.config.hooks?.after_run,
        phase: "after_run",
        cwd: run.workspace,
        runId: claim.runId,
        store: this.deps.store,
        env: this.hookEnv(run.issue, run.workspace, projectId),
      }).catch((error) =>
        this.deps.store.appendEvent(
          claim.runId,
          "hook.after_run.error",
          { error: error instanceof Error ? error.message : String(error) },
          projectId
        )
      );
    }
    if (
      run?.workflow.config.workspace.cleanupOnTerminal &&
      WORKSPACE_CLEANUP_RELEASE_OUTCOMES.has(outcome)
    )
      await this.removeWorkspace(run, claim.runId);
    this.deps.claims.release(issueId, projectId);
    this.deps.store.release(issueId, projectId);
    this.deps.store.finishRun(claim.runId, outcome);
    this.runs.delete(`${projectId}:${issueId}`);
    this.deps.ctx.emit("orchestrator.run.finished", {
      issueId,
      projectId,
      runId: claim.runId,
      outcome,
    });
  }

  private async removeWorkspace(run: RunMeta, runId: string): Promise<void> {
    await runHook({
      command: run.workflow.config.hooks?.before_remove,
      phase: "before_remove",
      cwd: run.workspace,
      runId,
      store: this.deps.store,
      env: this.hookEnv(run.issue, run.workspace, run.project.id),
    }).catch((error) =>
      this.deps.store.appendEvent(
        runId,
        "hook.before_remove.error",
        { error: error instanceof Error ? error.message : String(error) },
        run.project.id
      )
    );
    await new WorkspaceLayout(run.workflow.config.workspace.root).remove({
      identifier: run.issue.identifier,
    });
  }

  notifyStartupError(error: unknown): void {
    this.notifyHitl(
      `Orchestrator startup error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  notifyRunFailed(issueId: string, reason: string): void {
    this.notifyHitl(`Orchestrator run failed for ${issueId}: ${reason}`);
  }
  private notifyHitl(message: string): void {
    this.hitl.push(message);
  }

  private async flushHitl(messages: string[]): Promise<void> {
    const configured = this.deps.getConfig().notifyChannel;
    if (!configured) return;
    const message =
      messages.length === 1
        ? messages[0]
        : messages.map((item) => `- ${item}`).join("\n");
    const send =
      this.deps.notify ??
      (async (text: string) => {
        await notify({
          config: this.deps.ctx.getConfig().notifications,
          channel: configured,
          message: text,
        });
      });
    await send(message).catch((error) =>
      this.deps.ctx.emit("orchestrator.run.event", {
        type: "notification.error",
        message: error instanceof Error ? error.message : String(error),
      })
    );
  }
}
