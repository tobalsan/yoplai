import type { StreamEvent } from "@yoplai/shared";
import {
  abortSession,
  bufferPendingMessage,
  clearSessionHandle,
  enqueuePendingUserMessage,
  getSessionHandle,
  isStreaming,
  popAllPendingUserMessages,
  popPendingMessages,
  setSessionCurrentTurn,
  setSessionHandle,
  setSessionStreaming,
  shiftPendingUserMessage,
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
import {
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
  source?: string;
  background?: boolean;
  trace?: AgentStreamEvent["trace"];
  onEvent?: (event: StreamEvent) => void;
};

type QueuePolicy = {
  queueMode?: "queue" | "interrupt";
  capabilities: SdkCapabilities;
  adapter: SdkAdapter;
  message: string;
};

type QueueDecision =
  | { handled: false }
  | { handled: true; result: { text: string; queued: true } };

export class SessionRunLifecycle {
  private currentTurn: TurnBuffer | null = null;
  private completedTurns: TurnBuffer[] = [];
  private eagerUserFlushes: Promise<void>[] = [];

  constructor(private readonly context: LifecycleContext) {}

  isStreaming(): boolean {
    return isStreaming(this.context.agentId, this.context.sessionId);
  }

  emit(event: StreamEvent) {
    this.context.onEvent?.(event);
    agentEventBus.emitStreamEvent({
      ...event,
      agentId: this.context.agentId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      source: this.context.source,
      trace: this.context.trace,
    } as AgentStreamEvent);
  }

  async abortActiveRun(
    adapter: SdkAdapter,
    capabilities: SdkCapabilities
  ): Promise<boolean> {
    if (!this.isStreaming()) return false;

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

    if (policy.queueMode === "queue") {
      if (
        policy.capabilities.queueWhileStreaming &&
        policy.adapter.queueMessage
      ) {
        enqueuePendingUserMessage(
          this.context.agentId,
          this.context.sessionId,
          policy.message,
          Date.now()
        );
        const existingHandle = await this.waitForSessionHandle();
        if (existingHandle) {
          await policy.adapter.queueMessage(existingHandle, policy.message);
        } else {
          bufferPendingMessage(
            this.context.agentId,
            this.context.sessionId,
            policy.message
          );
        }
      } else {
        bufferPendingMessage(
          this.context.agentId,
          this.context.sessionId,
          policy.message
        );
      }

      const text = policy.capabilities.queueWhileStreaming
        ? "Message queued into current run"
        : "Message queued for next run";
      return { handled: true, result: { text, queued: true } };
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
      for (const msg of buffered) {
        adapter.queueMessage(handle, msg);
      }
    }
  }

  acceptHistoryEvent(event: HistoryEvent): void {
    agentEventBus.emitHistoryEvent({
      ...event,
      agentId: this.context.agentId,
      sessionId: this.context.sessionId,
      sessionKey: this.context.sessionKey,
      source: this.context.source,
      trace: this.context.trace,
    } as AgentHistoryEvent);

    if (event.type === "user") {
      this.startTurnWithUser(event);
      return;
    }
    if (event.type === "turn_end") {
      this.finishCurrentTurn();
      return;
    }
    const buffer = this.ensureCurrentTurn();
    bufferHistoryEvent(buffer, event);
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
    this.completedTurns = [];

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

  finishRun() {
    clearSessionHandle(this.context.agentId, this.context.sessionId);
    setSessionCurrentTurn(this.context.agentId, this.context.sessionId, null);
    setSessionStreaming(this.context.agentId, this.context.sessionId, false);
  }

  drainPendingMessages(): string[] {
    return popPendingMessages(this.context.agentId, this.context.sessionId);
  }

  private startTurnWithUser(event: Extract<HistoryEvent, { type: "user" }>) {
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
