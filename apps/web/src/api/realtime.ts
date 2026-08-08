import type { LeadSessionChangedEvent, SubagentRunStatus } from "@yoplai/shared/types";
import type { ActiveTurn } from "./agents";
import { dispatchWsEvent, wsDebug, type WsStreamEvent } from "./ws";
import {
  subscribeToRealtime,
  type RealtimeEvent,
  type RealtimeInterest,
} from "./realtime-client";

export type SubscriptionCallbacks = {
  onText?: (text: string) => void;
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
  onProgress?: (progress: { label: string; current?: number; total?: number; taskId?: string }) => void;
  onFileOutput?: (file: {
    fileId: string;
    filename: string;
    mimeType: string;
    size: number;
  }) => void;
  onActiveTurn?: (snapshot: ActiveTurn) => void;
  onDone?: () => void;
  onHistoryUpdated?: () => void;
  onError?: (error: string) => void;
};

export function subscribeToSession(
  agentId: string,
  sessionKey: string,
  callbacks: SubscriptionCallbacks,
  sessionId?: string
): () => void {
  return subscribeToRealtime({
    interests: [{ type: "session", agentId, sessionKey, sessionId }],
    reconnect: false,
    onOpen: () => callbacks.onHistoryUpdated?.(),
    onEvent: (event) => {
      dispatchWsEvent(event as WsStreamEvent, callbacks);
    },
    onError: () => callbacks.onError?.("Subscription connection error"),
  });
}

export type StatusCallbacks = {
  onStatus?: (agentId: string, status: "streaming" | "idle") => void;
  onError?: (error: string) => void;
  onReconnect?: () => void;
};

export type FileChangeCallbacks = {
  onFileChanged?: (projectId: string, file: string) => void;
  onAgentChanged?: (projectId: string) => void;
  onError?: (error: string) => void;
};

export type SubagentChangeCallbacks = {
  onSubagentChanged?: (event: {
    runId: string;
    parent?: { type: string; id: string };
    status: SubagentRunStatus;
  }) => void;
  onError?: (error: string) => void;
};

export type LeadSessionChangeCallbacks = {
  onLeadSessionChanged?: (event: LeadSessionChangedEvent) => void;
  onError?: (error: string) => void;
};

const statusSubscribers = new Set<StatusCallbacks>();
let statusCleanup: (() => void) | null = null;

function connectStatusSocket(): void {
  if (statusCleanup || statusSubscribers.size === 0) return;
  statusCleanup = subscribeToRealtime({
    interests: [{ type: "status" }],
    onReconnect: () => {
      for (const subscriber of statusSubscribers) subscriber.onReconnect?.();
    },
    onEvent: (event) => {
      if (event.type === "status") {
        if (wsDebug()) {
          console.log("[ws] status received:", event.agentId, event.status);
        }
        for (const subscriber of statusSubscribers) {
          subscriber.onStatus?.(event.agentId, event.status);
        }
        return;
      }
      if (event.type === "error") {
        for (const subscriber of statusSubscribers) {
          subscriber.onError?.(event.message);
        }
      }
    },
    onError: () => {
      for (const subscriber of statusSubscribers) {
        subscriber.onError?.("Status subscription connection error");
      }
    },
  });
}

function disconnectStatusSocket(): void {
  statusCleanup?.();
  statusCleanup = null;
}

const fileChangeSubscribers = new Set<FileChangeCallbacks>();
const subagentChangeSubscribers = new Set<SubagentChangeCallbacks>();
const leadSessionChangeSubscribers = new Set<LeadSessionChangeCallbacks>();
let projectCleanup: (() => void) | null = null;

function connectProjectSocket(): void {
  if (projectCleanup) return;
  if (
    fileChangeSubscribers.size === 0 &&
    subagentChangeSubscribers.size === 0 &&
    leadSessionChangeSubscribers.size === 0
  ) {
    return;
  }

  const interests: RealtimeInterest[] = [{ type: "project" }];
  if (
    subagentChangeSubscribers.size > 0 ||
    leadSessionChangeSubscribers.size > 0
  ) {
    interests.push({ type: "subagents" });
  }
  projectCleanup = subscribeToRealtime({
    interests,
    onEvent: (event: RealtimeEvent) => {
      if (wsDebug()) {
        console.log("[ws] file event received:", event.type);
      }
      if (event.type === "file_changed") {
        for (const subscriber of fileChangeSubscribers) {
          subscriber.onFileChanged?.(event.projectId, event.file);
        }
        return;
      }
      if (event.type === "agent_changed") {
        for (const subscriber of fileChangeSubscribers) {
          subscriber.onAgentChanged?.(event.projectId);
        }
        return;
      }
      if (event.type === "subagent_changed") {
        for (const subscriber of subagentChangeSubscribers) {
          subscriber.onSubagentChanged?.({
            runId: event.runId,
            parent: event.parent,
            status: event.status,
          });
        }
        return;
      }
      if (event.type === "lead_session_changed") {
        for (const subscriber of leadSessionChangeSubscribers) {
          subscriber.onLeadSessionChanged?.(event);
        }
        return;
      }
      if (event.type === "error") {
        for (const subscriber of fileChangeSubscribers) {
          subscriber.onError?.(event.message);
        }
        for (const subscriber of subagentChangeSubscribers) {
          subscriber.onError?.(event.message);
        }
        for (const subscriber of leadSessionChangeSubscribers) {
          subscriber.onError?.(event.message);
        }
      }
    },
    onError: () => {
      for (const subscriber of fileChangeSubscribers) {
        subscriber.onError?.("File change subscription connection error");
      }
      for (const subscriber of subagentChangeSubscribers) {
        subscriber.onError?.("Subagent subscription connection error");
      }
      for (const subscriber of leadSessionChangeSubscribers) {
        subscriber.onError?.("Lead session subscription connection error");
      }
    },
  });
}

function disconnectProjectSocket(): void {
  projectCleanup?.();
  projectCleanup = null;
}

export function subscribeToStatus(callbacks: StatusCallbacks): () => void {
  statusSubscribers.add(callbacks);
  connectStatusSocket();

  return () => {
    statusSubscribers.delete(callbacks);
    if (statusSubscribers.size === 0) {
      disconnectStatusSocket();
    }
  };
}

export function subscribeToFileChanges(
  callbacks: FileChangeCallbacks
): () => void {
  fileChangeSubscribers.add(callbacks);
  connectProjectSocket();

  return () => {
    fileChangeSubscribers.delete(callbacks);
    if (
      fileChangeSubscribers.size === 0 &&
      subagentChangeSubscribers.size === 0 &&
      leadSessionChangeSubscribers.size === 0
    ) {
      disconnectProjectSocket();
    }
  };
}

export function subscribeToSubagentChanges(
  callbacks: SubagentChangeCallbacks
): () => void {
  subagentChangeSubscribers.add(callbacks);
  if (projectCleanup) {
    disconnectProjectSocket();
  }
  connectProjectSocket();

  return () => {
    subagentChangeSubscribers.delete(callbacks);
    if (
      fileChangeSubscribers.size === 0 &&
      subagentChangeSubscribers.size === 0 &&
      leadSessionChangeSubscribers.size === 0
    ) {
      disconnectProjectSocket();
    } else if (
      subagentChangeSubscribers.size === 0 &&
      leadSessionChangeSubscribers.size === 0
    ) {
      disconnectProjectSocket();
      connectProjectSocket();
    }
  };
}

export function subscribeToLeadSessionChanges(
  callbacks: LeadSessionChangeCallbacks
): () => void {
  leadSessionChangeSubscribers.add(callbacks);
  if (projectCleanup) {
    disconnectProjectSocket();
  }
  connectProjectSocket();

  return () => {
    leadSessionChangeSubscribers.delete(callbacks);
    if (
      fileChangeSubscribers.size === 0 &&
      subagentChangeSubscribers.size === 0 &&
      leadSessionChangeSubscribers.size === 0
    ) {
      disconnectProjectSocket();
    } else if (
      subagentChangeSubscribers.size === 0 &&
      leadSessionChangeSubscribers.size === 0
    ) {
      disconnectProjectSocket();
      connectProjectSocket();
    }
  };
}
