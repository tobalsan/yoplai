import { agentEventBus } from "./events.js";
import { reportSessionTurns } from "./active-turns.js";
import type { RunAgentParams, WebCompletion } from "@yoplai/shared";
import type { TurnBuffer } from "../history/store.js";

export type PendingMessage = {
  message: string;
  sender?: RunAgentParams["sender"];
  params?: RunAgentParams;
};

export type AgentSession = {
  agentId: string;
  sessionId: string;
  isStreaming: boolean;
  streamStartedAt?: number;
  background: boolean;
  lastActivity: number;
  abortController?: AbortController;
  sessionHandle?: unknown; // SDK-agnostic session handle
  pendingMessages: PendingMessage[];
  pendingUserMessages: Array<{ text: string; timestamp: number }>;
  currentTurn?: TurnBuffer | null;
  bufferedTurns?: TurnBuffer[];
  storageOwnerId?: string | null;
  requesterId?: string;
  settled?: Promise<void>;
  resolveSettled?: () => void;
  resetting?: boolean;
};

export function setSessionCurrentTurn(
  agentId: string,
  sessionId: string,
  turn: TurnBuffer | null
) {
  const session = getOrCreateSession(agentId, sessionId);
  session.currentTurn = turn;
}

export function getSessionCurrentTurn(
  agentId: string,
  sessionId: string
): TurnBuffer | null {
  const session = getSession(agentId, sessionId);
  return session?.currentTurn ?? null;
}

const sessions = new Map<string, AgentSession>();

export function getSession(agentId: string, sessionId: string): AgentSession | undefined {
  return sessions.get(`${agentId}:${sessionId}`);
}

export function getOrCreateSession(agentId: string, sessionId: string): AgentSession {
  const key = `${agentId}:${sessionId}`;
  let session = sessions.get(key);
  if (!session) {
    session = {
      agentId,
      sessionId,
      isStreaming: false,
      background: false,
      lastActivity: Date.now(),
      pendingMessages: [],
      pendingUserMessages: [],
    };
    sessions.set(key, session);
  }
  return session;
}

/** Buffer a message to be queued once session handle is available */
export function bufferPendingMessage(
  agentId: string,
  sessionId: string,
  message: string,
  sender?: RunAgentParams["sender"],
  params?: RunAgentParams
) {
  const session = getOrCreateSession(agentId, sessionId);
  session.pendingMessages.push({ message, sender, params });
}

/** Get and clear pending messages */
export function popPendingMessages(agentId: string, sessionId: string): PendingMessage[] {
  const session = getSession(agentId, sessionId);
  if (!session) return [];
  const messages = session.pendingMessages;
  session.pendingMessages = [];
  return messages;
}

export function enqueuePendingUserMessage(
  agentId: string,
  sessionId: string,
  text: string,
  timestamp: number
) {
  const session = getOrCreateSession(agentId, sessionId);
  session.pendingUserMessages.push({ text, timestamp });
}

export function shiftPendingUserMessage(
  agentId: string,
  sessionId: string
): { text: string; timestamp: number } | undefined {
  const session = getSession(agentId, sessionId);
  if (!session || session.pendingUserMessages.length === 0) return undefined;
  return session.pendingUserMessages.shift();
}

export function popAllPendingUserMessages(
  agentId: string,
  sessionId: string
): Array<{ text: string; timestamp: number }> {
  const session = getSession(agentId, sessionId);
  if (!session) return [];
  const pending = session.pendingUserMessages;
  session.pendingUserMessages = [];
  return pending;
}

function syncActiveTurns(): void {
  reportSessionTurns(
    [...sessions.values()]
      .filter((s) => s.isStreaming)
      .map((s) => ({
        kind: "turn" as const,
        agentId: s.agentId,
        sessionId: s.sessionId,
        startedAt: new Date(s.streamStartedAt ?? s.lastActivity).toISOString(),
      }))
  );
}

export function setSessionStreaming(
  agentId: string,
  sessionId: string,
  streaming: boolean,
  abortController?: AbortController,
  background = false,
  completion?: WebCompletion
) {
  const session = getOrCreateSession(agentId, sessionId);
  const wasSessionStreaming = session.isStreaming;
  session.isStreaming = streaming;
  if (streaming && !wasSessionStreaming) session.streamStartedAt = Date.now();
  if (!streaming) session.streamStartedAt = undefined;
  session.background = streaming && background;
  session.lastActivity = Date.now();
  session.abortController = streaming ? abortController : undefined;

  // Emit on a streaming change or a persisted completion, even if cleanup
  // already cleared streaming. The event carries session-scoped status (so the
  // chat view can scope its Stop button to its own session) and the
  // agent-wide aggregate (so the sidebar activity indicator stays agent-wide).
  if (wasSessionStreaming !== streaming || completion) {
    syncActiveTurns();
    const isAgentStreaming = getAllSessionsForAgent(agentId).some(
      (s) => s.isStreaming && !s.background
    );
    agentEventBus.emitStatusChange({
      agentId,
      status: isAgentStreaming ? "streaming" : "idle",
      sessionId,
      sessionStatus: streaming ? "streaming" : "idle",
      ...(completion ? { completion } : {}),
    });
  }
}

export function isStreaming(agentId: string, sessionId: string): boolean {
  const session = getSession(agentId, sessionId);
  return session?.isStreaming ?? false;
}

export function abortSession(agentId: string, sessionId: string): boolean {
  const session = getSession(agentId, sessionId);
  if (!session?.abortController) return false;
  session.abortController.abort();
  return true;
}

export function setSessionHandle(
  agentId: string,
  sessionId: string,
  handle: unknown
) {
  const session = getOrCreateSession(agentId, sessionId);
  session.sessionHandle = handle;
}

export function getSessionHandle(
  agentId: string,
  sessionId: string
): unknown | undefined {
  const session = getSession(agentId, sessionId);
  return session?.sessionHandle;
}

export function clearSessionHandle(agentId: string, sessionId: string) {
  const session = getSession(agentId, sessionId);
  if (session) {
    session.sessionHandle = undefined;
  }
}

export function deleteSession(agentId: string, sessionId: string): boolean {
  const key = `${agentId}:${sessionId}`;
  const session = sessions.get(key);
  if (!session) return false;
  const wasSessionStreaming = session.isStreaming;
  session.abortController?.abort();
  sessions.delete(key);
  if (wasSessionStreaming) {
    syncActiveTurns();
    const isAgentStreaming = getAllSessionsForAgent(agentId).some(
      (s) => s.isStreaming && !s.background
    );
    agentEventBus.emitStatusChange({
      agentId,
      status: isAgentStreaming ? "streaming" : "idle",
      sessionId,
      sessionStatus: "idle",
    });
  }
  return true;
}

export function getAllSessionsForAgent(agentId: string): AgentSession[] {
  const result: AgentSession[] = [];
  for (const [key, session] of sessions) {
    if (key.startsWith(`${agentId}:`)) {
      result.push(session);
    }
  }
  return result;
}

export function getAgentStatuses(agentIds?: string[]): Record<string, "streaming" | "idle"> {
  const statuses: Record<string, "streaming" | "idle"> = {};
  if (agentIds && agentIds.length > 0) {
    for (const agentId of agentIds) {
      const sessions = getAllSessionsForAgent(agentId);
      statuses[agentId] = sessions.some(
        (session) => session.isStreaming && !session.background
      ) ? "streaming" : "idle";
    }
    return statuses;
  }
  for (const session of sessions.values()) {
    if (!statuses[session.agentId]) {
      statuses[session.agentId] = session.isStreaming && !session.background ? "streaming" : "idle";
    } else if (session.isStreaming && !session.background) {
      statuses[session.agentId] = "streaming";
    }
  }
  return statuses;
}
