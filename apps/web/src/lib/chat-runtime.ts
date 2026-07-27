import { createMemo, createSignal } from "solid-js";
import {
  getSessionKey as defaultGetSessionKey,
  postAbort,
  streamMessage,
  type DoneMeta,
  type StreamCallbacks,
  type StreamMessageOptions,
} from "../api/chat";
import { fetchFullHistory } from "../api/agents";
import { uploadFiles } from "../api/media";
import {
  subscribeToSession,
  type SubscriptionCallbacks,
} from "../api/realtime";
import type {
  FileAttachment,
  FileBlock,
  FullHistoryMessage,
  FullToolResultMessage,
} from "../api/types";
import {
  attachmentToFileBlock,
  createPendingFile,
  isSupportedFile,
  MAX_UPLOAD_SIZE_BYTES,
  revokePendingFile,
  type PendingFile,
} from "./attachments";

export type { PendingFile };

export type ChatRuntimeBlock =
  | { type: "thinking"; content: string }
  | { type: "text"; role: "assistant"; content: string }
  | {
      type: "tool";
      id: string;
      toolName: string;
      args: unknown;
      body?: string;
      result?: FullToolResultMessage;
      status: "running" | "done" | "error";
    }
  | (FileBlock & { type: "file" });

export type QueuedChatMessage = {
  text: string;
  files?: FileBlock[];
  onDequeued?: () => void;
};

type ChatRuntimeDeps = {
  fetchFullHistory: typeof fetchFullHistory;
  getSessionKey: typeof defaultGetSessionKey;
  postAbort: typeof postAbort;
  streamMessage: typeof streamMessage;
  subscribeToSession: typeof subscribeToSession;
  uploadFiles: typeof uploadFiles;
};

type ChatAttachmentRuntimeOptions = {
  acceptFile?: (file: File) => boolean | string;
  previewImages?: boolean;
};

type SendInput = {
  agentId: string;
  text: string;
  sessionKey?: string;
  options?: StreamMessageOptions;
  queueWhileStreaming?: boolean;
  onUserMessage?: (text: string, files?: FileBlock[]) => void;
  onAssistantError?: (message: string) => void;
};

type LoadHistoryInput = {
  agentId: string;
  sessionKey?: string;
};

const defaultDeps: ChatRuntimeDeps = {
  fetchFullHistory,
  getSessionKey: defaultGetSessionKey,
  postAbort,
  streamMessage,
  subscribeToSession,
  uploadFiles,
};

function appendStreamingText(
  blocks: ChatRuntimeBlock[],
  chunk: string
): ChatRuntimeBlock[] {
  const last = blocks.at(-1);
  if (last?.type === "text" && last.role === "assistant") {
    return [...blocks.slice(0, -1), { ...last, content: last.content + chunk }];
  }
  return [...blocks, { type: "text", role: "assistant", content: chunk }];
}

function appendStreamingThinking(
  blocks: ChatRuntimeBlock[],
  chunk: string
): ChatRuntimeBlock[] {
  const last = blocks.at(-1);
  if (last?.type === "thinking") {
    return [...blocks.slice(0, -1), { ...last, content: last.content + chunk }];
  }
  return [...blocks, { type: "thinking", content: chunk }];
}

function updateToolStatus(
  blocks: ChatRuntimeBlock[],
  toolName: string,
  status: "done" | "error"
): ChatRuntimeBlock[] {
  return blocks.map((block) =>
    block.type === "tool" &&
    block.toolName === toolName &&
    block.status === "running"
      ? { ...block, status }
      : block
  );
}

function attachToolResult(
  blocks: ChatRuntimeBlock[],
  id: string,
  name: string,
  content: string,
  isError: boolean,
  details?: { diff?: string }
): ChatRuntimeBlock[] {
  const result: FullToolResultMessage = {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: content }],
    isError,
    details,
    timestamp: Date.now(),
  };
  return blocks.map((block) =>
    block.type === "tool" && block.id === id
      ? {
          ...block,
          body: content,
          result,
          status: isError ? "error" : "done",
        }
      : block
  );
}

export function createChatAttachmentRuntime(
  options: ChatAttachmentRuntimeOptions = {}
) {
  const [pendingFiles, setPendingFiles] = createSignal<PendingFile[]>([]);
  const [uploadingFiles, setUploadingFiles] = createSignal(false);
  const [uploadError, setUploadError] = createSignal("");

  const clearFiles = () => {
    setPendingFiles((prev) => {
      prev.forEach(revokePendingFile);
      return [];
    });
  };

  const attachFiles = (files: FileList | File[]) => {
    setUploadError("");
    const next: PendingFile[] = [];
    for (const file of Array.from(files)) {
      const accepted = options.acceptFile?.(file);
      if (typeof accepted === "string") {
        setUploadError(accepted);
        continue;
      }
      if (accepted === false) continue;
      if (!isSupportedFile(file)) {
        setUploadError(`Unsupported file type: ${file.name}`);
        continue;
      }
      if (file.size > MAX_UPLOAD_SIZE_BYTES) {
        setUploadError(`File exceeds 25 MB: ${file.name}`);
        continue;
      }
      if (options.previewImages === false) {
        next.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          file,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
        });
      } else {
        next.push(createPendingFile(file));
      }
    }
    if (next.length > 0) setPendingFiles((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) => {
    setPendingFiles((prev) => {
      const removed = prev.find((item) => item.id === id);
      if (removed) revokePendingFile(removed);
      return prev.filter((item) => item.id !== id);
    });
  };

  return {
    pendingFiles,
    uploadingFiles,
    uploadError,
    setUploadingFiles,
    setUploadError,
    attachFiles,
    clearFiles,
    removeFile,
  };
}

export function createChatRuntime(deps: Partial<ChatRuntimeDeps> = {}) {
  const api = { ...defaultDeps, ...deps };
  const attachments = createChatAttachmentRuntime();
  const [messages, setMessages] = createSignal<FullHistoryMessage[]>([]);
  const [streamingBlocks, setStreamingBlocks] = createSignal<
    ChatRuntimeBlock[]
  >([]);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [waitingForFirstText, setWaitingForFirstText] = createSignal(false);
  const [queuedMessages, setQueuedMessages] = createSignal<QueuedChatMessage[]>(
    []
  );
  const [error, setError] = createSignal("");

  let activeStreamCleanup: (() => void) | null = null;
  let subscriptionCleanup: (() => void) | null = null;
  let activeQueuedMessage: QueuedChatMessage | null = null;
  let historyLoadVersion = 0;

  const combinedBlocks = createMemo(() => streamingBlocks());

  const clearStreaming = () => {
    setStreamingBlocks([]);
    setWaitingForFirstText(false);
  };

  const cleanupStream = () => {
    activeStreamCleanup?.();
    activeStreamCleanup = null;
  };

  const cleanupSubscription = () => {
    subscriptionCleanup?.();
    subscriptionCleanup = null;
  };

  const reset = () => {
    cleanupStream();
    cleanupSubscription();
    clearStreaming();
    setMessages([]);
    setQueuedMessages([]);
    setIsStreaming(false);
    setError("");
    activeQueuedMessage = null;
    historyLoadVersion += 1;
  };

  const applyActiveTurn = (
    turn: NonNullable<
      Awaited<ReturnType<typeof fetchFullHistory>>["activeTurn"]
    >
  ) => {
    setIsStreaming(true);
    setWaitingForFirstText(!turn.text?.trim() && !turn.thinking?.trim());
    const blocks: ChatRuntimeBlock[] = [];
    if (turn.thinking)
      blocks.push({ type: "thinking", content: turn.thinking });
    if (turn.text) {
      blocks.push({ type: "text", role: "assistant", content: turn.text });
    }
    for (const toolCall of turn.toolCalls ?? []) {
      blocks.push({
        type: "tool",
        id: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
        status: toolCall.status,
      });
    }
    setStreamingBlocks(blocks);
  };

  const callbacks = (
    agentId: string,
    sessionKey: string,
    onDone: () => void,
    onError: (message: string) => void
  ): Partial<StreamCallbacks> & SubscriptionCallbacks => ({
    onText(chunk) {
      if (!chunk) return;
      setWaitingForFirstText(false);
      setStreamingBlocks((prev) => appendStreamingText(prev, chunk));
    },
    onThinking(chunk) {
      if (!chunk) return;
      setStreamingBlocks((prev) => appendStreamingThinking(prev, chunk));
    },
    onToolCall(id, name, args) {
      setStreamingBlocks((prev) =>
        prev.some((block) => block.type === "tool" && block.id === id)
          ? prev
          : [
              ...prev,
              { type: "tool", id, toolName: name, args, status: "running" },
            ]
      );
    },
    onToolEnd(name, isError) {
      setStreamingBlocks((prev) =>
        updateToolStatus(prev, name, isError ? "error" : "done")
      );
    },
    onToolResult(id, name, content, isError, details) {
      setStreamingBlocks((prev) =>
        attachToolResult(prev, id, name, content, isError, details)
      );
    },
    onFileOutput(file) {
      setWaitingForFirstText(false);
      setStreamingBlocks((prev) => [
        ...prev,
        { type: "file", direction: "outbound", ...file },
      ]);
    },
    onActiveTurn(turn) {
      applyActiveTurn(turn);
    },
    onDone,
    onError,
    onSessionReset() {
      clearStreaming();
      setMessages([]);
      setQueuedMessages([]);
      activeQueuedMessage = null;
    },
    onHistoryUpdated() {
      if (!isStreaming()) {
        void loadHistory({ agentId, sessionKey });
      }
    },
  });

  const subscribe = (
    agentId: string,
    sessionKey = api.getSessionKey(agentId)
  ) => {
    cleanupSubscription();
    subscriptionCleanup = api.subscribeToSession(
      agentId,
      sessionKey,
      callbacks(
        agentId,
        sessionKey,
        () => {
          cleanupSubscription();
          setIsStreaming(false);
          setWaitingForFirstText(false);
          processNextQueuedMessage(agentId, sessionKey);
        },
        (message) => {
          cleanupSubscription();
          setError(message);
          clearStreaming();
          setIsStreaming(false);
          processNextQueuedMessage(agentId, sessionKey);
        }
      )
    );
    return subscriptionCleanup;
  };

  const loadHistory = async ({
    agentId,
    sessionKey = api.getSessionKey(agentId),
  }: LoadHistoryInput) => {
    const loadVersion = ++historyLoadVersion;
    const history = await api.fetchFullHistory(agentId, sessionKey);
    if (loadVersion !== historyLoadVersion) return history;
    setMessages(history.messages);
    if (history.isStreaming && history.activeTurn && !activeStreamCleanup) {
      subscribe(agentId, sessionKey);
      applyActiveTurn(history.activeTurn);
    } else if (!history.isStreaming) {
      clearStreaming();
    }
    setIsStreaming(Boolean(history.isStreaming));
    setWaitingForFirstText(
      Boolean(history.isStreaming && !history.activeTurn?.text?.trim())
    );
    return history;
  };

  const startStream = (
    agentId: string,
    sessionKey: string,
    text: string,
    mode: "normal" | "queued",
    options?: StreamMessageOptions,
    onAssistantError?: (message: string) => void
  ) => {
    cleanupSubscription();
    cleanupStream();
    clearStreaming();
    setIsStreaming(true);
    setWaitingForFirstText(true);
    setError("");

    activeStreamCleanup = api.streamMessage(
      agentId,
      text,
      sessionKey,
      (chunk) =>
        callbacks(
          agentId,
          sessionKey,
          () => {},
          () => {}
        ).onText?.(chunk),
      (meta?: DoneMeta) => {
        cleanupStream();
        setIsStreaming(false);
        setWaitingForFirstText(false);
        if (mode === "queued") activeQueuedMessage = null;
        if (!meta?.queued) processNextQueuedMessage(agentId, sessionKey);
      },
      (message) => {
        cleanupStream();
        setError(message);
        clearStreaming();
        setIsStreaming(false);
        if (mode === "queued") activeQueuedMessage = null;
        onAssistantError?.(message);
        processNextQueuedMessage(agentId, sessionKey);
      },
      callbacks(
        agentId,
        sessionKey,
        () => {},
        (message) => {
          setError(message);
        }
      ),
      options
    );
  };

  function processNextQueuedMessage(agentId: string, sessionKey: string) {
    if (isStreaming() || activeQueuedMessage) return;
    const next = queuedMessages()[0];
    if (!next) return;
    activeQueuedMessage = next;
    setQueuedMessages((prev) => prev.slice(1));
    next.onDequeued?.();
    startStream(agentId, sessionKey, next.text, "queued");
  }

  const send = async ({
    agentId,
    text,
    sessionKey = api.getSessionKey(agentId),
    options,
    queueWhileStreaming = true,
    onUserMessage,
    onAssistantError,
  }: SendInput) => {
    const currentPendingFiles = attachments.pendingFiles();
    const hasFiles = currentPendingFiles.length > 0;
    if (!text.trim() && !hasFiles) return;
    if (isStreaming() && hasFiles) {
      attachments.setUploadError(
        "Wait for the current response before attaching files."
      );
      return;
    }

    let uploaded: FileAttachment[] | undefined;
    let inboundFiles: FileBlock[] = [];
    if (hasFiles) {
      attachments.setUploadingFiles(true);
      attachments.setUploadError("");
      try {
        uploaded = await api.uploadFiles(
          currentPendingFiles.map((p) => p.file)
        );
        inboundFiles = uploaded.map((attachment, index) =>
          attachmentToFileBlock(attachment, currentPendingFiles[index])
        );
        attachments.clearFiles();
      } catch (err) {
        attachments.setUploadError(
          err instanceof Error ? err.message : "File upload failed"
        );
        attachments.setUploadingFiles(false);
        return;
      }
      attachments.setUploadingFiles(false);
    }

    const messageText = text.trim() || "Attached file(s).";
    const sentFiles = inboundFiles.length ? inboundFiles : undefined;

    if (isStreaming() && queueWhileStreaming) {
      setQueuedMessages((prev) => [
        ...prev,
        {
          text: messageText,
          files: sentFiles,
          onDequeued: () => onUserMessage?.(messageText, sentFiles),
        },
      ]);
      return;
    }

    onUserMessage?.(messageText, sentFiles);
    startStream(
      agentId,
      sessionKey,
      messageText,
      "normal",
      uploaded?.length ? { ...options, attachments: uploaded } : options,
      onAssistantError
    );
  };

  const stop = async (
    agentId: string,
    sessionKey = api.getSessionKey(agentId)
  ) => {
    await api.postAbort(agentId, sessionKey);
    cleanupStream();
    cleanupSubscription();
    setIsStreaming(false);
    setWaitingForFirstText(false);
    activeQueuedMessage = null;
    processNextQueuedMessage(agentId, sessionKey);
  };

  return {
    messages,
    streamingBlocks: combinedBlocks,
    isStreaming,
    waitingForFirstText,
    queuedMessages,
    error,
    pendingFiles: attachments.pendingFiles,
    uploadingFiles: attachments.uploadingFiles,
    uploadError: attachments.uploadError,
    attachFiles: attachments.attachFiles,
    clearFiles: attachments.clearFiles,
    removeFile: attachments.removeFile,
    setUploadError: attachments.setUploadError,
    loadHistory,
    send,
    stop,
    subscribe,
    reset,
  };
}
