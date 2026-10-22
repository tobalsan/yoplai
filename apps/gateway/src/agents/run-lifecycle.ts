import {
  sanitizeForStorage,
  type ContainerDeliveryContext,
  type FileAttachment,
  type RunAgentParams,
  type StreamEvent,
  type RunFailureKind,
  type WebCompletion,
} from "@yoplai/shared";
import {
  abortSession,
  bufferPendingMessage,
  clearSessionHandle,
  enqueuePendingUserMessage,
  getSessionHandle,
  getSession,
  isStreaming,
  popAllPendingUserMessages,
  popPendingMessages,
  setSessionCurrentTurn,
  setSessionHandle,
  setSessionStreaming,
  shiftPendingUserMessage,
  type PendingMessage,
} from "./sessions.js";
import {
  agentEventBus,
  type AgentHistoryEvent,
  type AgentStreamEvent,
} from "./events.js";
import type {
  HistoryEvent,
  SdkAdapter,
  SdkCapabilities,
} from "../sdk/types.js";
import { isRunSettledError } from "../sdk/run-settled.js";
import {
  backfillFromPiSession,
  appendRunFailureNotice,
  bufferHistoryEvent,
  createTurnBuffer,
  flushTurnBuffer,
  flushUserMessage,
  type TurnBuffer,
} from "../history/store.js";

const QUEUE_WAIT_MS = 500;
const QUEUE_POLL_MS = 10;
const INTERRUPT_WAIT_MS = 2000;
const INTERRUPT_POLL_MS = 50;

type LifecycleContext = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  userId?: string;
  requesterId?: string;
  source?: string;
  slackDelivery?: ContainerDeliveryContext["slack"];
  background?: boolean;
  trace?: AgentStreamEvent["trace"];
  onEvent?: (event: StreamEvent) => void;
};

type QueuePolicy = {
  queueMode?: "queue" | "interrupt";
  capabilities: SdkCapabilities;
  adapter: SdkAdapter;
  message: string;
  sender?: RunAgentParams["sender"];
  params?: RunAgentParams;
};

type QueueDecision =
  | { handled: false }
  | { handled: true; result: { text: string; queued: true; deferred: boolean } };

export class SessionRunLifecycle {
  private currentTurn: TurnBuffer | null = null;
  private completedTurns: TurnBuffer[] = [];
  private eagerUserFlushes: Promise<void>[] = [];
  // Run-scoped: this lifecycle accepted the user message before the adapter
  // ran (see beginUserTurn). Survives turn_end events clearing currentTurn.
  private preAcceptedRun = false;
  // Armed before each adapter.run() invocation; consumed by the adapter's
  // initial user-echo event so the pre-accepted message is not duplicated.
  private initialEchoArmed = false;
  private noticeWritten = false;

  constructor(private readonly context: LifecycleContext) {}

  isStreaming(): boolean {
    return isStreaming(this.context.agentId, this.context.sessionId);
  }

  setTraceMetadata(metadata: Record<string, unknown>): void {
    const trace = this.context.trace;
    this.context.trace = {
      ...trace,
      metadata: { ...trace?.metadata, ...metadata },
    };
  }

  emit(event: StreamEvent) {
    const sanitizedEvent = sanitizeForStorage(event);
    this.context.onEvent?.(sanitizedEvent);
    agentEventBus.emitStreamEvent({
      ...sanitizedEvent,
      agentId: this.context.agentId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      source: this.context.source,
      trace: this.context.trace,
    } as AgentStreamEvent);
  }

  /**
   * Acknowledge a message queued behind an active run. The queued text is
   * traced as a user input of the session's active trace, while the ack
   * itself is untraced so it neither creates an input-less trace nor closes
   * the active run's trace (traces are keyed by agent+session).
   */
  emitQueuedAck(message: string, text: string, deferred = false): void {
    if (message.trim()) {
      agentEventBus.emitHistoryEvent({
        ...sanitizeForStorage({
          type: "user",
          text: message,
          timestamp: Date.now(),
        } as HistoryEvent),
        agentId: this.context.agentId,
        sessionId: this.context.sessionId,
        sessionKey: this.context.sessionKey,
        source: this.context.source,
        trace: this.context.trace,
      } as AgentHistoryEvent);
    }
    const trace = { ...this.context.trace, enabled: false };
    for (const event of [
      { type: "text", data: text },
      { type: "done", meta: { durationMs: 0, queued: true } },
    ] as StreamEvent[]) {
      if (!deferred || event.type !== "done") this.context.onEvent?.(event);
      agentEventBus.emitStreamEvent({
        ...event,
        agentId: this.context.agentId,
        sessionId: this.context.sessionId,
        sessionKey: this.context.sessionKey,
        source: this.context.source,
        trace,
      } as AgentStreamEvent);
    }
  }

  async abortActiveRun(
    adapter: SdkAdapter,
    capabilities: SdkCapabilities
  ): Promise<boolean> {
    if (!this.isStreaming() || !getSession(this.context.agentId, this.context.sessionId)?.abortController) return false;

    if (capabilities.interrupt && adapter.abort) {
      const handle = getSessionHandle(
        this.context.agentId,
        this.context.sessionId
      );
      if (handle) {
        adapter.abort(handle);
      }
    }
    abortSession(this.context.agentId, this.context.sessionId);

    const ended = await this.waitForStreamingEnd();
    if (!ended) {
      this.forceClearActiveRun();
    }
    return true;
  }

  async handleJoin(policy: QueuePolicy): Promise<QueueDecision> {
    if (!this.isStreaming()) return { handled: false };

    const differentRequester = getSession(this.context.agentId, this.context.sessionId)?.requesterId !== this.context.requesterId;
    if (policy.queueMode === "queue" || differentRequester) {
      let deliveredToCurrentRun = false;
      if (
        policy.capabilities.queueWhileStreaming &&
        policy.adapter.queueMessage &&
        !differentRequester
      ) {
        enqueuePendingUserMessage(
          this.context.agentId,
          this.context.sessionId,
          policy.message,
          Date.now()
        );
        const existingHandle = await this.waitForSessionHandle();
        if (existingHandle) {
          try {
            await policy.adapter.queueMessage(
              existingHandle,
              policy.message,
              this.buildDeliveryContext()
            );
            deliveredToCurrentRun = true;
          } catch (error) {
            // The run settled while we still advertised it as streaming.
            // Re-buffer so the next run picks the message up instead of
            // writing it into a runtime nothing is polling.
            if (!isRunSettledError(error)) throw error;
          }
        }
      }

      if (!deliveredToCurrentRun) {
        bufferPendingMessage(
          this.context.agentId,
          this.context.sessionId,
          policy.message,
          policy.sender,
          policy.params
        );
      }

      const text = deliveredToCurrentRun
        ? "Message queued into current run"
        : "Message queued for next run";
      return { handled: true, result: { text, queued: true, deferred: !deliveredToCurrentRun } };
    }

    if (policy.queueMode === "interrupt") {
      await this.abortActiveRun(policy.adapter, policy.capabilities);
    }

    return { handled: false };
  }

  beginRun(): AbortController {
    const abortController = new AbortController();
    setSessionStreaming(
      this.context.agentId,
      this.context.sessionId,
      true,
      abortController,
      this.context.background
    );
    const session = getSession(this.context.agentId, this.context.sessionId);
    if (session) {
      session.requesterId = this.context.requesterId;
      session.storageOwnerId = this.context.userId ?? null;
      session.bufferedTurns = this.completedTurns;
      session.settled = new Promise<void>((resolve) => { session.resolveSettled = resolve; });
    }
    return abortController;
  }

  acceptSessionHandle(
    handle: unknown,
    adapter: SdkAdapter,
    capabilities: SdkCapabilities
  ) {
    setSessionHandle(this.context.agentId, this.context.sessionId, handle);
    if (capabilities.queueWhileStreaming && adapter.queueMessage) {
      const buffered = popPendingMessages(
        this.context.agentId,
        this.context.sessionId
      );
      for (const pending of buffered) {
        const requesterId = pending.params?.requesterId ?? pending.params?.userId;
        if (requesterId !== this.context.requesterId) {
          bufferPendingMessage(this.context.agentId, this.context.sessionId, pending.message, pending.sender, pending.params);
          continue;
        }
        adapter.queueMessage(handle, pending.message, this.buildDeliveryContext());
      }
    }
  }

  private buildDeliveryContext(): ContainerDeliveryContext {
    return {
      source: this.context.source,
      slack: this.context.slackDelivery,
    };
  }

  acceptHistoryEvent(event: HistoryEvent): void {
    const sanitizedEvent = sanitizeForStorage(event);
    agentEventBus.emitHistoryEvent({
      ...sanitizedEvent,
      agentId: this.context.agentId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      source: this.context.source,
      trace: this.context.trace,
    } as AgentHistoryEvent);

    if (sanitizedEvent.type === "user") {
      this.startTurnWithUser(sanitizedEvent);
      return;
    }
    if (sanitizedEvent.type === "turn_end") {
      this.finishCurrentTurn();
      return;
    }
    const buffer = this.ensureCurrentTurn();
    bufferHistoryEvent(buffer, sanitizedEvent);
  }

  async flushTurns() {
    await Promise.all(this.eagerUserFlushes);
    this.eagerUserFlushes = [];

    for (const buffer of this.completedTurns) {
      await flushTurnBuffer(
        this.context.agentId,
        this.context.sessionId,
        buffer,
        this.context.userId
      );
    }
    this.completedTurns.length = 0;

    if (this.currentTurn) {
      await flushTurnBuffer(
        this.context.agentId,
        this.context.sessionId,
        this.currentTurn,
        this.context.userId
      );
      this.currentTurn = null;
      setSessionCurrentTurn(this.context.agentId, this.context.sessionId, null);
    }

    const pendingUsers = popAllPendingUserMessages(
      this.context.agentId,
      this.context.sessionId
    );
    for (const pending of pendingUsers) {
      const buffer = createTurnBuffer();
      bufferHistoryEvent(buffer, {
        type: "user",
        text: pending.text,
        timestamp: pending.timestamp,
      });
      await flushTurnBuffer(
        this.context.agentId,
        this.context.sessionId,
        buffer,
        this.context.userId
      );
    }
  }

  async writeFailureNotice(notice: { kind: RunFailureKind; text: string }): Promise<void> {
    if (this.noticeWritten) return;
    await this.flushTurns();
    await appendRunFailureNotice(
      this.context.agentId,
      this.context.sessionId,
      notice,
      this.context.userId
    );
    this.noticeWritten = true;
  }

  finishRun(completion?: WebCompletion) {
    clearSessionHandle(this.context.agentId, this.context.sessionId);
    setSessionCurrentTurn(this.context.agentId, this.context.sessionId, null);
    setSessionStreaming(this.context.agentId, this.context.sessionId, false, undefined, false, completion);
    const session = getSession(this.context.agentId, this.context.sessionId);
    if (session) session.bufferedTurns = undefined;
    session?.resolveSettled?.();
    if (session) session.resolveSettled = undefined;
  }

  drainPendingMessages(): PendingMessage[] {
    return popPendingMessages(this.context.agentId, this.context.sessionId);
  }

  /**
   * Accept the user message into the current turn and persist it to
   * canonical history BEFORE the adapter runs, so a run that fails before
   * the model starts (model resolution, auth, etc.) still leaves the
   * message on disk. Callers must await; a rejection should abort the run
   * before the model is invoked.
   */
  async beginUserTurn(
    text: string,
    timestamp: number,
    attachments?: FileAttachment[]
  ): Promise<void> {
    const sanitized = sanitizeForStorage<Extract<HistoryEvent, { type: "user" }>>({
      type: "user",
      text,
      attachments,
      timestamp,
    });
    if (this.currentTurn) {
      // A turn is already streaming: keep queue semantics as today.
      enqueuePendingUserMessage(
        this.context.agentId,
        this.context.sessionId,
        sanitized.text,
        sanitized.timestamp
      );
      return;
    }
    const buffer = createTurnBuffer();
    bufferHistoryEvent(buffer, sanitized);
    this.currentTurn = buffer;
    setSessionCurrentTurn(
      this.context.agentId,
      this.context.sessionId,
      buffer
    );
    this.preAcceptedRun = true;
    this.initialEchoArmed = true;
    // Preserve legacy Pi-only sessions: backfill self-skips when canonical
    // history already exists, so this is a no-op after the first append.
    await backfillFromPiSession(
      this.context.agentId,
      this.context.sessionId,
      this.context.userId
    );
    await flushUserMessage(
      this.context.agentId,
      this.context.sessionId,
      buffer,
      this.context.userId
    );
  }

  /**
   * Re-arm the initial user-echo suppression before each adapter.run()
   * invocation (the adapter re-emits its initial user event on every
   * invocation, e.g. thinking-level fallback retries).
   */
  rearmInitialEcho(): void {
    this.initialEchoArmed = this.preAcceptedRun;
  }

  private startTurnWithUser(event: Extract<HistoryEvent, { type: "user" }>) {
    if (this.initialEchoArmed) {
      // Echo of the message pre-accepted in beginUserTurn: already on disk.
      this.initialEchoArmed = false;
      return;
    }
    const buffer = createTurnBuffer();
    bufferHistoryEvent(buffer, event);
    if (!this.currentTurn) {
      this.currentTurn = buffer;
      setSessionCurrentTurn(
        this.context.agentId,
        this.context.sessionId,
        buffer
      );
      this.eagerUserFlushes.push(
        flushUserMessage(
          this.context.agentId,
          this.context.sessionId,
          buffer,
          this.context.userId
        )
      );
    } else {
      enqueuePendingUserMessage(
        this.context.agentId,
        this.context.sessionId,
        event.text,
        event.timestamp
      );
    }
  }

  private ensureCurrentTurn(): TurnBuffer {
    if (!this.currentTurn) {
      const pendingUser = shiftPendingUserMessage(
        this.context.agentId,
        this.context.sessionId
      );
      this.currentTurn = createTurnBuffer();
      if (pendingUser) {
        bufferHistoryEvent(this.currentTurn, {
          type: "user",
          text: pendingUser.text,
          timestamp: pendingUser.timestamp,
        });
        this.eagerUserFlushes.push(
          flushUserMessage(
            this.context.agentId,
            this.context.sessionId,
            this.currentTurn,
            this.context.userId
          )
        );
      }
      setSessionCurrentTurn(
        this.context.agentId,
        this.context.sessionId,
        this.currentTurn
      );
    }
    return this.currentTurn;
  }

  private finishCurrentTurn() {
    if (this.currentTurn) {
      this.completedTurns.push(this.currentTurn);
      this.currentTurn = null;
      setSessionCurrentTurn(this.context.agentId, this.context.sessionId, null);
    }
  }

  private forceClearActiveRun() {
    clearSessionHandle(this.context.agentId, this.context.sessionId);
    setSessionStreaming(this.context.agentId, this.context.sessionId, false);
  }

  private async waitForSessionHandle(): Promise<unknown | undefined> {
    const deadline = Date.now() + QUEUE_WAIT_MS;
    while (Date.now() < deadline) {
      const handle = getSessionHandle(
        this.context.agentId,
        this.context.sessionId
      );
      if (handle) return handle;
      await new Promise((resolve) => setTimeout(resolve, QUEUE_POLL_MS));
    }
    return undefined;
  }

  private async waitForStreamingEnd(): Promise<boolean> {
    const deadline = Date.now() + INTERRUPT_WAIT_MS;
    while (Date.now() < deadline) {
      if (!this.isStreaming()) return true;
      await new Promise((resolve) => setTimeout(resolve, INTERRUPT_POLL_MS));
    }
    return false;
  }
}
