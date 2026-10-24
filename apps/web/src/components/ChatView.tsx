import { createChatSession } from "./chat/createChatSession";
import { ChatTranscript } from "./chat/ChatTranscript";
import chatViewStyles from "./chat/ChatView.css?inline";
import {
  createSignal,
  createEffect,
  createResource,
  createMemo,
  For,
  onCleanup,
  Show,
  on,
} from "solid-js";

import { useParams, useNavigate, useSearchParams, useLocation, A } from "@solidjs/router";
import { ArchivedSessionBanner } from "./ArchivedSessionBanner";
import { refreshToolLabels } from "../lib/tool-labels";
import {
  uploadFiles,
  getSessionKey,
  fetchAgent,
  fetchAgentSuggestions,
  fetchAgentSessions,
} from "../api";
import { fetchChatProject } from "../api/chat-projects";
import type {
  HistoryViewMode,
  ThinkLevel,
} from "../api/types";
import {
  capabilities,
  isExtensionEnabled,
  loadCapabilities,
} from "../lib/capabilities";
import {
  attachmentToFileBlock,
  FILE_INPUT_ACCEPT,
} from "../lib/attachments";
import { createChatAttachmentRuntime } from "../lib/chat-runtime";
import { impersonationStatus } from "./ImpersonationBanner";
import { SuggestionCards } from "./SuggestionCards";
import { showToast } from "../lib/toast";
import { MainAgentStarButton } from "./MainAgentStarButton";
import { fetchPoolActions } from "../api/teams";
import {
  notificationSoundEnabled,
  toggleNotificationSound,
} from "../lib/chat-notifications";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
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

  const currentSession = () => `${params.agentId}:${sessionKey()}:${explicitSessionId() ?? ""}`;
  const session = createChatSession({
    agentId: () => params.agentId,
    agent,
    sessionKey,
    explicitSessionId,
    viewMode,
    projectId: () => searchParams.project ? String(searchParams.project) : undefined,
    isArchived: isSessionArchived,
    uploadPending: async (currentPendingFiles) => {
      if (currentPendingFiles.length === 0) return { inboundFiles: [] };
      setUploadingFiles(true);
      setUploadError("");
      try {
        const attachments = await uploadFiles(currentPendingFiles.map((item) => item.file));
        const inboundFiles = attachments.map((attachment, index) =>
          attachmentToFileBlock(attachment, currentPendingFiles[index])
        );
        clearPendingFiles();
        setUploadingFiles(false);
        return { attachments, inboundFiles };
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : "File upload failed");
        setUploadingFiles(false);
        return "failed";
      }
    },
    onArchiveRestored: () => {
      showToast("Chat restored", "success");
      void refetchSessions();
      window.dispatchEvent(new Event("chat-projects-changed"));
    },
    onSessionReset: (sessionId) => {
      clearPendingFiles();
      navigate(`/chat/${encodeURIComponent(params.agentId)}?session=${encodeURIComponent(sessionId)}`);
    },
    preservePrependScroll: (prepend) => {
      const requestedSession = currentSession();
      const container = messagesContainerRef;
      const previousHeight = container?.scrollHeight ?? 0;
      const previousTop = container?.scrollTop ?? 0;
      setAutoScrollPinned(false);
      prepend();
      requestAnimationFrame(() => {
        if (container && requestedSession === currentSession()) {
          container.scrollTop = previousTop + container.scrollHeight - previousHeight;
        }
      });
    },
  });
  const {
    simpleMessages, fullMessages, streamingBlocks, streamingText, streamingFiles,
    activeTools, isStreaming, loading, stopping, pendingQueuedMessages,
    contextUsageDisplay, isContextUsageDanger, contextWarning, thinkingLevel,
    compactStatusForCurrentSession,
  } = session;
  let focusedHomeSession: string | null = null;
  createEffect(on(session.historyLoaded, (loaded) => {
    if (!loaded || !location.state?.mainAgentHome || loaded.sessionId || !loaded.empty || focusedHomeSession === loaded.scope) return;
    focusedHomeSession = loaded.scope;
    requestAnimationFrame(() => {
      if (loaded.scope === currentSession() && !document.querySelector('[aria-modal="true"]')) textareaRef?.focus();
    });
  }));
  createEffect(on(session.compactStatuses, () => scrollToBottom(true), { defer: true }));

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
  let fileDragDepth = 0;

  const isOAuth = () => agent()?.authMode === "oauth";

  void loadCapabilities().catch(() => undefined);

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

  const handleSend = async () => {
    session.flushFinished();

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
      await session.compact().catch(() => undefined);
      return;
    }

    const result = await session.send({ text, pendingFiles: currentPendingFiles });
    if (result.kind === "sent") {
      setInput("");
      if (textareaRef) textareaRef.style.height = "auto";
      scrollToBottom(true);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = async () => {
    const result = await session.stop();
    if (result.error) setUploadError(result.error);
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
    session.startNewChat(agentId);
    clearPendingFiles();
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
            value={thinkingLevel() ?? ""}
            onChange={(e) => {
              const val = e.currentTarget.value;
              session.selectThinking(val ? (val as ThinkLevel) : null);
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
        onRestore={async () => { await session.restoreArchived(); }}
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
          <ChatTranscript session={session} viewMode={viewMode} />
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
