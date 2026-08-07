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
} from "solid-js";

import { useParams, useNavigate, useSearchParams, A } from "@solidjs/router";
import {
  streamMessage,
  uploadFiles,
  getSessionKey,
  fetchFullHistory,
  fetchAgent,
  fetchAgentSuggestions,
  subscribeToSession,
  subscribeToRealtime,
  postAbort,
  postCompact,
  type DoneMeta,
} from "../api";
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
import { renderMarkdown } from "../lib/markdown";
import {
  capabilities,
  isExtensionEnabled,
  loadCapabilities,
} from "../lib/capabilities";
import { getMaxContextTokens } from "@yoplai/shared/model-context";
import {
  attachmentToFileBlock,
  FILE_INPUT_ACCEPT,
  formatFileSize,
} from "../lib/attachments";
import { createChatAttachmentRuntime } from "../lib/chat-runtime";
import { impersonationStatus } from "./ImpersonationBanner";
import { SuggestionCards } from "./SuggestionCards";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

// Threshold for auto-collapsing content
const COLLAPSE_THRESHOLD = 200;
type DropZone = "history" | "composer" | "attach";

type SimpleToolMessage = {
  id: string;
  role: "tool";
  toolName: string;
  timestamp: number;
};

type SimpleThinkingMessage = {
  id: string;
  role: "thinking";
  content: string;
  timestamp: number;
};

type SimpleViewMessage = Message | SimpleToolMessage | SimpleThinkingMessage;

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
      name: string;
      arguments: unknown;
      status: "running" | "done" | "error";
      timestamp: number;
      result?: FullToolResultMessage;
    }
  | (FileBlock & { timestamp: number });

type CompactStatus = {
  state: "running" | "done" | "error";
  text: string;
};

function isLongContent(content: string): boolean {
  return content.length > COLLAPSE_THRESHOLD;
}

function getFileIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "IMG";
  if (mimeType === "application/pdf") return "PDF";
  if (mimeType.includes("word")) return "DOC";
  if (mimeType.includes("excel") || mimeType.includes("spreadsheet"))
    return "XLS";
  if (mimeType === "text/csv") return "CSV";
  if (mimeType === "text/markdown") return "MD";
  return "FILE";
}

function formatJson(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

// Collapsible block component
function CollapsibleBlock(props: {
  title: string;
  content: string;
  defaultCollapsed?: boolean;
  isError?: boolean;
  mono?: boolean;
  timestamp?: number;
}) {
  const shouldCollapse = props.defaultCollapsed ?? isLongContent(props.content);
  const [collapsed, setCollapsed] = createSignal(shouldCollapse);

  return (
    <div class={`collapsible-block ${props.isError ? "error" : ""}`}>
      <button
        class="collapse-header"
        onClick={() => setCollapsed(!collapsed())}
      >
        <span class="collapse-icon">{collapsed() ? "▶" : "▼"}</span>
        <span class="collapse-title">{props.title}</span>
        {collapsed() && (
          <span class="collapse-hint">{props.content.slice(0, 50)}...</span>
        )}
      </button>
      <Show when={!collapsed()}>
        <div class={`collapse-content ${props.mono ? "mono" : ""}`}>
          {props.content}
        </div>
      </Show>
      {props.timestamp && (
        <div class="block-time">{formatTimestamp(props.timestamp)}</div>
      )}
    </div>
  );
}

function getToolResultText(result?: FullToolResultMessage): string {
  return (result?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => extractBlockText((b as { text: unknown }).text))
    .join("\n");
}

function getToolInputSummary(toolName: string, args: unknown): string {
  if (args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
    if (typeof record.path === "string") {
      return record.path.split("/").filter(Boolean).at(-1) ?? record.path;
    }
    if (typeof record.pattern === "string") return record.pattern;
    if (typeof record.query === "string") return record.query;
  }
  return toolName;
}

function truncateInline(value: string, max = 96): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > max
    ? `${singleLine.slice(0, Math.max(0, max - 1))}…`
    : singleLine;
}

function ToolBlock(props: {
  name: string;
  arguments: unknown;
  result?: FullToolResultMessage;
  status?: "running" | "done" | "error";
}) {
  const argsText = () => formatJson(props.arguments);
  const resultText = () => getToolResultText(props.result);
  const failed = () => props.status === "error" || props.result?.isError;
  const summary = () =>
    truncateInline(getToolInputSummary(props.name, props.arguments));
  const preview = () => truncateInline(resultText() || argsText(), 120);
  const [collapsed, setCollapsed] = createSignal(Boolean(props.result));
  const [autoCollapsed, setAutoCollapsed] = createSignal(Boolean(props.result));

  createEffect(() => {
    if (props.result && !autoCollapsed()) {
      setCollapsed(true);
      setAutoCollapsed(true);
    }
  });

  return (
    <div class={`tool-block ${failed() ? "error" : ""}`}>
      <button class="tool-header" onClick={() => setCollapsed(!collapsed())}>
        <span class="collapse-icon">{collapsed() ? "▶" : "▼"}</span>
        <span class="tool-kind">{props.name}</span>
        <span class="tool-title">{summary()}</span>
        <Show when={collapsed()}>
          <span class="tool-preview">{preview()}</span>
        </Show>
      </button>
      <Show when={!collapsed()}>
        <div class="tool-body">
          <Show
            when={props.name === "bash"}
            fallback={
              <>
                <div class="tool-section-label">Input</div>
                <pre class="tool-code">{argsText()}</pre>
                <Show when={props.result}>
                  <div class="tool-section-label">Output</div>
                  <pre class="tool-code">{resultText() || "(no output)"}</pre>
                </Show>
              </>
            }
          >
            <div class="tool-section-label">Shell</div>
            <pre class="tool-code">
              {`$ ${getToolInputSummary(props.name, props.arguments)}${
                props.result ? `\n\n${resultText() || "(no output)"}` : ""
              }`}
            </pre>
          </Show>
          <Show when={props.result?.details?.diff}>
            <div class="tool-section-label">Diff</div>
            <pre class="tool-code">{props.result!.details!.diff}</pre>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function SimpleToolBlock(props: { name: string }) {
  return (
    <div class="tool-block simple-tool-block">
      <div class="tool-header simple-tool-header">
        <span class="tool-title">Called tool:</span>
        <span class="tool-kind">{props.name}</span>
      </div>
    </div>
  );
}

function fullMessagesToSimpleView(
  messages: FullHistoryMessage[]
): SimpleViewMessage[] {
  const simple: SimpleViewMessage[] = [];
  for (const message of messages) {
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
      if (block.type === "text" && block.text.trim()) {
        simple.push({
          id: crypto.randomUUID(),
          role: "assistant",
          content: block.text,
          timestamp: message.timestamp,
        });
      } else if (block.type === "thinking" && block.thinking.trim()) {
        simple.push({
          id: crypto.randomUUID(),
          role: "thinking",
          content: block.thinking,
          timestamp: message.timestamp,
        });
      } else if (block.type === "toolCall") {
        simple.push({
          id: crypto.randomUUID(),
          role: "tool",
          toolName: block.name,
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

// Render content blocks for full mode
function ContentBlocks(props: {
  blocks: ContentBlock[];
  timestamp?: number;
  toolResultsMap?: Map<string, FullToolResultMessage>;
}) {
  return (
    <div class="content-blocks">
      <For each={props.blocks}>
        {(block) => {
          if (block.type === "text") {
            return (
              <div
                class="block-text markdown-content"
                innerHTML={renderMarkdown(block.text)}
              />
            );
          }
          if (block.type === "thinking") {
            return (
              <CollapsibleBlock
                title="Thinking"
                content={block.thinking}
                defaultCollapsed={true}
                timestamp={props.timestamp}
              />
            );
          }
          if (block.type === "toolCall") {
            const result = props.toolResultsMap?.get(block.id);
            return (
              <ToolBlock
                name={block.name}
                arguments={block.arguments}
                result={result}
              />
            );
          }
          if (block.type === "file") {
            return <FileCard file={block} />;
          }
          return null;
        }}
      </For>
    </div>
  );
}

function FileAttachmentList(props: { files?: FileBlock[] }) {
  return (
    <Show when={props.files && props.files.length > 0}>
      <div class="message-files">
        <For each={props.files ?? []}>
          {(file) => (
            <div class="message-file-pill">
              <span class="file-icon">{getFileIcon(file.mimeType)}</span>
              <span class="file-name" title={file.filename}>
                {file.filename}
              </span>
              <Show when={formatFileSize(file.size)}>
                {(size) => <span class="file-size">{size()}</span>}
              </Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

function FileCard(props: { file: FileBlock }) {
  const href = () => `/api/media/download/${props.file.fileId}`;
  return (
    <div class={`file-card ${props.file.direction}`}>
      <span class="file-icon">{getFileIcon(props.file.mimeType)}</span>
      <div class="file-card-body">
        <div class="file-card-name" title={props.file.filename}>
          {props.file.filename}
        </div>
        <div class="file-card-meta">
          {[props.file.mimeType, formatFileSize(props.file.size)]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <Show when={props.file.direction === "outbound"}>
        <a class="file-download" href={href()} download="">
          Download
        </a>
      </Show>
    </div>
  );
}

// Model meta display
function ModelMetaDisplay(props: { meta: ModelMeta }) {
  const usage = props.meta.usage;
  const cacheTokens =
    usage &&
    (typeof usage.cacheRead === "number" ? usage.cacheRead : 0) +
      (typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0);
  return (
    <div class="model-meta">
      <span class="meta-model">{props.meta.model ?? "unknown"}</span>
      {usage && (
        <span class="meta-tokens">
          {usage.input}
          {cacheTokens ? `+${cacheTokens} cache` : ""}→{usage.output} tok
        </span>
      )}
    </div>
  );
}

// Active tool indicator during streaming
function ActiveToolIndicator(props: { tools: ActiveToolCall[] }) {
  return (
    <div class="active-tools">
      <For each={props.tools}>
        {(tool) => (
          <div class={`active-tool ${tool.status}`}>
            <span class="tool-icon">
              {tool.status === "running"
                ? "⟳"
                : tool.status === "error"
                  ? "✗"
                  : "✓"}
            </span>
            <span class="tool-name">{tool.toolName}</span>
          </div>
        )}
      </For>
    </div>
  );
}

export function ChatView() {
  const params = useParams<{ agentId: string; view?: string }>();
  const navigate = useNavigate();
  const [agent] = createResource(() => params.agentId, fetchAgent);

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

  let chatViewRef: HTMLDivElement | undefined;
  let messagesContainerRef: HTMLDivElement | undefined;
  let textareaRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let cleanup: (() => void) | null = null;
  let subscriptionCleanup: (() => void) | null = null;
  let aborted = false;
  let skipNextHistoryRefresh = false;
  let fileDragDepth = 0;
  const noAnimIds = new Set<string>();
  const noAnimFullMessageKeys = new Set<string>();

  const [searchParams] = useSearchParams();
  const sessionKey = () => getSessionKey(params.agentId);
  const explicitSessionId = () =>
    typeof searchParams.session === "string" && searchParams.session.trim()
      ? searchParams.session
      : undefined;
  const [suggestions] = createResource(
    () => [params.agentId, explicitSessionId()] as const,
    ([agentId]) => fetchAgentSuggestions(agentId)
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

  const isCompactSummaryMessage = (message: FullHistoryMessage) =>
    message.role === "system" &&
    message.content.some(
      (block) =>
        block.type === "text" &&
        block.text.startsWith("[COMPACTED CONTEXT SUMMARY]")
    );

  const visibleFullMessages = createMemo(() =>
    fullMessages().filter((message) => !isCompactSummaryMessage(message))
  );

  const fullMessageKey = (message: FullHistoryMessage) =>
    `${message.role}:${message.timestamp}:${message.content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return block.thinking;
        if (block.type === "toolCall") return `${block.id}:${block.name}`;
        return block.fileId;
      })
      .join("|")
      .slice(0, 80)}`;

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
    if (element.closest(".input-wrapper") || element.closest(".input-area")) {
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
    setLoading(true);
    if (mode === "full") {
      const res = await fetchFullHistory(
        params.agentId,
        sessionKey(),
        explicitSessionId()
      );
      const baseMessages = [...res.messages];
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
      const res = await fetchFullHistory(
        params.agentId,
        sessionKey(),
        explicitSessionId()
      );
      setContextFullMessages(res.messages);
      const base = fullMessagesToSimpleView(res.messages);
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
  };

  const refreshContextUsage = async () => {
    const res = await fetchFullHistory(
      params.agentId,
      sessionKey(),
      explicitSessionId()
    );
    setContextFullMessages(res.messages);
  };

  const compactKey = (agentId: string, key: string, sessionId?: string) =>
    `${agentId}:${key}:${sessionId ?? ""}`;

  const compactStatusForCurrentSession = () =>
    compactStatuses().get(
      compactKey(params.agentId, sessionKey(), explicitSessionId())
    );

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
        setCompactStatus(key, { state: "done", text: "Context compacted." });
        scrollToBottom(true);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to compact context";
        setCompactStatus(key, { state: "error", text: message });
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
    setIsStreaming(true);
    setStreamingStartedAt(turn.startedAt ?? Date.now());
    setStreamingThinking(turn.thinking ?? "");
    setStreamingThinkingAt(turn.thinking ? turn.startedAt : null);
    setStreamingText(turn.text ?? "");
    setStreamingTextAt(turn.text ? turn.startedAt : null);
    setStreamingToolCalls(
      (turn.toolCalls ?? []).map((tc) => ({
        id: tc.id,
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
      if (!cleanup && isStreaming()) resetStreamingState();
      return;
    }
    if (!turn) return;
    if (cleanup) return;
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
    details?: { diff?: string }
  ) => {
    const result: FullToolResultMessage = {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: content }],
      isError,
      details,
      timestamp: Date.now(),
    };
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
      if (currentAgent) void loadHistory(mode);
    })
  );

  // Subscribe to live updates for background runs
  createEffect(() => {
    const agentId = params.agentId;
    const key = sessionKey();
    if (!agentId) return;

    subscriptionCleanup?.();
    subscriptionCleanup = subscribeToSession(
      agentId,
      key,
      {
        onText: (chunk) => {
          if (cleanup) return;
          setStreamingFinished(false);
          appendStreamingTextBlock(chunk);
          setStreamingText((prev) => prev + chunk);
          if (!streamingTextAt()) setStreamingTextAt(Date.now());
          if (!streamingStartedAt()) setStreamingStartedAt(Date.now());
          setIsStreaming(true);
        },
        onThinking: (chunk) => {
          if (cleanup) return;
          setStreamingFinished(false);
          appendStreamingThinkingBlock(chunk);
          setStreamingThinking((prev) => prev + chunk);
          if (!streamingThinkingAt()) setStreamingThinkingAt(Date.now());
          if (!streamingStartedAt()) setStreamingStartedAt(Date.now());
          setIsStreaming(true);
        },
        onToolCall: (id, name, args) => {
          if (cleanup) return;
          setStreamingFinished(false);
          appendStreamingToolCallBlock(id, name, args);
          setStreamingToolCalls((prev) => {
            if (prev.some((tc) => tc.id === id)) return prev;
            return [
              ...prev,
              {
                id,
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
          if (cleanup) return;
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
          if (cleanup) return;
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
        onToolResult: (id, name, content, isError, details) => {
          if (cleanup) return;
          attachStreamingToolResult(id, name, content, isError, details);
        },
        onFileOutput: (file) => {
          if (cleanup) return;
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
          if (cleanup) return;
          if (streamingFinished()) return;
          resetStreamingState();
        },
        onActiveTurn: (turn) => {
          if (cleanup) return;
          applyActiveTurnSnapshot(turn);
        },
        onHistoryUpdated: () => {
          if (skipNextHistoryRefresh) {
            skipNextHistoryRefresh = false;
            void refreshContextUsage();
            return;
          }
          // Refetch history when background run completes. Also reconcile if
          // isStreaming is stale-true but we don't own the direct stream — the
          // history_updated signal means the backend finished and history is ready.
          if (!isStreaming() || !cleanup) {
            if (isStreaming() && !cleanup) resetStreamingState();
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
        } else if (status === "idle" && isStreaming() && !cleanup) {
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
      const path = session
        ? `${basePath}?session=${encodeURIComponent(session)}`
        : basePath;
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
  };

  const appendStreamingAssistantMessage = () => {
    const content = streamingText();
    const blocks = streamingBlocks();
    const files = streamingFiles();
    if (!content && blocks.length === 0 && files.length === 0) {
      return false;
    }

    const contentBlocks: ContentBlock[] =
      blocks.length > 0
        ? blocks.map((block) => {
            if (block.type === "toolCall") {
              return {
                type: "toolCall",
                id: block.id,
                name: block.name,
                arguments: block.arguments,
              };
            }
            if (block.type === "thinking") {
              return { type: "thinking", thinking: block.thinking };
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
                },
              ];
            }
            if (block.type === "toolCall") {
              return [
                {
                  id: crypto.randomUUID(),
                  role: "tool",
                  toolName: block.name,
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
    for (const m of simpleStreamMessages) noAnimIds.add(m.id);
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
    noAnimFullMessageKeys.add(fullMessageKey(assistantMessage));
    setFullMessages((prev) => [...prev, assistantMessage, ...toolResults]);
    return true;
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
      ...(attachments?.length ? { attachments } : {}),
      ...(levelToSend ? { thinkLevel: levelToSend } : {}),
      ...(!isResetCommand && explicitSessionId()
        ? { sessionId: explicitSessionId() }
        : {}),
    };

    const handleSessionReset = (sessionId: string) => {
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
    setSimpleMessages((prev) => [...prev, userMsg]);
    setFullMessages((prev) => [
      ...prev,
      {
        role: "user",
        content: [{ type: "text", text: messageText }, ...inboundFiles],
        timestamp: Date.now(),
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
            timestamp: Date.now(),
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
        name: string;
        arguments: unknown;
        status: "running" | "done" | "error";
        timestamp: number;
      }> = [];

      // Send queued message with minimal handlers (queue ack doesn't affect streaming state)
      const queueCleanup = streamMessage(
        params.agentId,
        messageText,
        sessionKey(),
        (chunk) => {
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
                      id: crypto.randomUUID(),
                      role: "tool",
                      toolName: block.name,
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
          const content = `Error: ${error}`;
          setSimpleMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content,
              timestamp: Date.now(),
            },
          ]);
          if (queueCleanup) queueCleanup();
        },
        {
          onThinking: (chunk) => {
            queuedThinking += chunk;
            const last = queuedBlocks.at(-1);
            if (last?.type === "thinking") {
              last.thinking += chunk;
            } else {
              queuedBlocks.push({ type: "thinking", thinking: chunk });
            }
          },
          onToolCall: (id, name, args) => {
            queuedToolCalls.push({
              id,
              name,
              arguments: args,
              status: "running",
              timestamp: Date.now(),
            });
            queuedBlocks.push({
              type: "toolCall",
              id,
              name,
              arguments: args,
            });
          },
          onToolEnd: (toolName, isError) => {
            for (const tc of queuedToolCalls) {
              if (tc.name === toolName && tc.status === "running") {
                tc.status = isError ? "error" : "done";
              }
            }
          },
          onToolResult: (id, name, content, isError, details) => {
            queuedToolResults.push({
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content: [{ type: "text", text: content }],
              isError,
              details,
              timestamp: Date.now(),
            });
          },
          onFileOutput: (file) => {
            const fileBlock: FileBlock = {
              type: "file",
              direction: "outbound",
              ...file,
            };
            queuedFiles.push(fileBlock);
            queuedBlocks.push(fileBlock);
          },
          onSessionReset: (sessionId) => {
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

    cleanup = streamMessage(
      params.agentId,
      messageText,
      sessionKey(),
      (chunk) => {
        setStreamingFinished(false);
        appendStreamingTextBlock(chunk);
        setStreamingText((prev) => prev + chunk);
        if (!streamingTextAt()) setStreamingTextAt(Date.now());
      },
      (meta?: DoneMeta) => {
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
            skipNextHistoryRefresh = true;
            setShowInterrupted(true);
            setActiveTools([]);
            setIsStreaming(false);
            setStreamingFinished(true);
            cleanup = null;
          });
          return;
        }

        if (viewMode() !== "full") {
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
          appendStreamingAssistantMessage();
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
        const content = `Error: ${error}`;
        setSimpleMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content,
            timestamp: Date.now(),
          },
        ]);
        setFullMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: [{ type: "text", text: content }],
            timestamp: Date.now(),
          },
        ]);
        resetStreamingState();
        cleanup = null;
      },
      {
        onThinking: (chunk) => {
          setStreamingFinished(false);
          appendStreamingThinkingBlock(chunk);
          setStreamingThinking((prev) => prev + chunk);
          if (!streamingThinkingAt()) setStreamingThinkingAt(Date.now());
        },
        onToolCall: (id, name, args) => {
          setStreamingFinished(false);
          appendStreamingToolCallBlock(id, name, args);
          setStreamingToolCalls((prev) => [
            ...prev,
            {
              id,
              name,
              arguments: args,
              status: "running",
              timestamp: Date.now(),
            },
          ]);
        },
        onToolStart: (toolName) => {
          setActiveTools((prev) => [
            ...prev,
            { id: crypto.randomUUID(), toolName, status: "running" },
          ]);
        },
        onToolEnd: (toolName, isError) => {
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
        onToolResult: (id, name, content, isError, details) => {
          attachStreamingToolResult(id, name, content, isError, details);
        },
        onFileOutput: (file) => {
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

  return (
    <div
      ref={chatViewRef}
      class="chat-view"
      classList={{ "drop-active": isFileDragActive() }}
    >
      <header class="header">
        <A href="/agents" class="back-btn" aria-label="Go back">
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
            <div class="agent-name">{agent()?.name ?? "Loading..."}</div>
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
        </div>
        <Show when={isExtensionEnabled("projects")}>
          <A
            class="taskboard-btn"
            href="/projects"
            aria-label="Open taskboard"
            title="Tasks (Cmd+K)"
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
        <Show when={isOAuth()}>
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
      </header>

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
        <Show
          when={
            !loading() &&
            !isStreaming() &&
            simpleMessages().length === 0 &&
            fullMessages().length === 0
          }
        >
          <SuggestionCards
            suggestions={suggestions() ?? []}
            onSelect={prefillSuggestion}
          />
        </Show>
        <Show when={viewMode() === "simple"}>
          <For each={simpleMessages()}>
            {(msg) => {
              const skipAnim = noAnimIds.delete(msg.id);
              return (
                <div class={`message ${msg.role}${skipAnim ? " no-anim" : ""}`}>
                  {msg.role === "tool" ? (
                    <SimpleToolBlock name={msg.toolName} />
                  ) : msg.role === "thinking" ? (
                    <CollapsibleBlock
                      title="Thinking"
                      content={msg.content}
                      defaultCollapsed={true}
                      timestamp={msg.timestamp}
                    />
                  ) : msg.role === "assistant" ? (
                    <>
                      <Show when={msg.content}>
                        <div
                          class="content markdown-content"
                          innerHTML={renderMarkdown(msg.content)}
                        />
                      </Show>
                      <For each={msg.files ?? []}>
                        {(file) => <FileCard file={file} />}
                      </For>
                    </>
                  ) : (
                    <>
                      <div class="content">{msg.content}</div>
                      <FileAttachmentList files={msg.files} />
                    </>
                  )}
                  <Show when={msg.role !== "tool" && msg.role !== "thinking"}>
                    <div class="message-time">
                      {formatTimestamp(msg.timestamp)}
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>

        <Show when={viewMode() === "full"}>
          <For each={visibleFullMessages()}>
            {(msg) => {
              if (msg.role === "user") {
                const textContent = msg.content
                  .filter(
                    (b): b is { type: "text"; text: string } =>
                      b.type === "text"
                  )
                  .map((b) => b.text)
                  .join("\n");
                return (
                  <div class="message user">
                    <Show when={textContent}>
                      <div class="content">{textContent}</div>
                    </Show>
                    <FileAttachmentList
                      files={msg.content.filter(
                        (b): b is FileBlock => b.type === "file"
                      )}
                    />
                    <div class="message-time">
                      {formatTimestamp(msg.timestamp)}
                    </div>
                  </div>
                );
              }
              if (msg.role === "assistant") {
                const skipAnim = noAnimFullMessageKeys.delete(
                  fullMessageKey(msg)
                );
                return (
                  <div
                    class="message assistant full-message"
                    classList={{ "no-anim": skipAnim }}
                  >
                    <ContentBlocks
                      blocks={msg.content}
                      timestamp={msg.timestamp}
                      toolResultsMap={toolResultsMap()}
                    />
                    {msg.meta && <ModelMetaDisplay meta={msg.meta} />}
                    <div class="message-time">
                      {formatTimestamp(msg.timestamp)}
                    </div>
                  </div>
                );
              }
              if (msg.role === "system") {
                return (
                  <div class="message assistant full-message system-message">
                    <ContentBlocks
                      blocks={msg.content}
                      timestamp={msg.timestamp}
                      toolResultsMap={toolResultsMap()}
                    />
                    <div class="message-time">
                      {formatTimestamp(msg.timestamp)}
                    </div>
                  </div>
                );
              }
              // Skip toolResult messages - they are now rendered inline with their tool calls
              if (msg.role === "toolResult") {
                return null;
              }
              return null;
            }}
          </For>
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
              <Index each={streamingBlocks()}>
                {(blockAccessor) => {
                  const initial = blockAccessor();
                  if (initial.type === "thinking") {
                    return (
                      <CollapsibleBlock
                        title="Thinking"
                        content={
                          (blockAccessor() as { thinking: string }).thinking
                        }
                        defaultCollapsed={false}
                        timestamp={initial.timestamp}
                      />
                    );
                  }
                  if (initial.type === "text") {
                    return (
                      <div
                        class="block-text markdown-content"
                        innerHTML={renderMarkdown(
                          (blockAccessor() as { text: string }).text
                        )}
                      />
                    );
                  }
                  if (initial.type === "toolCall") {
                    return (
                      <ToolBlock
                        name={initial.name}
                        arguments={initial.arguments}
                        result={
                          (
                            blockAccessor() as {
                              result?: FullToolResultMessage;
                            }
                          ).result
                        }
                        status={
                          (
                            blockAccessor() as {
                              status: "running" | "done" | "error";
                            }
                          ).status
                        }
                      />
                    );
                  }
                  return <FileCard file={blockAccessor() as FileBlock} />;
                }}
              </Index>
            </div>
            {streamingStartedAt() && (
              <div class="message-time">
                {formatTimestamp(streamingStartedAt()!)}
              </div>
            )}
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
                <div
                  class="content markdown-content"
                  innerHTML={renderMarkdown(streamingText())}
                />
                {(streamingTextAt() || streamingStartedAt()) && (
                  <div class="message-time">
                    {formatTimestamp(
                      (streamingTextAt() ?? streamingStartedAt()) as number
                    )}
                  </div>
                )}
              </div>
            </Show>
            <Index each={streamingBlocks()}>
              {(blockAccessor) => {
                const initial = blockAccessor();
                if (initial.type === "text") {
                  return (
                    <div class="message assistant streaming">
                      <div
                        class="content markdown-content"
                        innerHTML={renderMarkdown(
                          (blockAccessor() as { text: string }).text
                        )}
                      />
                      <div class="message-time">
                        {formatTimestamp(initial.timestamp)}
                      </div>
                    </div>
                  );
                }
                if (initial.type === "thinking") {
                  return (
                    <div class="message thinking streaming">
                      <CollapsibleBlock
                        title="Thinking"
                        content={
                          (blockAccessor() as { thinking: string }).thinking
                        }
                        defaultCollapsed={false}
                        timestamp={initial.timestamp}
                      />
                    </div>
                  );
                }
                if (initial.type === "toolCall") {
                  return (
                    <div class="message tool">
                      <SimpleToolBlock name={initial.name} />
                    </div>
                  );
                }
                if (initial.type === "file") {
                  return (
                    <div class="message assistant">
                      <FileCard file={initial} />
                      <div class="message-time">
                        {formatTimestamp(initial.timestamp)}
                      </div>
                    </div>
                  );
                }
                return null;
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

        <Show when={compactStatusForCurrentSession()}>
          {(status) => (
            <div class={`message compact-status ${status().state}`}>
              <div class="content">{status().text}</div>
            </div>
          )}
        </Show>

        <div data-scroll-anchor />
      </div>

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
        <button
          type="button"
          class="attach-btn"
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
        <div
          class="input-wrapper"
          classList={{
            "drop-target":
              isFileDragActive() && activeDropZone() === "composer",
          }}
        >
          <Show when={isFileDragActive() && activeDropZone() === "composer"}>
            <div class="input-drop-hint">Drop files to attach</div>
          </Show>
          <textarea
            ref={textareaRef}
            class="input"
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
        </div>
        <Show when={impersonationStatus()?.active}>
          <div class="readonly-impersonation-hint">
            Read-only — exit impersonation to send.
          </div>
        </Show>
        <Show
          when={isStreaming()}
          fallback={
            <button
              class="send-btn"
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
            class="stop-btn"
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

      <style>{`
        .chat-view {
          --accent: #2563eb;
          --accent-soft: color-mix(in srgb, var(--accent) 11%, transparent);
          --accent-glow: color-mix(in srgb, var(--accent) 18%, transparent);
          --drop-surface: color-mix(in srgb, var(--accent) 8%, transparent);
          --drop-border: color-mix(in srgb, var(--accent) 34%, transparent);
          --surface-0: var(--bg-base);
          --surface-1: color-mix(in srgb, var(--bg-surface) 88%, var(--bg-base));
          --surface-2: var(--border-default);
          --surface-3: color-mix(in srgb, var(--bg-raised) 72%, var(--bg-base));
          --transcript-width: 1120px;
          --user-bg: color-mix(in srgb, var(--accent) 10%, var(--bg-surface));
          --tool-bg: color-mix(in srgb, var(--text-primary) 5%, var(--bg-surface));
          --tool-border: color-mix(in srgb, var(--text-primary) 9%, transparent);
          --error: #ef4444;
          --success: #22c55e;
          --radius-sm: 10px;
          --radius-md: 18px;
          --radius-lg: 28px;

          height: 100%;
          display: flex;
          flex-direction: column;
          background: var(--surface-0);
          font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
        }

        .chat-view.drop-active {
          box-shadow: inset 0 0 0 1px var(--drop-border);
        }

        .header {
          display: flex;
          align-items: center;
          padding: 14px max(18px, calc((100% - var(--transcript-width)) / 2 + 18px));
          gap: 12px;
          background: color-mix(in srgb, var(--surface-0) 86%, transparent);
          border-bottom: 1px solid color-mix(in srgb, var(--surface-2) 70%, transparent);
          backdrop-filter: blur(18px);
          position: sticky;
          top: 0;
          z-index: 10;
        }

        .back-btn,
        .taskboard-btn {
          width: 38px;
          height: 38px;
          border-radius: var(--radius-sm);
          background: transparent;
          border: 1px solid transparent;
          color: var(--text-secondary);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
          text-decoration: none;
        }

        .back-btn:hover,
        .taskboard-btn:hover {
          background: var(--surface-1);
          border-color: var(--surface-2);
          color: var(--text-primary);
        }

        .back-btn:focus-visible,
        .taskboard-btn:focus-visible,
        .toggle-btn:focus-visible,
        .attach-btn:focus-visible,
        .send-btn:focus-visible,
        .stop-btn:focus-visible,
        .attachment-remove:focus-visible,
        .file-download:focus-visible,
        .collapse-header:focus-visible,
        .tool-header:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }

        .agent-info {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 1;
          min-width: 0;
        }

        .agent-info-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .agent-avatar {
          width: 36px;
          height: 36px;
          border-radius: 12px;
          background: var(--surface-1);
          border: 1px solid color-mix(in srgb, var(--surface-2) 72%, transparent);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          overflow: hidden;
        }

        .avatar-emoji {
          font-size: 20px;
          line-height: 1;
        }

        .avatar-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .agent-description-sep {
          color: var(--text-muted);
          margin: 0 2px;
        }

        .agent-description-inline {
          font-size: 12px;
          color: var(--text-muted);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .agent-name {
          font-size: 15px;
          font-weight: 600;
          letter-spacing: -0.01em;
          color: var(--text-primary);
        }

        .agent-status {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .status-dot {
          width: 6px;
          height: 6px;
          background: color-mix(in srgb, var(--success) 78%, var(--text-muted));
          border-radius: 50%;
        }

        .status-dot.active {
          background: var(--accent);
          animation: pulse-dot 2s ease-in-out infinite;
        }

        @keyframes pulse-dot {
          50% { opacity: 0.5; }
        }

        .status-text {
          font-size: 12px;
          color: var(--text-muted);
        }

        .think-dropdown {
          background: transparent;
          color: var(--text-primary);
          border: 1px solid color-mix(in srgb, var(--surface-2) 70%, transparent);
          border-radius: var(--radius-sm);
          padding: 7px 10px;
          font-size: 12px;
          cursor: pointer;
          outline: none;
        }

        .think-dropdown:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-glow);
        }

        .suggestion-cards {
          display: grid;
          gap: 10px;
          width: min(100%, 440px);
          margin: auto;
          padding: 48px 18px;
        }

        .suggestion-cards-lead {
          margin: 0 0 4px;
          font-size: 16px;
          font-style: italic;
          color: var(--text-tertiary);
          text-align: center;
        }

        .suggestion-card {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          color: var(--text-primary);
          font: inherit;
          text-align: left;
          cursor: pointer;
          background: var(--surface-1);
          border: 1px solid var(--surface-2);
          border-radius: var(--radius-sm);
        }

        .suggestion-card:hover,
        .suggestion-card:focus-visible {
          border-color: var(--accent);
          outline: none;
        }

        .suggestion-card-icon {
          color: var(--text-tertiary);
          font-size: 12px;
          transition: color 0.15s ease-out, transform 0.15s ease-out;
        }

        .suggestion-card:hover .suggestion-card-icon,
        .suggestion-card:focus-visible .suggestion-card-icon {
          color: var(--accent);
          transform: translateX(2px);
        }

        .view-toggle {
          display: flex;
          background: color-mix(in srgb, var(--surface-1) 78%, transparent);
          border-radius: 12px;
          padding: 2px;
          border: 1px solid color-mix(in srgb, var(--surface-2) 70%, transparent);
        }

        .toggle-btn {
          padding: 6px 12px;
          border: none;
          background: transparent;
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 500;
          cursor: pointer;
          border-radius: 9px;
          transition: background 0.16s ease, color 0.16s ease;
        }

        .toggle-btn.active {
          background: var(--surface-3);
          color: var(--text-primary);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--surface-2) 70%, transparent);
        }

        .toggle-btn:hover:not(.active) {
          color: var(--text-primary);
        }

        .messages {
          position: relative;
          flex: 1;
          overflow-y: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-y;
          width: min(100%, var(--transcript-width));
          box-sizing: border-box;
          margin: 0 auto;
          padding: 36px 18px 30px;
          display: flex;
          flex-direction: column;
          gap: 22px;
          scroll-padding-block: 30px;
        }

        .messages.drop-target {
          background:
            linear-gradient(180deg, var(--drop-surface), transparent 28%),
            var(--surface-0);
          outline: 1px dashed var(--drop-border);
          outline-offset: -10px;
          border-radius: 18px;
        }

        .messages::-webkit-scrollbar {
          width: 6px;
        }

        .messages::-webkit-scrollbar-thumb {
          background: color-mix(in srgb, var(--text-primary) 12%, transparent);
          border-radius: 3px;
        }

        .message {
          max-width: min(78ch, 100%);
          padding: 0;
          border-radius: var(--radius-md);
          line-height: 1.58;
          white-space: pre-wrap;
          word-wrap: break-word;
          font-size: 16px;
          letter-spacing: -0.01em;
          animation: message-in 0.22s ease-out;
        }

        @keyframes message-in {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .message.no-anim {
          animation: none;
        }

        .message.user {
          align-self: flex-end;
          background: var(--user-bg);
          color: color-mix(in srgb, var(--accent) 78%, var(--text-primary));
          border: 1px solid color-mix(in srgb, var(--accent) 10%, var(--surface-2));
          border-radius: 22px;
          padding: 14px 18px;
        }

        .message.assistant {
          align-self: flex-start;
          background: transparent;
          color: var(--text-primary);
          border: 1px solid transparent;
        }

        .message.assistant:not(.full-message) {
          width: min(78ch, 100%);
        }

        .message.tool {
          width: min(78ch, 100%);
          max-width: min(78ch, 100%);
          align-self: flex-start;
        }

        .message.full-message {
          width: 100%;
          max-width: 100%;
        }

        .message.tool-result {
          align-self: flex-start;
          max-width: 95%;
          background: var(--tool-bg);
          border: 1px solid var(--tool-border);
          padding: 8px;
        }

        .message.tool-result.error {
          border-color: var(--error);
        }

        .message-time {
          margin-top: 8px;
          font-size: 11px;
          color: var(--text-muted);
          text-align: right;
          font-variant-numeric: tabular-nums;
        }

        .message.user .message-time {
          color: color-mix(in srgb, var(--accent) 48%, var(--text-muted));
        }

        .message.assistant .message-time {
          text-align: left;
        }

        .message-files {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 8px;
        }

        .message-file-pill,
        .file-card {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          border-radius: var(--radius-sm);
        }

        .message-file-pill {
          max-width: 260px;
          padding: 6px 8px;
          background: color-mix(in srgb, var(--accent) 12%, transparent);
          border: 1px solid color-mix(in srgb, var(--accent) 14%, transparent);
        }

        .file-icon {
          flex-shrink: 0;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0;
          color: var(--text-secondary);
        }

        .message.user .file-icon,
        .message.user .file-size,
        .message.user .file-name {
          color: color-mix(in srgb, var(--accent) 70%, var(--text-primary));
        }

        .file-name,
        .file-card-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .file-name {
          min-width: 0;
          font-size: 12px;
        }

        .file-size {
          flex-shrink: 0;
          font-size: 11px;
          color: var(--text-muted);
        }

        .file-card {
          width: min(360px, 100%);
          padding: 11px 12px;
          background: var(--tool-bg);
          border: 1px solid var(--tool-border);
          white-space: normal;
        }

        .file-card-body {
          min-width: 0;
          flex: 1;
        }

        .file-card-name {
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 600;
        }

        .file-card-meta {
          margin-top: 2px;
          color: var(--text-muted);
          font-size: 11px;
        }

        .file-download {
          flex-shrink: 0;
          padding: 6px 8px;
          border-radius: var(--radius-sm);
          background: var(--accent-soft);
          color: var(--accent);
          font-size: 12px;
          text-decoration: none;
        }

        .message.streaming .content::after,
        .message.streaming .block-text:last-child::after {
          content: "";
          display: inline-block;
          width: 2px;
          height: 1em;
          background: var(--accent);
          margin-left: 3px;
          vertical-align: -0.12em;
          animation: cursor-blink 1s step-end infinite;
        }

        @keyframes cursor-blink {
          50% { opacity: 0; }
        }

        .message.thinking {
          padding: 14px 0;
        }

        .thinking-dots {
          display: flex;
          gap: 6px;
        }

        .thinking-dots span {
          width: 8px;
          height: 8px;
          background: var(--text-muted);
          border-radius: 50%;
          animation: thinking 1.4s ease-in-out infinite;
        }

        .thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
        .thinking-dots span:nth-child(3) { animation-delay: 0.3s; }

        @keyframes thinking {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.85); }
          40% { opacity: 1; transform: scale(1); }
        }

        .collapsible-block {
          background: var(--tool-bg);
          border: 1px solid var(--tool-border);
          border-radius: 14px;
          overflow: hidden;
          margin: 2px 0;
        }

        .collapsible-block.error {
          border-color: var(--error);
        }

        .collapse-header {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 9px 14px;
          background: transparent;
          border: none;
          color: var(--text-secondary);
          font-size: 14px;
          cursor: pointer;
          text-align: left;
        }

        .collapse-header:hover {
          background: color-mix(in srgb, var(--text-primary) 4%, transparent);
        }

        .collapse-icon {
          font-size: 9px;
          color: var(--text-muted);
        }

        .collapse-title {
          font-weight: 560;
          color: var(--text-primary);
        }

        .collapse-hint {
          flex: 1;
          color: var(--text-muted);
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .collapse-content {
          padding: 12px 14px 14px;
          border-top: 1px solid color-mix(in srgb, var(--tool-border) 84%, transparent);
          font-size: 13px;
          color: var(--text-secondary);
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 300px;
          overflow-y: auto;
        }

        .collapse-content.mono {
          font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
          font-size: 12.5px;
          line-height: 1.62;
        }

        .block-time {
          padding: 0 14px 10px;
          font-size: 11px;
          color: var(--text-muted);
          text-align: left;
          font-variant-numeric: tabular-nums;
        }

        .content-blocks {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .tool-block {
          background: var(--tool-bg);
          border: 1px solid var(--tool-border);
          border-radius: 14px;
          overflow: hidden;
        }

        .tool-block.error {
          border-color: color-mix(in srgb, var(--error) 42%, var(--tool-border));
        }

        .tool-header {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          min-height: 42px;
          padding: 8px 14px;
          background: transparent;
          border: none;
          color: var(--text-secondary);
          cursor: pointer;
          text-align: left;
        }

        .tool-header:hover {
          background: color-mix(in srgb, var(--text-primary) 4%, transparent);
        }

        .simple-tool-block {
          display: inline-flex;
          max-width: 100%;
        }

        .simple-tool-header {
          width: auto;
          min-height: 34px;
          padding: 6px 11px;
          cursor: default;
        }

        .simple-tool-header:hover {
          background: transparent;
        }

        .tool-title {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-primary);
          font-size: 14px;
          font-weight: 560;
        }

        .tool-kind {
          flex-shrink: 0;
          padding: 1px 6px;
          border-radius: 999px;
          background: color-mix(in srgb, var(--text-primary) 6%, transparent);
          color: var(--text-muted);
          font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
          font-size: 11px;
          letter-spacing: 0;
        }

        .tool-preview {
          min-width: 120px;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-muted);
          font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
          font-size: 12px;
        }

        .tool-body {
          padding: 12px 14px 14px;
          border-top: 1px solid color-mix(in srgb, var(--tool-border) 84%, transparent);
        }

        .tool-section-label {
          margin-bottom: 8px;
          color: var(--text-muted);
          font-size: 12px;
          font-weight: 560;
        }

        .tool-section-label:not(:first-child) {
          margin-top: 14px;
        }

        .tool-code {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--text-secondary);
          font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
          font-size: 12.5px;
          line-height: 1.62;
        }

        .simple-stream-blocks {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .block-text {
          white-space: pre-wrap;
          max-width: 78ch;
        }

        .markdown-content {
          line-height: 1.68;
          white-space: normal;
        }

        .markdown-content > *:first-child {
          margin-top: 0;
        }

        .markdown-content > *:last-child {
          margin-bottom: 0;
        }

        .markdown-content p {
          margin: 0.5em 0;
        }

        .markdown-content code {
          background: color-mix(in srgb, var(--text-primary) 7%, transparent);
          padding: 0.08em 0.34em;
          border-radius: 6px;
          font-family: 'SF Mono', 'Cascadia Code', 'Consolas', monospace;
          font-size: 0.9em;
        }

        .markdown-content pre {
          background: var(--tool-bg);
          border: 1px solid var(--tool-border);
          border-radius: 14px;
          padding: 12px 14px;
          overflow-x: auto;
          margin: 0.7em 0;
        }

        .markdown-content pre code {
          background: none;
          padding: 0;
          font-size: 0.85em;
          line-height: 1.4;
        }

        .markdown-content ul,
        .markdown-content ol {
          margin: 0.6em 0;
          padding-left: 1.5em;
        }

        .markdown-content li {
          margin: 0.25em 0;
        }

        .markdown-content li p {
          margin: 0;
        }

        .markdown-content a {
          color: var(--accent);
          text-decoration: underline;
          text-decoration-color: color-mix(in srgb, var(--accent) 32%, transparent);
          text-underline-offset: 2px;
          transition: text-decoration-color 0.15s ease;
        }

        .markdown-content a:hover {
          text-decoration-color: var(--accent);
        }

        .markdown-content blockquote {
          border-left: 3px solid color-mix(in srgb, var(--text-primary) 12%, transparent);
          margin: 0.4em 0;
          padding-left: 0.75em;
          color: var(--text-secondary);
        }

        .markdown-content h1,
        .markdown-content h2,
        .markdown-content h3 {
          margin: 0.6em 0 0.3em 0;
          font-weight: 600;
        }

        .markdown-content table {
          width: 100%;
          display: block;
          overflow-x: auto;
          -webkit-overflow-scrolling: touch;
          border-collapse: collapse;
          margin: 0.5em 0;
          font-size: 0.9em;
        }

        .markdown-content th,
        .markdown-content td {
          padding: 8px 12px;
          text-align: left;
          border: 1px solid var(--border-default);
        }

        .markdown-content th {
          background: var(--bg-surface);
          font-weight: 600;
          color: var(--text-primary);
        }

        .markdown-content tbody tr:nth-child(even) {
          background: color-mix(in srgb, var(--text-primary) 3%, transparent);
        }

        .model-meta {
          display: flex;
          gap: 12px;
          margin-top: 12px;
          padding-top: 8px;
          border-top: 1px solid color-mix(in srgb, var(--surface-2) 70%, transparent);
          font-size: 11px;
          color: var(--text-muted);
        }

        .meta-model {
          font-weight: 500;
        }

        .active-tools {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 8px 0;
        }

        .active-tool {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          background: var(--tool-bg);
          border: 1px solid var(--tool-border);
          border-radius: var(--radius-sm);
          font-size: 12px;
          color: var(--text-secondary);
        }

        .active-tool.running .tool-icon {
          animation: spin 1s linear infinite;
          color: var(--accent);
        }

        .active-tool.done .tool-icon {
          color: var(--success);
        }

        .active-tool.error .tool-icon {
          color: var(--error);
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .input-area {
          display: flex;
          align-items: flex-end;
          flex-shrink: 0;
          gap: 10px;
          width: min(100%, var(--transcript-width));
          box-sizing: border-box;
          margin: 0 auto;
          padding: 14px 18px 22px;
          background: color-mix(in srgb, var(--surface-0) 88%, transparent);
          border-top: 1px solid color-mix(in srgb, var(--surface-2) 54%, transparent);
          backdrop-filter: blur(18px);
        }

        .input-area.drop-active {
          background:
            linear-gradient(180deg, color-mix(in srgb, var(--accent) 3%, transparent), transparent 70%),
            var(--surface-0);
        }

        .file-input {
          display: none;
        }

        .pending-attachments {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 8px;
          width: min(100%, var(--transcript-width));
          box-sizing: border-box;
          margin: 0 auto;
          padding: 10px 18px 0;
          background: var(--surface-0);
          border-top: 1px solid color-mix(in srgb, var(--surface-2) 54%, transparent);
        }

        .drop-banner {
          width: min(100%, var(--transcript-width));
          box-sizing: border-box;
          margin: 0 auto;
          padding: 10px 18px 0;
          background: var(--surface-0);
          color: var(--accent);
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.01em;
        }

        .attachment-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          max-width: 240px;
          padding: 6px 8px;
          border-radius: var(--radius-sm);
          background: var(--tool-bg);
          border: 1px solid var(--tool-border);
        }

        .attachment-thumb {
          width: 24px;
          height: 24px;
          object-fit: cover;
          border-radius: 4px;
          flex-shrink: 0;
        }

        .attachment-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 12px;
          color: var(--text-secondary);
        }

        .attachment-remove {
          width: 18px;
          height: 18px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          line-height: 1;
        }

        .attachment-remove:hover:not(:disabled) {
          background: color-mix(in srgb, var(--text-primary) 6%, transparent);
          color: var(--text-primary);
        }

        .uploading-label,
        .upload-error {
          color: var(--text-muted);
          font-size: 12px;
        }

        .upload-error {
          width: min(100%, var(--transcript-width));
          box-sizing: border-box;
          margin: 0 auto;
          padding: 8px 18px 0;
          color: var(--error);
          background: var(--surface-0);
        }

        .attach-btn {
          width: 44px;
          height: 44px;
          border-radius: var(--radius-sm);
          background: transparent;
          border: 1px solid transparent;
          color: var(--text-secondary);
          cursor: pointer;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease, transform 0.16s ease;
        }

        .attach-btn svg {
          width: 22px;
          height: 22px;
        }

        .attach-btn:hover:not(:disabled) {
          background: var(--surface-1);
          border-color: var(--surface-2);
          color: var(--text-primary);
        }

        .attach-btn.drop-target {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
          box-shadow: 0 0 0 4px var(--accent-glow);
          transform: translateY(-1px);
        }

        .attach-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .input-wrapper {
          position: relative;
          flex: 1;
          background: var(--surface-1);
          border: 1px solid color-mix(in srgb, var(--surface-2) 82%, transparent);
          border-radius: 22px;
          box-shadow: 0 12px 38px color-mix(in srgb, #000 8%, transparent);
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        .input-wrapper.drop-target {
          border-color: var(--accent);
          box-shadow: 0 0 0 4px var(--accent-glow);
          background:
            linear-gradient(180deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 70%),
            var(--surface-1);
        }

        .input-drop-hint {
          position: absolute;
          top: 8px;
          right: 14px;
          z-index: 1;
          pointer-events: none;
          color: var(--accent);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .input-wrapper:focus-within {
          border-color: color-mix(in srgb, var(--accent) 44%, var(--surface-2));
          box-shadow:
            0 0 0 3px var(--accent-glow),
            0 14px 42px color-mix(in srgb, #000 10%, transparent);
        }

        .input {
          width: 100%;
          padding: 13px 18px;
          background: transparent;
          border: none;
          color: var(--text-primary);
          font-size: 15px;
          line-height: 22px;
          resize: none;
          outline: none;
          font-family: inherit;
          overflow-y: auto;
        }

        .input::placeholder {
          color: var(--text-muted);
        }

        .input:disabled {
          opacity: 0.5;
        }

        .send-btn,
        .stop-btn {
          width: 44px;
          height: 44px;
          border-radius: 50%;
          border: 1px solid var(--surface-2);
          cursor: pointer;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: background 0.18s ease, border-color 0.18s ease, color 0.18s ease, transform 0.18s ease, box-shadow 0.18s ease;
        }

        .send-btn {
          background: var(--surface-1);
          color: var(--text-muted);
        }

        .send-btn:not(:disabled) {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
          box-shadow: 0 10px 24px var(--accent-glow);
        }

        .send-btn:not(:disabled):hover,
        .stop-btn:hover:not(:disabled) {
          transform: translateY(-1px);
        }

        .send-btn:not(:disabled):active,
        .stop-btn:active:not(:disabled) {
          transform: translateY(0);
        }

        .send-btn:disabled {
          cursor: not-allowed;
        }

        .send-icon {
          transition: transform 0.2s ease;
        }

        .send-btn:not(:disabled):hover .send-icon {
          transform: translateX(2px);
        }

        .stop-btn {
          background: #d32f2f;
          border-color: #d32f2f;
          color: #fff;
          box-shadow: 0 10px 24px rgba(211, 47, 47, 0.24);
        }

        .stop-btn:hover:not(:disabled) {
          background: #c62828;
        }

        .stop-btn.stopping {
          background: #f57c00;
          border-color: #f57c00;
          cursor: not-allowed;
        }

        .context-usage {
          width: min(100%, var(--transcript-width));
          box-sizing: border-box;
          margin: 0 auto 4px;
          text-align: left;
          color: color-mix(in srgb, var(--text-primary) 70%, var(--text-muted));
          font-size: 12px;
          font-weight: 500;
          line-height: 1.35;
          padding: 2px 18px 8px 72px;
        }

        .context-usage.unavailable {
          opacity: 0.9;
        }

        .context-usage.danger {
          color: #ef4444;
        }

        .context-warning {
          width: min(calc(100% - 36px), calc(var(--transcript-width) - 36px));
          box-sizing: border-box;
          margin: 0 auto 8px;
          padding: 8px 10px;
          border: 1px solid color-mix(in srgb, #ef4444 35%, transparent);
          border-radius: 10px;
          background: color-mix(in srgb, #ef4444 10%, transparent);
          color: #fca5a5;
          font-size: 12px;
          line-height: 1.4;
        }

        .message.interrupted {
          text-align: center;
          padding: 8px 20px;
        }

        .message.interrupted .content {
          color: var(--text-muted);
          font-size: 0.85em;
          font-style: italic;
        }

        .message.compact-status {
          text-align: center;
          padding: 8px 20px;
        }

        .message.compact-status .content {
          display: inline-flex;
          border: 1px solid var(--border-default);
          border-radius: 999px;
          padding: 5px 10px;
          color: var(--text-muted);
          font-size: 0.85em;
          background: var(--bg-surface);
        }

        .message.compact-status.error .content {
          border-color: color-mix(in srgb, #ef4444 45%, transparent);
          color: #ef4444;
        }

        @media (max-width: 720px) {
          .header {
            padding: 10px 12px;
          }

          .agent-description-inline,
          .agent-description-sep {
            display: none;
          }

          .messages {
            padding: 24px 12px 24px;
            gap: 18px;
          }

          .message {
            font-size: 15px;
          }

          .message.user {
            max-width: 92%;
            padding: 12px 14px;
          }

          .input-area {
            padding: 10px 12px 14px;
          }

          .context-usage {
            padding-left: 64px;
          }

          .attach-btn,
          .send-btn,
          .stop-btn {
            width: 42px;
            height: 42px;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .message,
          .thinking-dots span,
          .active-tool.running .tool-icon,
          .status-dot.active,
          .message.streaming .content::after,
          .message.streaming .block-text:last-child::after {
            animation: none;
          }

          .send-btn,
          .stop-btn,
          .attach-btn,
          .toggle-btn,
          .back-btn,
          .taskboard-btn,
          .send-icon {
            transition: none;
          }
        }
      `}</style>
    </div>
  );
}
