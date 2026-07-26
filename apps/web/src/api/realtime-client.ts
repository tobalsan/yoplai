import type { LeadSessionChangedEvent, SubagentRunStatus } from "@yoplai/shared/types";
import { getWsUrl, type WsStreamEvent } from "./ws";

export type RealtimeInterest =
  | { type: "session"; agentId: string; sessionKey: string; sessionId?: string }
  | { type: "status" }
  | { type: "project"; projectId?: string }
  | { type: "subagents" }
  | { type: "orchestrator" };

export type RealtimeEvent =
  | {
      type: "status";
      agentId: string;
      status: "streaming" | "idle";
      sessionId: string;
      sessionStatus: "streaming" | "idle";
    }
  | { type: "file_changed"; projectId: string; file: string }
  | { type: "agent_changed"; projectId: string }
  | {
      type: "subagent_changed";
      runId: string;
      parent?: { type: string; id: string };
      status: SubagentRunStatus;
    }
  | { type: `orchestrator.${string}`; [key: string]: unknown }
  | LeadSessionChangedEvent
  | WsStreamEvent;

export type SubscribeToRealtimeOptions = {
  interests: RealtimeInterest[];
  onEvent: (event: RealtimeEvent) => void;
  onOpen?: () => void;
  onError?: (error: string) => void;
  onReconnect?: () => void;
  reconnect?: boolean;
  socketFactory?: (url: string) => WebSocket;
};

function hasInterest(
  interests: RealtimeInterest[],
  type: RealtimeInterest["type"]
): boolean {
  return interests.some((interest) => interest.type === type);
}

function matchesProject(
  interests: RealtimeInterest[],
  event: { projectId?: string }
): boolean {
  const projectInterests = interests.filter(
    (interest): interest is Extract<RealtimeInterest, { type: "project" }> =>
      interest.type === "project"
  );
  if (projectInterests.length === 0) return false;
  return projectInterests.some(
    (interest) => !interest.projectId || interest.projectId === event.projectId
  );
}

function shouldDeliver(
  interests: RealtimeInterest[],
  event: RealtimeEvent
): boolean {
  if (event.type === "status") return hasInterest(interests, "status");
  if (event.type === "file_changed" || event.type === "agent_changed") {
    return matchesProject(interests, event);
  }
  if (event.type === "subagent_changed" || event.type === "lead_session_changed") {
    return hasInterest(interests, "subagents");
  }
  if (event.type.startsWith("orchestrator.")) {
    return hasInterest(interests, "orchestrator");
  }
  if (event.type === "error") return true;
  return hasInterest(interests, "session");
}

export function subscribeToRealtime({
  interests,
  onEvent,
  onOpen,
  onError,
  onReconnect,
  reconnect = true,
  socketFactory = (url) => new WebSocket(url),
}: SubscribeToRealtimeOptions): () => void {
  let ws: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let closed = false;
  let connectedOnce = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== undefined) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const scheduleReconnect = () => {
    if (closed || !reconnect || reconnectTimer !== undefined) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, 1000);
  };

  const sendSubscriptions = (socket: WebSocket) => {
    for (const interest of interests) {
      if (interest.type === "session") {
        socket.send(
          JSON.stringify({
            type: "subscribe",
            agentId: interest.agentId,
            sessionKey: interest.sessionKey,
            ...(interest.sessionId ? { sessionId: interest.sessionId } : {}),
          })
        );
      } else if (interest.type === "status") {
        socket.send(JSON.stringify({ type: "subscribeStatus" }));
      }
    }
  };

  const connect = () => {
    if (closed) return;
    const socket = socketFactory(getWsUrl());
    ws = socket;

    socket.onopen = () => {
      sendSubscriptions(socket);
      onOpen?.();
      if (connectedOnce) onReconnect?.();
      connectedOnce = true;
    };

    socket.onmessage = (event) => {
      const payload = JSON.parse(event.data) as RealtimeEvent;
      if (shouldDeliver(interests, payload)) onEvent(payload);
    };

    socket.onerror = () => {
      onError?.("Realtime subscription connection error");
    };

    socket.onclose = () => {
      if (ws === socket) ws = null;
      scheduleReconnect();
    };
  };

  connect();

  return () => {
    closed = true;
    clearReconnectTimer();
    const socket = ws;
    ws = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      if (hasInterest(interests, "session")) {
        socket.send(JSON.stringify({ type: "unsubscribe" }));
      }
      if (hasInterest(interests, "status")) {
        socket.send(JSON.stringify({ type: "unsubscribeStatus" }));
      }
    }
    socket.close();
  };
}

export function useProjectRealtime(
  projectId: string,
  interests: Array<"files" | "agents" | "subagents">,
  onEvent: (event: RealtimeEvent) => void
): () => void {
  return subscribeToRealtime({
    interests: [
      ...(interests.includes("files") || interests.includes("agents")
        ? [{ type: "project" as const, projectId }]
        : []),
      ...(interests.includes("subagents")
        ? [{ type: "subagents" as const }]
        : []),
    ],
    onEvent,
  });
}
