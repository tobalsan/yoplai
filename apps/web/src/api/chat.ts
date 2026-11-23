import type { McpAppView, McpAppViewReference } from "@yoplai/shared/types";
import type {
  FileAttachment,
  SessionSummary,
  SessionSearchResult,
  ThinkLevel,
} from "./types";
import { API_BASE, apiFetch as fetch } from "./core";
import { dispatchWsEvent, getWsUrl, type WsStreamEvent } from "./ws";
import type { WsDeviceApprovalRequest, WsDeviceApprovalResolved } from "@yoplai/shared";
import { readMigratedLocal } from "../lib/local-storage";

const SESSION_KEY_PREFIX = "yoplai:sessionKey:";
const DEFAULT_SESSION_KEY = "main";
const COMPACT_TIMEOUT_MS = 60_000;

export type DoneMeta = {
  durationMs?: number;
  aborted?: boolean;
  queued?: boolean;
};

export type StreamCallbacks = {
  onText: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolCall?: (id: string, name: string, args: unknown, parentToolCallId?: string, view?: McpAppView) => void;
  onToolResult?: (
    id: string,
    name: string,
    content: string,
    isError: boolean,
    details?: { diff?: string },
    parentToolCallId?: string,
    view?: McpAppViewReference
  ) => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string, isError: boolean) => void;
  onProgress?: (progress: {
    label: string;
    current?: number;
    total?: number;
    taskId?: string;
  }) => void;
  onFileOutput?: (file: {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
  }) => void;
  onSessionReset?: (sessionId: string) => void;
  onTurnExists?: () => void;
  onDeviceApprovalClosed?: () => void;
  /** `answer` sends the reply on the socket of this message. It returns false when the socket is closed. */
  onDeviceApprovalRequest?: (
    request: WsDeviceApprovalRequest,
    answer: (approvalId: string, approve: boolean) => boolean
  ) => void;
  onDeviceApprovalResolved?: (resolved: WsDeviceApprovalResolved) => void;
  onDone: (meta?: DoneMeta) => void;
  onError: (error: string) => void;
};

export type StreamMessageOptions = {
  retryOnDisconnect?: boolean;
  turnId?: string;
  projectId?: string;
  attachments?: FileAttachment[];
  thinkLevel?: ThinkLevel;
  sessionId?: string;
};

export async function postAbort(
  agentId: string,
  sessionKey: string,
  sessionId?: string
): Promise<void> {
  await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "/abort", sessionKey, sessionId }),
  });
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Unauthenticated");
    this.name = "UnauthenticatedError";
  }
}

export async function fetchAgentSessions(options?: {
  includeArchived?: boolean;
  strict?: boolean;
  signal?: AbortSignal;
}): Promise<{
  items: SessionSummary[];
}> {
  const params = new URLSearchParams();
  if (options?.includeArchived) {
    params.set("includeArchived", "1");
  }
  const url = `${API_BASE}/agents/sessions${params.toString() ? `?${params}` : ""}`;
  const res = await fetch(url, options?.signal ? { signal: options.signal } : undefined);
  if (res.status === 401) throw new UnauthenticatedError();
  if (!res.ok) {
    if (options?.strict) throw new Error("Failed to fetch sessions");
    return { items: [] };
  }
  return res.json();
}

export async function searchSessions(query: string, signal: AbortSignal): Promise<{ items: SessionSearchResult[] }> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${API_BASE}/agents/sessions/search?${params}`, { signal });
  if (!res.ok) throw new Error("Unable to search chats");
  return res.json();
}

export async function deleteAgentSession(
  agentId: string,
  sessionId: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "DELETE",
    }
  );
  if (!res.ok) throw new Error("Failed to delete session");
}

export async function renameAgentSession(
  agentId: string,
  sessionId: string,
  title: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }
  );
  if (!res.ok) throw new Error("Failed to rename session");
}

export async function pinAgentSession(
  agentId: string,
  sessionId: string,
  pinned: boolean
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    }
  );
  if (!res.ok) throw new Error("Failed to pin session");
}

export async function archiveAgentSession(
  agentId: string,
  sessionId: string,
  archived: boolean
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived }),
    }
  );
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Failed to archive session" }));
    throw new Error(error.error || "Failed to archive session");
  }
}

export async function postCompact(
  agentId: string,
  sessionKey: string,
  sessionId?: string
): Promise<void> {
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    COMPACT_TIMEOUT_MS
  );
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/agents/${encodeURIComponent(agentId)}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey, ...(sessionId ? { sessionId } : {}) }),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Compaction timed out. Try again.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: unknown;
    } | null;
    throw new Error(
      typeof body?.error === "string" ? body.error : "Failed to compact context"
    );
  }
}

export function getSessionKey(agentId: string): string {
  return (
    readMigratedLocal(`${SESSION_KEY_PREFIX}${agentId}`) ?? DEFAULT_SESSION_KEY
  );
}

export function setSessionKey(agentId: string, key: string): void {
  localStorage.setItem(`${SESSION_KEY_PREFIX}${agentId}`, key);
}

// Start a brand-new chat for an agent: mint a fresh logical session key so
// the gateway creates a new session on the first message instead of resuming
// the agent's "main" session.
export function startNewChat(agentId: string): void {
  const key = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  setSessionKey(agentId, key);
}

export function streamMessage(
  agentId: string,
  message: string,
  sessionKey: string,
  onText: (text: string) => void,
  onDone: (meta?: DoneMeta) => void,
  onError: (error: string) => void,
  callbacks?: Partial<StreamCallbacks>,
  options?: StreamMessageOptions
): () => void {
  const payload = JSON.stringify({
    type: "send",
    agentId,
    sessionKey,
    message,
    clientSendId: crypto.randomUUID(),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.turnId !== undefined ? { turnId: options.turnId } : {}),
    ...(options?.projectId ? { projectId: options.projectId } : {}),
    ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
    ...(options?.thinkLevel ? { thinkLevel: options.thinkLevel } : {}),
  });
  let ws: WebSocket;
  let terminated = false;
  let approvalsClosed = false;
  let canRetry = options?.retryOnDisconnect === true;
  let receivedText = "";
  let replayPrefix = "";
  const closeApprovals = () => {
    if (approvalsClosed) return;
    approvalsClosed = true;
    callbacks?.onDeviceApprovalClosed?.();
  };

  const answerApproval = (approvalId: string, approve: boolean) => {
    if (terminated || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify({ type: "device_approval_answer", approvalId, approve }));
    return true;
  };

  function connect() {
    const socket = new WebSocket(getWsUrl());
    ws = socket;
    socket.onopen = () => {
      if (socket === ws && !terminated) socket.send(payload);
    };
    const lost = (message: string) => {
      if (socket !== ws || terminated) return;
      if (canRetry) {
        canRetry = false;
        replayPrefix = receivedText;
        connect();
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
        return;
      }
      closeApprovals();
      terminated = true;
      onError(message);
    };
    socket.onmessage = (e) => {
      if (socket !== ws || terminated) return;
      const event = JSON.parse(e.data) as WsStreamEvent;
      if (event.type === "done" || event.type === "error" || event.type === "turn_exists") {
        terminated = true;
        closeApprovals();
      }
      if (event.type === "turn_exists") {
        callbacks?.onTurnExists?.();
        return;
      }
      const approval = event as unknown as { type: string };
      if (approval.type === "device_approval_request") {
        callbacks?.onDeviceApprovalRequest?.(event as unknown as WsDeviceApprovalRequest, answerApproval);
        return;
      }
      if (approval.type === "device_approval_resolved") {
        callbacks?.onDeviceApprovalResolved?.(event as unknown as WsDeviceApprovalResolved);
        return;
      }
      if (event.type === "text" && options?.retryOnDisconnect) {
        if (replayPrefix.startsWith(event.data)) {
          replayPrefix = replayPrefix.slice(event.data.length);
          return;
        }
        if (!event.data.startsWith(replayPrefix)) {
          lost("Connection closed");
          return;
        }
        event.data = event.data.slice(replayPrefix.length);
        replayPrefix = "";
        receivedText += event.data;
      }
      dispatchWsEvent(event, { ...callbacks, onText, onDone, onError });
    };

    socket.onerror = () => lost("Connection error");
    socket.onclose = () => lost("Connection closed");
  }
  connect();

  return () => {
    closeApprovals();
    terminated = true;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };
}
