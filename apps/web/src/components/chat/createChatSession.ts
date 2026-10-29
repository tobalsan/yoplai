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
  type DoneMeta,
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
import type { PendingFile } from "../../lib/attachments";
import { fullMessagesToSimpleView, type SimpleViewMessage, type ChatContentBlock } from "./chat-history";

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


type HistoryLoaded = { scope: string; sessionId: string | undefined; empty: boolean };
type SendRequest = {
  text: string;
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
  uploadPending: (pendingFiles: readonly PendingFile[]) => Promise<{ attachments?: FileAttachment[]; inboundFiles: FileBlock[] } | "failed">;
  onArchiveRestored: () => void;
  onSessionReset: (newSessionId: string) => void;
  preservePrependScroll: (prepend: () => void) => void;
};

export function createChatSession(input: ChatSessionInput) {
  const { agent, sessionKey, explicitSessionId, viewMode } = input;
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


  let cleanup: (() => void) | null = null;
  let directStreamSession: string | null = null;
  let displayedSession: string | null = null;
  let pendingResetSession: string | null = null;
  let subscriptionCleanup: (() => void) | null = null;
  let aborted = false;
  let skipNextHistoryRefresh = false;

  const noAnimIds = new Set<string>();

  createEffect(on([() => input.agentId(), sessionKey, explicitSessionId], () => {
    appSessionLookup?.abort();
    appSessionLookup = undefined;
    setAppSessionFailed(false);
    setResolvedSessionId(pendingResetSession === currentSession() ? explicitSessionId() : undefined);
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

  const estimatedContextUsagePct = createMemo(() => {
    const active = activeContextUsage();
    if (active) {
      const pct = (active.inputTokens / getMaxContextTokens(active.model)) * 100;
      return pct > 0 && pct < 1 ? 1 : Math.max(0, Math.min(100, Math.round(pct)));
    }
    let highestInputTokens = 0;
    let modelName: string | undefined;
    const messages = contextFullMessages();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      const meta = message.meta;
      if (meta?.model) modelName = meta.model;
      const rawUsage = meta?.usage;
      if (!rawUsage) continue;
      const inputTokens =
        (typeof rawUsage.input === "number" ? rawUsage.input : 0) +
        (typeof rawUsage.cacheRead === "number" ? rawUsage.cacheRead : 0) +
        (typeof rawUsage.cacheWrite === "number" ? rawUsage.cacheWrite : 0);
      if (inputTokens > highestInputTokens) highestInputTokens = inputTokens;
    }
    const maxTokens = getMaxContextTokens(modelName);
    if (maxTokens <= 0 || highestInputTokens <= 0) return 0;
    const rawPct = (highestInputTokens / maxTokens) * 100;
    if (rawPct > 0 && rawPct < 1) return 1;
    return Math.max(0, Math.min(100, Math.round(rawPct)));
  });

  const contextUsageDisplay = createMemo(() => {
    const pct = estimatedContextUsagePct();
    return {
      text: pct > 0 ? `~${pct}% context used` : "0% context used",
      unavailable: false,
    };
  });

  const isContextUsageDanger = createMemo(
    () => estimatedContextUsagePct() >= 75
  );

  const shouldAutoCompact = createMemo(() => estimatedContextUsagePct() >= 80);

  const contextWarning = createMemo(() => {
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
  const loadHistory = async (mode: HistoryViewMode) => {
    const requestedSession = currentSession();
    const agentId = input.agentId();
    const key = sessionKey();
    const sessionId = explicitSessionId();
    setLoading(true);
    const res = await fetchFullHistory(agentId, key, sessionId, { limit: 100 });
    if (requestedSession !== currentSession()) return;
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
    setHistoryError("");
    setActiveContextUsage(res.activeContextUsage);
    if (mode === "full") {
      const baseMessages = [...loadedHistory];
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
      applyActiveTurn(res.isStreaming ?? false, res.activeTurn ?? null);
    } else {
      setContextFullMessages(res.messages);
      const base = fullMessagesToSimpleView(loadedHistory);
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
      applyActiveTurn(res.isStreaming ?? false, res.activeTurn ?? null);
    }
    setLoading(false);
    setHistoryLoaded({ scope: requestedSession, sessionId, empty: res.messages.length === 0 });
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
    turn: import("../../api").ActiveTurn | null
  ) => {
    if (!streaming) {
      // Backend says not streaming: clear stale isStreaming if we don't own a
      // direct stream ourselves (cleanup null means no active streamMessage).
      if (!ownsDisplayedDirectStream() && isStreaming()) resetStreamingState();
      return;
    }
    if (!turn) return;
    if (ownsDisplayedDirectStream()) return;
    applyActiveTurnSnapshot(turn);
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

  const resolveAppSession = () => {
    if (explicitSessionId() || resolvedSessionId() || appSessionLookup || appSessionFailed()) return;
    const scope = currentSession();
    const controller = new AbortController();
    appSessionLookup = controller;
    const timer = setTimeout(() => {
      if (scope === currentSession()) setAppSessionFailed(true);
      controller.abort();
    }, 15_000);
    controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    void fetchFullHistory(input.agentId(), sessionKey(), undefined, { limit: 1 }, controller.signal)
      .then((response) => {
        if (controller.signal.aborted || scope !== currentSession()) return;
        if (response.sessionId) setResolvedSessionId(response.sessionId);
        else setAppSessionFailed(true);
      })
      .catch(() => {
        if (!controller.signal.aborted && scope === currentSession()) setAppSessionFailed(true);
      })
      .finally(() => {
        clearTimeout(timer);
        if (appSessionLookup === controller) appSessionLookup = undefined;
      });
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
        b.type === "toolCall" && b.id === id ? { ...b, status, result } : b
      )
    );
    setStreamingToolCalls((prev) =>
      prev.map((tc) => (tc.id === id ? { ...tc, status } : tc))
    );
  };

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
    const key = sessionKey();
    if (!agentId) return;
    const subscribedSession = currentSession();
    const isCurrentSubscription = () => subscribedSession === currentSession();

    subscriptionCleanup?.();
    subscriptionCleanup = subscribeToSession(
      agentId,
      key,
      {
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
        onActiveTurn: (turn) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          applyActiveTurnSnapshot(turn);
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
            loadHistory(viewMode());
          }
        },
      },
      explicitSessionId()
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
          loadHistory(viewMode());
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
    { text, pendingFiles }: SendRequest,
    resolve: (result: SendResult) => void,
  ): Promise<void> => {
    if (input.isArchived() && !(await restoreSession("Failed to restore session. Try again.")).ok) {
      resolve({ kind: "blocked" });
      return;
    }
    const isResetCommand =
      text === "/new" ||
      text.startsWith("/new ") ||
      text === "/reset" ||
      text.startsWith("/reset ");

    if (!isResetCommand && !isStreaming() && shouldAutoCompact()) {
      try {
        await compactCurrentSession();
      } catch {
        resolve({ kind: "blocked" });
        return;
      }
    }

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

    const messageText = text || "Attached file(s).";
    const levelToSend = pendingThinkLevel() ?? thinkingLevel();
    const currentAgent = agent();
    const queueMode = currentAgent?.queueMode ?? "queue";
    const streamOptions = {
      ...(input.projectId() ? { projectId: input.projectId() } : {}),
      ...(attachments?.length ? { attachments } : {}),
      ...(levelToSend ? { thinkLevel: levelToSend } : {}),
      ...(!isResetCommand && explicitSessionId()
        ? { sessionId: explicitSessionId() }
        : {}),
    };

    const handleSessionReset = (sessionId: string) => {
      setResolvedSessionId(sessionId);
      setSimpleMessages([]);
      setFullMessages([]);
      setPendingQueuedMessages([]);
      input.onSessionReset(sessionId);
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
      const sdkId = currentAgent?.sdk ?? "pi";
      const trackSequentialQueue = sdkId === "openclaw";
      if (trackSequentialQueue) {
        setPendingQueuedMessages((prev) => [
          ...prev,
          {
            text: messageText,
            files: inboundFiles.length > 0 ? inboundFiles : undefined,
            timestamp: userMsg.timestamp,
          },
        ]);
      }
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

          if (trackSequentialQueue) {
            setPendingQueuedMessages((prev) =>
              prev.length ? prev.slice(0, -1) : prev
            );
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
          onSessionReset: (sessionId) => {
            if (!isCurrentQueuedStream()) return;
            queuedResetFrom = queuedSession;
            queuedSession = sessionScope(sessionId);
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

    let streamSession = currentSession();
    let resetFromSession: string | null = null;
    directStreamSession = streamSession;
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
        if (!isCurrentDirectStream()) return;
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
          // A silent (NO_REPLY) turn streams no text; load it from history.
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
        onSessionReset: (sessionId) => {
          if (!isCurrentDirectStream()) return;
          resetFromSession = streamSession;
          streamSession = sessionScope(sessionId);
          directStreamSession = streamSession;
          pendingResetSession = streamSession;
          // Clear messages when session resets (e.g., /new command)
          handleSessionReset(sessionId);
        },
      },
      streamOptions
    );
  };

  const send = (request: SendRequest): Promise<SendResult> =>
    new Promise((resolve, reject) => {
      void performSend(request, resolve).catch(reject);
    });
  const stop = async (): Promise<{ error?: string }> => {
    if (stopping() || !isStreaming() || !input.agentId()) return {};
    setStopping(true);
    aborted = true;

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
    appSessionLookup?.abort();
    appSessionLookup = undefined;
    setAppSessionFailed(false);
    setResolvedSessionId(undefined);
    if (cleanup) cleanup();
    cleanup = null;
    directStreamSession = null;
    resetStreamingState();
    startNewChatKey(agentId);
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
  const copyTurnFor = (message: SimpleViewMessage | ContentBlock): string[] | undefined =>
    "role" in message ? simpleCopyReplies().get(message) : fullCopyReplies().get(message);
  const shouldAnimate = (id: string) => !noAnimIds.delete(id);
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
    contextUsageDisplay, isContextUsageDanger, contextWarning,
    compactStatusForCurrentSession, compactStatuses,
    copyTurnFor, shouldAnimate,
    thinkingLevel: () => pendingThinkLevel() ?? thinkingLevel(),
    selectThinking: (level: ThinkLevel | null) => setPendingThinkLevel(level),
    flushFinished, send, stop, compact: compactCurrentSession,
    loadEarlierHistory, restoreArchived, startNewChat,
  };
}
export type ChatSession = ReturnType<typeof createChatSession>;
