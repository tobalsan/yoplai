import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isNoReply,
  type ExtensionContext,
  type RunAgentResult,
  type StreamEvent,
} from "@yoplai/shared";
import {
  MAX_BODY_CHARS,
  ThreaditApi,
  describeFailure,
  isUncertain,
  sessionOf,
  splitAnswer,
  stopRequestedFor,
  type ApiResult,
  type BoardAccount,
  type BoardMessage,
  type FetchFn,
} from "./api.js";
import type { ResolvedThreaditConfig } from "./config.js";
import { detailedToolLabel, progressLabel, toolLabel } from "./labels.js";
import { buildPrompt } from "./prompt.js";

const WORKING = "👀";
const DONE = "✅";
const STOP_WAIT_MS = 30_000;
const HEARTBEAT_MS = 600_000;
const FAILURE_REPLY = "I could not finish this request.";
const STOPPED_REPLY = "Stopped on request.";

export type PollerOptions = {
  ctx: ExtensionContext;
  agentId: string;
  config: ResolvedThreaditConfig;
  /**
   * Read the latest config. The poller calls it between poll cycles, so a token
   * saved at run time applies without a restart. It never aborts a running turn.
   */
  readConfig?: () => ResolvedThreaditConfig | undefined;
  fetchFn?: FetchFn;
  /** Test overrides. */
  heartbeatMs?: number;
  stopWaitMs?: number;
  turnTimeoutMs?: number;
};

type Outcome = { result: RunAgentResult } | { error: unknown };
type StopReason = "stop" | "timeout" | "closed" | "shutdown";

type TurnEnd =
  | { kind: "answer"; text: string }
  | { kind: "silent" }
  | { kind: "stopped" }
  | { kind: "failed" }
  | { kind: "closed" }
  | { kind: "shutdown" };

type Posted = { status: "ok"; stop: boolean } | { status: "closed" } | { status: "failed" };
type Replied = "ok" | "closed" | "failed" | "uncertain";

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ThreaditPoller {
  private current: ThreaditApi | undefined;
  private readonly ctx: ExtensionContext;
  private readonly agentId: string;
  private config: ResolvedThreaditConfig;
  private readonly readConfig: (() => ResolvedThreaditConfig | undefined) | undefined;
  private readonly fetchFn: FetchFn | undefined;
  private pendingLogged = false;
  private readonly heartbeatMs: number;
  private readonly stopWaitMs: number;
  private readonly turnTimeoutMs: number;
  private readonly markerDir: string;
  private readonly handled = new Set<number>();
  private readonly aborters = new Set<() => void>();
  private readonly sleepers = new Set<() => void>();
  private me: BoardAccount | undefined;
  private stopped = false;
  private rejected = false;
  private recovered = false;
  /** New items whose 👀 result was unknown. Recovery retries them as processing items. */
  private readonly retrying = new Set<number>();
  private timer: NodeJS.Timeout | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: PollerOptions) {
    this.ctx = options.ctx;
    this.agentId = options.agentId;
    this.config = options.config;
    this.readConfig = options.readConfig;
    this.fetchFn = options.fetchFn;
    this.current = this.buildApi(options.config);
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
    this.turnTimeoutMs =
      options.turnTimeoutMs ?? options.config.turnTimeoutMinutes * 60_000;
    this.markerDir = path.join(
      options.ctx.getDataDir(),
      "threadit",
      options.agentId,
      "delivering"
    );
  }

  /** The client of the current account. Only used after `init` succeeds. */
  private get api(): ThreaditApi {
    if (!this.current) throw new Error("no token");
    return this.current;
  }

  private buildApi(config: ResolvedThreaditConfig): ThreaditApi | undefined {
    return config.token
      ? new ThreaditApi(config.baseUrl, config.token, this.fetchFn)
      : undefined;
  }

  /**
   * Switch to a new token or base URL. This runs only at the start of a poll
   * cycle, so no turn is in flight. The new account starts with a clean state.
   */
  private applyLatestConfig(): void {
    const latest = this.readConfig?.();
    if (!latest && this.readConfig) {
      // The agent disabled or removed the extension. Drop the old token.
      if (this.current) this.log("info", "disabled, token dropped");
      this.current = undefined;
      this.me = undefined;
      this.recovered = false;
      this.handled.clear();
      this.retrying.clear();
      return;
    }
    if (
      !latest ||
      ((this.current || !latest.token) &&
        latest.token === this.config.token &&
        latest.baseUrl === this.config.baseUrl)
    ) {
      if (latest) this.config = latest;
      return;
    }
    this.config = latest;
    this.current = this.buildApi(latest);
    this.me = undefined;
    this.rejected = false;
    this.recovered = false;
    this.pendingLogged = false;
    this.handled.clear();
    this.retrying.clear();
    this.log("info", "token changed");
  }

  start(): void {
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    for (const abort of [...this.aborters]) abort();
    for (const wake of [...this.sleepers]) wake();
    if (this.loop) await withTimeout(this.loop, this.stopWaitMs);
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.loop = this.iterate();
    }, ms);
  }

  private async iterate(): Promise<void> {
    try {
      this.applyLatestConfig();
      if (!this.current || this.rejected) {
        this.schedule(this.config.pollIntervalMs);
        return;
      }
      if (!this.me && !(await this.init())) {
        this.schedule(this.config.pollIntervalMs);
        return;
      }
      if (!this.recovered) this.recovered = await this.resumeProcessing();
      if (this.recovered) await this.pollOnce();
    } catch {
      this.log("warn", "unexpected error");
    }
    this.schedule(this.config.pollIntervalMs);
  }

  /** Check the token. False when the poller must not run (yet). */
  private async init(): Promise<boolean> {
    const result = await this.api.me();
    if (!result.ok) {
      if (
        result.kind === "http" &&
        result.status === 403 &&
        result.code === "account_pending"
      ) {
        if (!this.pendingLogged) {
          this.log("info", "account waits for approval");
          this.pendingLogged = true;
        }
        return false;
      }
      if (
        result.kind === "http" &&
        (result.status === 401 || result.status === 403)
      ) {
        this.log("error", "token rejected");
        this.rejected = true;
        return false;
      }
      this.log("warn", "could not reach the board", result);
      return false;
    }
    if (result.data.account_type !== "agent") {
      this.log("error", "not an agent account");
      this.rejected = true;
      return false;
    }
    this.me = result.data;
    this.pendingLogged = false;
    this.recovered = await this.resumeProcessing();
    return true;
  }

  private log(
    level: "warn" | "error" | "info",
    category: string,
    failure?: Exclude<ApiResult<never>, { ok: true }>
  ): void {
    const detail = failure ? ` (${describeFailure(failure)})` : "";
    console[level](`[threadit] ${this.agentId}: ${category}${detail}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.sleepers.add(done);
    });
  }

  private get meId(): number {
    return this.me?.id ?? 0;
  }

  // ---- polling ----

  /** True when every processing item was listed and handled. */
  /** Read every page before any write, so writes cannot shift the page offsets. */
  private async listAttention(
    status: "processing" | "unacknowledged"
  ): Promise<BoardMessage[] | undefined> {
    const items: BoardMessage[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.api.attention(status, offset);
      if (!page.ok) {
        this.log("warn", `could not list ${status} items`, page);
        return undefined;
      }
      offset += page.data.items.length;
      items.push(...page.data.items);
      if (!page.data.hasMore || page.data.items.length === 0) return items;
    }
  }

  /** True when live config is gone or has another account. Then the batch is stale. */
  private configChanged(): boolean {
    if (!this.readConfig) return false;
    const latest = this.readConfig();
    return (
      !latest ||
      latest.token !== this.config.token ||
      latest.baseUrl !== this.config.baseUrl
    );
  }

  private async resumeProcessing(): Promise<boolean> {
    const items = await this.listAttention("processing");
    if (!items) return false;
    let complete = true;
    for (const item of items.sort((a, b) => a.id - b.id)) {
      if (this.stopped || this.configChanged()) return false;
      if (this.handled.has(item.id)) continue;
      const state = sessionOf(item, this.meId)?.state ?? "";
      if (state === "working" || state === "stale") {
        const done = await this.handleItem(item, true);
        if (!done && !this.stopped) complete = false;
      } else if (state === "stopping") {
        this.handled.add(item.id);
        await this.finishStopped(item);
      }
    }
    return complete;
  }

  private async pollOnce(): Promise<void> {
    const listed = await this.listAttention("unacknowledged");
    if (!listed) return;
    const items = listed.sort((a, b) =>
      a.created_at === b.created_at
        ? a.id - b.id
        : a.created_at < b.created_at
          ? -1
          : 1
    );
    for (const item of items) {
      if (this.stopped || this.configChanged()) return;
      if (!this.handled.has(item.id)) await this.handleItem(item, false);
    }
  }

  // ---- board writes ----

  private async postActivity(
    item: BoardMessage,
    kind: string,
    body: string,
    ephemeral: boolean
  ): Promise<Posted> {
    if (this.stopped) return { status: "failed" };
    const result = await this.api.activity(item.id, kind, body, ephemeral);
    if (result.ok) {
      return { status: "ok", stop: result.data.stop_requested != null };
    }
    if (result.kind === "closed") return { status: "closed" };
    this.log("warn", "activity failed", result);
    return { status: "failed" };
  }

  private markerPath(itemId: number): string {
    return path.join(this.markerDir, String(itemId));
  }

  private async hasMarker(itemId: number): Promise<boolean> {
    try {
      await stat(this.markerPath(itemId));
      return true;
    } catch {
      return false;
    }
  }

  private async clearMarker(itemId: number): Promise<void> {
    await rm(this.markerPath(itemId), { force: true });
  }

  private async replyAll(item: BoardMessage, text: string): Promise<Replied> {
    if (this.stopped) return "failed";
    try {
      await mkdir(this.markerDir, { recursive: true });
      await writeFile(this.markerPath(item.id), "");
    } catch {
      this.log("warn", "could not write the delivery marker");
      return "failed";
    }
    for (const part of splitAnswer(text, MAX_BODY_CHARS)) {
      if (this.stopped) return "failed";
      const result = await this.api.reply(item.thread_id, item.id, part);
      if (result.ok) continue;
      if (result.kind === "closed") {
        await this.clearMarker(item.id);
        return "closed";
      }
      this.log("warn", "reply failed", result);
      if (!isUncertain(result)) {
        await this.clearMarker(item.id);
        return "failed";
      }
      return "uncertain";
    }
    return "ok";
  }

  private async markDone(item: BoardMessage): Promise<void> {
    if (this.stopped) return;
    const result = await this.api.react(item.id, DONE);
    if (result.ok) {
      await this.clearMarker(item.id);
    } else if (result.kind !== "closed") {
      this.log("warn", "could not add the done reaction", result);
    }
  }

  private async failItem(item: BoardMessage): Promise<void> {
    const posted = await this.postActivity(item, "error", "Run failed", false);
    if (posted.status === "closed") return;
    // The item keeps 👀, so markDone never clears this marker.
    if ((await this.replyAll(item, FAILURE_REPLY)) === "ok") {
      await this.clearMarker(item.id);
      this.handled.delete(item.id);
      this.retrying.delete(item.id);
    }
  }

  private hasReply(message: BoardMessage): boolean {
    return sessionOf(message, this.meId)?.reply_id != null;
  }

  /** Reply that the run stopped and add ✅. An existing reply is not repeated. */
  private async finishStopped(item: BoardMessage): Promise<void> {
    if (this.hasReply(item)) {
      await this.markDone(item);
    } else if (await this.hasMarker(item.id)) {
      this.log("warn", "reply delivery is unconfirmed, item stays at working");
    } else {
      await this.replyAndFinish(item, STOPPED_REPLY);
    }
  }

  /** Reply, then add ✅ when the reply is known to exist. Never send twice. */
  private async replyAndFinish(item: BoardMessage, text: string): Promise<void> {
    const replied = await this.replyAll(item, text);
    if (replied === "ok") {
      await this.markDone(item);
    } else if (replied === "uncertain") {
      const message = await this.api.message(item.id);
      if (message.ok && this.hasReply(message.data)) {
        await this.markDone(item);
      } else {
        this.log("warn", "could not confirm the reply, item stays at working");
      }
    }
  }

  // ---- one item ----

  /** False only when a transient working reaction needs another recovery attempt. */
  private async handleItem(item: BoardMessage, resumed: boolean): Promise<boolean> {
    if (stopRequestedFor(item, this.meId)) {
      this.handled.add(item.id);
      await this.markDone(item);
      return true;
    }
    if (resumed && this.hasReply(item)) {
      this.handled.add(item.id);
      await this.markDone(item);
      return true;
    }
    if (resumed && (await this.hasMarker(item.id))) {
      this.handled.add(item.id);
      this.log("warn", "reply delivery is unconfirmed, item stays at working");
      return true;
    }
    if (this.stopped) return true;
    const reacted = await this.api.react(item.id, WORKING);
    if (!reacted.ok) {
      if (reacted.kind !== "closed") {
        this.log("warn", "could not add the working reaction", reacted);
      }
      // Only a transient failure is retried. A permanent one must not block recovery.
      const retryable =
        isUncertain(reacted) || (reacted.kind === "http" && reacted.status === 429);
      if (!retryable) {
        this.handled.add(item.id);
      } else if (!resumed) {
        // The 👀 can be on the server already. Then the item is processing and
        // the unacknowledged poll never returns it again.
        this.retrying.add(item.id);
        this.recovered = false;
      }
      return !retryable;
    }
    this.handled.add(item.id);
    if (this.stopped) return true;

    const first = await this.postActivity(
      item,
      "thought",
      resumed && !this.retrying.has(item.id) ? "Resumed after restart" : "Started",
      false
    );
    if (first.status === "closed") return true;
    if (first.status === "ok" && first.stop) {
      await this.finishStopped(item);
      return true;
    }

    const context = await this.api.context(item.id);
    if (!context.ok) {
      this.log("warn", "could not read the context", context);
      if (this.stopped) return true;
      await this.failItem(item);
      return true;
    }
    if (this.stopped) return true;
    const prompt = buildPrompt(this.me?.username ?? "", context.data);

    const end = await this.runTurn(item, prompt);
    if (this.stopped) return true;
    switch (end.kind) {
      case "answer":
        await this.replyAndFinish(item, end.text);
        break;
      case "silent":
        await this.markDone(item);
        break;
      case "stopped":
        await this.replyAndFinish(item, STOPPED_REPLY);
        break;
      case "failed":
        await this.failItem(item);
        break;
      case "closed":
        this.log("info", "thread closed, writes stopped");
        break;
      case "shutdown":
        break;
    }
    return true;
  }

  // ---- one turn ----

  private async runTurn(item: BoardMessage, prompt: string): Promise<TurnEnd> {
    const controller = new AbortController();
    const state: { reason?: StopReason } = {};
    const abort = (reason: StopReason): void => {
      if (state.reason) return;
      state.reason = reason;
      controller.abort();
      for (const wake of [...this.sleepers]) wake();
    };
    const onShutdown = () => abort("shutdown");
    this.aborters.add(onShutdown);

    let lastPost = Date.now();
    let pending = 0;
    let lastLabel: string | undefined;
    let lastProgress: string | undefined;
    // Read the mode per turn, so a change applies to the next item of a batch.
    const detailed =
      (this.readConfig?.()?.activity ?? this.config.activity) === "detailed";
    type Job = { kind: string; body: string; ephemeral: boolean };
    const queue: Job[] = [];
    let running = false;
    let chain: Promise<void> = Promise.resolve();
    const pump = async (): Promise<void> => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (state.reason) {
          pending--;
          continue;
        }
        const posted = await this.postActivity(item, job.kind, job.body, job.ephemeral);
        pending--;
        lastPost = Date.now();
        if (state.reason) continue;
        if (posted.status === "closed") abort("closed");
        else if (posted.status === "ok" && posted.stop) abort("stop");
      }
      running = false;
    };
    const post = (kind: string, body: string, ephemeral: boolean): void => {
      if (detailed && ephemeral) {
        // Coalesce: only the latest queued ephemeral action is worth posting.
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i]!.ephemeral) {
            queue.splice(i, 1);
            pending--;
          }
        }
      }
      queue.push({ kind, body, ephemeral });
      pending++;
      if (!running) {
        running = true;
        // Deferred to a microtask, so an immediate stop cancels the first post.
        chain = Promise.resolve().then(pump);
      }
    };

    const onEvent = (event: StreamEvent): void => {
      if (state.reason) return;
      if (detailed && event.type === "progress") {
        const label = progressLabel(event.label);
        if (label === undefined || label === lastProgress) return;
        lastProgress = label;
        post("thought", label, false);
        return;
      }
      if (event.type !== "tool_call") return;
      const label = detailed
        ? detailedToolLabel(event.name, event.arguments)
        : toolLabel(event.name);
      if (label === undefined || label === lastLabel) return;
      lastLabel = label;
      post("action", label, true);
    };

    let resolveDeferred: (outcome: Outcome) => void = () => {};
    const deferred = new Promise<Outcome>((resolve) => {
      resolveDeferred = resolve;
    });
    const settled: Promise<Outcome> = (async () => {
      try {
        const result = await this.ctx.runAgent({
          agentId: this.agentId,
          message: prompt,
          sessionKey: `threadit:thread-${item.thread_id}`,
          source: "threadit",
          sessionOwnerId: null,
          signal: controller.signal,
          onEvent,
          onDeferredResult: (outcome) => resolveDeferred(outcome),
          ...(item.author.account_type === "agent"
            ? {
                sender: {
                  kind: "agent" as const,
                  agentId: `threadit:${item.author.username}`,
                },
              }
            : {}),
        });
        return result.meta.queued ? await deferred : { result };
      } catch (error) {
        return { error };
      }
    })();

    const deadline = Date.now() + this.turnTimeoutMs;
    const deadlineTimer = setTimeout(
      () => abort("timeout"),
      Math.max(0, deadline - Date.now())
    );
    let outcome: Outcome | undefined;
    try {
      while (!(outcome && pending === 0) && !state.reason) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          abort("timeout");
          break;
        }
        const winner = await Promise.race([
          outcome ? chain.then(() => undefined) : settled,
          this.sleep(Math.min(this.config.pollIntervalMs, remaining)).then(
            () => undefined
          ),
        ]);
        if (winner) outcome = winner;
        if (state.reason) break;
        if (outcome && pending === 0) break;
        if (Date.now() >= deadline) {
          abort("timeout");
          break;
        }
        const message = await this.api.message(item.id);
        if (message.ok && stopRequestedFor(message.data, this.meId)) {
          abort("stop");
          break;
        }
        if (!outcome && pending === 0 && Date.now() - lastPost >= this.heartbeatMs) {
          post("thought", "Still working", true);
        }
      }
      if (state.reason) {
        const drained = settled.then((o) => {
          outcome = o;
        });
        await withTimeout(drained, this.stopWaitMs);
      }
      if (!state.reason && Date.now() >= deadline) abort("timeout");
    } finally {
      clearTimeout(deadlineTimer);
      this.aborters.delete(onShutdown);
    }

    const reason = state.reason;
    if (reason === "closed") return { kind: "closed" };
    if (reason === "shutdown") return { kind: "shutdown" };
    if (reason === "stop") return { kind: "stopped" };
    if (reason === "timeout") return { kind: "failed" };
    if (!outcome || "error" in outcome) return { kind: "failed" };
    const { result } = outcome;
    if (result.meta.aborted) return { kind: "failed" };
    const text = result.payloads
      .map((payload) => payload.text ?? "")
      .filter((part) => part.trim() !== "")
      .join("\n\n");
    if (result.meta.silent || text.trim() === "" || isNoReply(text)) {
      return { kind: "silent" };
    }
    return { kind: "answer", text };
  }
}
