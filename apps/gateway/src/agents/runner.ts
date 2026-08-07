import fs from "node:fs/promises";
import path from "node:path";
import type {
  RunAgentParams as SharedRunAgentParams,
  RunAgentResult as SharedRunAgentResult,
  ThinkLevel,
  StreamEvent,
  SimpleHistoryMessage,
  FullHistoryMessage,
  HistoryViewMode,
} from "@yoplai/shared";
import { getAgent, resolveWorkspaceDir, CONFIG_DIR } from "../config/index.js";
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
import { logError } from "../logging.js";
import { getContainerAdapter } from "../sdk/container/adapter.js";
import { getSdkAdapter, getDefaultSdkId } from "../sdk/registry.js";
import type { SdkId, HistoryEvent } from "../sdk/types.js";
import type { ExtensionRuntime } from "../extensions/runtime.js";
import { getExtensionRuntime } from "../extensions/registry.js";
import {
  getSimpleHistory as getCanonicalSimpleHistory,
  getFullHistory as getCanonicalFullHistory,
  hasCanonicalHistory,
  readPiSessionHistory,
  backfillFromPiSession,
  invalidateResolvedHistoryFile,
} from "../history/store.js";

export type InternalRunAgentParams = SharedRunAgentParams & {
  userId?: string;
  extensionRuntime?: ExtensionRuntime;
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
        params.userId
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
      invalidateResolvedHistoryFile(params.agentId, sessionId, params.userId);
    }
  } else if (params.sessionId) {
    sessionId = params.sessionId;
  } else if (sessionKey) {
    const resolved = await resolveSessionId({
      agentId: params.agentId,
      userId: params.userId,
      sessionKey,
      message: params.message,
    });
    sessionId = resolved.sessionId;
    message = resolved.message;
    // Invalidate cached history path on reset (new session via /new, /reset, or idle timeout)
    if (resolved.isNew) {
      invalidateResolvedHistoryFile(params.agentId, sessionId, params.userId);
    }
  } else {
    sessionId = "default";
  }

  const lifecycle = new SessionRunLifecycle({
    agentId: params.agentId,
    sessionId,
    sessionKey,
    userId: params.userId,
    source: params.source,
    slackDelivery: params.slackDelivery,
    trace: params.trace,
    onEvent: params.onEvent,
  });
  const emit = (event: StreamEvent) => lifecycle.emit(event);

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
          params.userId
        );
        await appendSessionMeta(
          params.agentId,
          sessionId,
          "thinkingLevel",
          directive.thinkLevel,
          params.userId
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

  const join = await lifecycle.handleJoin({
    queueMode: agent.queueMode,
    capabilities,
    adapter,
    message,
  });
  if (join.handled) {
    emit({ type: "text", data: join.result.text });
    emit({ type: "done", meta: { durationMs: 0, queued: true } });
    return {
      payloads: [{ text: join.result.text }],
      meta: { durationMs: 0, sessionId, queued: true },
    };
  }

  await ensureSessionsDir();
  const workspaceDir = resolveWorkspaceDir(agent.workspace);

  const abortController = lifecycle.beginRun();

  // Wire external abort signal (e.g. scheduler timeout) into the session abort path.
  if (params.signal?.aborted) {
    abortController.abort();
  } else {
    params.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const started = Date.now();
  let aborted = false;
  let runCompleted = false;

  try {
    // Run with fallback retry for unsupported thinking levels
    let hasEmittedContent = false;
    let actualThinkLevel = resolvedThinkLevel;
    let fallbackUsed = false;

    const runParams = {
      agentId: params.agentId,
      agent,
      userId: params.userId,
      sessionId,
      sessionKey,
      message,
      attachments: params.attachments,
      workspaceDir,
      model: params.model,
      context: params.context,
      extensionRuntime,
      onEvent: (event: StreamEvent) => {
        if (event.type === "text" || event.type === "thinking") {
          hasEmittedContent = true;
        }
        emit(event);
      },
      onHistoryEvent: (event: HistoryEvent) =>
        lifecycle.acceptHistoryEvent(event),
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
      result = await adapter.run({ ...runParams, thinkLevel: undefined });
    } else {
      // Try with fallback on thinking level errors
      let lastError: unknown;
      for (let i = startIdx; i < THINK_LEVELS_ORDERED.length; i++) {
        const level = THINK_LEVELS_ORDERED[i];
        if (attempted.has(level)) continue;
        attempted.add(level);

        try {
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

    // Add fallback note if a different level was used
    if (fallbackUsed && actualThinkLevel !== resolvedThinkLevel) {
      const note = `\n\n_Note: Used thinking level "${actualThinkLevel}" ("${resolvedThinkLevel}" not supported by model)_`;
      emit({ type: "text", data: note });
    }

    aborted = result.aborted ?? false;

    await lifecycle.flushTurns();

    const durationMs = Date.now() - started;
    emit({ type: "done", meta: { durationMs, aborted } });
    runCompleted = true;

    return {
      payloads: result.text ? [{ text: result.text }] : [],
      meta: { durationMs, sessionId, aborted },
    };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logError("[agent] run failed", err, { agentId: params.agentId, sessionId });
    emit({ type: "error", message: errMessage });
    throw err;
  } finally {
    lifecycle.finishRun();

    // Drain pending queue if adapter lacks native queue support
    if (runCompleted && !capabilities.queueWhileStreaming) {
      const pendingMessages = lifecycle.drainPendingMessages();
      for (const pendingMsg of pendingMessages) {
        // Run next message - omit onEvent to use agentEventBus only
        await runAgent({
          agentId: params.agentId,
          userId: params.userId,
          message: pendingMsg,
          sessionId,
          sessionKey,
          thinkLevel: params.thinkLevel,
          extensionRuntime,
          source: params.source,
          slackDelivery: params.slackDelivery,
          trace: params.trace,
          // onEvent omitted - events go to agentEventBus only
        });
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
