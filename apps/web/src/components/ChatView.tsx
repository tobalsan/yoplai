import { CompactionSummary, CompactStatusView, ActivityGroup, ContentBlocks, FileAttachmentList, FileCard, ModelMetaDisplay, ActiveToolIndicator, AssistantText, type ActivityItem } from "./chat/ChatBlocks";
import chatViewStyles from "./chat/ChatView.css?inline";
import {
  createSignal,
  createEffect,
  createResource,
  createMemo,
  For,
  Index,
  onCleanup,
  Show,
  on,
  batch,
  Switch,
  Match,
  type JSX,
} from "solid-js";

import { useParams, useNavigate, useSearchParams, useLocation, A } from "@solidjs/router";
import { ArchivedSessionBanner } from "./ArchivedSessionBanner";
import { isNoReply } from "@yoplai/shared/no-reply";
import { refreshToolLabels } from "../lib/tool-labels";
import {
  streamMessage,
  uploadFiles,
  getSessionKey,
  startNewChat,
  fetchFullHistory,
  fetchAgent,
  fetchAgentSuggestions,
  fetchAgentSessions,
  archiveAgentSession,
  subscribeToSession,
  subscribeToRealtime,
  postAbort,
  postCompact,
  type DoneMeta,
} from "../api";
import { fetchChatProject } from "../api/chat-projects";
import type {
  Message,
  HistoryViewMode,
  FullHistoryMessage,
  FullToolResultMessage,
  ContentBlock,
  FileAttachment,
  FileBlock,
  ModelMeta,
  ActiveToolCall,
  ThinkLevel,
} from "../api/types";
import { formatTimestamp } from "../lib/format";
import { extractBlockText } from "../lib/history";
import { formatReplyClipboard } from "../lib/reply-clipboard";
import { writeReplyClipboard } from "../lib/clipboard";
import { CopyButton } from "./CopyButton";
import {
  capabilities,
  isExtensionEnabled,
  loadCapabilities,
} from "../lib/capabilities";
import { getMaxContextTokens } from "@yoplai/shared/model-context";
import {
  attachmentToFileBlock,
  FILE_INPUT_ACCEPT,
} from "../lib/attachments";
import { createChatAttachmentRuntime } from "../lib/chat-runtime";
import { impersonationStatus } from "./ImpersonationBanner";
import { SuggestionCards } from "./SuggestionCards";
import {
  groupActivityItems,
  type ActivitySegment,
  streamingActivityItems,
} from "../lib/chat-activity";
import { showToast } from "../lib/toast";
import { MainAgentStarButton } from "./MainAgentStarButton";
import { fetchPoolActions } from "../api/teams";
import {
  notificationSoundEnabled,
  registerViewedChat,
  toggleNotificationSound,
} from "../lib/chat-notifications";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

function activityItems<T>(segment: ActivitySegment<T>): T[] {
  return segment.kind === "activity" ? segment.items : [];
}

function userText(message: FullHistoryMessage): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function SegmentView<T>(props: {
  segment: ActivitySegment<T>;
  activity: (items: () => T[]) => JSX.Element;
  message: (item: () => T) => JSX.Element;
}) {
  return (
    <Show
      when={props.segment.kind === "activity"}
      fallback={
        <Show when={messageItem(props.segment)}>
          {(item) => props.message(item as () => T)}
        </Show>
      }
    >
      {props.activity(() => activityItems(props.segment))}
    </Show>
  );
}

function messageItem<T>(segment: ActivitySegment<T>): T | undefined {
  return segment.kind === "message" ? segment.item : undefined;
}

// Greeting one-liners for the empty-chat hero; one is picked at random
// per new chat session.
const HERO_ONE_LINERS = [
  "What are we building today?",
  "Where do you want to start?",
  "What's on your mind?",
  "Ready when you are.",
  "What can I help you ship?",
  "Got something to untangle?",
  "Let's make something good.",
  "What's the mission?",
  "First thought, best thought.",
  "What are you curious about?",
  "Drop the big question.",
  "What needs doing?",
  "Say the word.",
  "New session, fresh ideas.",
  "What's brewing?",
  "Pick a thread to pull.",
  "What should we tackle first?",
  "Blank slate, endless options.",
  "What's the puzzle today?",
  "Ask me anything.",
  "Let's get to work.",
  "What's on the docket?",
  "Bring me your hardest problem.",
  "What are we exploring?",
  "Start anywhere. I'll keep up.",
  "What's the goal today?",
  "Give me the gist.",
  "What's next on the list?",
  "Fire away.",
  "What's the plan, boss?",
];

const pickHeroOneLiner = () =>
  HERO_ONE_LINERS[Math.floor(Math.random() * HERO_ONE_LINERS.length)];

type DropZone = "history" | "composer" | "attach";

type SimpleToolMessage = {
  id: string;
  parentToolCallId?: string;
  result?: FullToolResultMessage;
  role: "tool";
  toolName: string;
  arguments?: unknown;
  timestamp: number;
};

type SimpleThinkingMessage = {
  id: string;
  role: "thinking";
  content: string;
  timestamp: number;
  endedAt?: number;
};

type SimpleSummaryMessage = {
  id: string;
  role: "compaction";
  content: string;
  timestamp: number;
};

type SimpleViewMessage = Message | SimpleToolMessage | SimpleThinkingMessage | SimpleSummaryMessage;

const COMPACT_SUMMARY_PREFIX = "[COMPACTED CONTEXT SUMMARY]";

function compactSummary(message: FullHistoryMessage): string | undefined {
  if (message.role !== "system") return undefined;
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => extractBlockText(block.text))
    .join("\n");
  return text.startsWith(COMPACT_SUMMARY_PREFIX)
    ? text.slice(COMPACT_SUMMARY_PREFIX.length).trim()
    : undefined;
}

type StreamingBlock =
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
    }
  | (FileBlock & { timestamp: number });

export type CompactStatus = {
  state: "running" | "done" | "error";
  text: string;
  /** When compaction settled; anchors the status inline in the history. */
  at?: number;
};

type FullDisplayRow =
  | { kind: "activity"; item: ActivityItem; historyIndex: number }
  | {
      kind: "assistant-content";
      historyIndex: number;
      block: Extract<ContentBlock, { type: "text" | "file" }>;
      timestamp: number;
      meta?: ModelMeta;
      footer: boolean;
    }
  | { kind: "message"; message: FullHistoryMessage; historyIndex: number };

function fullHistoryDisplayRows(
  messages: FullHistoryMessage[],
  toolResults: Map<string, FullToolResultMessage>
): FullDisplayRow[] {
  const rows: FullDisplayRow[] = [];
  messages.forEach((message, historyIndex) => {
    if (message.role === "toolResult") return;
    if (message.role !== "assistant") {
      rows.push({ kind: "message", message, historyIndex });
      return;
    }
    const visibleBlocks = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "text" | "file" }> =>
        block.type === "text" || block.type === "file"
    );
    let visibleIndex = 0;
    for (const block of message.content) {
      if (block.type === "thinking") {
        rows.push({
          kind: "activity",
          historyIndex,
          item: {
            type: "thinking",
            content: block.thinking,
            startedAt: block.startedAt,
            endedAt: block.endedAt,
          },
        });
      } else if (block.type === "toolCall") {
        rows.push({
          kind: "activity",
          historyIndex,
          item: {
            type: "tool",
            id: block.id,
            parentToolCallId: block.parentToolCallId,
            name: block.name,
            arguments: block.arguments,
            result: toolResults.get(block.id),
            at: message.timestamp,
          },
        });
      } else if (block.type === "text" || block.type === "file") {
        visibleIndex += 1;
        rows.push({
          kind: "assistant-content",
          historyIndex,
          block,
          timestamp: message.timestamp,
          meta: message.meta,
          footer: visibleIndex === visibleBlocks.length,
        });
      }
    }
  });
  return rows;
}

function fullMessagesToSimpleView(
  messages: FullHistoryMessage[]
): SimpleViewMessage[] {
  const simple: SimpleViewMessage[] = [];
  const results = new Map(
    messages.filter((message): message is FullToolResultMessage => message.role === "toolResult")
      .map((message) => [message.toolCallId, message])
  );
  for (const message of messages) {
    const summary = compactSummary(message);
    if (summary !== undefined) {
      simple.push({ id: crypto.randomUUID(), role: "compaction", content: summary, timestamp: message.timestamp });
      continue;
    }
    if (message.role === "toolResult" || message.role === "system") continue;
    if (message.role === "user") {
      const text = message.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            block.type === "text"
        )
        .map((block) => block.text)
        .join("\n");
      simple.push({
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        files: message.content.filter(
          (block): block is FileBlock => block.type === "file"
        ),
        timestamp: message.timestamp,
      });
      continue;
    }

    for (const block of message.content) {
      if (block.type === "text" && block.text.trim() && !isNoReply(block.text)) {
        simple.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: block.text,
          meta: message.meta,
          timestamp: message.timestamp,
        });
      } else if (block.type === "thinking" && block.thinking.trim()) {
        simple.push({
          id: crypto.randomUUID(),
          role: "thinking",
          content: block.thinking,
          timestamp: block.startedAt ?? message.timestamp,
          endedAt: block.endedAt,
        });
      } else if (block.type === "toolCall") {
        simple.push({
          id: block.id,
          parentToolCallId: block.parentToolCallId,
          result: results.get(block.id),
          role: "tool",
          toolName: block.name,
          arguments: block.arguments,
          timestamp: message.timestamp,
        });
      } else if (block.type === "file") {
        simple.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          files: [block],
          timestamp: message.timestamp,
        });
      }
    }
  }
  return simple;
}

export { ThinkingLine } from "./chat/ChatBlocks";

export function ChatView() {
  const codeCopyTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  onCleanup(() => codeCopyTimers.forEach((timer) => clearTimeout(timer)));
  const handleCodeCopy = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-copy-code]");
    if (!button) return;
    const text: string = JSON.parse(button.dataset.copyCode!);
    const status = button.querySelector("span")!;
    const showFeedback = (success: boolean) => {
      status.textContent = success ? "Copied" : "Copy failed";
      clearTimeout(codeCopyTimers.get(button));
      const timer = setTimeout(() => {
        status.textContent = "⧉";
        codeCopyTimers.delete(button);
      }, 2000);
      codeCopyTimers.set(button, timer);
    };
    try {
      void navigator.clipboard.writeText(text).then(() => showFeedback(true), () => showFeedback(false));
    } catch {
      showFeedback(false);
    }
  };
  void refreshToolLabels();
  const params = useParams<{ agentId: string; view?: string }>();
  const navigate = useNavigate();
  const location = useLocation<{ mainAgentHome?: boolean; draftMessage?: string }>();
  const [agent] = createResource(() => params.agentId, fetchAgent);
  // Settings live on the pool agent in forked mode; the chat agent is a fork.
  const [settingsPoolActions] = createResource(
    () => (capabilities.forkedAgents ? params.agentId : null),
    (chatAgentId) => fetchPoolActions()
      .then((entries) => ({ chatAgentId, poolId: entries.find((entry) => entry.action === "chat" && entry.chatAgentId === chatAgentId)?.poolId ?? null }))
      .catch(() => ({ chatAgentId, poolId: null }))
  );
  // Ignore a stale result from the previous agent while the new lookup loads.
  const settingsAgentId = () => {
    if (!capabilities.forkedAgents) return params.agentId;
    const resolved = settingsPoolActions();
    return resolved?.chatAgentId === params.agentId ? resolved.poolId : null;
  };

  const hasSuperadminRole = (role: string | string[] | null | undefined) => {
    return Array.isArray(role)
      ? role.includes("superadmin")
      : role === "superadmin";
  };
  const canUseFullView = createMemo(
    () => !capabilities.multiUser || hasSuperadminRole(capabilities.user?.role)
  );
  const viewMode = createMemo<HistoryViewMode>(() =>
    params.view === "full" && canUseFullView() ? "full" : "simple"
  );
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
  const [input, setInput] = createSignal("");
  const attachmentRuntime = createChatAttachmentRuntime();
  const pendingFiles = attachmentRuntime.pendingFiles;
  const uploadingFiles = attachmentRuntime.uploadingFiles;
  const uploadError = attachmentRuntime.uploadError;
  const setUploadingFiles = attachmentRuntime.setUploadingFiles;
  const setUploadError = attachmentRuntime.setUploadError;
  const [isFileDragActive, setIsFileDragActive] = createSignal(false);
  const [activeDropZone, setActiveDropZone] = createSignal<DropZone | null>(
    null
  );
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
  const [compactStatuses, setCompactStatuses] = createSignal(
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
  let focusedHomeSession: string | null = null;
  let loadedHistoryOffset = 0;

  // Empty-chat hero state. `heroEmpty` is true when the chat has no content;
  // `heroPhase` tracks hero -> exiting -> off so the composer can slide from
  // its centered hero position to the docked position once, smoothly.
  const heroEmpty = createMemo(
    () =>
      !loading() &&
      !isStreaming() &&
      simpleMessages().length === 0 &&
      fullMessages().length === 0 &&
      pendingQueuedMessages().length === 0
  );
  const [heroPhase, setHeroPhase] = createSignal<"hero" | "exiting" | "off">(
    "off"
  );
  const [heroGone, setHeroGone] = createSignal(false);
  let heroExitTimer: number | undefined;
  createEffect(() => {
    const empty = heroEmpty();
    if (empty) {
      if (heroExitTimer !== undefined) {
        window.clearTimeout(heroExitTimer);
        heroExitTimer = undefined;
      }
      setHeroGone(false);
      setHeroPhase("hero");
      return;
    }
    if (heroPhase() === "hero") {
      setHeroPhase("exiting");
      heroExitTimer = window.setTimeout(() => {
        heroExitTimer = undefined;
        if (!heroEmpty()) {
          setHeroGone(true);
          setHeroPhase("off");
        }
      }, 450);
    }
  });
  onCleanup(() => {
    if (heroExitTimer !== undefined) window.clearTimeout(heroExitTimer);
  });
  const [heroOneLiner, setHeroOneLiner] = createSignal(HERO_ONE_LINERS[0]);
  createEffect(() => {
    void params.agentId;
    void sessionKey();
    void explicitSessionId();
    setHeroOneLiner(pickHeroOneLiner());
  });

  let chatViewRef: HTMLDivElement | undefined;
  let messagesContainerRef: HTMLDivElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let cleanup: (() => void) | null = null;
  let directStreamSession: string | null = null;
  let displayedSession: string | null = null;
  let pendingResetSession: string | null = null;
  let subscriptionCleanup: (() => void) | null = null;
  let aborted = false;
  let skipNextHistoryRefresh = false;
  let fileDragDepth = 0;
  const noAnimIds = new Set<string>();

  const [searchParams] = useSearchParams();
  const sessionKey = () => getSessionKey(params.agentId);
  const explicitSessionId = () =>
    typeof searchParams.session === "string" && searchParams.session.trim()
      ? searchParams.session
      : undefined;
  createEffect(on([() => params.agentId, sessionKey, explicitSessionId], () => {
    setResolvedSessionId(pendingResetSession === currentSession() ? explicitSessionId() : undefined);
  }));
  createEffect(() => {
    const sessionId = resolvedSessionId();
    if (sessionId) onCleanup(registerViewedChat(params.agentId, sessionId));
  });
  const sessionScope = (sessionId = explicitSessionId()) =>
    `${params.agentId}:${sessionKey()}:${sessionId ?? ""}`;
  const currentSession = () => sessionScope();
  const ownsDisplayedDirectStream = () =>
    cleanup !== null && directStreamSession === currentSession();
  const [suggestions] = createResource(
    () => [params.agentId, explicitSessionId()] as const,
    ([agentId]) => fetchAgentSuggestions(agentId)
  );

  // Get project ID from query params or session
  const currentProjectId = createMemo(() => {
    // First try query param
    if (typeof searchParams.project === "string" && searchParams.project.trim()) {
      return searchParams.project;
    }
    // Otherwise use resolved session's projectId if available
    // We'll need to fetch sessions to get this
    return undefined;
  });

  const [allSessions, { refetch: refetchSessions }] = createResource(
    () => explicitSessionId(),
    async (sessionId) => {
      if (!sessionId) return { items: [] };
      return fetchAgentSessions({ includeArchived: true });
    }
  );

  const sessionProjectId = createMemo(() => {
    const sid = explicitSessionId();
    if (!sid || !allSessions()) return undefined;
    const session = allSessions()?.items.find(s => s.sessionId === sid);
    return session?.projectId ?? undefined;
  });

  const isSessionArchived = createMemo(() => {
    const sid = explicitSessionId();
    if (!sid || !allSessions()) return false;
    const session = allSessions()?.items.find(s => s.agentId === params.agentId && s.sessionId === sid);
    return session?.archived != null;
  });

  const projectId = () => currentProjectId() ?? sessionProjectId();

  const [project] = createResource(
    projectId,
    async (id) => {
      if (!id) return null;
      try {
        return await fetchChatProject(id);
      } catch {
        return null;
      }
    }
  );

  const isOAuth = () => agent()?.authMode === "oauth";

  void loadCapabilities().catch(() => undefined);

  // Build a map of toolCallId -> toolResult for grouping tool calls with their results
  const toolResultsMap = createMemo(() => {
    const map = new Map<string, FullToolResultMessage>();
    for (const msg of fullMessages()) {
      if (msg.role === "toolResult") {
        map.set(msg.toolCallId, msg);
      }
    }
    return map;
  });

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

  const visibleFullMessages = fullMessages;
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
  const fullDisplaySegments = createMemo(() =>
    groupActivityItems(
      fullHistoryDisplayRows(visibleFullMessages(), toolResultsMap()),
      (row) => row.kind === "activity"
    )
  );

  const [autoScrollPinned, setAutoScrollPinned] = createSignal(true);
  const SCROLL_THRESHOLD = 40;
  let autoScrollFrame: number | undefined;
  let programmaticScrollUntil = 0;

  const checkIsAtBottom = () => {
    if (!messagesContainerRef) return true;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef;
    return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
  };

  const handleScroll = () => {
    if (performance.now() < programmaticScrollUntil) return;
    setAutoScrollPinned(checkIsAtBottom());
  };

  const handleUserScrollIntent = () => {
    programmaticScrollUntil = 0;
    if (!checkIsAtBottom()) setAutoScrollPinned(false);
  };

  const scrollToBottom = (force = false) => {
    if (!messagesContainerRef) return;
    if (force) setAutoScrollPinned(true);
    if (!(force || autoScrollPinned())) return;
    if (autoScrollFrame !== undefined) cancelAnimationFrame(autoScrollFrame);
    autoScrollFrame = requestAnimationFrame(() => {
      autoScrollFrame = undefined;
      if (!messagesContainerRef) return;
      if (!(force || autoScrollPinned())) return;
      programmaticScrollUntil = performance.now() + 100;
      messagesContainerRef.scrollTop = messagesContainerRef.scrollHeight;
    });
  };

  const canAttachFiles = () =>
    !loading() &&
    !uploadingFiles() &&
    !isStreaming() &&
    !impersonationStatus()?.active;

  const getFileDropError = () => {
    if (isStreaming()) {
      return "Wait for the current response before attaching files.";
    }
    if (uploadingFiles()) {
      return "Wait for the current upload to finish before attaching files.";
    }
    if (loading()) {
      return "Wait for the chat to finish loading before attaching files.";
    }
    return "";
  };

  const isFileDragEvent = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");

  const getDropZone = (target: EventTarget | null): DropZone | null => {
    const element = target instanceof Element ? target : null;
    if (!element) return null;
    if (element.closest(".attach-btn")) return "attach";
    if (element.closest(".input-pill") || element.closest(".input-area")) {
      return "composer";
    }
    if (element.closest(".messages")) return "history";
    return null;
  };

  const resetFileDragState = () => {
    fileDragDepth = 0;
    setIsFileDragActive(false);
    setActiveDropZone(null);
  };

  const updateDropZoneFromEvent = (event: DragEvent) => {
    setActiveDropZone(getDropZone(event.target));
  };

  const resizeTextarea = () => {
    if (!textareaRef) return;
    textareaRef.style.height = "auto";
    const lineHeight = 22;
    const maxHeight = lineHeight * 10;
    textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, maxHeight)}px`;
  };

  const prefillSuggestion = (prompt: string) => {
    setInput(prompt);
    requestAnimationFrame(() => {
      resizeTextarea();
      textareaRef?.focus();
    });
  };

  const clearPendingFiles = attachmentRuntime.clearFiles;
  const addPendingFiles = attachmentRuntime.attachFiles;
  const removePendingFile = attachmentRuntime.removeFile;

  onCleanup(clearPendingFiles);

  // Load history based on view mode
  const loadHistory = async (mode: HistoryViewMode) => {
    const requestedSession = currentSession();
    const agentId = params.agentId;
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
    if (location.state?.mainAgentHome && !sessionId && res.messages.length === 0 && focusedHomeSession !== requestedSession) {
      focusedHomeSession = requestedSession;
      requestAnimationFrame(() => {
        if (requestedSession === currentSession() && !document.querySelector('[aria-modal="true"]')) textareaRef?.focus();
      });
    }
  };

  const loadEarlierHistory = async () => {
    const before = historyCursor();
    if (!before || loadingEarlier()) return;
    const requestedSession = currentSession();
    setLoadingEarlier(true);
    setHistoryError("");
    try {
      const res = await fetchFullHistory(params.agentId, sessionKey(), explicitSessionId(), { limit: 100, before });
      if (requestedSession !== currentSession() || before !== historyCursor()) return;
      const container = messagesContainerRef;
      const previousHeight = container?.scrollHeight ?? 0;
      const previousTop = container?.scrollTop ?? 0;
      setAutoScrollPinned(false);
      loadedHistory = [...res.messages, ...loadedHistory];
      loadedHistoryOffset = res.historyOffset ?? Math.max(0, loadedHistoryOffset - res.messages.length);
      if (viewMode() === "full") setFullMessages((messages) => [...res.messages, ...messages]);
      else setSimpleMessages((messages) => [...fullMessagesToSimpleView(res.messages), ...messages]);
      setHistoryCursor(res.nextCursor);
      requestAnimationFrame(() => {
        if (container && requestedSession === currentSession()) {
          container.scrollTop = previousTop + container.scrollHeight - previousHeight;
        }
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
        params.agentId,
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
      compactKey(params.agentId, sessionKey(), explicitSessionId())
    );

  // Index of the last visible message at or before compaction settled; the
  // status renders right after it so later messages flow below. -1 = before
  // all messages; null = bottom (still running).
  const compactStatusAnchorIndex = createMemo((): number | null => {
    const at = compactStatusForCurrentSession()?.at;
    if (at === undefined) return null;
    const list: { role: string; timestamp: number }[] =
      viewMode() === "simple"
        ? simpleMessages()
        : fullHistoryDisplayRows(visibleFullMessages(), toolResultsMap()).map(
            (row) => visibleFullMessages()[row.historyIndex]
          );
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role !== "toolResult" && list[i].timestamp <= at) return i;
    }
    return -1;
  });

  const setCompactStatus = (key: string, status: CompactStatus) => {
    setCompactStatuses((statuses) => new Map(statuses).set(key, status));
  };

  const compactCurrentSession = () => {
    const agentId = params.agentId;
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
      scrollToBottom(true);
      try {
        await postCompact(agentId, currentSessionKey, currentSessionId);
        if (
          compactKey(params.agentId, sessionKey(), explicitSessionId()) === key
        ) {
          await loadHistory(viewMode());
        }
        setCompactStatus(key, {
          state: "done",
          text: "Context compacted.",
          at: Date.now(),
        });
        scrollToBottom(true);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to compact context";
        setCompactStatus(key, { state: "error", text: message, at: Date.now() });
        scrollToBottom(true);
        throw error;
      } finally {
        compactRequests.delete(key);
      }
    })();
    compactRequests.set(key, request);
    return request;
  };

  const applyActiveTurnSnapshot = (turn: import("../api").ActiveTurn) => {
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
      attachStreamingToolResult(result.id, result.name, result.content, result.isError, result.details, result.parentToolCallId);
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
    turn: import("../api").ActiveTurn | null
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

  const appendStreamingToolCallBlock = (
    id: string,
    name: string,
    args: unknown,
    parentToolCallId?: string,
    timestamp = Date.now()
  ) => {
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
    parentToolCallId?: string
  ) => {
    const result: FullToolResultMessage = {
      role: "toolResult",
      toolCallId: id,
      parentToolCallId,
      toolName: name,
      content: [{ type: "text", text: content }],
      isError,
      details,
      timestamp: Date.now(),
    };
    if (flushedRunningToolIds.delete(id)) {
      setFullMessages((prev) => [...prev, result]);
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
    const agentId = params.agentId;
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
        onToolCall: (id, name, args, parentToolCallId) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          setStreamingFinished(false);
          appendStreamingToolCallBlock(id, name, args, parentToolCallId);
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
        onToolResult: (id, name, content, isError, details, parentToolCallId) => {
          if (!isCurrentSubscription()) return;
          if (ownsDisplayedDirectStream()) return;
          attachStreamingToolResult(id, name, content, isError, details, parentToolCallId);
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
    const agentId = params.agentId;
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

  createEffect(() => {
    simpleMessages();
    fullMessages();
    streamingText();
    void streamingBlocks().length;
    streamingFiles();
    activeTools();
    scrollToBottom();
  });

  onCleanup(() => {
    if (autoScrollFrame !== undefined) cancelAnimationFrame(autoScrollFrame);
    cleanup?.();
    subscriptionCleanup?.();
    statusCleanup?.();
    resetFileDragState();
  });

  createEffect(() => {
    if (canAttachFiles()) return;
    resetFileDragState();
  });

  createEffect(() => {
    const root = chatViewRef;
    if (!root) return;

    const handleRootDragEnter = (event: Event) => {
      const dragEvent = event as DragEvent;
      if (!isFileDragEvent(dragEvent) || !canAttachFiles()) return;
      dragEvent.preventDefault();
      fileDragDepth += 1;
      setIsFileDragActive(true);
      updateDropZoneFromEvent(dragEvent);
    };

    const handleRootDragOver = (event: Event) => {
      const dragEvent = event as DragEvent;
      if (!isFileDragEvent(dragEvent)) return;
      if (!canAttachFiles()) return;
      dragEvent.preventDefault();
      if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "copy";
      setIsFileDragActive(true);
      updateDropZoneFromEvent(dragEvent);
    };

    const handleRootDragLeave = (event: Event) => {
      const dragEvent = event as DragEvent;
      if (!isFileDragEvent(dragEvent) || fileDragDepth === 0) return;
      fileDragDepth = Math.max(0, fileDragDepth - 1);
      if (fileDragDepth === 0) resetFileDragState();
    };

    const handleRootDrop = (event: Event) => {
      const dragEvent = event as DragEvent;
      if (!isFileDragEvent(dragEvent)) return;
      dragEvent.preventDefault();
      const files = dragEvent.dataTransfer?.files;
      const dropError = getFileDropError();
      resetFileDragState();
      if (dropError) {
        setUploadError(dropError);
        return;
      }
      if (!files || files.length === 0) return;
      addPendingFiles(files);
    };

    root.addEventListener("dragenter", handleRootDragEnter, true);
    root.addEventListener("dragover", handleRootDragOver, true);
    root.addEventListener("dragleave", handleRootDragLeave, true);
    root.addEventListener("drop", handleRootDrop, true);
    onCleanup(() => {
      root.removeEventListener("dragenter", handleRootDragEnter, true);
      root.removeEventListener("dragover", handleRootDragOver, true);
      root.removeEventListener("dragleave", handleRootDragLeave, true);
      root.removeEventListener("drop", handleRootDrop, true);
    });
  });

  const handleViewChange = (mode: HistoryViewMode) => {
    if (mode !== viewMode()) {
      const basePath =
        mode === "full"
          ? `/chat/${params.agentId}/full`
          : `/chat/${params.agentId}`;
      const session = explicitSessionId();
      const query = new URLSearchParams();
      if (session) query.set("session", session);
      if (searchParams.project) query.set("project", String(searchParams.project));
      const path = query.size ? `${basePath}?${query}` : basePath;
      navigate(path, { replace: true });
    }
  };

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
    const contentBlocks: ContentBlock[] =
      blocks.length > 0
        ? blocks.map((block, index) => {
            if (block.type === "toolCall") {
              return {
                type: "toolCall",
                id: block.id,
                parentToolCallId: block.parentToolCallId,
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

  const handleSend = async () => {
    if (streamingFinished()) {
      batch(() => {
        appendStreamingAssistantMessage();
        resetStreamingState();
      });
    }

    if (impersonationStatus()?.active) return;
    const text = input().trim();
    const currentPendingFiles = pendingFiles();
    const hasFiles = currentPendingFiles.length > 0;
    if ((!text && !hasFiles) || loading() || uploadingFiles()) return;
    if (isStreaming() && hasFiles) {
      setUploadError("Wait for the current response before attaching files.");
      return;
    }

    // Treat /stop as an interrupt
    if (text === "/stop") {
      setInput("");
      if (textareaRef) textareaRef.style.height = "auto";
      handleStop();
      return;
    }

    if (text === "/compact") {
      setInput("");
      if (textareaRef) textareaRef.style.height = "auto";
      await compactCurrentSession().catch(() => undefined);
      return;
    }

    // Auto-unarchive if sending a message to an archived session
    if (isSessionArchived()) {
      try {
        await archiveAgentSession(params.agentId, explicitSessionId()!, false);
        showToast("Chat restored", "success");
        // Refetch sessions to clear archived state
        void refetchSessions();
        window.dispatchEvent(new Event("chat-projects-changed"));
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to restore session. Try again.";
        setSimpleMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Error: ${message}`,
            timestamp: Date.now(),
          },
        ]);
        setFullMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: [{ type: "text", text: `Error: ${message}` }],
            timestamp: Date.now(),
          },
        ]);
        return;
      }
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
        return;
      }
    }

    let attachments: FileAttachment[] | undefined;
    let inboundFiles: FileBlock[] = [];
    if (hasFiles) {
      setUploadingFiles(true);
      setUploadError("");
      try {
        attachments = await uploadFiles(
          currentPendingFiles.map((item) => item.file)
        );
        inboundFiles = attachments.map((attachment, index) =>
          attachmentToFileBlock(attachment, currentPendingFiles[index])
        );
        clearPendingFiles();
      } catch (error) {
        setUploadError(
          error instanceof Error ? error.message : "File upload failed"
        );
        setUploadingFiles(false);
        return;
      }
      setUploadingFiles(false);
    }

    const messageText = text || "Attached file(s).";
    const levelToSend = pendingThinkLevel() ?? thinkingLevel();
    const currentAgent = agent();
    const queueMode = currentAgent?.queueMode ?? "queue";
    const streamOptions = {
      ...(searchParams.project ? { projectId: String(searchParams.project) } : {}),
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
      clearPendingFiles();
      navigate(
        `/chat/${encodeURIComponent(params.agentId)}?session=${encodeURIComponent(sessionId)}`
      );
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

    setInput("");
    if (textareaRef) textareaRef.style.height = "auto";
    scrollToBottom(true);

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
      const queuedBlocks: ContentBlock[] = [];
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
        params.agentId,
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

          const blocks: ContentBlock[] = queuedBlocks.length
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
          onToolCall: (id, name, args, parentToolCallId) => {
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
          onToolResult: (id, name, content, isError, details, parentToolCallId) => {
            if (!isCurrentQueuedStream()) return;
            queuedToolResults.push({
              role: "toolResult",
              toolCallId: id,
              parentToolCallId,
              toolName: name,
              content: [{ type: "text", text: content }],
              isError,
              details,
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
      params.agentId,
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
        onToolCall: (id, name, args, parentToolCallId) => {
          if (!isCurrentDirectStream()) return;
          setStreamingFinished(false);
          appendStreamingToolCallBlock(id, name, args, parentToolCallId);
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
        onToolResult: (id, name, content, isError, details, parentToolCallId) => {
          if (!isCurrentDirectStream()) return;
          attachStreamingToolResult(id, name, content, isError, details, parentToolCallId);
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

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = async () => {
    if (stopping() || !isStreaming() || !params.agentId) return;
    setStopping(true);
    aborted = true;

    try {
      const sessionId = explicitSessionId();
      if (sessionId) await postAbort(params.agentId, sessionKey(), sessionId);
      else await postAbort(params.agentId, sessionKey());
    } catch (error) {
      aborted = false;
      setUploadError(
        error instanceof Error ? error.message : "Failed to stop run"
      );
    } finally {
      setStopping(false);
    }
  };

  const fileDropHint = createMemo(() => {
    if (!isFileDragActive()) return "";
    if (activeDropZone() === "history") return "Drop files into the chat.";
    if (activeDropZone() === "composer") {
      return "Drop files to attach them to your next message.";
    }
    if (activeDropZone() === "attach") return "Drop files on + to attach.";
    return "Drop files to attach them.";
  });

  const startFreshChat = (agentId: string) => {
    if (cleanup) cleanup();
    cleanup = null;
    directStreamSession = null;
    resetStreamingState();
    startNewChat(agentId);
    setSimpleMessages([]);
    setFullMessages([]);
    setPendingQueuedMessages([]);
    clearPendingFiles();
    setShowInterrupted(false);
    setInput("");
    navigate(`/chat/${encodeURIComponent(agentId)}`);
    requestAnimationFrame(() => textareaRef?.focus());
  };

  let draftMessageUsed = false;
  createEffect(() => {
    const message = location.state?.draftMessage;
    if (!message || draftMessageUsed || loading() || !agent()) return;
    draftMessageUsed = true;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: { mainAgentHome: location.state?.mainAgentHome } });
    if (simpleMessages().length || fullMessages().length) return;
    prefillSuggestion(message);
  });

  return (
    <div
      ref={chatViewRef}
      class="chat-view"
      onClick={handleCodeCopy}
      classList={{
        "drop-active": isFileDragActive(),
        "hero-mode": heroPhase() !== "off",
        "hero-sent": heroPhase() === "exiting" || heroPhase() === "off",
      }}
    >
      <header class="header">
        <A
          href={projectId() ? `/p/${projectId()}` : "/agents"}
          class="back-btn"
          aria-label={projectId() ? "Back to project" : "Go back"}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </A>
        <div class="agent-info">
          <Show when={agent()?.avatar}>
            {(avatar) => (
              <div class="agent-avatar">
                {isEmoji(avatar()) ? (
                  <span class="avatar-emoji">{avatar()}</span>
                ) : (
                  <img src={avatar()} alt={agent()?.name} class="avatar-img" />
                )}
              </div>
            )}
          </Show>
          <div class="agent-info-text">
            <div class="agent-title-row">
              <div class="agent-name">{agent()?.name ?? "Loading..."}</div>
              <Show when={project()}>
                {(proj) => (
                  <A href={`/p/${projectId()}`} class="chat-project-chip">
                    <i class="fa-solid fa-folder" />
                    <span>{proj().name}</span>
                  </A>
                )}
              </Show>
            </div>
            <div class="agent-status">
              <span class="status-dot" classList={{ active: isStreaming() }} />
              <span class="status-text">
                {isStreaming() ? "thinking" : "online"}
              </span>
              <Show when={agent()?.description}>
                <span class="agent-description-sep">&middot;</span>
                <span class="agent-description-inline">
                  {agent()!.description}
                </span>
              </Show>
            </div>
          </div>
          <button
            type="button"
            class="notification-sound-btn"
            aria-label={notificationSoundEnabled() ? "Notification sound on" : "Notification sound off"}
            aria-pressed={notificationSoundEnabled()}
            title={notificationSoundEnabled()
              ? "Sound on: a sound plays when an agent finishes a reply. Click to turn off."
              : "Sound off: no sound when an agent finishes a reply. Click to turn on."}
            onClick={toggleNotificationSound}
          >
            <i class={notificationSoundEnabled() ? "fa-solid fa-bell" : "fa-solid fa-bell-slash"} aria-hidden="true" />
          </button>
        </div>
        <Show when={isExtensionEnabled("projects")}>
          <A
            class="taskboard-btn"
            href="/projects"
            aria-label="Open taskboard"
            title="Tasks"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 11l3 3L22 4" />
              <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
            </svg>
          </A>
        </Show>
        <Show when={isOAuth() && canUseFullView()}>
          <select
            class="think-dropdown"
            value={pendingThinkLevel() ?? thinkingLevel() ?? ""}
            onChange={(e) => {
              const val = e.currentTarget.value;
              setPendingThinkLevel(val ? (val as ThinkLevel) : null);
            }}
          >
            <option value="">Default</option>
            <option value="off">Off</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="xhigh">XHigh</option>
          </select>
        </Show>
        <Show when={canUseFullView()}>
          <div class="view-toggle">
            <button
              class="toggle-btn"
              classList={{ active: viewMode() === "simple" }}
              onClick={() => handleViewChange("simple")}
            >
              Simple
            </button>
            <button
              class="toggle-btn"
              classList={{ active: viewMode() === "full" }}
              onClick={() => handleViewChange("full")}
            >
              Full
            </button>
          </div>
        </Show>
        <button
          class="new-chat-btn"
          aria-label="Start a new chat"
          title="New chat"
          onClick={() => startFreshChat(params.agentId)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>
        <Show when={settingsAgentId()}>
          {(poolId) => (
            <A
              href={`/agents/${encodeURIComponent(poolId())}/edit`}
              state={{ backTo: `${location.pathname}${location.search}` }}
              class="agent-settings-btn"
              aria-label={`${agent()?.name ?? "Agent"} settings`}
              title="Agent settings"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </A>
          )}
        </Show>
        <Show when={!projectId() && agent()}>
          {(current) => <MainAgentStarButton agentId={params.agentId} name={current().name} onPick={startFreshChat} />}
        </Show>
      </header>

      <ArchivedSessionBanner
        isArchived={isSessionArchived()}
        onRestore={async () => {
          await archiveAgentSession(params.agentId, explicitSessionId()!, false);
          showToast("Chat restored", "success");
          void refetchSessions();
          window.dispatchEvent(new Event("chat-projects-changed"));
        }}
        onError={(message) => {
          setSimpleMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: `Error: ${message}`,
              timestamp: Date.now(),
            },
          ]);
          setFullMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              content: [{ type: "text", text: `Error: ${message}` }],
              timestamp: Date.now(),
            },
          ]);
        }}
      />

      <div class="chat-body">
        <div class="hero-spacer hero-spacer-top" />
        <div class="hero hero-collapsible" classList={{ gone: heroGone() }}>
          <Show
            when={agent()?.avatar}
            fallback={
              <div class="hero-avatar">
                <span class="avatar-emoji">
                  {agent()?.name?.[0]?.toUpperCase() ?? "A"}
                </span>
              </div>
            }
          >
            {(avatar) => (
              <div class="hero-avatar">
                {isEmoji(avatar()) ? (
                  <span class="avatar-emoji">{avatar()}</span>
                ) : (
                  <img src={avatar()} alt={agent()?.name} class="avatar-img" />
                )}
              </div>
            )}
          </Show>
          <h1 class="hero-one-liner">{heroOneLiner()}</h1>
        </div>

        <div
          class="messages"
          ref={messagesContainerRef}
          onScroll={handleScroll}
          onWheel={handleUserScrollIntent}
          onTouchMove={handleUserScrollIntent}
          onKeyDown={(e) => {
            if (
              e.key === "PageUp" ||
              e.key === "PageDown" ||
              e.key === "ArrowUp" ||
              e.key === "ArrowDown" ||
              e.key === "Home" ||
              e.key === "End"
            ) {
              handleUserScrollIntent();
            }
          }}
          classList={{
            "drop-target": isFileDragActive() && activeDropZone() === "history",
          }}
        >
          <Show when={historyCursor()}>
            <button class="load-earlier" disabled={loadingEarlier()} onClick={() => void loadEarlierHistory()}>
              {loadingEarlier() ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          </Show>
          <Show when={historyError()}><div role="alert">{historyError()}</div></Show>
          <Show when={compactStatusAnchorIndex() === -1}>
            <CompactStatusView status={compactStatusForCurrentSession()} />
          </Show>

          <Show when={viewMode() === "simple"}>
            <Index
              each={groupActivityItems(
                simpleMessages(),
                (msg) => msg.role === "tool" || msg.role === "thinking"
              )}
            >
              {(segment) => (
                <SegmentView
                  segment={segment()}
                  activity={(items) => (
                    <>
                      <ActivityGroup
                        simple
                        items={items().map((msg) =>
                          msg.role === "thinking"
                            ? {
                                type: "thinking" as const,
                                content: msg.content,
                                startedAt: msg.timestamp,
                                endedAt: msg.endedAt,
                              }
                            : {
                                type: "tool" as const,
                                id: msg.id,
                                parentToolCallId: (msg as SimpleToolMessage).parentToolCallId,
                                result: (msg as SimpleToolMessage).result,
                                name: (msg as SimpleToolMessage).toolName,
                                arguments: (msg as SimpleToolMessage).arguments,
                                at: msg.timestamp,
                              }
                        )}
                      />
                      <Show
                        when={segment().endIndex === compactStatusAnchorIndex()}
                      >
                        <CompactStatusView
                          status={compactStatusForCurrentSession()}
                        />
                      </Show>
                    </>
                  )}
                  message={(row) => {
                    const skipAnim = noAnimIds.delete(row().id);
                    const visible = () => {
                      const message = row();
                      return message.role === "tool" ||
                        message.role === "thinking" || message.role === "compaction"
                        ? undefined
                        : message;
                    };
                    return (
                      <>
                        <Show when={row().role === "compaction"}>
                          <CompactionSummary text={(row() as SimpleSummaryMessage).content} timestamp={row().timestamp} />
                        </Show>
                        <Show when={visible()}>
                          {(item) => (
                            <div
                              class={`message ${item().role}${skipAnim ? " no-anim" : ""}`}
                              classList={{ "system-message": !!item().meta?.failure }}
                            >
                              {item().role === "assistant" ? (
                                <>
                                  <Show when={item().content}>
                                    <AssistantText class="content markdown-content" text={item().content} options={{ copyCode: true }} />
                                  </Show>
                                  <For each={item().files ?? []}>
                                    {(file) => <FileCard file={file} />}
                                  </For>
                                </>
                              ) : (
                                <>
                                  <div class="content">{item().content}</div>
                                  <FileAttachmentList files={item().files} />
                                </>
                              )}
                              <div class="message-time">
                                {formatTimestamp(item().timestamp)}
                                <Show when={simpleCopyReplies().get(row())}>
                                  {(texts) => <CopyButton label="Copy reply" copy={() => writeReplyClipboard(formatReplyClipboard(texts()))} />}
                                </Show>
                              </div>
                            </div>
                          )}
                        </Show>
                        <Show
                          when={
                            segment().endIndex === compactStatusAnchorIndex()
                          }
                        >
                          <CompactStatusView
                            status={compactStatusForCurrentSession()}
                          />
                        </Show>
                      </>
                    );
                  }}
                />
              )}
            </Index>
          </Show>

          <Show when={viewMode() === "full"}>
            <Index each={fullDisplaySegments()}>
              {(segment) => (
                <>
                <SegmentView
                  segment={segment()}
                  activity={(items) => (
                    <ActivityGroup
                      items={items().map(
                        (row) =>
                          (row as Extract<FullDisplayRow, { kind: "activity" }>)
                            .item
                      )}
                    />
                  )}
                  message={(row) => (
                    <Switch>
                      <Match when={row().kind === "assistant-content"}>
                        {(() => {
                          const assistantRow = () =>
                            row() as Extract<
                              FullDisplayRow,
                              { kind: "assistant-content" }
                            >;
                          return (
                            <div class="message assistant full-message" classList={{ "system-message": !!assistantRow().meta?.failure }}>
                              <Show
                                when={assistantRow().block.type === "text"}
                                fallback={
                                  <FileCard
                                    file={assistantRow().block as FileBlock}
                                  />
                                }
                              >
                                <AssistantText class="block-text markdown-content" text={(
                                      assistantRow().block as {
                                        type: "text";
                                        text: string;
                                      }
                                    ).text} options={{ copyCode: true }} />
                              </Show>
                              <Show when={assistantRow().footer}>
                                {assistantRow().meta && (
                                  <ModelMetaDisplay
                                    meta={assistantRow().meta!}
                                  />
                                )}
                                <div class="message-time">
                                  {formatTimestamp(assistantRow().timestamp)}
                                  <Show when={fullCopyReplies().get(assistantRow().block)}>
                                    {(texts) => <CopyButton label="Copy reply" copy={() => writeReplyClipboard(formatReplyClipboard(texts()))} />}
                                  </Show>
                                </div>
                              </Show>
                            </div>
                          );
                        })()}
                      </Match>
                      <Match when={row().kind === "message"}>
                        {(() => {
                          const msg = () =>
                            (
                              row() as Extract<
                                FullDisplayRow,
                                { kind: "message" }
                              >
                            ).message;
                          return (
                            <>
                              <Show when={msg().role === "user"}>
                                <div class="message user">
                                  <Show when={userText(msg())}>
                                    <div class="content">{userText(msg())}</div>
                                  </Show>
                                  <FileAttachmentList
                                    files={msg().content.filter(
                                      (b): b is FileBlock => b.type === "file"
                                    )}
                                  />
                                  <div class="message-time">
                                    {formatTimestamp(msg().timestamp)}
                                  </div>
                                </div>
                              </Show>
                              <Show when={compactSummary(msg()) !== undefined}>
                                <CompactionSummary text={compactSummary(msg())!} timestamp={msg().timestamp} />
                              </Show>
                              <Show when={msg().role === "system" && compactSummary(msg()) === undefined}>
                                <div class="message assistant full-message system-message">
                                  <ContentBlocks
                                    blocks={msg().content}
                                    timestamp={msg().timestamp}
                                    toolResultsMap={toolResultsMap()}
                                  />
                                  <div class="message-time">
                                    {formatTimestamp(msg().timestamp)}
                                  </div>
                                </div>
                              </Show>
                            </>
                          );
                        })()}
                      </Match>
                    </Switch>
                  )}
                />
                <Show when={segment().endIndex === compactStatusAnchorIndex()}>
                  <CompactStatusView status={compactStatusForCurrentSession()} />
                </Show>
                </>
              )}
            </Index>
          </Show>

          {/* Streaming content in full mode - show blocks incrementally */}
          <Show
            when={
              viewMode() === "full" &&
              (isStreaming() || streamingFinished()) &&
              (streamingBlocks().length > 0 ||
                streamingText() ||
                streamingFiles().length > 0)
            }
          >
            <div
              class="message assistant full-message"
              classList={{ streaming: isStreaming() }}
            >
              <div class="content-blocks">
                <Index
                  each={groupActivityItems(
                    streamingBlocks(),
                    (block) =>
                      block.type === "thinking" || block.type === "toolCall"
                  )}
                >
                  {(segmentAccessor) => {
                    const segment = () => segmentAccessor();
                    return (
                      <SegmentView
                        segment={segment()}
                        activity={() => (
                          <ActivityGroup
                            streaming={isStreaming()}
                            working={
                              isStreaming() &&
                              segment().endIndex ===
                                streamingBlocks().length - 1
                            }
                            items={streamingActivityItems<
                              StreamingBlock,
                              FullToolResultMessage
                            >(
                              streamingBlocks(),
                              segment() as ActivitySegment<StreamingBlock> & {
                                kind: "activity";
                              },
                              isStreaming(),
                              true
                            )}
                          />
                        )}
                        message={() => {
                          const block = () => messageItem(segment());
                          return (
                            <Switch>
                              <Match when={block()?.type === "text"}>
                                <AssistantText class="block-text markdown-content" text={(block() as { text: string }).text} options={{ copyCode: true }} />
                              </Match>
                              <Match when={block()?.type === "file"}>
                                <FileCard file={block() as FileBlock} />
                              </Match>
                            </Switch>
                          );
                        }}
                      />
                    );
                  }}
                </Index>
              </div>
              <Show
                when={
                  streamingStartedAt() &&
                  streamingBlocks().some(
                    (block) => block.type === "text" || block.type === "file"
                  )
                }
              >
                <div class="message-time">
                  {formatTimestamp(streamingStartedAt()!)}
                </div>
              </Show>
            </div>
          </Show>

          {/* Streaming content in simple mode */}
          <Show
            when={
              viewMode() === "simple" &&
              isStreaming() &&
              (streamingBlocks().length > 0 ||
                streamingText() ||
                streamingFiles().length > 0)
            }
          >
            <div class="simple-stream-blocks">
              <Show when={streamingBlocks().length === 0 && streamingText()}>
                <div class="message assistant streaming">
                  <AssistantText class="content markdown-content" text={streamingText()} options={{ copyCode: true }} />
                  {(streamingTextAt() || streamingStartedAt()) && (
                    <div class="message-time">
                      {formatTimestamp(
                        (streamingTextAt() ?? streamingStartedAt()) as number
                      )}
                    </div>
                  )}
                </div>
              </Show>
              <Index
                each={groupActivityItems(
                  streamingBlocks(),
                  (block) =>
                    block.type === "thinking" || block.type === "toolCall"
                )}
              >
                {(segmentAccessor) => {
                  const segment = () => segmentAccessor();
                  return (
                    <SegmentView
                      segment={segment()}
                      activity={() => (
                        <ActivityGroup
                          simple
                          streaming={isStreaming()}
                          working={
                            isStreaming() &&
                            segment().endIndex === streamingBlocks().length - 1
                          }
                          items={streamingActivityItems<
                            StreamingBlock,
                            FullToolResultMessage
                          >(
                            streamingBlocks(),
                            segment() as ActivitySegment<StreamingBlock> & {
                              kind: "activity";
                            },
                            isStreaming(),
                            false
                          )}
                        />
                      )}
                      message={() => {
                        const block = () => messageItem(segment());
                        return (
                          <Switch>
                            <Match when={block()?.type === "text"}>
                              <div class="message assistant streaming">
                                <AssistantText class="content markdown-content" text={(block() as { text: string }).text} options={{ copyCode: true }} />
                                <div class="message-time">
                                  {formatTimestamp(block()!.timestamp)}
                                </div>
                              </div>
                            </Match>
                            <Match when={block()?.type === "file"}>
                              <div class="message assistant">
                                <FileCard file={block() as FileBlock} />
                                <div class="message-time">
                                  {formatTimestamp(block()!.timestamp)}
                                </div>
                              </div>
                            </Match>
                          </Switch>
                        );
                      }}
                    />
                  );
                }}
              </Index>
              <Show when={streamingBlocks().length === 0}>
                <For each={streamingFiles()}>
                  {(file) => <FileCard file={file} />}
                </For>
              </Show>
            </div>
          </Show>

        {/* Thinking dots when waiting (nothing received yet) */}
        {isStreaming() &&
          !streamingThinking() &&
          streamingToolCalls().length === 0 &&
          !streamingText() &&
          streamingFiles().length === 0 && (
            <div class="message assistant thinking">
              <div class="thinking-dots">
                <span />
                <span />
                <span />
              </div>
              {streamingStartedAt() && (
                <div class="message-time">
                  {formatTimestamp(streamingStartedAt()!)}
                </div>
              )}
            </div>
          )}

        <Show
          when={
            viewMode() === "simple" &&
            activeTools().length > 0 &&
            streamingBlocks().length === 0
          }
        >
          <ActiveToolIndicator tools={activeTools()} />
        </Show>

        <Show when={showInterrupted()}>
          <div class="message interrupted">
            <div class="content">Interrupted</div>
          </div>
        </Show>

        <Show when={compactStatusAnchorIndex() === null}>
          <CompactStatusView status={compactStatusForCurrentSession()} />
        </Show>

        <div data-scroll-anchor />
        </div>

        <div class="composer-zone">
        <Show when={isFileDragActive()}>
        <div class="drop-banner">{fileDropHint()}</div>
      </Show>
      <Show when={uploadError()}>
        {(error) => <div class="upload-error">{error()}</div>}
      </Show>
      <Show when={pendingFiles().length > 0}>
        <div class="pending-attachments">
          <For each={pendingFiles()}>
            {(item) => (
              <div class="attachment-pill">
                <Show when={item.previewUrl}>
                  {(url) => <img class="attachment-thumb" src={url()} alt="" />}
                </Show>
                <span class="attachment-name" title={item.name}>
                  {item.name}
                </span>
                <button
                  type="button"
                  class="attachment-remove"
                  aria-label={`Remove ${item.name}`}
                  disabled={uploadingFiles()}
                  onClick={() => removePendingFile(item.id)}
                >
                  x
                </button>
              </div>
            )}
          </For>
          <Show when={uploadingFiles()}>
            <span class="uploading-label">Uploading...</span>
          </Show>
        </div>
      </Show>

      <div class="input-area" classList={{ "drop-active": isFileDragActive() }}>
        <input
          ref={fileInputRef}
          class="file-input"
          type="file"
          accept={FILE_INPUT_ACCEPT}
          multiple
          onChange={(e) => {
            if (isStreaming() || impersonationStatus()?.active) return;
            const files = e.currentTarget.files;
            if (!files || files.length === 0) return;
            addPendingFiles(files);
            e.currentTarget.value = "";
          }}
        />
        <div
          class="input-pill"
          classList={{
            "drop-target":
              isFileDragActive() && activeDropZone() === "composer",
          }}
        >
          <Show when={isFileDragActive() && activeDropZone() === "composer"}>
            <div class="input-drop-hint">Drop files to attach</div>
          </Show>
        <button
          type="button"
          class="pill-btn attach-btn"
          classList={{
            "drop-target": isFileDragActive() && activeDropZone() === "attach",
          }}
          aria-label="Attach files"
          disabled={
            loading() ||
            uploadingFiles() ||
            isStreaming() ||
            impersonationStatus()?.active
          }
          onClick={() => fileInputRef?.click()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="currentColor"
              d="M16.5 6.5v9.1a4.5 4.5 0 0 1-9 0V6.3a3.3 3.3 0 0 1 6.6 0v8.8a2.1 2.1 0 1 1-4.2 0V7.2h1.6v7.9a.5.5 0 1 0 1 0V6.3a1.7 1.7 0 0 0-3.4 0v9.3a2.9 2.9 0 0 0 5.8 0V6.5h1.6z"
            />
          </svg>
        </button>
          <textarea
            ref={textareaRef}
            class="input"
            data-tour="composer"
            placeholder={
              impersonationStatus()?.active
                ? "Read-only — exit impersonation to send."
                : "Message..."
            }
            value={input()}
            disabled={impersonationStatus()?.active}
            onInput={(e) => {
              setInput(e.currentTarget.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          <Show
            when={isStreaming()}
          fallback={
            <button
              class="pill-btn send-btn"
              data-tour="send"
              onClick={handleSend}
              disabled={
                impersonationStatus()?.active ||
                (!input().trim() && pendingFiles().length === 0) ||
                loading() ||
                uploadingFiles() ||
                compactStatusForCurrentSession()?.state === "running"
              }
              aria-label="Send message"
            >
              <svg
                class="send-icon"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
              >
                <path
                  d="M5 12h14M12 5l7 7-7 7"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          }
        >
          <button
            class="pill-btn stop-btn"
            classList={{ stopping: stopping() }}
            disabled={stopping()}
            onClick={handleStop}
            aria-label="Stop agent"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        </Show>
        </div>
        <Show when={impersonationStatus()?.active}>
          <div class="readonly-impersonation-hint">
            Read-only — exit impersonation to send.
          </div>
        </Show>
        </div>

        <div
          class="suggestion-slot hero-collapsible"
          classList={{ gone: heroGone() }}
        >
          <Show when={(suggestions() ?? []).length > 0}>
            <SuggestionCards
              suggestions={suggestions() ?? []}
              onSelect={prefillSuggestion}
            />
          </Show>
          <Show when={suggestions.state === "ready" && (suggestions() ?? []).length === 0}>
            <div class="hero-no-suggestions">
              No prompt suggestions configured for this agent.
            </div>
          </Show>
        </div>
        </div>

        <div class="hero-spacer hero-spacer-bottom" />
      </div>

      <Show when={contextUsageDisplay()}>
        {(display) => (
          <div
            class="context-usage"
            classList={{
              unavailable: display().unavailable,
              danger: isContextUsageDanger(),
            }}
          >
            {display().text}
          </div>
        )}
      </Show>
      <Show when={contextWarning()}>
        {(warning) => <div class="context-warning">{warning()}</div>}
      </Show>

      <style>{chatViewStyles}</style>
    </div>
  );
}
