import { targetsDurableMain } from "@yoplai/shared/types";
// Flicker: keep immutable streamingBlocks() reads, batch completion/reset, and
// history/block identity for transcript Index/non-keyed branches and reply copy.
// Run under the page owner; pagination fetch/guard precedes the synchronous
// preservePrependScroll mutation so DOM measurement happens after the network wait.
import {
  createSignal,
  createEffect,
  createMemo,
  onCleanup,
  on,
  batch,
  type Accessor,
} from "solid-js";
import type { McpAppView, McpAppViewReference } from "@yoplai/shared/types";
import type { WsDeviceApprovalRequest, WsDeviceApprovalResolved } from "@yoplai/shared";
import type { RealtimeSubscription } from "../../api/realtime-client";
import { isNoReply } from "@yoplai/shared/no-reply";
import { getMaxContextTokens } from "@yoplai/shared/model-context";
import {
  streamMessage,
  startNewChat as startNewChatKey,
  fetchFullHistory,
  archiveAgentSession,
  subscribeToSession,
  subscribeToRealtime,
  postAbort,
  postCompact,
  type ActiveTurn,
  type DoneMeta,
  type StreamCallbacks,
} from "../../api";
import type {
  Agent,
  Message,
  HistoryViewMode,
  FullHistoryMessage,
  FullToolResultMessage,
  ContentBlock,
  FileAttachment,
  FileBlock,
  ActiveToolCall,
  ThinkLevel,
} from "../../api/types";
import { refreshToolLabels } from "../../lib/tool-labels";
import { registerViewedChat } from "../../lib/chat-notifications";
import { classifyFile, type PendingFile } from "../../lib/attachments";
import { fullMessagesToSimpleView, isExtensionFrameView, type SimpleViewMessage, type ChatContentBlock } from "./chat-history";

export type StreamingBlock =
  | {
      type: "thinking";
      thinking: string;
      timestamp: number;
    }
  | {
      type: "text";
      text: string;
      timestamp: number;
    }
  | {
      type: "toolCall";
      id: string;
      parentToolCallId?: string;
      name: string;
      arguments: unknown;
      status: "running" | "done" | "error";
      timestamp: number;
      result?: FullToolResultMessage;
      view?: McpAppView;
    }
  | (FileBlock & { timestamp: number });

export type CompactStatus = {
  state: "running" | "done" | "error";
  text: string;
  /** When compaction settled; anchors the status inline in the history. */
  at?: number;
};


/** `request` numbers the history requests in start order. `refresh` marks one made after the gateway said the run ended. */
type HistoryLoaded = { scope: string; sessionId: string | undefined; empty: boolean; request: number; refresh: boolean };
type SendRequest = {
  text: string;
  turnId?: string;
  onTaggedError?: () => void;
  // The composer captures this before restore/compaction; later selections belong to the next send.
  pendingFiles: readonly PendingFile[];
};
type SendResult = { kind: "sent" | "blocked" };
type ChatSessionInput = {
  agentId: Accessor<string>;
  agent: Accessor<Agent | undefined>;
  sessionKey: Accessor<string>;
  explicitSessionId: Accessor<string | undefined>;
  viewMode: Accessor<HistoryViewMode>;
  projectId: Accessor<string | undefined>;
  isArchived: Accessor<boolean>;
  isImpersonating: Accessor<boolean>;
  isUploading: Accessor<boolean>;
  uploadPending: (pendingFiles: readonly PendingFile[]) => Promise<{ attachments?: FileAttachment[]; inboundFiles: FileBlock[] } | "failed">;
  onArchiveRestored: () => void;
  onSessionReset: (newSessionId: string) => void;
  onRemoteReset: () => Promise<void>;
  preservePrependScroll: (prepend: () => void) => void;
  onLiveView?: (view: McpAppViewReference) => void;
};

/** A device call that waits for the user. `answered` means the page sent its answer. */
export type DeviceApprovalItem = {
  request: WsDeviceApprovalRequest;
  state: "pending" | "answered" | "timeout";
};

/** A remote agent has an id of the form `name@gateway`. Only its socket connects again after a drop. */
function isRemoteAgent(agentId: string): boolean {
  return agentId.includes("@");
}

export function createChatSession(input: ChatSessionInput) {
  const { agent, sessionKey, viewMode, explicitSessionId } = input;
  const durableMain = () => targetsDurableMain(agent(), explicitSessionId());
  const [historyLoaded, setHistoryLoaded] = createSignal<HistoryLoaded>();
  const [simpleMessages, setSimpleMessages] = createSignal<SimpleViewMessage[]>(
    []
  );
  const [fullMessages, setFullMessages] = createSignal<FullHistoryMessage[]>(
    []
  );
  const [thinkingLevel, setThinkingLevel] = createSignal<
    ThinkLevel | undefined
  >();
  const [pendingThinkLevel, setPendingThinkLevel] =
    createSignal<ThinkLevel | null>(null);

  const [deviceApprovals, setDeviceApprovals] = createSignal<DeviceApprovalItem[]>([]);
  const [deviceConnectionLost, setDeviceConnectionLost] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const [showInterrupted, setShowInterrupted] = createSignal(false);
  const [isStreaming, setIsStreaming] = createSignal(false);
  // The concrete sessionId this view currently owns. The web UI subscribes by
  // sessionKey (default "main"); the gateway resolves it to a sessionId which we
  // capture from the history response so we can scope status events to this
  // session and ignore background sessions (forum threads, scheduler, amsg).
  const [resolvedSessionId, setResolvedSessionId] = createSignal<
    string | undefined
  >(undefined);
  const [appSessionFailed, setAppSessionFailed] = createSignal(false);
  let appSessionLookup: AbortController | undefined;
  const [streamingThinking, setStreamingThinking] = createSignal("");
  const [streamingThinkingAt, setStreamingThinkingAt] = createSignal<
    number | null
  >(null);
  const [streamingToolCalls, setStreamingToolCalls] = createSignal<
    Array<{
      id: string;
      parentToolCallId?: string;
      name: string;
      arguments: unknown;
      status: "running" | "done" | "error";
      timestamp: number;
    }>
  >([]);
  const [streamingText, setStreamingText] = createSignal("");
  const [streamingBlocks, setStreamingBlocks] = createSignal<StreamingBlock[]>(
    []
  );
  const [streamingFiles, setStreamingFiles] = createSignal<FileBlock[]>([]);
  const [streamingTextAt, setStreamingTextAt] = createSignal<number | null>(
    null
  );
  const [streamingStartedAt, setStreamingStartedAt] = createSignal<
    number | null
  >(null);
  const [streamingFinished, setStreamingFinished] = createSignal(false);
  const [activeTools, setActiveTools] = createSignal<ActiveToolCall[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [pendingQueuedMessages, setPendingQueuedMessages] = createSignal<
    Array<{ text: string; timestamp: number; files?: FileBlock[] }>
  >([]);
  const [contextFullMessages, setContextFullMessages] = createSignal<
    FullHistoryMessage[]
  >([]);
  const [compactStatuses, setCompactStatuses] = createSignal<ReadonlyMap<string, CompactStatus>>(
    new Map<string, CompactStatus>()
  );
  const compactRequests = new Map<string, Promise<void>>();
  const [historyCursor, setHistoryCursor] = createSignal<string | undefined>();
  const [loadingEarlier, setLoadingEarlier] = createSignal(false);
  const [historyError, setHistoryError] = createSignal("");
  const [activeContextUsage, setActiveContextUsage] = createSignal<
    { inputTokens: number; model?: string } | undefined
  >();
  let loadedHistory: FullHistoryMessage[] = [];
  let loadedHistorySession: string | null = null;
  let loadedHistoryOffset = 0;
  let latestDurableTurn: ActiveTurn | null = null;
  let directDurableSnapshotSeen = false;
  let refreshingDurableProgress = false;
  let pendingDurableProgress = false;


  let cleanup: (() => void) | null = null;
  let directStreamSession: string | null = null;
  let displayedSession: string | null = null;
  let pendingResetSession: string | null = null;
  let subscriptionCleanup: RealtimeSubscription | null = null;
  let aborted = false;
  let skipNextHistoryRefresh = false;
  let preparingSend = false;

  const noAnimIds = new Set<string>();

  createEffect(on([() => input.agentId(), sessionKey, explicitSessionId], (scope, previous) => {
    if (previous && scope.every((value, index) => value === previous[index])) return;
    appSessionLookup?.abort();
    appSessionLookup = undefined;
    setAppSessionFailed(false);
    const followsResolved = previous && scope[0] === previous[0] && scope[1] === previous[1] && scope[2] === resolvedSessionId();
    setResolvedSessionId(pendingResetSession === currentSession() || followsResolved ? explicitSessionId() : undefined);
  }));
  createEffect(() => {
    const sessionId = resolvedSessionId();
    if (sessionId) onCleanup(registerViewedChat(input.agentId(), sessionId));
  });
  const sessionScope = (sessionId = explicitSessionId()) =>
    `${input.agentId()}:${sessionKey()}:${sessionId ?? ""}`;
  const currentSession = () => sessionScope();
  const ownsDisplayedDirectStream = () =>
    cleanup !== null && directStreamSession === currentSession();

  const contextUsage = createMemo(() => {
    const active = activeContextUsage();
    if (active) {
      return { inputTokens: active.inputTokens, maxTokens: getMaxContextTokens(active.model) };
    }
    let highestInputTokens = 0;
    let hasUsage = false;
    let modelName: string | undefined;
    for (const message of contextFullMessages()) {
      if (message.role !== "assistant") continue;
      const meta = message.meta;
      if (meta?.model) modelName = meta.model;
      const usage = meta?.usage;
      if (!usage) continue;
      const { input, cacheRead, cacheWrite } = usage;
      hasUsage ||= [input, cacheRead, cacheWrite].some((value) => typeof value === "number");
      const inputTokens =
        (typeof input === "number" ? input : 0) +
        (typeof cacheRead === "number" ? cacheRead : 0) +
        (typeof cacheWrite === "number" ? cacheWrite : 0);
      if (inputTokens > highestInputTokens) highestInputTokens = inputTokens;
    }
    const maxTokens = getMaxContextTokens(modelName);
    return hasUsage && maxTokens > 0 ? { inputTokens: highestInputTokens, maxTokens } : null;
  });

  const estimatedContextUsagePct = createMemo(() => {
    const usage = contextUsage();
    if (!usage) return 0;
    const pct = (usage.inputTokens / usage.maxTokens) * 100;
    return pct > 0 && pct < 1 ? 1 : Math.max(0, Math.min(100, Math.round(pct)));
  });

  const shouldAutoCompact = createMemo(() => !durableMain() && estimatedContextUsagePct() >= 80);

  const contextWarning = createMemo(() => {
    if (durableMain()) return null;
    const pct = estimatedContextUsagePct();
    if (pct >= 75) {
      return `Context usage is high, consider compacting by sending "/compact". Context will be auto-compacted above 80%.`;
    }
    return null;
  });

  const copyTurnOverrides = new WeakMap<object, number>();
  const copyExcludedMessages = new WeakSet<object>();
  const [streamingCopyTurnTimestamp, setStreamingCopyTurnTimestamp] = createSignal<number>();
  const activeCopyTurnTimestamp = (messages: { role: string; timestamp: number }[]) => {
    if (!isStreaming()) return Infinity;
    if (streamingCopyTurnTimestamp() !== undefined) return streamingCopyTurnTimestamp()!;
    const started = streamingStartedAt() ?? Infinity;
    return messages.filter((message) => message.role === "user" && message.timestamp <= started).at(-1)?.timestamp ?? -Infinity;
  };
  const copyReplies = <T extends object>(rows: { role: string; timestamp: number; blocks: { key: T; text?: string }[] }[], activeTurn: number) => {
    const turns = new Map<number, { texts: string[]; anchor?: T }>();
    let current: number | undefined;
    for (const row of rows) {
      if (row.role === "user") {
        current = row.timestamp;
        if (!turns.has(current)) turns.set(current, { texts: [] });
      } else if (row.role === "assistant") {
        for (const block of row.blocks) {
          const turnId = copyTurnOverrides.get(block.key) ?? current;
          const turn = turnId === undefined ? undefined : turns.get(turnId);
          if (!turn) continue;
          turn.anchor = block.key;
          if (block.text?.trim() && !isNoReply(block.text)) turn.texts.push(block.text);
        }
      }
    }
    const replies = new Map<T, string[]>();
    for (const [id, turn] of turns) {
      if (id < activeTurn && turn.anchor && turn.texts.length) replies.set(turn.anchor, turn.texts);
    }
    return replies;
  };
  const simpleCopyReplies = createMemo(() => copyReplies<SimpleViewMessage>(simpleMessages().map((message) => ({
    role: message.role,
    timestamp: message.timestamp,
    blocks: message.role === "assistant" && !message.meta?.failure && !copyExcludedMessages.has(message)
      ? [{ key: message, text: message.content }] : [],
  })), activeCopyTurnTimestamp(simpleMessages())));
  const fullCopyReplies = createMemo(() => copyReplies(fullMessages().map((message) => ({
    role: message.role,
    timestamp: message.timestamp,
    blocks: message.role === "assistant" && !message.meta?.failure && !copyExcludedMessages.has(message)
      ? message.content.flatMap((block) => block.type === "text" ? [{ key: block as ContentBlock, text: block.text }] : block.type === "file" ? [{ key: block as ContentBlock }] : [])
      : [],
  })), activeCopyTurnTimestamp(fullMessages())));

  // Load history based on view mode
  let latestHistoryRequest = 0;
  const loadHistory = async (mode: HistoryViewMode, refresh = false) => {
    const agentId = input.agentId();
    if (!agentId) return;
    const request = ++latestHistoryRequest;
    const requestedSession = currentSession();
    const key = sessionKey();
    const sessionId = explicitSessionId();
    setLoading(true);
    const res = await fetchFullHistory(agentId, key, sessionId, { limit: 100 });
    if (requestedSession !== currentSession() || request !== latestHistoryRequest) return;
    const offset = res.historyOffset ?? 0;
    const prefixLength = loadedHistorySession === requestedSession
      ? offset - loadedHistoryOffset
      : -1;
    const older = prefixLength > 0 && prefixLength <= loadedHistory.length
      ? loadedHistory.slice(0, prefixLength)
      : [];
    loadedHistory = [...older, ...res.messages];
    loadedHistorySession = requestedSession;
    if (!older.length) {
      loadedHistoryOffset = offset;
      setHistoryCursor(res.nextCursor);
    }
    const turn = res.activeTurn ?? null;
    const displayHistory = durableMain() && turn
      ? historyWithLiveTools(loadedHistory, turn) : loadedHistory;
    setHistoryError("");
    setActiveContextUsage(res.activeContextUsage);
    if (mode === "full") {
      const baseMessages = [...displayHistory];
      if (res.activeTurn?.userText) {
        baseMessages.push({
          role: "user",
          content: [{ type: "text", text: res.activeTurn.userText }],
          timestamp: res.activeTurn.userTimestamp,
        });
      }
      const pending = pendingQueuedMessages();
      const merged = pending.length
        ? [
            ...baseMessages,
            ...pending.map((msg) => ({
              role: "user" as const,
              content: [
                { type: "text" as const, text: msg.text },
                ...(msg.files ?? []),
              ],
              timestamp: msg.timestamp,
            })),
          ]
        : baseMessages;
      setFullMessages(merged);
      setContextFullMessages(res.messages);
      if (res.thinkingLevel) setThinkingLevel(res.thinkingLevel);
      if (res.sessionId) setResolvedSessionId(res.sessionId);
      applyActiveTurn(durableMain() ? turn !== null : res.isStreaming ?? false, turn);
    } else {
      setContextFullMessages(res.messages);
      const base = fullMessagesToSimpleView(displayHistory);
      if (res.activeTurn?.userText) {
        base.push({
          id: crypto.randomUUID(),
          role: "user",
          content: res.activeTurn.userText,
          files: undefined,
          timestamp: res.activeTurn.userTimestamp,
        });
      }
      const pending = pendingQueuedMessages();
      const merged = pending.length
        ? [
            ...base,
            ...pending.map((msg) => ({
              id: crypto.randomUUID(),
              role: "user" as const,
              content: msg.text,
              files: msg.files,
              timestamp: msg.timestamp,
            })),
          ]
        : base;
      setSimpleMessages(merged);
      if (res.thinkingLevel) setThinkingLevel(res.thinkingLevel);
      if (res.sessionId) setResolvedSessionId(res.sessionId);
      applyActiveTurn(durableMain() ? turn !== null : res.isStreaming ?? false, turn);
    }
    setLoading(false);
    setHistoryLoaded({ scope: requestedSession, sessionId, empty: res.messages.length === 0, request, refresh });
  };

  const loadEarlierHistory = async () => {
    const before = historyCursor();
    if (!before || loadingEarlier()) return;
    const requestedSession = currentSession();
    setLoadingEarlier(true);
    setHistoryError("");
    try {
      const res = await fetchFullHistory(input.agentId(), sessionKey(), explicitSessionId(), { limit: 100, before });
      if (requestedSession !== currentSession() || before !== historyCursor()) return;
      input.preservePrependScroll(() => {
        loadedHistory = [...res.messages, ...loadedHistory];
        loadedHistoryOffset = res.historyOffset ?? Math.max(0, loadedHistoryOffset - res.messages.length);
        if (viewMode() === "full") setFullMessages((messages) => [...res.messages, ...messages]);
        else setSimpleMessages((messages) => [...fullMessagesToSimpleView(res.messages), ...messages]);
        setHistoryCursor(res.nextCursor);
      });
    } catch {
      if (requestedSession === currentSession()) setHistoryError("Could not load earlier messages. Please retry.");
    } finally {
      setLoadingEarlier(false);
    }
  };

  let contextRefreshSession: string | null = null;
  const refreshContextUsage = async () => {
    const requestedSession = currentSession();
    if (contextRefreshSession === requestedSession) return;
    contextRefreshSession = requestedSession;
    try {
      const res = await fetchFullHistory(
        input.agentId(),
        sessionKey(),
        explicitSessionId(),
        { limit: 1 }
      );
      if (requestedSession !== currentSession()) return;
      if (res.sessionId) setResolvedSessionId(res.sessionId);
      setActiveContextUsage(res.activeContextUsage);
      setContextFullMessages(res.messages);
    } finally {
      if (contextRefreshSession === requestedSession) contextRefreshSession = null;
    }
  };

  const compactKey = (agentId: string, key: string, sessionId?: string) =>
    `${agentId}:${key}:${sessionId ?? ""}`;

  const compactStatusForCurrentSession = () =>
    compactStatuses().get(
      compactKey(input.agentId(), sessionKey(), explicitSessionId())
    );


  const setCompactStatus = (key: string, status: CompactStatus) => {
    setCompactStatuses((statuses) => new Map(statuses).set(key, status));
  };

  const compactCurrentSession = () => {
    const agentId = input.agentId();
    const currentSessionKey = sessionKey();
    const currentSessionId = explicitSessionId();
    const key = compactKey(agentId, currentSessionKey, currentSessionId);
    const existing = compactRequests.get(key);
    if (existing) return existing;
    const request = (async () => {
      setCompactStatus(key, {
        state: "running",
        text: "Compacting context...",
      });
      try {
        await postCompact(agentId, currentSessionKey, currentSessionId);
        if (
          compactKey(input.agentId(), sessionKey(), explicitSessionId()) === key
        ) {
          await loadHistory(viewMode());
        }
        setCompactStatus(key, {
          state: "done",
          text: "Context compacted.",
          at: Date.now(),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to compact context";
        setCompactStatus(key, { state: "error", text: message, at: Date.now() });
        throw error;
      } finally {
        compactRequests.delete(key);
      }
    })();
    compactRequests.set(key, request);
    return request;
  };

  const storedToolResults = (messages: readonly FullHistoryMessage[]) => new Set(
    messages.flatMap((message) => message.role === "toolResult" ? [message.toolCallId] : [])
  );

  // A pending invocation is already in Durable history as a call block.
  // Keep it in the live bubble until history includes its result.
  const historyWithLiveTools = (messages: FullHistoryMessage[], turn: ActiveTurn) => {
    const finished = storedToolResults(messages);
    const pending = new Set(turn.toolCalls.filter(({ id }) => !finished.has(id)).map(({ id }) => id));
    if (!pending.size) return messages;
    return messages.flatMap<FullHistoryMessage>((message) => {
      if (message.role !== "assistant") return [message];
      const content = message.content.filter((block) => block.type !== "toolCall" || !pending.has(block.id));
      return content.length === message.content.length ? [message] : content.length ? [{ ...message, content }] : [];
    });
  };

  const showDurableTurn = (turn: ActiveTurn) => {
    latestDurableTurn = turn;
    if (ownsDisplayedDirectStream()) directDurableSnapshotSeen = true;
    const finished = storedToolResults(loadedHistory);
    batch(() => applyActiveTurnSnapshot({
      ...turn,
      toolCalls: turn.toolCalls.filter(({ id }) => !finished.has(id)),
      toolResults: turn.toolResults?.filter(({ id }) => !finished.has(id)),
    }));
  };

  const durableToolsKey = (turn: ActiveTurn | null) => JSON.stringify(
    turn?.toolCalls.filter(({ parentToolCallId }) => parentToolCallId === undefined)
      .map(({ id, status }) => [id, status === "running"]) ?? []
  );

  // HTTP and WebSocket are separate transports. When a socket partial
  // overlaps history, confirm against a fresh, coherent history/live read.
  // A repeated phrase can belong to a new round and still be in flight.
  const durableTurnMayBeStored = (turn: ActiveTurn) => {
    if (!turn.text && !turn.thinking) return false;
    return loadedHistory.some((message) => {
      if (message.role !== "assistant" || message.timestamp < turn.userTimestamp) return false;
      const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      const thinking = message.content.flatMap((block) => block.type === "thinking" ? [block.thinking] : []).join("");
      return text.startsWith(turn.text) && thinking.startsWith(turn.thinking);
    });
  };

  const refreshDurableProgress = (toolsChanged = false) => {
    if (refreshingDurableProgress) {
      pendingDurableProgress ||= toolsChanged;
      return;
    }
    refreshingDurableProgress = true;
    void loadHistory(viewMode(), true).finally(() => {
      refreshingDurableProgress = false;
      const pending = pendingDurableProgress;
      pendingDurableProgress = false;
      if (pending && durableMain()) refreshDurableProgress();
    });
  };

  const applyActiveTurnSnapshot = (turn: import("../../api").ActiveTurn) => {
    const knownResults = new Map(streamingBlocks().flatMap((block) =>
      block.type === "toolCall" && block.result ? [[block.id, block.result] as const] : []
    ));
    setIsStreaming(true);
    setStreamingStartedAt(turn.startedAt ?? Date.now());
    setStreamingCopyTurnTimestamp(turn.userTimestamp);
    setStreamingThinking(turn.thinking ?? "");
    setStreamingThinkingAt(turn.thinking ? turn.startedAt : null);
    setStreamingText(turn.text ?? "");
    setStreamingTextAt(turn.text ? turn.startedAt : null);
    setStreamingToolCalls(
      (turn.toolCalls ?? []).map((tc) => ({
        id: tc.id,
        parentToolCallId: tc.parentToolCallId,
        name: tc.name,
        arguments: tc.arguments,
        status: tc.status,
        timestamp: turn.startedAt,
      }))
    );
    setStreamingBlocks([
      ...(turn.thinking
        ? ([
            {
              type: "thinking" as const,
              thinking: turn.thinking,
              timestamp: turn.startedAt,
            },
          ] satisfies StreamingBlock[])
        : []),
      ...(turn.text
        ? ([
            {
              type: "text" as const,
              text: turn.text,
              timestamp: turn.startedAt,
            },
          ] satisfies StreamingBlock[])
        : []),
      ...(turn.toolCalls ?? []).map(
        (tc): StreamingBlock => ({
          type: "toolCall",
          id: tc.id,
          parentToolCallId: tc.parentToolCallId,
          result: knownResults.get(tc.id),
          view: tc.view,
          name: tc.name,
          arguments: tc.arguments,
          status: tc.status,
          timestamp: turn.startedAt,
        })
      ),
    ]);
    setActiveTools(
      (turn.toolCalls ?? []).map((tc) => ({
        id: tc.id || crypto.randomUUID(),
        toolName: tc.name,
        status: tc.status,
      }))
    );
    for (const result of turn.toolResults ?? []) {
      attachStreamingToolResult(result.id, result.name, result.content, result.isError, result.details, result.parentToolCallId, result.view);
    }
    // Ensure the user message that triggered the active run is visible
    // even before the persisted history is re-fetched.
    if (turn.userText) {
      const userText = turn.userText;
      const timestamp = turn.userTimestamp;
      setSimpleMessages((prev) =>
        prev.some((m) => m.timestamp === timestamp && m.role === "user")
          ? prev
          : [
              ...prev,
              {
                id: crypto.randomUUID(),
                role: "user",
                content: userText,
                timestamp,
              },
            ]
      );
      setFullMessages((prev) =>
        prev.some((m) => m.timestamp === timestamp && m.role === "user")
          ? prev
          : [
              ...prev,
              {
                role: "user",
                content: [{ type: "text", text: userText }],
                timestamp,
              },
            ]
      );
    }
  };

  const applyActiveTurn = (
    streaming: boolean,
    turn: ActiveTurn | null
  ) => {
    if (!streaming) {
      // Backend says not streaming: clear stale isStreaming if we don't own a
      // direct stream ourselves (cleanup null means no active streamMessage).
      if ((durableMain() && latestDurableTurn) || (!ownsDisplayedDirectStream() && isStreaming())) resetStreamingState();
      return;
    }
    if (!turn) return;
    if (durableMain()) {
      showDurableTurn(turn);
    } else if (!ownsDisplayedDirectStream()) {
      applyActiveTurnSnapshot(turn);
    }
  };

  const appendStreamingTextBlock = (chunk: string, timestamp = Date.now()) => {
    setStreamingBlocks((blocks) => {
      const lastIdx = blocks.length - 1;
      const last = lastIdx >= 0 ? blocks[lastIdx] : undefined;
      if (last?.type === "text") {
        const next = blocks.slice();
        next[lastIdx] = { ...last, text: last.text + chunk };
        return next;
      }
      return [...blocks, { type: "text", text: chunk, timestamp }];
    });
  };

  const appendStreamingThinkingBlock = (
    chunk: string,
    timestamp = Date.now()
  ) => {
    setStreamingBlocks((blocks) => {
      const lastIdx = blocks.length - 1;
      const last = lastIdx >= 0 ? blocks[lastIdx] : undefined;
      if (last?.type === "thinking") {
        const next = blocks.slice();
        next[lastIdx] = { ...last, thinking: last.thinking + chunk };
        return next;
      }
      return [...blocks, { type: "thinking", thinking: chunk, timestamp }];
    });
  };

  // The local gateway names the chat as the page sends it: the explicit session ID, else the session key.
  // The session key lives in local storage, so a new chat bumps a counter to tell the page.
  const [newChatCount, setNewChatCount] = createSignal(0);
  const deviceChatName = () => {
    newChatCount();
    return explicitSessionId() ? `session:${explicitSessionId()}` : `key:${sessionKey()}`;
  };
  /** The socket of a message that got the request. An answer goes back on the same socket. */
  const approvalAnswerers = new Map<string, (approvalId: string, approve: boolean) => boolean>();
  const addDeviceApproval = (request: WsDeviceApprovalRequest) =>
    setDeviceApprovals((prev) =>
      prev.some((item) => item.request.approvalId === request.approvalId)
        ? prev
        : [...prev, { request, state: "pending" }]
    );
  const resolveDeviceApproval = (resolved: WsDeviceApprovalResolved) => {
    approvalAnswerers.delete(resolved.approvalId);
    setDeviceApprovals((prev) =>
      resolved.outcome === "timeout"
        ? prev.map((item) => (item.request.approvalId === resolved.approvalId ? { ...item, state: "timeout" } : item))
        : prev.filter((item) => item.request.approvalId !== resolved.approvalId)
    );
  };
  const messageApprovalCallbacks = (agentId: string): Pick<StreamCallbacks, "onDeviceApprovalRequest" | "onDeviceApprovalResolved" | "onDeviceApprovalClosed"> => {
    const chat = deviceChatName();
    let socketAnswer: ((approvalId: string, approve: boolean) => boolean) | undefined;
    return {
      onDeviceApprovalRequest: (request, answer) => {
        if (input.agentId() !== agentId || request.agentId !== agentId || request.chat !== deviceChatName() || chat !== deviceChatName()) return;
        socketAnswer = answer;
        approvalAnswerers.set(request.approvalId, answer);
        addDeviceApproval(request);
      },
      onDeviceApprovalResolved: (resolved) => {
        if (input.agentId() === agentId) resolveDeviceApproval(resolved);
      },
      onDeviceApprovalClosed: () => {
        for (const [id, answer] of approvalAnswerers) {
          if (answer === socketAnswer) approvalAnswerers.delete(id);
        }
        socketAnswer = undefined;
      },
    };
  };
  const isDeviceApprovalShown = (item: DeviceApprovalItem) => item.request.chat === deviceChatName();

  const resolveAppSession = (onFailed?: () => void) => {
    if (explicitSessionId() || resolvedSessionId() || appSessionLookup || appSessionFailed()) return;
    const scope = currentSession();
    const controller = new AbortController();
    appSessionLookup = controller;
    const timer = setTimeout(() => {
      if (scope === currentSession()) {
        setAppSessionFailed(true);
        onFailed?.();
      }
      controller.abort();
    }, 15_000);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    void fetchFullHistory(input.agentId(), sessionKey(), undefined, { limit: 1 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted || scope !== currentSession()) return;
        if (response.sessionId) setResolvedSessionId(response.sessionId);
        else {
          setAppSessionFailed(true);
          onFailed?.();
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && scope === currentSession()) {
          setAppSessionFailed(true);
          onFailed?.();
        }
      })
      .finally(() => {
        clearTimeout(timer);
        if (appSessionLookup === controller) appSessionLookup = undefined;
      });
  };

  // The active turn of the subscription for the key of this chat gives the session ID.
  const adoptSessionId = (sessionId: string) => {
    if (explicitSessionId() || resolvedSessionId()) return;
    setResolvedSessionId(sessionId);
    setAppSessionFailed(false);
  };

  const appendStreamingToolCallBlock = (
    id: string,
    name: string,
    args: unknown,
    parentToolCallId?: string,
    timestamp = Date.now(),
    view?: McpAppView
  ) => {
    if (view) resolveAppSession();
    setStreamingBlocks((blocks) => {
      if (blocks.some((b) => b.type === "toolCall" && b.id === id))
        return blocks;
      return [
        ...blocks,
        {
          type: "toolCall",
          id,
          parentToolCallId,
          name,
          arguments: args,
          view,
          status: "running",
          timestamp,
        },
      ];
    });
  };

  const updateStreamingToolBlockStatus = (
    toolName: string,
    status: "done" | "error"
  ) => {
    setStreamingBlocks((blocks) =>
      blocks.map((b) =>
        b.type === "toolCall" && b.name === toolName && b.status === "running"
          ? { ...b, status }
          : b
      )
    );
  };

  const attachStreamingToolResult = (
    id: string,
    name: string,
    content: string,
    isError: boolean,
    details?: { diff?: string },
    parentToolCallId?: string,
    view?: McpAppViewReference
  ) => {
    if (isExtensionFrameView(view)) resolveAppSession();
    const result: FullToolResultMessage = {
      role: "toolResult",
      toolCallId: id,
      parentToolCallId,
      toolName: name,
      content: [{ type: "text", text: content }],
      isError,
      details,
      view,
      timestamp: Date.now(),
    };
    if (flushedRunningToolIds.delete(id)) {
      setFullMessages((prev) => [...prev, result]);
      setSimpleMessages((prev) => prev.map((message) => message.role === "tool" && message.id === id ? { ...message, result } : message));
      return;
    }
    const status = isError ? "error" : "done";
    setStreamingBlocks((blocks) =>
      blocks.map((b) =>
        b.type === "toolCall" && b.id === id ? { ...b, status, result, view: b.view ?? (isExtensionFrameView(view) ? view : undefined) } : b
      )
    );
    setStreamingToolCalls((prev) =>
      prev.map((tc) => (tc.id === id ? { ...tc, status } : tc))
    );
  };

  function notifyLiveView(view?: McpAppViewReference) {
    if (view?.server === "yoplai" && (view.resourceUri === "ui://yoplai/dashboard" || isExtensionFrameView(view) || (view.file && ["html", "markdown", "pdf"].includes(classifyFile(view.file))))) input.onLiveView?.(view);
  }

  const appendStreamingFileBlock = (
    file: FileBlock,
    timestamp = Date.now()
  ) => {
    setStreamingBlocks((blocks) => [...blocks, { ...file, timestamp }]);
  };

  // Load history when agent is loaded or view mode changes.
  // Do not track isStreaming here: reloading on stream end can wipe optimistic
  // user/error messages for failed runs before history is persisted.
  createEffect(
    on([agent, viewMode, explicitSessionId], ([currentAgent, mode]) => {
      if (!currentAgent) return;
      const nextSession = currentSession();
      const followsReset = pendingResetSession === nextSession;
      if (
        displayedSession !== null &&
        displayedSession !== nextSession &&
        !followsReset
      ) {
        if (cleanup) cleanup();
        cleanup = null;
        directStreamSession = null;
        resetStreamingState();
      }
      if (followsReset) pendingResetSession = null;
      displayedSession = nextSession;
      void loadHistory(mode);
    })
  );

  // Subscribe to live updates for background runs
  createEffect(() => {
    const agentId = input.agentId();
    newChatCount(); // "New chat" writes a new session key. Subscribe again with it.
    const key = sessionKey();
    if (!agentId) return;
    const subscribedSession = currentSession();
    const isCurrentSubscription = () => subscribedSession === currentSession();
    const isOpenAgent = () => input.agentId() === agentId;

    subscriptionCleanup?.();
    approvalAnswerers.clear();
    // The new subscription gets each approval that still waits.
    setDeviceApprovals([]);
    setDeviceConnectionLost(false);
    subscriptionCleanup = subscribeToSession(
      agentId,
      key,
      {
        onConnected: () => {
          if (!isCurrentSubscription()) return;
          // The gateway sends each approval that still waits after each subscribe.
          setDeviceApprovals([]);
          setDeviceConnectionLost(false);
        },
        onDisconnected: () => {
          if (!isCurrentSubscription()) return;
          setDeviceConnectionLost(true);
        },
        onDeviceApprovalRequest: (request) => {
          if (isOpenAgent()) addDeviceApproval(request);
        },
        onDeviceApprovalResolved: (resolved) => {
          if (isOpenAgent()) resolveDeviceApproval(resolved);
        },
        onText: (chunk) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setStreamingFinished(false);
          appendStreamingTextBlock(chunk);
          setStreamingText((prev) => prev + chunk);
          if (!streamingTextAt()) setStreamingTextAt(Date.now());
          if (!streamingStartedAt()) setStreamingStartedAt(Date.now());
          setIsStreaming(true);
        },
        onThinking: (chunk) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setStreamingFinished(false);
          appendStreamingThinkingBlock(chunk);
          setStreamingThinking((prev) => prev + chunk);
          if (!streamingThinkingAt()) setStreamingThinkingAt(Date.now());
          if (!streamingStartedAt()) setStreamingStartedAt(Date.now());
          setIsStreaming(true);
        },
        onProgress: () => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setIsStreaming(true);
        },
        onToolCall: (id, name, args, parentToolCallId, view) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setStreamingFinished(false);
          appendStreamingToolCallBlock(id, name, args, parentToolCallId, Date.now(), view);
          setStreamingToolCalls((prev) => {
            if (prev.some((tc) => tc.id === id)) return prev;
            return [
              ...prev,
              {
                id,
                parentToolCallId,
                name,
                arguments: args,
                status: "running",
                timestamp: Date.now(),
              },
            ];
          });
          if (!streamingStartedAt()) setStreamingStartedAt(Date.now());
          setIsStreaming(true);
        },
        onToolStart: (toolName) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setActiveTools((prev) =>
            prev.some((t) => t.toolName === toolName && t.status === "running")
              ? prev
              : [
                  ...prev,
                  { id: crypto.randomUUID(), toolName, status: "running" },
                ]
          );
        },
        onToolEnd: (toolName, isError) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setActiveTools((prev) =>
            prev.map((t) =>
              t.toolName === toolName && t.status === "running"
                ? { ...t, status: isError ? "error" : "done" }
                : t
            )
          );
          setStreamingToolCalls((prev) =>
            prev.map((tc) =>
              tc.name === toolName && tc.status === "running"
                ? { ...tc, status: isError ? "error" : "done" }
                : tc
            )
          );
          updateStreamingToolBlockStatus(toolName, isError ? "error" : "done");
        },
        onToolResult: (id, name, content, isError, details, parentToolCallId, view) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          attachStreamingToolResult(id, name, content, isError, details, parentToolCallId, view);
          notifyLiveView(view);
        },
        onFileOutput: (file) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setStreamingFinished(false);
          const fileBlock: FileBlock = {
            type: "file",
            direction: "outbound",
            ...file,
          };
          setStreamingFiles((prev) => [...prev, fileBlock]);
          appendStreamingFileBlock(fileBlock);
          if (!streamingStartedAt()) setStreamingStartedAt(Date.now());
          setIsStreaming(true);
        },
        onDone: () => {
          void refreshToolLabels();
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          if (streamingFinished()) return;
          resetStreamingState();
        },
        onError: () => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          resetStreamingState();
        },
        onActiveTurn: (turn, sessionId) => {
          if (!isCurrentSubscription()) return;
          // The gateway sends this event for the session of the subscribed key.
          if (sessionId) adoptSessionId(sessionId);
          if (durableMain()) {
            if (durableTurnMayBeStored(turn)) {
              refreshDurableProgress();
              return;
            }
            const toolsChanged = durableToolsKey(latestDurableTurn) !== durableToolsKey(turn);
            const finished = storedToolResults(loadedHistory);
            if (turn.toolCalls.length && turn.toolCalls.every(({ id }) => finished.has(id))) {
              if (toolsChanged) refreshDurableProgress(true);
              return;
            }
            showDurableTurn(turn);
            if (toolsChanged) refreshDurableProgress(true);
          } else if (!ownsDisplayedDirectStream()) {
            applyActiveTurnSnapshot(turn);
          }
        },
        onHistoryUpdated: () => {
          if (!isCurrentSubscription()) return;
          if (skipNextHistoryRefresh) {
            skipNextHistoryRefresh = false;
            void refreshContextUsage();
            return;
          }
          // Refetch history when background run completes. Also reconcile if
          // isStreaming is stale-true but we don't own the direct stream — the
          // history_updated signal means the backend finished and history is ready.
          if (!isStreaming() || !ownsDisplayedDirectStream()) {
            if (isStreaming() && !ownsDisplayedDirectStream())
              resetStreamingState();
            if (pendingQueuedMessages().length > 0) {
              setPendingQueuedMessages((prev) => prev.slice(1));
            }
            loadHistory(viewMode(), true);
          }
        },
      },
      explicitSessionId(),
      isRemoteAgent(agentId)
    );
  });

  // On mount, check if the agent is already running (e.g. after page refresh)
  // and subscribe to status changes to track when runs start/finish.
  let statusCleanup: (() => void) | null = null;
  createEffect(() => {
    const agentId = input.agentId();
    if (!agentId) return;

    statusCleanup?.();

    // Initial streaming state is derived from the session-scoped history load
    // (res.isStreaming -> applyActiveTurn), so we must NOT use the agent-wide
    // /agents/status endpoint here: a background session streaming would
    // wrongly flip this view's Stop button on.

    // Subscribe to real-time status changes
    statusCleanup = subscribeToRealtime({
      interests: [{ type: "status" }],
      onEvent: (event) => {
        if (event.type !== "status") return;
        const id = event.agentId;
        if (id !== agentId) return;
        // Scope the Stop button to the session this view owns. Status events
        // from background sessions (forum threads, scheduler, amsg) must not
        // flip this view to "running". If we haven't resolved our sessionId
        // yet, ignore the event; the session-scoped history load reconciles
        // the initial streaming state via applyActiveTurn().
        const owned = resolvedSessionId();
        if (!owned || event.sessionId !== owned) return;
        const status = event.sessionStatus;
        if (status === "streaming" && !isStreaming() && !streamingFinished()) {
          setIsStreaming(true);
          setStreamingStartedAt(Date.now());
        } else if (
          status === "idle" &&
          isStreaming() &&
          !ownsDisplayedDirectStream()
        ) {
          if (streamingFinished()) {
            setIsStreaming(false);
            return;
          }
          // Agent went idle and we're not the ones streaming (no active cleanup)
          // This means a background/reconnected run finished
          resetStreamingState();
          loadHistory(viewMode(), true);
        }
      },
      onReconnect: () => {
        // Re-derive streaming state from the session-scoped history after a
        // reconnect. applyActiveTurn() reconciles isStreaming for this session
        // only, ignoring background sessions.
        void loadHistory(viewMode());
      },
    });
  });


  // Helper to reset streaming state (used by onDone and onError)
  const resetStreamingState = () => {
    latestDurableTurn = null;
    setStreamingThinking("");
    setStreamingThinkingAt(null);
    setStreamingToolCalls([]);
    setStreamingText("");
    setStreamingBlocks([]);
    setStreamingFiles([]);
    setStreamingTextAt(null);
    setActiveTools([]);
    setIsStreaming(false);
    setStreamingFinished(false);
    setStreamingStartedAt(null);
    setStreamingCopyTurnTimestamp(undefined);
  };

  const appendStreamingAssistantMessage = () => {
    const content = streamingText();
    const blocks = streamingBlocks();
    const files = streamingFiles();
    if (!content && blocks.length === 0 && files.length === 0) {
      return false;
    }

    const completedAt = Date.now();
    const contentBlocks: ChatContentBlock[] =
      blocks.length > 0
        ? blocks.map((block, index) => {
            if (block.type === "toolCall") {
              return {
                type: "toolCall",
                id: block.id,
                parentToolCallId: block.parentToolCallId,
                viewCall: !!block.view,
                view: block.view,
                name: block.name,
                arguments: block.arguments,
              };
            }
            if (block.type === "thinking") {
              return {
                type: "thinking",
                thinking: block.thinking,
                startedAt: block.timestamp,
                endedAt: blocks[index + 1]?.timestamp ?? completedAt,
              };
            }
            if (block.type === "text") {
              return { type: "text", text: block.text };
            }
            return {
              type: "file",
              fileId: block.fileId,
              filename: block.filename,
              mimeType: block.mimeType,
              size: block.size,
              direction: block.direction,
            };
          })
        : [{ type: "text", text: content }, ...files];

    const timestamp = streamingStartedAt() ?? Date.now();
    const simpleStreamMessages: SimpleViewMessage[] =
      blocks.length > 0
        ? blocks.flatMap((block): SimpleViewMessage[] => {
            if (block.type === "text" && block.text.trim()) {
              return [
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: block.text,
                  timestamp: block.timestamp,
                },
              ];
            }
            if (block.type === "thinking" && block.thinking.trim()) {
              return [
                {
                  id: crypto.randomUUID(),
                  role: "thinking",
                  content: block.thinking,
                  timestamp: block.timestamp,
                  endedAt:
                    blocks[blocks.indexOf(block) + 1]?.timestamp ?? completedAt,
                },
              ];
            }
            if (block.type === "toolCall") {
              return [
                {
                  id: block.id,
                  parentToolCallId: block.parentToolCallId,
                  result: block.result,
                  viewCall: !!block.view,
                  view: block.view,
                  role: "tool",
                  toolName: block.name,
                  arguments: block.arguments,
                  timestamp: block.timestamp,
                },
              ];
            }
            if (block.type === "file") {
              return [
                {
                  id: crypto.randomUUID(),
                  role: "assistant",
                  content: "",
                  files: [block],
                  timestamp: block.timestamp,
                },
              ];
            }
            return [];
          })
        : [
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content,
              files: files.length > 0 ? files : undefined,
              timestamp,
            },
          ];
    const copyTurn = activeCopyTurnTimestamp(simpleMessages());
    for (const message of simpleStreamMessages) {
      noAnimIds.add(message.id);
      copyTurnOverrides.set(message, copyTurn);
    }
    for (const block of contentBlocks) copyTurnOverrides.set(block, copyTurn);
    setSimpleMessages((prev) => [...prev, ...simpleStreamMessages]);
    const toolResults = blocks
      .filter((block) => block.type === "toolCall" && block.result)
      .map((block) => (block.type === "toolCall" ? block.result : undefined))
      .filter((result): result is FullToolResultMessage => Boolean(result));
    const assistantMessage: FullHistoryMessage = {
      role: "assistant",
      content:
        contentBlocks.length > 0
          ? contentBlocks
          : [{ type: "text", text: content }],
      timestamp,
    };
    setFullMessages((prev) => [...prev, assistantMessage, ...toolResults]);
    return true;
  };

  // Tool calls committed to history while still running; their results arrive
  // after the flush and must be appended to history directly.
  const flushedRunningToolIds = new Set<string>();

  // Commit everything streamed so far to history so a mid-turn queued user
  // message lands after it, keeping chronological order.
  const flushStreamingBeforeQueuedMessage = () => {
    batch(() => {
      for (const b of streamingBlocks()) {
        if (b.type === "toolCall" && b.status === "running") {
          flushedRunningToolIds.add(b.id);
        }
      }
      if (!appendStreamingAssistantMessage()) return;
      setActiveTools([]);
      setStreamingBlocks([]);
      setStreamingText("");
      setStreamingThinking("");
      setStreamingFiles([]);
      setStreamingToolCalls([]);
      setStreamingTextAt(null);
      setStreamingThinkingAt(null);
    });
  };

  // Check if stream has any content (used to guard against wiping real stream)
  const hasStreamingContent = () =>
    streamingText() ||
    streamingThinking() ||
    streamingToolCalls().length > 0 ||
    streamingBlocks().length > 0 ||
    streamingFiles().length > 0;


  const restoreSession = async (fallback: string): Promise<{ ok: boolean }> => {
    try {
      await archiveAgentSession(input.agentId(), explicitSessionId()!, false);
      input.onArchiveRestored();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : fallback;
      setSimpleMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: "assistant", content: `Error: ${message}`, timestamp: Date.now(),
      }]);
      setFullMessages((prev) => [...prev, {
        role: "assistant", content: [{ type: "text", text: `Error: ${message}` }], timestamp: Date.now(),
      }]);
      return { ok: false };
    }
  };

  const restoreArchived = () => restoreSession("Failed to restore session.");

  const performSend = async (
    { text, pendingFiles, turnId, onTaggedError }: SendRequest,
    resolve: (result: SendResult) => void,
    beforeSubmit?: () => void,
  ): Promise<void> => {
    if (turnId && (!explicitSessionId() || input.isArchived() || isStreaming() || loading())) {
      resolve({ kind: "blocked" });
      return;
    }
    if (input.isArchived() && !(await restoreSession("Failed to restore session. Try again.")).ok) {
      resolve({ kind: "blocked" });
      return;
    }
    beforeSubmit?.();
    const isResetCommand = !durableMain() && /^(\/new|\/reset)( |$)/.test(text);

    if (!turnId && !isResetCommand && !isStreaming() && shouldAutoCompact()) {
      try {
        await compactCurrentSession();
      } catch {
        resolve({ kind: "blocked" });
        return;
      }
    }
    beforeSubmit?.();

    let attachments: FileAttachment[] | undefined;
    let inboundFiles: FileBlock[] = [];
    if (pendingFiles.length > 0) {
      const uploaded = await input.uploadPending(pendingFiles);
      if (uploaded === "failed") {
        resolve({ kind: "blocked" });
        return;
      }
      ({ attachments, inboundFiles } = uploaded);
    }
    beforeSubmit?.();

    if (isResetCommand && isRemoteAgent(input.agentId())) {
      await input.onRemoteReset();
      batch(() => startNewChat(input.agentId()));
    }
    const messageText = text || "Attached file(s).";
    const levelToSend = pendingThinkLevel() ?? thinkingLevel();
    const currentAgent = agent();
    const queueMode = currentAgent?.queueMode ?? "queue";
    const streamOptions = {
      ...(durableMain() ? { retryOnDisconnect: true } : {}),
      ...(turnId ? { turnId } : {}),
      ...(input.projectId() ? { projectId: input.projectId() } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(levelToSend ? { thinkLevel: levelToSend } : {}),
      ...((!isResetCommand || currentAgent?.durable) && explicitSessionId()
        ? { sessionId: explicitSessionId() }
        : {}),
    };

    const handleSessionReset = (sessionId: string) => {
      setResolvedSessionId(sessionId);
      setSimpleMessages([]);
      setFullMessages([]);
      setPendingQueuedMessages([]);
      if (!isRemoteAgent(input.agentId())) input.onSessionReset(sessionId);
    };

    // Add user message to both views
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: "user",
      content: messageText,
      files: inboundFiles.length > 0 ? inboundFiles : undefined,
      timestamp: Date.now(),
    };
    setShowInterrupted(false);
    if (isStreaming() && queueMode === "queue") {
      flushStreamingBeforeQueuedMessage();
    }
    setSimpleMessages((prev) => [...prev, userMsg]);
    setFullMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: [{ type: "text", text: messageText }, ...inboundFiles],
        timestamp: userMsg.timestamp,
      },
    ]);

    resolve({ kind: "sent" });

    // If streaming in queue mode, send message without interrupting current stream
    if (isStreaming() && queueMode === "queue") {
      let queuedText = "";
      let queuedThinking = "";
      const queuedFiles: FileBlock[] = [];
      const queuedBlocks: ChatContentBlock[] = [];
      const queuedToolResults: FullToolResultMessage[] = [];
      const queuedToolCalls: Array<{
        id: string;
        parentToolCallId?: string;
        name: string;
        arguments: unknown;
        status: "running" | "done" | "error";
        timestamp: number;
      }> = [];
      let queuedSession = currentSession();
      let queuedResetFrom: string | null = null;
      const isCurrentQueuedStream = () =>
        queuedSession === currentSession() ||
        (queuedResetFrom === currentSession() &&
          pendingResetSession === queuedSession);

      // Send queued message with minimal handlers (queue ack doesn't affect streaming state)
      const queueCleanup = streamMessage(
        input.agentId(),
        messageText,
        sessionKey(),
        (chunk) => {
          if (!isCurrentQueuedStream()) return;
          queuedText += chunk;
          const last = queuedBlocks.at(-1);
          if (last?.type === "text") {
            last.text += chunk;
          } else {
            queuedBlocks.push({ type: "text", text: chunk });
          }
        },
        (meta?: DoneMeta) => {
          if (meta?.queued) {
            if (queueCleanup) queueCleanup();
            return;
          }
          if (!isCurrentQueuedStream()) {
            if (queueCleanup) queueCleanup();
            return;
          }

          const blocks: ChatContentBlock[] = queuedBlocks.length
            ? queuedBlocks
            : [
                ...(queuedThinking
                  ? [{ type: "thinking" as const, thinking: queuedThinking }]
                  : []),
                ...queuedToolCalls.map((tc) => ({
                  type: "toolCall" as const,
                  id: tc.id,
                  parentToolCallId: tc.parentToolCallId,
                  name: tc.name,
                  arguments: tc.arguments,
                })),
                ...(queuedText
                  ? [{ type: "text" as const, text: queuedText }]
                  : []),
                ...queuedFiles,
              ];

          if (
            queuedText ||
            queuedThinking ||
            queuedToolCalls.length > 0 ||
            queuedFiles.length > 0 ||
            queuedToolResults.length > 0
          ) {
            const timestamp = Date.now();
            for (const block of blocks) copyTurnOverrides.set(block, userMsg.timestamp);
            setSimpleMessages((prev) => [
              ...prev,
              ...blocks.flatMap((block): SimpleViewMessage[] => {
                if (block.type === "text" && block.text.trim()) {
                  return [
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content: block.text,
                      timestamp,
                    },
                  ];
                }
                if (block.type === "thinking" && block.thinking.trim()) {
                  return [
                    {
                      id: crypto.randomUUID(),
                      role: "thinking",
                      content: block.thinking,
                      timestamp,
                    },
                  ];
                }
                if (block.type === "toolCall") {
                  return [
                    {
                      id: block.id,
                      parentToolCallId: block.parentToolCallId,
                      result: queuedToolResults.find((result) => result.toolCallId === block.id),
                      viewCall: block.viewCall,
                      view: block.view,
                      role: "tool",
                      toolName: block.name,
                      arguments: block.arguments,
                      timestamp,
                    },
                  ];
                }
                if (block.type === "file") {
                  return [
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      content: "",
                      files: [block],
                      timestamp,
                    },
                  ];
                }
                return [];
              }).map((message) => {
                copyTurnOverrides.set(message, userMsg.timestamp);
                return message;
              }),
            ]);
            setFullMessages((prev) => [
              ...prev,
              {
                role: "assistant",
                content:
                  blocks.length > 0
                    ? blocks
                    : [{ type: "text", text: queuedText }],
                timestamp,
              },
              ...queuedToolResults,
            ]);
          }
          if (pendingThinkLevel()) {
            setThinkingLevel(pendingThinkLevel()!);
            setPendingThinkLevel(null);
          }

          if (queueCleanup) queueCleanup();
        },
        (error) => {
          if (!isCurrentQueuedStream()) {
            if (queueCleanup) queueCleanup();
            return;
          }
          const content = error;
          const notice: Message = {
            id: crypto.randomUUID(),
            role: "assistant",
            content,
            timestamp: Date.now(),
          };
          copyExcludedMessages.add(notice);
          setSimpleMessages((prev) => [...prev, notice]);
          resetStreamingState();
          void loadHistory(viewMode());
          if (queueCleanup) queueCleanup();
        },
        {
          onThinking: (chunk) => {
            if (!isCurrentQueuedStream()) return;
            queuedThinking += chunk;
            const last = queuedBlocks.at(-1);
            if (last?.type === "thinking") {
              last.thinking += chunk;
            } else {
              queuedBlocks.push({ type: "thinking", thinking: chunk });
            }
          },
          onToolCall: (id, name, args, parentToolCallId, view) => {
            if (!isCurrentQueuedStream()) return;
            queuedToolCalls.push({
              id,
              parentToolCallId,
              name,
              arguments: args,
              status: "running",
              timestamp: Date.now(),
            });
            queuedBlocks.push({
              type: "toolCall",
              id,
              parentToolCallId,
              name,
              arguments: args,
              viewCall: !!view,
              view,
            });
          },
          onToolEnd: (toolName, isError) => {
            if (!isCurrentQueuedStream()) return;
            for (const tc of queuedToolCalls) {
              if (tc.name === toolName && tc.status === "running") {
                tc.status = isError ? "error" : "done";
              }
            }
          },
          onToolResult: (id, name, content, isError, details, parentToolCallId, view) => {
            if (!isCurrentQueuedStream()) return;
            queuedToolResults.push({
              role: "toolResult",
              toolCallId: id,
              parentToolCallId,
              toolName: name,
              content: [{ type: "text", text: content }],
              isError,
              details,
              view,
              timestamp: Date.now(),
            });
          },
          onFileOutput: (file) => {
            if (!isCurrentQueuedStream()) return;
            const fileBlock: FileBlock = {
              type: "file",
              direction: "outbound",
              ...file,
            };
            queuedFiles.push(fileBlock);
            queuedBlocks.push(fileBlock);
          },
          ...messageApprovalCallbacks(input.agentId()),
          onSessionReset: (sessionId) => {
            if (!isCurrentQueuedStream()) return;
            queuedResetFrom = queuedSession;
            queuedSession = isRemoteAgent(input.agentId()) ? currentSession() : sessionScope(sessionId);
            pendingResetSession = queuedSession;
            // Queued /new or /reset triggered - clear messages and streaming state
            handleSessionReset(sessionId);
            resetStreamingState();
            if (cleanup) {
              cleanup();
              cleanup = null;
            }
          },
        },
        streamOptions
      );
      return;
    }

    // Interrupt mode or not streaming: abort current stream if running
    if (cleanup) {
      cleanup();
      cleanup = null;
    }

    setStreamingCopyTurnTimestamp(userMsg.timestamp);
    setIsStreaming(true);
    setStreamingFinished(false);
    setStreamingStartedAt(Date.now());
    setStreamingThinking("");
    setStreamingThinkingAt(null);
    setStreamingToolCalls([]);
    setStreamingText("");
    setStreamingBlocks([]);
    setStreamingFiles([]);
    setStreamingTextAt(null);
    setActiveTools([]);
    setAppSessionFailed(false);

    let streamSession = currentSession();
    let resetFromSession: string | null = null;
    directStreamSession = streamSession;
    directDurableSnapshotSeen = false;
    const isCurrentDirectStream = () =>
      directStreamSession === streamSession &&
      (currentSession() === streamSession ||
        (resetFromSession === currentSession() &&
          pendingResetSession === streamSession));
    cleanup = streamMessage(
      input.agentId(),
      messageText,
      sessionKey(),
      (chunk) => {
        if (!isCurrentDirectStream() || (durableMain() && directDurableSnapshotSeen)) return;
        setStreamingFinished(false);
        appendStreamingTextBlock(chunk);
        setStreamingText((prev) => prev + chunk);
        if (!streamingTextAt()) setStreamingTextAt(Date.now());
      },
      (meta?: DoneMeta) => {
        if (!isCurrentDirectStream()) return;
        // Queued ack arrived unexpectedly - reset state only if no real stream content
        if (meta?.queued) {
          if (!hasStreamingContent()) {
            resetStreamingState();
            cleanup = null;
          }
          return;
        }

        // If aborted, discard streamed content and show system message
        if (aborted || meta?.aborted) {
          if (viewMode() !== "full") {
            batch(() => {
              aborted = false;
              appendStreamingAssistantMessage();
              skipNextHistoryRefresh = true;
              setShowInterrupted(true);
              resetStreamingState();
              cleanup = null;
            });
            return;
          }
          batch(() => {
            aborted = false;
            appendStreamingAssistantMessage();
            skipNextHistoryRefresh = true;
            setShowInterrupted(true);
            resetStreamingState();
            setStreamingFinished(true);
            cleanup = null;
          });
          return;
        }

        if (durableMain()) {
          batch(() => {
            if (pendingThinkLevel()) {
              setThinkingLevel(pendingThinkLevel()!);
              setPendingThinkLevel(null);
            }
            resetStreamingState();
            cleanup = null;
          });
          void loadHistory(viewMode(), true);
          return;
        }
        if (viewMode() !== "full") {
          if (!resolvedSessionId()) void refreshContextUsage();
          batch(() => {
            appendStreamingAssistantMessage();
            skipNextHistoryRefresh = true;
            if (pendingThinkLevel()) {
              setThinkingLevel(pendingThinkLevel()!);
              setPendingThinkLevel(null);
            }
            resetStreamingState();
            cleanup = null;
          });
          return;
        }

        batch(() => {
          const streamedText =
            !!streamingText() ||
            streamingBlocks().some((block) => block.type === "text");
          appendStreamingAssistantMessage();
          if (!streamedText) void loadHistory("full");
          else if (!resolvedSessionId()) void refreshContextUsage();
          skipNextHistoryRefresh = true;
          // Update thinkingLevel if pending was used
          if (pendingThinkLevel()) {
            setThinkingLevel(pendingThinkLevel()!);
            setPendingThinkLevel(null);
          }
          resetStreamingState();
          cleanup = null;
        });
      },
      (error) => {
        if (!isCurrentDirectStream()) return;
        if (turnId) {
          onTaggedError?.();
          resetStreamingState();
          cleanup?.();
          cleanup = null;
          void loadHistory(viewMode());
          return;
        }
        const content = error;
        const notice: Message = {
          id: crypto.randomUUID(),
          role: "assistant",
          content,
          timestamp: Date.now(),
        };
        const fullNotice: FullHistoryMessage = {
          role: "assistant",
          content: [{ type: "text", text: content }],
          timestamp: Date.now(),
        };
        copyExcludedMessages.add(notice);
        copyExcludedMessages.add(fullNotice);
        setSimpleMessages((prev) => [...prev, notice]);
        setFullMessages((prev) => [...prev, fullNotice]);
        resetStreamingState();
        void loadHistory(viewMode());
        cleanup = null;
      },
      {
        onTurnExists: () => {
          if (!turnId || !isCurrentDirectStream()) return;
          resetStreamingState();
          cleanup?.();
          cleanup = null;
          void loadHistory(viewMode());
        },
        onThinking: (chunk) => {
          if (!isCurrentDirectStream()) return;
          setStreamingFinished(false);
          appendStreamingThinkingBlock(chunk);
          setStreamingThinking((prev) => prev + chunk);
          if (!streamingThinkingAt()) setStreamingThinkingAt(Date.now());
        },
        onProgress: () => {
          if (!isCurrentDirectStream()) return;
          setIsStreaming(true);
        },
        onToolCall: (id, name, args, parentToolCallId, view) => {
          if (!isCurrentDirectStream()) return;
          setStreamingFinished(false);
          appendStreamingToolCallBlock(id, name, args, parentToolCallId, Date.now(), view);
          setStreamingToolCalls((prev) => [
            ...prev,
            {
              id,
              parentToolCallId,
              name,
              arguments: args,
              status: "running",
              timestamp: Date.now(),
            },
          ]);
        },
        onToolStart: (toolName) => {
          if (!isCurrentDirectStream()) return;
          setActiveTools((prev) => [
            ...prev,
            { id: crypto.randomUUID(), toolName, status: "running" },
          ]);
        },
        onToolEnd: (toolName, isError) => {
          if (!isCurrentDirectStream()) return;
          // Update activeTools for the pill display
          setActiveTools((prev) =>
            prev.map((t) =>
              t.toolName === toolName && t.status === "running"
                ? { ...t, status: isError ? "error" : "done" }
                : t
            )
          );
          // Also update streamingToolCalls status
          setStreamingToolCalls((prev) =>
            prev.map((tc) =>
              tc.name === toolName && tc.status === "running"
                ? { ...tc, status: isError ? "error" : "done" }
                : tc
            )
          );
          updateStreamingToolBlockStatus(toolName, isError ? "error" : "done");
        },
        onToolResult: (id, name, content, isError, details, parentToolCallId, view) => {
          if (!isCurrentDirectStream()) return;
          attachStreamingToolResult(id, name, content, isError, details, parentToolCallId, view);
          notifyLiveView(view);
        },
        onFileOutput: (file) => {
          if (!isCurrentDirectStream()) return;
          setStreamingFinished(false);
          const fileBlock: FileBlock = {
            type: "file",
            direction: "outbound",
            ...file,
          };
          setStreamingFiles((prev) => [...prev, fileBlock]);
          appendStreamingFileBlock(fileBlock);
        },
        ...messageApprovalCallbacks(input.agentId()),
        onSessionReset: (sessionId) => {
          if (!isCurrentDirectStream()) return;
          resetFromSession = streamSession;
          streamSession = isRemoteAgent(input.agentId()) ? currentSession() : sessionScope(sessionId);
          directStreamSession = streamSession;
          pendingResetSession = streamSession;
          // Clear messages when session resets (e.g., /new command)
          handleSessionReset(sessionId);
        },
      },
      streamOptions
    );
  };

  const startSend = (request: SendRequest, beforeSubmit?: () => void): Promise<SendResult> =>
    new Promise((resolve, reject) => {
      if (preparingSend) { resolve({ kind: "blocked" }); return; }
      preparingSend = true;
      let preparing = true;
      const release = () => {
        if (!preparing) return;
        preparing = false;
        preparingSend = false;
      };
      void performSend(request, (result) => {
        release();
        resolve(result);
      }, beforeSubmit).catch((error: unknown) => {
        release();
        reject(error);
      });
    });
  const send = (request: SendRequest) => startSend(request);
  const stop = async (): Promise<{ error?: string }> => {
    if (stopping() || !isStreaming() || !input.agentId()) return {};
    setStopping(true);
    if (!durableMain()) aborted = true;

    try {
      const sessionId = explicitSessionId();
      if (sessionId) await postAbort(input.agentId(), sessionKey(), sessionId);
      else await postAbort(input.agentId(), sessionKey());
    } catch (error) {
      aborted = false;
      return { error: error instanceof Error ? error.message : "Failed to stop run" };
    } finally {
      setStopping(false);
    }
    return {};
  };


  const startNewChat = (agentId: string) => {
    if (durableMain()) return;
    approvalAnswerers.clear();
    appSessionLookup?.abort();
    appSessionLookup = undefined;
    setAppSessionFailed(false);
    setResolvedSessionId(undefined);
    if (cleanup) cleanup();
    cleanup = null;
    directStreamSession = null;
    resetStreamingState();
    startNewChatKey(agentId);
    setNewChatCount((count) => count + 1);
    setSimpleMessages([]);
    setFullMessages([]);
    setPendingQueuedMessages([]);
    setShowInterrupted(false);
  };
  const flushFinished = () => {
    if (!streamingFinished()) return;
    batch(() => {
      appendStreamingAssistantMessage();
      resetStreamingState();
    });
  };
  const assertViewSend = (text: string) => {
    if (input.isImpersonating()) throw new Error("Cannot send while impersonating");
    if (input.isUploading()) throw new Error("An upload is in progress");
    if (loading()) throw new Error("History is loading");
    if (text.trim().startsWith("/")) throw new Error("Slash commands are not allowed from views");
    if (isStreaming() && (agent()?.queueMode ?? "queue") !== "queue") throw new Error("Agent is busy; wait for the response");
  };
  const sendFromView = async (text: string): Promise<void> => {
    flushFinished();
    assertViewSend(text);
    if (preparingSend) throw new Error("Another message is preparing");
    const requestedScope = currentSession();
    const requestedSession = resolvedSessionId();
    const result = await startSend({ text: text.trim(), pendingFiles: [] }, () => {
      if (requestedScope !== currentSession() || requestedSession !== resolvedSessionId()) throw new Error("Chat session changed");
      flushFinished();
      assertViewSend(text);
    });
    if (result.kind === "blocked") throw new Error("Message could not be sent");
  };
  const copyTurnFor = (message: SimpleViewMessage | ContentBlock): string[] | undefined =>
    "role" in message ? simpleCopyReplies().get(message) : fullCopyReplies().get(message);
  const shouldAnimate = (id: string) => !noAnimIds.delete(id);
  const answerDeviceApproval = (approvalId: string, approve: boolean) => {
    const sent =
      approvalAnswerers.get(approvalId)?.(approvalId, approve) ||
      subscriptionCleanup?.send({ type: "device_approval_answer", approvalId, approve });
    if (!sent) return;
    setDeviceApprovals((prev) =>
      prev.map((item) => (item.request.approvalId === approvalId ? { ...item, state: "answered" } : item))
    );
  };
  onCleanup(() => {
    appSessionLookup?.abort();
    cleanup?.();
    subscriptionCleanup?.();
    statusCleanup?.();
  });

  return {
    appSessionId: () => explicitSessionId() ?? resolvedSessionId() ?? (appSessionFailed() ? null : undefined),
    simpleMessages, fullMessages, streamingBlocks, streamingText, streamingThinking,
    streamingToolCalls, streamingFiles, streamingTextAt, streamingStartedAt,
    streamingFinished, activeTools, isStreaming, loading, stopping, showInterrupted,
    pendingQueuedMessages, historyCursor, loadingEarlier, historyError, historyLoaded,
    historyRequests: () => latestHistoryRequest,
    contextUsage, contextWarning,
    compactStatusForCurrentSession, compactStatuses,
    copyTurnFor, shouldAnimate,
    deviceApprovals, isDeviceApprovalShown, deviceChatName, deviceConnectionLost, answerDeviceApproval,
    thinkingLevel: () => pendingThinkLevel() ?? thinkingLevel(),
    selectThinking: (level: ThinkLevel | null) => setPendingThinkLevel(level),
    flushFinished, send, sendFromView, stop, compact: compactCurrentSession,
    loadEarlierHistory, restoreArchived, startNewChat,
  };
}
export type ChatSession = ReturnType<typeof createChatSession>;
