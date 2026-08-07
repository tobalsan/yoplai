import type {
  FileAttachment,
  SendMessageResponse,
  SessionSummary,
  ThinkLevel,
} from "./types";
import { API_BASE, apiFetch as fetch } from "./core";
import { dispatchWsEvent, getWsUrl, type WsStreamEvent } from "./ws";
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
  onToolCall?: (id: string, name: string, args: unknown) => void;
  onToolResult?: (
    id: string,
    name: string,
    content: string,
    isError: boolean,
    details?: { diff?: string }
  ) => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string, isError: boolean) => void;
  onFileOutput?: (file: {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
  }) => void;
  onSessionReset?: (sessionId: string) => void;
  onDone: (meta?: DoneMeta) => void;
  onError: (error: string) => void;
};

export type StreamMessageOptions = {
  attachments?: FileAttachment[];
  thinkLevel?: ThinkLevel;
  sessionId?: string;
};

export async function sendMessage(
  agentId: string,
  message: string,
  sessionId?: string
): Promise<SendMessageResponse> {
  const res = await fetch(`${API_BASE}/agents/${agentId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId }),
  });
  if (!res.ok) throw new Error("Failed to send message");
  return res.json();
}

export async function postAbort(
  agentId: string,
  sessionKey: string,
  sessionId?: string
): Promise<void> {
  await fetch(`${API_BASE}/agents/${agentId}/messages`, {
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

export async function fetchAgentSessions(): Promise<{
  items: SessionSummary[];
}> {
  const res = await fetch(`${API_BASE}/agents/sessions`);
  if (res.status === 401) throw new UnauthenticatedError();
  if (!res.ok) return { items: [] };
  return res.json();
}

export async function deleteAgentSession(
  agentId: string,
  sessionId: string
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/agents/${agentId}/sessions/${sessionId}`,
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
    `${API_BASE}/agents/${agentId}/sessions/${sessionId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }
  );
  if (!res.ok) throw new Error("Failed to rename session");
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
    res = await fetch(`${API_BASE}/agents/${agentId}/compact`, {
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
  const ws = new WebSocket(getWsUrl());
  let terminated = false;

  ws.onopen = () => {
    const payload: Record<string, unknown> = {
      type: "send",
      agentId,
      sessionKey,
      message,
    };
    if (options?.sessionId) payload.sessionId = options.sessionId;
    if (options?.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments;
    }
    if (options?.thinkLevel) {
      payload.thinkLevel = options.thinkLevel;
    }
    ws.send(JSON.stringify(payload));
  };

  ws.onmessage = (e) => {
    const event = JSON.parse(e.data) as WsStreamEvent;
    if (event.type === "done" || event.type === "error") terminated = true;
    dispatchWsEvent(event, {
      ...callbacks,
      onText,
      onDone,
      onError,
    });
  };

  ws.onerror = () => {
    terminated = true;
    onError("Connection error");
  };

  // If the socket closes without a terminal done/error event (e.g. network drop,
  // server restart), surface a recoverable error so the UI can clear isStreaming.
  ws.onclose = () => {
    if (!terminated) {
      terminated = true;
      onError("Connection closed");
    }
  };

  return () => {
    terminated = true;
    if (
      ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING
    ) {
      ws.close();
    }
  };
}
