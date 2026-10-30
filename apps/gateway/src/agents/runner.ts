import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { classifyRunFailure, runFailureMessage } from "@yoplai/shared";
import type {
  RunAgentParams as SharedRunAgentParams,
  RunAgentResult as SharedRunAgentResult,
  ThinkLevel,
  StreamEvent,
  SimpleHistoryMessage,
  FullHistoryMessage,
  HistoryViewMode,
  WebCompletion,
} from "@yoplai/shared";
import {
  getAgent,
  loadConfig,
  resolveWorkspaceDir,
  CONFIG_DIR,
} from "../config/index.js";
import { waitForCompactionActivation } from "./compaction-activation.js";
import { ProjectContextResolver } from "../chat-projects/context-resolver.js";
import { SessionRunLifecycle } from "./run-lifecycle.js";
import {
  resolveSessionId,
  getSessionEntry,
  isAbortTrigger,
} from "../sessions/index.js";
import { parseThinkDirective } from "../sessions/directives.js";
import {
  setSessionThinkLevel,
  DEFAULT_MAIN_KEY,
} from "../sessions/store.js";
import { appendSessionMeta } from "../history/store.js";
import { agentEventBus, type AgentStreamEvent } from "./events.js";
import { logError, logInfo, logWarn } from "../logging.js";
import { createNoReplyHoldback, isNoReply } from "./no-reply.js";
import {
  checkAgentLoop,
  DEFAULT_MAX_AGENT_TURNS,
  DEFAULT_MAX_HOPS,
} from "./loop-guard.js";
import { getContainerAdapter } from "../sdk/container/adapter.js";
import { getSdkAdapter, getDefaultSdkId } from "../sdk/registry.js";
import type { SdkId, HistoryEvent } from "../sdk/types.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { requireActorExecution, resolveRunActor } from "../extensions/runtime.js";
import { getExtensionRuntime } from "../extensions/registry.js";
import { getTask, pauseTaskForControlCommand } from "../tasks/store.js";
import {
  getSimpleHistory as getCanonicalSimpleHistory,
  getFullHistory as getCanonicalFullHistory,
  hasCanonicalHistory,
  readPiSessionHistory,
  backfillFromPiSession,
  invalidateResolvedHistoryFile,
} from "../history/store.js";
import { maybeAutoTitleSession } from "../maintenance/session-auto-title.js";
import { maybeGenerateToolLabel } from "../maintenance/tool-labels.js";
import { notifyProviderQuota } from "./quota-notification.js";
import { getSession } from "./sessions.js";
import { startShapedTurn, topicsReply } from "../chat-shape/index.js";

export type InternalRunAgentParams = SharedRunAgentParams & {
  userId?: string;
  extensionRuntime?: ExtensionRuntime;
  deferredTurn?: boolean;
  resolvedSession?: {
    sessionId: string;
    sessionKey?: string;
    message: string;
    isNew: boolean;
  };
};

export type InternalRunAgentResult = SharedRunAgentResult;

const SESSIONS_DIR = path.join(CONFIG_DIR, "sessions");

// Thinking levels in fallback order (highest to lowest)
const THINK_LEVELS_ORDERED: ThinkLevel[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "off",
];

/**
 * Check if error is a thinking level unsupported error
 */
function isThinkingLevelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /thinking.*not.*supported|unsupported.*thinking|budget_tokens.*invalid|reasoning_effort.*invalid/i.test(
    msg
  );
}

async function ensureSessionsDir() {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
}

function resolveAgentThinkLevel(agent: { reasoning?: ThinkLevel; thinkLevel?: ThinkLevel }) {
  return agent.reasoning ?? agent.thinkLevel;
}

export async function runAgent(
  params: InternalRunAgentParams
): Promise<InternalRunAgentResult> {
  const agent = getAgent(params.agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${params.agentId}`);
  }

  const actorConfig = loadConfig();
  const actor = resolveRunActor(actorConfig, params.userId, params);
  await requireActorExecution(agent.id, actorConfig, params.userId, actor);
  params = { ...params, ...actor };

  const sessionOwnerId = params.sessionOwnerId === undefined ? params.userId : params.sessionOwnerId ?? undefined;

  // Resolve SDK adapter
  const sdkId = (agent.sdk ?? getDefaultSdkId()) as SdkId;
  const extensionRuntime = params.extensionRuntime ?? getExtensionRuntime();
  const adapter = agent.sandbox?.enabled
    ? getContainerAdapter()
    : getSdkAdapter(sdkId);
  const capabilities = adapter.capabilities;

  // Handle /abort command early - do NOT create new sessions or forward to model
  if (isAbortTrigger(params.message)) {
    // Resolve session without creating new one
    let sessionId: string | undefined;
    if (params.sessionId) {
      sessionId = params.sessionId;
    } else if (params.sessionKey) {
      const entry = await getSessionEntry(
        params.agentId,
        params.sessionKey,
        sessionOwnerId
      );
      sessionId = entry?.sessionId;
    } else {
      sessionId = "default";
    }

    // No active session to abort
    if (!sessionId) {
      const emit = (event: StreamEvent) => {
        params.onEvent?.(event);
        agentEventBus.emitStreamEvent({
          ...event,
          agentId: params.agentId,
          sessionId: "none",
          sessionKey: params.sessionKey,
          source: params.source,
          trace: params.trace,
        } as AgentStreamEvent);
      };
      emit({ type: "text", data: "No active run." });
      emit({ type: "done", meta: { durationMs: 0, aborted: false } });
      return {
        payloads: [{ text: "No active run." }],
        meta: { durationMs: 0, sessionId: "none", aborted: false },
      };
    }

    const lifecycle = new SessionRunLifecycle({
      agentId: params.agentId,
      sessionId,
      sessionKey: params.sessionKey,
      background: params.background,
      source: params.source,
      slackDelivery: params.slackDelivery,
      trace: params.trace,
      onEvent: params.onEvent,
    });
    const aborted = await lifecycle.abortActiveRun(adapter, capabilities);

    // Only explicit gateway controls may alter task ownership without an agent
    // lifecycle-tool call. Preserve the task so its work can be resumed, even
    // when the adapter has just settled before the control arrives.
    await pauseTaskForControlCommand(
      params.agentId,
      sessionId,
      params.message.trim().split(/\s+/, 1)[0]!,
      sessionOwnerId
    );

    const ackText = aborted ? "Run aborted." : "No active run.";
    lifecycle.emit({ type: "text", data: ackText });
    lifecycle.emit({ type: "done", meta: { durationMs: 0, aborted } });
    return {
      payloads: [{ text: ackText }],
      meta: { durationMs: 0, sessionId, aborted },
    };
  }

  // Resolve sessionId: explicit > sessionKey resolution > default
  let sessionId: string;
  let message = params.resolvedSession?.message ?? params.message;
  const sessionKey = params.resolvedSession?.sessionKey ?? params.sessionKey;
  if (params.resolvedSession) {
    sessionId = params.resolvedSession.sessionId;
    if (params.resolvedSession.isNew) {
      invalidateResolvedHistoryFile(params.agentId, sessionId, sessionOwnerId);
    }
  } else if (params.sessionId) {
    sessionId = params.sessionId;
  } else if (sessionKey) {
    const resolved = await resolveSessionId({
      agentId: params.agentId,
      userId: sessionOwnerId,
      sessionKey,
      message: params.message,
    });
    sessionId = resolved.sessionId;
    message = resolved.message;
    // Invalidate cached history path on reset (new session via /new, /reset, or idle timeout)
    if (resolved.isNew) {
      invalidateResolvedHistoryFile(params.agentId, sessionId, sessionOwnerId);
    }
  } else {
    sessionId = "default";
  }

  const lifecycle = new SessionRunLifecycle({
    agentId: params.agentId,
    sessionId,
    sessionKey,
    userId: sessionOwnerId,
    requesterId: params.requesterId ?? params.userId,
    source: params.source,
    slackDelivery: params.slackDelivery,
    trace: params.trace,
    onEvent: params.onEvent,
  });
  const emit = (event: StreamEvent) => lifecycle.emit(event);

  const globalLoop = loadConfig().agentLoop;
  const maxAgentTurns =
    agent.agentLoop?.maxAgentTurns ??
    globalLoop?.maxAgentTurns ??
    DEFAULT_MAX_AGENT_TURNS;
  const maxHops =
    agent.agentLoop?.maxHops ?? globalLoop?.maxHops ?? DEFAULT_MAX_HOPS;
  const loopGuard = checkAgentLoop({
    key: `${params.agentId}:${sessionOwnerId ?? "default"}:${sessionId}`,
    sender: params.sender,
    maxAgentTurns,
    maxHops,
  });
  if (loopGuard) {
    logWarn("[agent] loop guard blocked turn", {
      agentId: params.agentId,
      sessionId,
      senderAgentId: params.sender?.agentId,
      reason: loopGuard,
    });
    params.onEvent?.({ type: "done", meta: { durationMs: 0 } });
    return {
      payloads: [],
      meta: { durationMs: 0, sessionId, silent: true, loopGuard },
    };
  }

  // chat-shape: hold, lint, and rewrite replies of human turns (undefined when off or skipped).
  const workspaceDir = resolveWorkspaceDir(agent.workspace);
  const shape = startShapedTurn(agent, params, sessionId, workspaceDir);
  if (shape && message.trim() === "/topics") {
    const text = topicsReply(workspaceDir);
    emit({ type: "text", data: text });
    emit({ type: "done", meta: { durationMs: 0 } });
    return { payloads: [{ text }], meta: { durationMs: 0, sessionId } };
  }

  // Resolve sessionKey for thinkLevel persistence (OAuth only)
  const resolvedSessionKey = sessionKey ?? DEFAULT_MAIN_KEY;
  const isOAuth = agent.auth?.mode === "oauth";

  // Handle /think directive (OAuth agents only)
  let directiveThinkLevel: ThinkLevel | undefined;
  if (isOAuth) {
    const directive = parseThinkDirective(message);
    if (directive.hasDirective) {
      // Update message with directive stripped
      message = directive.message;

      if (directive.thinkLevel) {
        // /think level - update session state and persist
        directiveThinkLevel = directive.thinkLevel;
        await setSessionThinkLevel(
          params.agentId,
          resolvedSessionKey,
          directive.thinkLevel,
          sessionId,
          sessionOwnerId
        );
        await appendSessionMeta(
          params.agentId,
          sessionId,
          "thinkingLevel",
          directive.thinkLevel,
          sessionOwnerId
        );

        // If no remaining message, just acknowledge and return
        if (!message.trim()) {
          const ackText = `Thinking level set to: ${directive.thinkLevel}`;
          emit({ type: "text", data: ackText });
          emit({ type: "done", meta: { durationMs: 0 } });
          return {
            payloads: [{ text: ackText }],
            meta: { durationMs: 0, sessionId },
          };
        }
      } else if (directive.rawLevel) {
        // Invalid level specified
        const validLevels = [
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "min",
          "mid",
          "med",
          "max",
          "ultra",
          "none",
        ];
        const errText = `Invalid thinking level: "${directive.rawLevel}". Valid levels: ${validLevels.join(", ")}`;
        emit({ type: "text", data: errText });
        emit({ type: "done", meta: { durationMs: 0 } });
        return {
          payloads: [{ text: errText }],
          meta: { durationMs: 0, sessionId },
        };
      } else {
        // /think with no arg - show current level
        const currentLevel =
          params.thinkLevel ??
          directiveThinkLevel ??
          resolveAgentThinkLevel(agent) ??
          "not set";
        const statusText = `Current thinking level: ${currentLevel}`;
        emit({ type: "text", data: statusText });
        emit({ type: "done", meta: { durationMs: 0 } });
        return {
          payloads: [{ text: statusText }],
          meta: { durationMs: 0, sessionId },
        };
      }
    }
  }

  // Resolve thinkLevel:
  // - OAuth: API param > Directive > Config > undefined
  // - Non-OAuth: API param > Config > undefined (no directive/session support)
  let resolvedThinkLevel: ThinkLevel | undefined;
  if (isOAuth) {
    resolvedThinkLevel =
      params.thinkLevel ?? directiveThinkLevel ?? resolveAgentThinkLevel(agent);
  } else {
    // Non-OAuth: still honor API param and config, just no directive/session
    resolvedThinkLevel = params.thinkLevel ?? resolveAgentThinkLevel(agent);
  }

  if (resolvedThinkLevel) {
    lifecycle.setTraceMetadata({ thinkingLevel: resolvedThinkLevel });
  }

  // An ordinary inbound message must never implicitly interrupt work that is
  // durably active. It remains a conversational follow-up until the agent
  // explicitly changes the task through its lifecycle tools.
  const activeTask = await getTask(params.agentId, sessionId, sessionOwnerId);
  const joinPolicy = {
    queueMode: activeTask?.status === "active" ? "queue" : agent.queueMode ?? "queue",
    capabilities,
    adapter,
    message,
    sender: params.sender,
    params: { ...params, message, sessionOwnerId: sessionOwnerId ?? null },
  };

  await ensureSessionsDir();

  let abortController: AbortController | undefined;
  while (!abortController) {
    // Check and reserve synchronously after all asynchronous setup. Two senders
    // arriving at an idle thread must not both activate it.
    abortController = await waitForCompactionActivation(params.agentId, sessionId, sessionOwnerId, () =>
      {
        if (getSession(params.agentId, sessionId)?.resetting) throw new Error("Session is being reset. Retry once the reset completes.");
        return lifecycle.isStreaming() ? undefined : lifecycle.beginRun();
      }
    );
    if (abortController) break;
    const join = await lifecycle.handleJoin(joinPolicy);
    if (join.handled) {
      lifecycle.emitQueuedAck(message, join.result.text, join.result.deferred);
      return {
        payloads: [{ text: join.result.text }],
        meta: { durationMs: 0, sessionId, queued: true },
      };
    }
  }

  let acceptsAbort = true;
  // Wire external abort signal (e.g. scheduler timeout) into the session abort path.
  if (params.signal?.aborted) {
    abortController.abort();
  } else {
    params.signal?.addEventListener("abort", () => { if (acceptsAbort) abortController.abort(); }, { once: true });
  }

  const started = Date.now();
  let aborted = false;
  let answerPersisted = false;
  const holdback = createNoReplyHoldback(emit);
  shape?.end(); // new turn: clear any stale declaration

  try {
    const context = await new ProjectContextResolver().resolve({
      agentId: params.agentId, sessionId, userId: params.userId,
      projectId: params.projectId, context: params.context,
      sessionHistory: sdkId !== "openclaw" && loadConfig().sessionHistory?.enabled !== false,
    });

    // Persist the user message before the adapter runs so a failure before
    // the model starts (model resolution, auth, ...) cannot lose it. Must be
    // awaited: a persistence error aborts the run via the normal catch path.
    if (message.trim()) {
      await lifecycle.beginUserTurn(
        message,
        Date.now(),
        params.attachments
      );
    }

    // Run with fallback retry for unsupported thinking levels
    let hasEmittedContent = false;
    let actualThinkLevel = resolvedThinkLevel;
    let fallbackUsed = false;

    const runParams = {
      agentId: params.agentId,
      agent,
      userId: params.userId,
      actorUserId: params.actorUserId,
      actorKind: params.actorKind,
      sessionOwnerId: sessionOwnerId ?? null,
      requesterId: params.requesterId,
      sessionId,
      sessionKey,
      message,
      nudge: shape?.nudge,
      attachments: params.attachments,
      workspaceDir,
      model: params.model,
      context,
      extensionRuntime,
      onEvent: (event: StreamEvent) => {
        // Adapters may emit an error and then reject. Only the runner emits
        // the terminal error, after its user-visible notice is persisted.
        if (event.type === "error") return;
        if (event.type === "text" || event.type === "thinking") {
          hasEmittedContent = true;
        }
        if (event.type === "tool_call") {
          maybeGenerateToolLabel({
            agentId: params.agentId,
            sessionId,
            userId: sessionOwnerId,
            toolName: event.name,
            args: event.arguments,
          });
        }
        if (shape?.holdEvent(event)) return;
        holdback.push(event);
      },
      onHistoryEvent: (event: HistoryEvent) =>
        shape ? shape.holdHistory(event) : lifecycle.acceptHistoryEvent(event),
      onSessionHandle: (handle: unknown) => {
        lifecycle.acceptSessionHandle(handle, adapter, capabilities);
      },
      abortSignal: abortController.signal,
    };

    let result: Awaited<ReturnType<typeof adapter.run>>;
    const startIdx = actualThinkLevel
      ? THINK_LEVELS_ORDERED.indexOf(actualThinkLevel)
      : -1;
    const attempted = new Set<ThinkLevel>();

    if (startIdx === -1 || !actualThinkLevel) {
      // No thinking level set, run normally
      lifecycle.rearmInitialEcho();
      result = await adapter.run({ ...runParams, thinkLevel: undefined });
    } else {
      // Try with fallback on thinking level errors
      let lastError: unknown;
      for (let i = startIdx; i < THINK_LEVELS_ORDERED.length; i++) {
        const level = THINK_LEVELS_ORDERED[i];
        if (attempted.has(level)) continue;
        attempted.add(level);

        try {
          lifecycle.rearmInitialEcho();
          result = await adapter.run({ ...runParams, thinkLevel: level });
          actualThinkLevel = level;
          fallbackUsed = level !== resolvedThinkLevel;
          break;
        } catch (err) {
          lastError = err;
          // Only retry if no content emitted yet and it's a thinking level error
          if (!hasEmittedContent && isThinkingLevelError(err)) {
            continue;
          }
          throw err;
        }
      }
      // If loop exhausted without success, throw last error
      if (!result!) {
        throw lastError ?? new Error("All thinking levels failed");
      }
    }

    let silent = isNoReply(result.text);
    if (shape && !silent && !result.aborted) {
      let verdict = shape.lint();
      if (!verdict.ok) {
        // A second run keeps the draft in the model's context only; the hint stays out of the stored chat.
        shape.startRewrite();
        result = await adapter.run({
          ...runParams,
          message: `[chat-shape] ${verdict.hint}`,
          nudge: undefined,
          thinkLevel: actualThinkLevel,
        });
        silent = isNoReply(result.text);
        verdict = shape.lint();
      }
      if (!silent && !result.aborted) await shape.log(verdict);
    }
    shape?.flushText(emit);
    if (silent) {
      holdback.drop();
      logInfo("[agent] silent turn", { agentId: params.agentId, sessionId });
    } else {
      holdback.flush();
      // Add fallback note if a different level was used.
      if (fallbackUsed && actualThinkLevel !== resolvedThinkLevel) {
        const note = `\n\n_Note: Used thinking level "${actualThinkLevel}" ("${resolvedThinkLevel}" not supported by model)_`;
        emit({ type: "text", data: note });
      }
    }

    aborted = result.aborted ?? false;

    shape?.release().forEach((event) => lifecycle.acceptHistoryEvent(event));
    await lifecycle.flushTurns();
    answerPersisted = true;

    const durationMs = Date.now() - started;
    emit({ type: "done", meta: { durationMs, aborted } });
    if (!aborted && sdkId === "pi") {
      maybeAutoTitleSession({
        agentId: params.agentId,
        sessionId,
        userId: sessionOwnerId,
      });
    }

    return {
      payloads: silent || !result.text ? [] : [{ text: result.text }],
      meta: { durationMs, sessionId, aborted, silent },
    };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logError("[agent] run failed", err, { agentId: params.agentId, sessionId });
    holdback.finishSegment();
    shape?.flushText(emit);
    shape?.release().forEach((event) => lifecycle.acceptHistoryEvent(event));
    if (!aborted && !abortController.signal.aborted && !(err instanceof Error && err.name === "AbortError")) {
      const kind = classifyRunFailure(err, errMessage);
      const text = runFailureMessage(kind, agent.language ?? "en");
      await lifecycle.writeFailureNotice({ kind, text });
      answerPersisted = true;
      emit({ type: "error", message: errMessage, kind, userMessage: text });
      if (kind === "quota") {
        void notifyProviderQuota(agent, params.model).catch((error) => {
          logError("[agent] quota notification failed", error, { agentId: params.agentId });
        });
      }
    } else {
      await lifecycle.flushTurns();
      emit({ type: "done", meta: { durationMs: Date.now() - started, aborted: true } });
    }
    throw err;
  } finally {
    shape?.end();
    let completion: WebCompletion | undefined;
    try {
      if (answerPersisted && params.source === "web" && !aborted && !abortController.signal.aborted) {
        // Completion wins synchronously after the answer is durable. Keep the
        // run reserved while metadata settles, but Stop can no longer abort it.
        acceptsAbort = false;
        const session = getSession(params.agentId, sessionId);
        if (session?.abortController === abortController) session.abortController = undefined;
        const marker = { id: randomUUID(), endedAt: Date.now() };
        await appendSessionMeta(params.agentId, sessionId, "lastWebCompletion", marker, sessionOwnerId);
        completion = marker;
      }
    } catch (error) {
      logError("[agent] completion marker write failed", error, { agentId: params.agentId, sessionId });
    } finally {
      acceptsAbort = false;
      lifecycle.finishRun(completion);
    }

    // Deferred turns keep the sender's complete request, including credentials and delivery.
    if (!params.deferredTurn) {
      const drainingSession = getSession(params.agentId, sessionId);
      while (!drainingSession?.resetting && getSession(params.agentId, sessionId) === drainingSession) {
        const pendingMessages = lifecycle.drainPendingMessages();
        if (!pendingMessages.length) break;
        for (const pending of pendingMessages) {
          if (drainingSession?.resetting || getSession(params.agentId, sessionId) !== drainingSession) {
            pending.params?.onEvent?.({ type: "done", meta: { durationMs: 0, aborted: true } });
            continue;
          }
          let outcome: { result: SharedRunAgentResult } | { error: unknown };
          try {
            outcome = { result: await runAgent({
              ...(pending.params ?? params),
              message: pending.message,
              sender: pending.sender,
              sessionId,
              sessionKey,
              resolvedSession: undefined,
              deferredTurn: true,
              extensionRuntime,
              onEvent: pending.params?.onEvent,
            }) };
          } catch (error) {
            logError("[agent] queued turn failed", error, { agentId: params.agentId, sessionId });
            outcome = { error };
          }
          try {
            await pending.params?.onDeferredResult?.(outcome);
          } catch (error) {
            logError("[agent] queued delivery failed", error, { agentId: params.agentId, sessionId });
          }
        }
      }
    }
  }
}

// Re-export types for backward compatibility
export type { SimpleHistoryMessage, FullHistoryMessage, HistoryViewMode };

/**
 * Load conversation history (simple view)
 * Uses canonical history store, with one-time backfill from Pi session files
 */
export async function getSessionHistory(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<SimpleHistoryMessage[]> {
  // One-time backfill from Pi session if canonical doesn't exist
  await backfillFromPiSession(agentId, sessionId, userId);

  // Try canonical history
  if (await hasCanonicalHistory(agentId, sessionId, userId)) {
    return getCanonicalSimpleHistory(agentId, sessionId, userId);
  }

  // No history exists
  return [];
}

/**
 * Load full conversation history with all content blocks
 * Uses canonical history store, with one-time backfill from Pi session files
 */
export async function getFullSessionHistory(
  agentId: string,
  sessionId: string,
  userId?: string
): Promise<FullHistoryMessage[]> {
  // One-time backfill from Pi session if canonical doesn't exist
  await backfillFromPiSession(agentId, sessionId, userId);

  // Try canonical history
  if (await hasCanonicalHistory(agentId, sessionId, userId)) {
    const canonical = await getCanonicalFullHistory(agentId, sessionId, userId);
    // If canonical is incomplete (streaming in progress), fall back to Pi
    if (canonical.length > 0) {
      const last = canonical[canonical.length - 1];
      if (last.role === "user") {
        // Turn hasn't flushed yet — canonical only has user message
        const piHistory = await readPiSessionHistory(
          agentId,
          sessionId,
          userId
        );
        if (piHistory.length > canonical.length) return piHistory;
      }
    }
    return canonical;
  }

  // No canonical — try Pi session directly
  return readPiSessionHistory(agentId, sessionId, userId);
}
