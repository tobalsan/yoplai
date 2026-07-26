import type { ActiveTurn } from "./agents";
import type { DoneMeta, StreamCallbacks } from "./chat";

// `debug` is user-authored, so the legacy `aihub:ws` namespace still enables it.
export const wsDebug = () => {
  const debug = globalThis.localStorage?.getItem("debug");
  return !!debug && (debug.includes("yoplai:ws") || debug.includes("aihub:ws"));
};

export function getWsUrl(): string {
  // Use Vite's proxy in dev mode, direct connection in prod
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

type DispatchCallbacks = Partial<
  StreamCallbacks & {
    onActiveTurn?: (snapshot: ActiveTurn) => void;
    onHistoryUpdated?: () => void;
  }
>;

export type WsStreamEvent =
  | {
      type: "text";
      data: string;
    }
  | {
      type: "thinking";
      data: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      content: string;
      isError?: boolean;
      details?: { diff?: string };
    }
  | {
      type: "tool_start";
      toolName: string;
    }
  | {
      type: "tool_end";
      toolName: string;
      isError?: boolean;
    }
  | {
      type: "file_output";
      fileId: string;
      filename: string;
      mimeType: string;
      size: number;
    }
  | {
      type: "session_reset";
      sessionId: string;
    }
  | {
      type: "done";
      meta?: DoneMeta;
    }
  | {
      type: "history_updated";
    }
  | {
      type: "active_turn";
      agentId: string;
      sessionId: string;
      userText: string | null;
      userTimestamp: number;
      startedAt: number;
      thinking: string;
      text: string;
      toolCalls: Array<{
        id: string;
        name: string;
        arguments: unknown;
        status: "running" | "done" | "error";
      }>;
    }
  | {
      type: "error";
      message: string;
    };

export function dispatchWsEvent(
  event: WsStreamEvent,
  callbacks: DispatchCallbacks
): void {
  switch (event.type) {
    case "text":
      callbacks.onText?.(event.data);
      break;
    case "thinking":
      callbacks.onThinking?.(event.data);
      break;
    case "tool_call":
      callbacks.onToolCall?.(event.id, event.name, event.arguments);
      break;
    case "tool_result":
      callbacks.onToolResult?.(
        event.id,
        event.name,
        event.content,
        event.isError ?? false,
        event.details
      );
      break;
    case "tool_start":
      callbacks.onToolStart?.(event.toolName);
      break;
    case "tool_end":
      callbacks.onToolEnd?.(event.toolName, event.isError ?? false);
      break;
    case "file_output":
      callbacks.onFileOutput?.({
        fileId: event.fileId,
        filename: event.filename,
        mimeType: event.mimeType,
        size: event.size,
      });
      break;
    case "session_reset":
      callbacks.onSessionReset?.(event.sessionId);
      break;
    case "done":
      callbacks.onDone?.(event.meta);
      break;
    case "history_updated":
      callbacks.onHistoryUpdated?.();
      break;
    case "active_turn":
      callbacks.onActiveTurn?.({
        userText: event.userText,
        userTimestamp: event.userTimestamp,
        startedAt: event.startedAt,
        thinking: event.thinking,
        text: event.text,
        toolCalls: event.toolCalls,
      });
      break;
    case "error":
      callbacks.onError?.(event.message);
      break;
  }
}
