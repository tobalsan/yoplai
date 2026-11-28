import { DURABLE_MAIN_SESSION_ID, targetsDurableMain } from "@yoplai/shared/types";
import { AgentSettingsSidebar } from "./agent-management/AgentSettingsSidebar";
import { createDiscardPrompt } from "./agent-management/discard";
import { stripBase } from "../lib/path";
import { createFirstChat } from "../desktop-setup/first-chat";
import { setupRepairHref } from "../desktop-setup/repair";
import { useOptionalSetup } from "../desktop-setup/SetupGate";
import type { McpAppViewReference } from "@yoplai/shared/types";
import { decodeRouteParam } from "../lib/path";
import { createChatSession } from "./chat/createChatSession";
import { RemoteAgentMark } from "./RemoteAgentMark";
import { ChatToolbarOverflow } from "./chat/ChatToolbarOverflow";
import { ContextUsageRing } from "./chat/ContextUsageRing";
import { durableModeVersion, useDurableMode } from "../api/durable-mode";
import { fetchMemory, sendThreadMessage } from "../api/durable";
import { fetchAgentDashboards } from "../api/agents";
import { MemoryPanel, memoryFraction } from "./chat/MemoryPanel";
import { DurableThreadTabs, createDurableThreads } from "./chat/DurableThreadTabs";
import { watchThreadFeed } from "./chat/thread-feed";
import "./chat/DurableShell.css";
import { fetchFeedWindow, subscribeToFeed } from "../api/feed";
import { createFeedWindow, FEED_PAGE_SIZE } from "./chat/feed-window";
import { FeedTranscript, createFeedDetails, feedAppViewCalls } from "./chat/FeedTranscript";
import { isExtensionFrameView } from "./chat/chat-history";
import { captureFeedScroll, centerFeedMessage, clearFeedCentering } from "./chat/feed-scroll";
import { LegacyChatViewer } from "./chat/LegacyChatViewer";
import { ChatTranscript } from "./chat/ChatTranscript";
import { DeviceApprovalCards } from "./chat/DeviceApprovalCards";
import { DeviceSettingsControl } from "./chat/DeviceSettingsControl";
import { createAppViews, chatAppViewCalls, appViewKey } from "./chat/appViews";
import { load as loadPanelTabs } from "./chat/appViewStorage";
import { ChatSidePanel, canSplitPanel } from "./chat/ChatSidePanel";
import { ChatPanelTabs } from "./chat/ChatPanelTabs";
import { createDashboardAnnotations, DashboardAnnotationsContext, noteTarget } from "./chat/dashboardAnnotations";
import chatViewStyles from "./chat/ChatView.css?inline";
import {
  createSignal,
  createEffect,
  createResource,
  createMemo,
  startTransition,
  For,
  onCleanup,
  onMount,
  Show,
  on,
  untrack,
  type Accessor,
  type Resource,
} from "solid-js";

import { PageToolbar } from "./PageToolbar";
import { useParams, useBeforeLeave, useNavigate, useSearchParams, useLocation, A } from "@solidjs/router";
import { ArchivedSessionBanner } from "./ArchivedSessionBanner";
import { ScheduleAlertsBanner } from "./ScheduleAlertsBanner";
import { refreshToolLabels } from "../lib/tool-labels";
import {
  uploadFiles,
  getSessionKey,
  startNewChat,
  fetchAgent,
  fetchAgentSuggestions,
  fetchAgentSessions,
} from "../api";
import { fetchChatProject } from "../api/chat-projects";
import type {
  Agent,
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
  classifyFile,
  FILE_INPUT_ACCEPT,
} from "../lib/attachments";
import { createChatAttachmentRuntime } from "../lib/chat-runtime";
import { impersonationStatus } from "./ImpersonationBanner";
import { SuggestionCards } from "./SuggestionCards";
import { showToast } from "../lib/toast";
import { ChatSettingsMenu } from "./ChatSettingsMenu";
import { Button } from "./ui/Button";
import {
  notificationSoundEnabled,
  toggleNotificationSound,
} from "../lib/chat-notifications";
import { defaultAvatarUrl } from "../lib/default-avatar";

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
  const routeParams = useParams<{ agentId: string; view?: string }>();
  const params = {
    get agentId() { return decodeRouteParam(routeParams.agentId); },
    get view() { return routeParams.view; },
  };
  const [agent, { mutate: setAgent, refetch: refetchAgent }] = createResource(() => params.agentId, fetchAgent);
  createEffect(on(durableModeVersion, () => { void refetchAgent(); }, { defer: true }));
  const [searchParams] = useSearchParams();
  const explicitSessionId = () =>
    typeof searchParams.session === "string" && searchParams.session.trim()
      ? searchParams.session
      : undefined;
  const olderId = () => {
    const id = searchParams.session;
    return typeof id === "string" && id !== DURABLE_MAIN_SESSION_ID ? id : undefined;
  };
  const legacy = createMemo(() => {
    const sessionId = olderId();
    if (sessionId === undefined || agent.error) return;
    const current = agent.latest;
    if (current?.id === params.agentId && current.durable && !current.gateway) {
      return { agentId: current.id, sessionId };
    }
  });
  // Capabilities lists local IDs, including ones that look like linked agents.
  // Only linked chats can start their live controller before agent details arrive.
  const linked = () => params.agentId.includes("@") && !capabilities.agents.includes(params.agentId);
  const ready = () => olderId() === undefined || linked() ||
    (!agent.error && (!agent.loading || agent.latest?.id === params.agentId));
  return (
    <Show when={ready()} fallback={<p role="status">{agent.error ? "This chat is not available." : "Loading chat…"}</p>}>
      <Show when={legacy()} keyed fallback={
        <LiveChatView params={params} agent={agent} setAgent={setAgent} explicitSessionId={explicitSessionId} />
      }>
        {(chat) => <LegacyChatViewer agentId={chat.agentId} sessionId={chat.sessionId} />}
      </Show>
    </Show>
  );
}

function LiveChatView({ params, agent, setAgent, explicitSessionId }: {
  params: { agentId: string; view?: string };
  agent: Resource<Agent>;
  setAgent: (agent: Agent) => void;
  explicitSessionId: Accessor<string | undefined>;
}) {
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
  const navigate = useNavigate();
  const location = useLocation<{ mainAgentHome?: boolean; draftMessage?: string; feedSearch?: number }>();
  const modeEnabled = useDurableMode();
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [settingsDirty, setSettingsDirty] = createSignal(false);
  const [settingsSaving, setSettingsSaving] = createSignal(false);
  let settingsButton: HTMLButtonElement | undefined;
  const closeSettings = () => {
    setSettingsDirty(false);
    setSettingsOpen(false);
  };
  const discardSettings = createDiscardPrompt(() => settingsOpen() && settingsDirty(), "Discard unsaved changes?");
  const afterSettings = (action: () => void) => {
    if (settingsSaving()) return;
    discardSettings.request(() => {
      closeSettings();
      action();
    });
  };
  const requestSettingsClose = () => afterSettings(() => settingsButton?.focus());
  useBeforeLeave((event) => {
    if (!settingsOpen()) return;
    if (settingsSaving()) { event.preventDefault(); return; }
    if (!settingsDirty()) { closeSettings(); return; }
    event.preventDefault();
    afterSettings(() => event.retry(true));
  });
  createEffect(() => {
    if (!settingsOpen()) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || discardSettings.pending()) return;
      event.preventDefault();
      requestSettingsClose();
    };
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });
  const refreshAgentSettingsIdentity = () => {
    const id = params.agentId;
    void fetchAgent(id).then((updated) => {
      if (params.agentId === id) setAgent(updated);
    }, () => undefined);
    window.dispatchEvent(new Event("chat-projects-changed"));
  };
  // The gateway of a captured dashboard comes from the resolved agent, never from an ID suffix or a tool result.
  const chatGateway = () => (agent.loading || agent.error ? undefined : agent()?.gateway);
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
  const [durableSendError, setDurableSendError] = createSignal("");
  const [isFileDragActive, setIsFileDragActive] = createSignal(false);
  const [activeDropZone, setActiveDropZone] = createSignal<DropZone | null>(
    null
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionKey = () => getSessionKey(params.agentId);
  const durableMain = createMemo(() => agent()?.id === params.agentId && !agent()?.gateway &&
    targetsDurableMain(agent()?.durable === true, explicitSessionId()));
  const shell = createMemo(() => modeEnabled() && durableMain());
  const threadId = createMemo(() => shell() && typeof searchParams.thread === "string" ? searchParams.thread || undefined : undefined);
  const selectedSessionId = () => {
    const thread = threadId();
    return thread ? "thread:" + thread : explicitSessionId();
  };
  const switchThread = (id?: string) => {
    if (id === threadId()) return;
    const query = new URLSearchParams(location.search);
    if (id) query.set("thread", id);
    else query.delete("thread");
    navigate(location.pathname + (query.size ? `?${query}` : ""), { scroll: false });
  };
  const threads = createDurableThreads(() => shell() ? params.agentId : undefined, threadId, switchThread);
  const dashboardFromUrl = () => typeof searchParams.dashboard === "string" ? searchParams.dashboard : undefined;
  if (dashboardFromUrl() && searchParams.new === "1" && !explicitSessionId()) startNewChat(params.agentId);
  const [memoryOpen, setMemoryOpen] = createSignal(false);
  const [memoryActive, setMemoryActive] = createSignal(false);
  const [memoryRead, { refetch: refreshMemory }] = createResource(() => shell() ? params.agentId : undefined, async (id) => {
    try { return { id, data: await fetchMemory(id), fetchedAt: Date.now(), error: false }; }
    catch { return { id, data: undefined, fetchedAt: undefined, error: true }; }
  });
  const memory = () => memoryRead.latest?.id === params.agentId ? memoryRead.latest : undefined;
  const memoryShown = () => shell() && memoryOpen();
  createEffect(on(() => params.agentId, () => { setMemoryOpen(false); setMemoryActive(false); }, { defer: true }));
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

  const currentSession = () => `${params.agentId}:${sessionKey()}:${selectedSessionId() ?? ""}`;
  createEffect(on(currentSession, () => setDurableSendError(""), { defer: true }));
  // Live views to open, in arrival order and one per view. They wait for the agent (it fixes the tab key)
  // and the history (it restores saved tabs first). Each stays queued until the conversation holds its result.
  // `after` is the number of history requests started when the view arrived.
  const [openRequests, setOpenRequests] = createSignal<{ session: string; views: Map<string, { view: McpAppViewReference; after: number }>; last: McpAppViewReference }>();
  function requestOpen(view: McpAppViewReference) {
    if (view.server !== "yoplai" || (
      view.resourceUri !== "ui://yoplai/dashboard" && !isExtensionFrameView(view) &&
      !(view.file && ["html", "markdown", "pdf"].includes(classifyFile(view.file)))
    )) return;
    const scope = currentSession();
    setOpenRequests((current) => {
      const views = current?.session === scope ? new Map(current.views) : new Map<string, { view: McpAppViewReference; after: number }>();
      views.set(appViewKey(view), { view, after: session.historyRequests() });
      return { session: scope, views, last: view };
    });
  }
  const feedScope = createMemo(() => durableMain() ? params.agentId : undefined);
  const feedChat = createMemo(on([feedScope, threadId], ([agentId, thread]) => {
    if (!agentId) return;
    const requests = new AbortController();
    const read = (selector = {}) => fetchFeedWindow(agentId, selector, FEED_PAGE_SIZE,
      AbortSignal.any([requests.signal, AbortSignal.timeout(15_000)]), thread);
    const feed = createFeedWindow(read, preserveFeedScroll);
    const details = createFeedDetails(agentId, preserveFeedScroll, thread);
    const watch = thread ? watchThreadFeed(agentId, () => read(), feed.onFrame) : undefined;
    const stop = thread ? undefined : subscribeToFeed(agentId, FEED_PAGE_SIZE, feed.onFrame, feed.disconnected);
    onCleanup(() => {
      feed.dispose();
      requests.abort();
      watch?.stop();
      stop?.();
    });
    return { feed, details, watch };
  }));
  const feed = () => feedChat()?.feed;

  const session = createChatSession({
    durableLive: () => feed()?.live(),
    durableThreadId: threadId,
    onDurableEvent: (type, id) => {
      if (!shell()) return;
      if (type === "history_updated") {
        threads.refresh();
        if (id === DURABLE_MAIN_SESSION_ID) {
          window.dispatchEvent(new CustomEvent("durable-history-updated", { detail: params.agentId }));
          void refreshMemory();
        }
      }
      if (threadId() && (id === selectedSessionId() || !id)) {
        feedChat()?.watch?.refresh(type === "history_updated");
      }
    },
    onDurableError: setDurableSendError,
    agentId: () => params.agentId,
    agent,
    sessionKey,
    explicitSessionId: selectedSessionId,
    viewMode,
    projectId: () => searchParams.project ? String(searchParams.project) : undefined,
    isArchived: isSessionArchived,
    isImpersonating: () => !!impersonationStatus()?.active,
    isUploading: uploadingFiles,
    onLiveView: requestOpen,
    uploadPending: async (currentPendingFiles) => {
      if (currentPendingFiles.length === 0) return { inboundFiles: [] };
      setUploadingFiles(true);
      setUploadError("");
      try {
        const attachments = await uploadFiles(currentPendingFiles.map((item) => item.file), params.agentId);
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
    onRemoteReset: async () => {
      clearPendingFiles();
      const query = new URLSearchParams(location.search);
      query.delete("session");
      const search = query.toString();
      const url = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
      await startTransition(() => {
        navigate(url, { replace: true, state: location.state });
      });
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
    activeTools, isStreaming: sessionStreaming, loading: sessionLoading, stopping, pendingQueuedMessages,
    contextUsage, contextWarning, thinkingLevel,
    compactStatusForCurrentSession,
  } = session;
  const [threadPosting, setThreadPosting] = createSignal<ReadonlySet<string>>(new Set());
  const isStreaming = () => !!feed()?.live() || sessionStreaming() || threadPosting().has(currentSession());
  const loading = () => feed() ? feed()?.status() === "loading" : sessionLoading();
  const historyLoaded = () => {
    const window = feed();
    if (!window) return session.historyLoaded();
    const status = window.status();
    if (status === "ready" || status === "not-found") {
      return { scope: currentSession(), sessionId: selectedSessionId(), empty: window.items().length === 0 };
    }
  };
  const setup = useOptionalSetup();
  const firstChat = createFirstChat({
    agentId: () => params.agentId, sessionId: explicitSessionId, chat: session,
    ready: () => !!agent() && historyLoaded()?.scope === currentSession() && !loading(),
  });
  const missingModel = () => {
    const current = agent();
    const models = setup?.models();
    return current && !current.gateway && current.model && models && !models.some((model) =>
      model.provider === current.model?.provider && model.model === current.model.model &&
      (!current.model.source || model.source === current.model.source));
  };
  const repairModel = () => setupRepairHref("model", stripBase(location.pathname) + location.search);
  const [panelStorageReady, setPanelStorageReady] = createSignal(false);
  const initialPanelScope = currentSession();
  const appViews = createAppViews(session.appSessionId, () => {
    const chat = feedChat();
    return chat ? feedAppViewCalls(chat.feed, chat.details) : chatAppViewCalls(session, viewMode());
  }, currentSession, {
    agentId: () => params.agentId,
    ready: panelStorageReady,
  }, chatGateway);

  createEffect(() => {
    if (panelStorageReady()) return;
    if (currentSession() !== initialPanelScope) {
      setPanelStorageReady(true);
      return;
    }
    // Captured dashboards take their gateway from the resolved agent, so restore waits for it.
    if (agent.loading) return;
    const loaded = historyLoaded();
    const sessionId = session.appSessionId();
    if (!loaded || loaded.scope !== currentSession() || !sessionId) return;
    const row = chatViewRef?.querySelector(".chat-main")?.parentElement;
    if (row && canSplitPanel(row.getBoundingClientRect().width)) {
      const saved = loadPanelTabs(params.agentId, sessionId);
      if (saved) appViews.restore(saved, !!feed());
    }
    setPanelStorageReady(true);
  });
  // Opens the queued views from the oldest on, and stops at the first one the conversation does not hold yet:
  // a history response older than a live result drops it until the next response. A view that a history
  // requested after it arrived and after the run ended still lacks, for example one beyond the loaded page,
  // leaves the queue so it does not block the later views. A later change of the conversation runs this again,
  // so the tabs keep arrival order and the last view received ends selected.
  createEffect(() => {
    const requests = openRequests();
    const loaded = session.historyLoaded();
    if (!requests || agent.loading || !panelStorageReady()) return;
    const row = chatViewRef?.querySelector(".chat-main")?.parentElement;
    if (requests.session !== currentSession() || !row || !canSplitPanel(row.getBoundingClientRect().width)) {
      setOpenRequests(undefined);
      return;
    }
    const waiting = new Map(requests.views);
    for (const [id, { view, after }] of requests.views) {
      const key = appViewKey(view, chatGateway());
      if (!appViews.canOpen(key)) {
        if (!loaded?.refresh || loaded.scope !== requests.session || loaded.request <= after) break;
      } else untrack(() => appViews.open(key));
      waiting.delete(id);
    }
    if (waiting.size === requests.views.size) return;
    untrack(() => appViews.activate(appViewKey(requests.last, chatGateway())));
    setOpenRequests(waiting.size ? { ...requests, views: waiting } : undefined);
  });
  createEffect(on(feed, (current) => {
    if (!current) return;
    const seen = new Set<string>();
    createEffect(() => {
      const live = current.live();
      if (!live) seen.clear();
      if (!live || current.detached()) return;
      for (const call of live.toolCalls) {
        const view = call.result?.view ?? call.view;
        if (!view || call.status === "running" || seen.has(view.recordId)) continue;
        seen.add(view.recordId);
        requestOpen(view);
      }
    });
  }));
  onCleanup(appViews.close);
  // Staged dashboard notes belong to this conversation only.
  const annotations = createDashboardAnnotations(() => params.agentId);
  createEffect(on(currentSession, () => annotations.reset(), { defer: true }));
  const annotationPageCount = () => new Set(annotations.notes().map((note) => note.page.id)).size;
  const viewMessageTimes = new Map<string, number[]>();
  createEffect(on(() => `${params.agentId}\n${session.appSessionId() ?? currentSession()}`, () => viewMessageTimes.clear()));
  const handleViewMessage = async (viewKey: string, text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Message is empty");
    if (trimmed.length > 4000) throw new Error("Message exceeds 4000 characters");
    const now = Date.now();
    const times = (viewMessageTimes.get(viewKey) ?? []).filter((time) => now - time < 10 * 60 * 1000);
    if (times.length && now - times[times.length - 1] < 2000) throw new Error("Wait 2 seconds between messages");
    if (times.length >= 10) throw new Error("Limit of 10 messages per 10 minutes");
    times.push(now);
    viewMessageTimes.set(viewKey, times);
    if (feed()) {
      setDurableSendError("");
      jumpToLatest();
    }
    if (threadId()) await postThread(trimmed);
    else await session.sendFromView(trimmed);
  };
  let focusedHomeSession: string | null = null;
  createEffect(on(historyLoaded, (loaded) => {
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
      (feed() ? historyLoaded()?.empty === true : simpleMessages().length === 0 && fullMessages().length === 0) &&
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

  onMount(() => { void loadCapabilities().catch(() => undefined); });

  const [autoScrollPinned, setAutoScrollPinned] = createSignal(true);
  const SCROLL_THRESHOLD = 40;
  let autoScrollFrame: number | undefined;
  let programmaticScrollUntil = 0;
  let programmaticTop = 0;
  const recordProgrammaticScroll = () => {
    programmaticTop = messagesContainerRef?.scrollTop ?? 0;
    programmaticScrollUntil = performance.now() + 100;
  };

  const checkIsAtBottom = () => {
    if (!messagesContainerRef) return true;
    const { scrollTop, scrollHeight, clientHeight } = messagesContainerRef;
    return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
  };

  const handleScroll = () => {
    const window = feed();
    if (performance.now() < programmaticScrollUntil &&
      (!window || Math.abs((messagesContainerRef?.scrollTop ?? 0) - programmaticTop) < 1)) return;
    const atBottom = checkIsAtBottom();
    setAutoScrollPinned(atBottom && !window?.detached());
    if (!window || !messagesContainerRef) return;
    if (messagesContainerRef.scrollTop <= SCROLL_THRESHOLD && window.hasBefore()) {
      void window.loadBefore();
    } else if (atBottom && window.hasAfter()) {
      void window.loadAfter();
    }
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
      messagesContainerRef.scrollTop = messagesContainerRef.scrollHeight;
      recordProgrammaticScroll();
    });
  };

  let feedScrollFrame: number | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const [flashing, setFlashing] = createSignal<string>();
  function preserveFeedScroll() {
    const container = messagesContainerRef;
    const current = feed();
    if (!container || feedScrollFrame !== undefined) return;
    if (autoScrollPinned() && !current?.detached()) {
      scrollToBottom();
      return;
    }
    const restore = captureFeedScroll(container);
    if (!restore) return;
    feedScrollFrame = requestAnimationFrame(() => {
      feedScrollFrame = undefined;
      if (current !== feed() || container !== messagesContainerRef) return;
      restore();
      recordProgrammaticScroll();
    });
  }
  function cancelFeedScroll() {
    if (feedScrollFrame !== undefined) cancelAnimationFrame(feedScrollFrame);
    feedScrollFrame = undefined;
  }
  function jumpToLatest() {
    const current = feed();
    if (!current) return;
    cancelFeedScroll();
    clearFeedCentering(messagesContainerRef);
    setAutoScrollPinned(true);
    const jump = current.jumpToLatest();
    scrollToBottom(true);
    void jump.then(() => {
      if (current === feed() && autoScrollPinned() && !current.detached()) scrollToBottom();
    });
  }
  const [messageHash, setMessageHash] = createSignal(location.hash);
  createEffect(() => setMessageHash(location.hash));
  const onHashChange = () => setMessageHash(window.location.hash);
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => window.removeEventListener("hashchange", onHashChange));
  const anchorId = () => new URLSearchParams(messageHash()?.slice(1)).get("m");
  createEffect(on([feed, anchorId, () => location.state?.feedSearch], ([window, id]) => {
    cancelFeedScroll();
    clearFeedCentering(messagesContainerRef);
    clearTimeout(flashTimer);
    setFlashing(undefined);
    if (!window) return;
    setAutoScrollPinned(!id);
    if (id) void window.openAround(id);
    else void window.openTail();
  }));
  createEffect(on(() => feed()?.flash(), (anchor) => {
    if (!anchor) return;
    cancelFeedScroll();
    const frame = requestAnimationFrame(() => {
      if (!messagesContainerRef || !centerFeedMessage(messagesContainerRef, anchor.id)) return;
      recordProgrammaticScroll();
      setFlashing(anchor.id);
      flashTimer = setTimeout(() => setFlashing(undefined), 1200);
    });
    onCleanup(() => cancelAnimationFrame(frame));
  }));
  createEffect(on(() => feed()?.status(), (status) => {
    if (status !== "not-found") return;
    cancelFeedScroll();
    scrollToBottom(true);
  }));
  onCleanup(() => {
    cancelFeedScroll();
    clearTimeout(flashTimer);
  });

  const canAttachFiles = () =>
    !threadId() &&
    !loading() &&
    !uploadingFiles() &&
    !isStreaming() &&
    !impersonationStatus()?.active;

  const getFileDropError = () => {
    if (threadId()) return "Open Main to attach files.";
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
    const window = feed();
    if (window) {
      window.items();
      if (!window.detached()) {
        window.live();
        scrollToBottom();
      }
      return;
    }
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
          ? `/chat/${encodeURIComponent(params.agentId)}/full`
          : `/chat/${encodeURIComponent(params.agentId)}`;
      const session = explicitSessionId();
      const query = new URLSearchParams();
      if (session) query.set("session", session);
      if (threadId()) query.set("thread", threadId()!);
      if (searchParams.project) query.set("project", String(searchParams.project));
      const path = query.size ? `${basePath}?${query}` : basePath;
      navigate(durableMain() ? path + messageHash() : path, { replace: true });
    }
  };

  const threadSendRetries = new Map<string, { text: string; id: string }>();
  async function postThread(text: string) {
    const thread = threadId();
    const scope = currentSession();
    if (!thread || threadPosting().has(scope)) return;
    const retry = threadSendRetries.get(scope);
    const request = retry?.text === text ? retry : { text, id: crypto.randomUUID() };
    setThreadPosting((pending) => new Set([...pending, scope]));
    setDurableSendError("");
    jumpToLatest();
    const clearPending = feed()?.addPendingSend(text);
    try {
      await sendThreadMessage(params.agentId, thread, text, request.id);
      threadSendRetries.delete(scope);
    } catch (error) {
      clearPending?.();
      threadSendRetries.set(scope, request);
      if (currentSession() === scope) setDurableSendError(error instanceof Error ? error.message : "Could not send the message.");
      throw error;
    } finally {
      setThreadPosting((pending) => new Set([...pending].filter((item) => item !== scope)));
      if (currentSession() === scope) feedChat()?.watch?.refresh(true);
    }
  }

  let submittingDurableDraft = false;
  const handleSend = async () => {
    const main = durableMain();
    session.flushFinished();

    if (impersonationStatus()?.active) return;
    const draftText = input();
    const text = draftText.trim();
    const stoppingMain = main && text === "/stop";
    if (!stoppingMain && ((main && submittingDurableDraft) || loading() || uploadingFiles())) return;
    const currentPendingFiles = pendingFiles();
    const hasFiles = currentPendingFiles.length > 0;
    const hasNotes = annotations.notes().length > 0;
    if (!text && !hasFiles && !hasNotes) return;
    if (!stoppingMain && isStreaming() && hasFiles) {
      setUploadError("Wait for the current response before attaching files.");
      return;
    }

    // Treat /stop as an interrupt
    if (text === "/stop") {
      setInput("");
      if (textareaRef) textareaRef.style.height = "auto";
      await handleStop(stoppingMain);
      return;
    }

    if (text === "/compact" && !main) {
      setInput("");
      if (textareaRef) textareaRef.style.height = "auto";
      await session.compact().catch(() => undefined);
      return;
    }

    const message = annotations.compose(text);
    if (threadId()) {
      const scope = currentSession();
      if (threadPosting().has(scope)) return;
      setInput("");
      if (textareaRef) textareaRef.style.height = "auto";
      try {
        await postThread(message.text);
        if (scope === currentSession()) message.sent();
      } catch {
        if (scope === currentSession() && !input()) setInput(text);
      }
      return;
    }
    if (main) {
      submittingDurableDraft = true;
      setDurableSendError("");
      jumpToLatest();
    }
    const draftScope = main ? currentSession() : undefined;
    const clearPending = main ? feed()?.addPendingSend(message.text || "Attached file(s).") : undefined;
    let rejected = false;
    const restoreDraft = () => {
      if (draftScope !== currentSession()) return;
      rejected = true;
      setUploadError("");
      if (!input()) {
        setInput(draftText);
        resizeTextarea();
      }
      if (hasFiles) addPendingFiles(currentPendingFiles.map(({ file }) => file));
    };
    try {
      const result = await session.send({
        text: message.text,
        pendingFiles: currentPendingFiles,
        onDurableFailure: main ? (code) => {
          const rejected = code === "send_rejected";
          clearPending?.(rejected);
          if (rejected) restoreDraft();
        } : undefined,
      });
      if (result.kind === "blocked") clearPending?.();
      if (result.kind === "sent" && (!main || draftScope === currentSession())) {
        message.sent();
        if (!rejected && (!main || input() === draftText)) {
          setInput("");
          if (textareaRef) textareaRef.style.height = "auto";
        }
        if (!main) scrollToBottom(true);
      }
    } catch (error) {
      clearPending?.();
      throw error;
    } finally {
      if (main) submittingDurableDraft = false;
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const images = Array.from(e.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    e.preventDefault();
    const pasteError = getFileDropError();
    if (pasteError) {
      setUploadError(pasteError);
      return;
    }
    addPendingFiles(images);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleStop = async (unbound = false) => {
    const result = await session.stop(unbound || (!!threadId() && threadPosting().has(currentSession()) && !feed()?.live()));
    if (result.error) setUploadError(result.error);
    if (result.status === "already_finished") showToast("Run already finished.");
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
    appViews.close();
    annotations.reset();
    session.startNewChat(agentId);
    clearPendingFiles();
    setInput("");
    navigate(`/chat/${encodeURIComponent(agentId)}`);
    requestAnimationFrame(() => textareaRef?.focus());
  };

  let openedDashboard: string | undefined;
  createEffect(() => {
    const id = dashboardFromUrl();
    if (!id) { openedDashboard = undefined; return; }
    const agentId = params.agentId;
    const link = agentId + "\n" + id;
    const mainLink = !explicitSessionId() && searchParams.new !== "1";
    if (openedDashboard === link || ((agentId.includes("@") || mainLink) && agent.loading)) return;
    openedDashboard = link;
    const gateway = chatGateway();
    const open = (title: string) => {
      if (params.agentId !== agentId || openedDashboard !== link) return;
      if (!agent.error) {
        appViews.openFrame({ kind: "dashboard", id, title, ...(gateway ? { gateway } : {}) });
        setMemoryActive(false);
      }
      setSearchParams({ dashboard: undefined, new: undefined }, { replace: true });
    };
    if (mainLink && durableMain()) {
      void fetchAgentDashboards(agentId, undefined, AbortSignal.timeout(3000)).then(
        (rows) => open(Array.isArray(rows) ? rows.find((row) => row.id === id)?.title ?? "Dashboard" : "Dashboard"),
        () => open("Dashboard"),
      );
    } else untrack(() => open("Dashboard"));
  });
  const activeDashboardTitle = () => {
    const frame = appViews.frame();
    if (frame) return frame.title === "Dashboard" ? "this dashboard" : frame.title;
    const view = appViews.panel()?.latest.result?.view;
    if (view?.resourceUri === "ui://yoplai/dashboard") return view.title ?? "this dashboard";
  };
  function jumpToMemoryRef(id: string) {
    const query = new URLSearchParams(location.search);
    query.delete("thread");
    const target = location.pathname + (query.size ? `?${query}` : "") + `#m=${encodeURIComponent(id)}`;
    navigate(target, { scroll: false, state: { ...location.state, feedSearch: Date.now() } });
  }


  let draftMessageUsed = false;
  createEffect(() => {
    const message = location.state?.draftMessage;
    if (!message || draftMessageUsed || loading() || !agent()) return;
    draftMessageUsed = true;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: { mainAgentHome: location.state?.mainAgentHome } });
    if (simpleMessages().length || fullMessages().length) return;
    prefillSuggestion(message);
  });

  const toolbar = () => (
      <div class="chat-toolbar">
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
          <div class="agent-avatar">
            <Show
              when={agent()?.avatar}
              fallback={<img src={defaultAvatarUrl(params.agentId)} alt="" class="avatar-img" />}
            >
              {(avatar) => isEmoji(avatar()) ? (
                <span class="avatar-emoji">{avatar()}</span>
              ) : (
                <img src={avatar()} alt={agent()?.name} class="avatar-img" />
              )}
            </Show>
          </div>
          <div class="agent-info-text">
            <div class="agent-title-row">
              <div class="agent-name">{agent()?.name ?? "Loading..."}<RemoteAgentMark gateway={agent()?.gateway} /></div>
              <span
                class="status-dot"
                classList={{ active: isStreaming() }}
                role="img"
                aria-label={isStreaming() ? "Thinking" : "Online"}
                title={isStreaming() ? "Thinking" : "Online"}
              />
              <Show when={project()}>
                {(proj) => (
                  <A href={`/p/${projectId()}`} class="chat-project-chip">
                    <i class="fa-solid fa-folder" />
                    <span>{proj().name}</span>
                  </A>
                )}
              </Show>
            </div>
            <Show when={agent()?.description}>
              <span class="agent-description-inline">{agent()!.description}</span>
            </Show>
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
        <Show when={isExtensionEnabled("projects") || canUseFullView() || agent()?.gateway}>
          <ChatToolbarOverflow>
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
                <span class="chat-overflow-label">Open taskboard</span>
              </A>
            </Show>
            <Show when={isOAuth() && canUseFullView()}>
              <select
                class="think-dropdown"
                aria-label="Thinking level"
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
            <Show when={agent()?.gateway}>
              {(gateway) => <DeviceSettingsControl agentId={params.agentId} gateway={gateway()} chat={session.deviceChatName()} refreshKey={session.deviceApprovals().length} />}
            </Show>
          </ChatToolbarOverflow>
        </Show>
        <Show when={shell()}>
          <button type="button" class="new-chat-btn memory-toolbar-button" aria-label="Memory"
            title={`What ${agent()?.name ?? "the agent"} remembers`} aria-pressed={memoryShown() && memoryActive()}
            onClick={() => {
              if (memoryShown() && memoryActive()) { setMemoryOpen(false); return; }
              setMemoryOpen(true);
              setMemoryActive(true);
              void refreshMemory();
            }}>
            <span class="memory-ring" aria-hidden="true"
              classList={{ "memory-full": memoryFraction(memory()?.data?.gauge) >= 0.7 }}
              style={{ "--memory-fill": `${memoryFraction(memory()?.data?.gauge) * 100}%` }} />
            <span>Memory</span>
          </button>
        </Show>
        <Show when={!shell()}>
        <button
          class="new-chat-btn"
          aria-label="Start a new chat"
          title="New chat"
          onClick={() => afterSettings(() => startFreshChat(params.agentId))}
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
          <span class="new-chat-label">New chat</span>
        </button>
        </Show>
        <button type="button" class="agent-settings-btn" classList={{ "agent-settings-active": settingsOpen() }}
          aria-label="Agent settings" title="Agent settings" aria-expanded={settingsOpen()} ref={settingsButton}
          onClick={() => settingsOpen() ? requestSettingsClose() : setSettingsOpen(true)}>
          <i class="fa-solid fa-sliders" aria-hidden="true" />
        </button>
        <ChatSettingsMenu beforePick={afterSettings} agentId={params.agentId} settingsAgentId={params.agentId} sessionId={session.appSessionId()} projectId={projectId()} onPick={startFreshChat} />
      </div>
  );

  const body = () => (
    <div
      ref={chatViewRef}
      class="chat-view"
      inert={settingsOpen()}
      onClick={handleCodeCopy}
      classList={{
        "drop-active": isFileDragActive(),
        "hero-mode": heroPhase() !== "off",
        "hero-sent": heroPhase() === "exiting" || heroPhase() === "off",
      }}
    >
      <div class="chat-main">
      <Show when={shell()}>
        <DurableThreadTabs agentId={params.agentId} threads={threads} />
      </Show>
      <Show when={firstChat.failed() || missingModel()}>
        <div class="desktop-chat-repair">
          <Show when={firstChat.failed()}><p role="alert">Yoplai could not complete the first turn.</p></Show>
          <Show when={firstChat.failed()}><Button onClick={() => void firstChat.retry()}>Try again</Button></Show>
          <Button onClick={() => navigate(repairModel())}>Fix model access</Button>
        </div>
      </Show>
      <Show when={firstChat.readError()}><p role="status">Yoplai could not check the first turn. Yoplai will try again.</p></Show>
      <ArchivedSessionBanner
        isArchived={isSessionArchived()}
        onRestore={async () => { await session.restoreArchived(); }}
      />

      <ScheduleAlertsBanner agentId={params.agentId} gateway={chatGateway()} />

      <div class="chat-body" role="region" aria-label="Chat transcript">
        <div class="hero-spacer hero-spacer-top" />
        <div class="hero hero-collapsible" classList={{ gone: heroGone() }}>
          <Show
            when={agent()?.avatar}
            fallback={
              <div class="hero-avatar">
                <img src={defaultAvatarUrl(params.agentId)} alt="" class="avatar-img" />
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
          onWheel={(event) => {
            handleUserScrollIntent();
            const current = feed();
            if (!current) return;
            if (event.deltaY < 0 && event.currentTarget.scrollTop <= SCROLL_THRESHOLD) void current.loadBefore();
            if (event.deltaY > 0 && checkIsAtBottom()) void current.loadAfter();
          }}
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
            "feed-messages": !!feed(),
          }}
        >
          <Show when={feedChat()} keyed fallback={
            <ChatTranscript agentId={params.agentId} gateway={chatGateway()} gatewayPending={agent.loading} session={session} viewMode={viewMode} appViews={appViews} onUserMessage={handleViewMessage} />
          }>
            {(chat) => <FeedTranscript agentId={params.agentId} sessionId={DURABLE_MAIN_SESSION_ID} mode={viewMode()}
              feed={chat.feed} details={chat.details} appViews={appViews} flashing={flashing()} onUserMessage={handleViewMessage}
              sending={isStreaming()}
              showUserActions={shell()} onStartThread={shell() && !threadId() && !impersonationStatus()?.active ? threads.start : undefined}
              threadActionBusy={threads.busy()} />}
          </Show>
          <Show when={agent()?.gateway}>
            <DeviceApprovalCards
              agentName={agent()?.name ?? "The agent"}
              items={session.deviceApprovals().filter(session.isDeviceApprovalShown)}
              connectionLost={session.deviceConnectionLost()}
              onAnswer={session.answerDeviceApproval}
            />
          </Show>
        </div>

        <div class="composer-zone">
        <Show when={feed()?.detached()}>
          <Button class="ui-button feed-jump" onClick={jumpToLatest}>
            Jump to latest
            <Show when={feed()?.newCount()}>
              {(count) => <span> · {count()} new message{count() === 1 ? "" : "s"}</span>}
            </Show>
          </Button>
        </Show>
        <Show when={isFileDragActive()}>
        <div class="drop-banner">{fileDropHint()}</div>
      </Show>
      <Show when={uploadError() || durableSendError()}>
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

      <Show when={annotations.notes().length > 0}>
        <ul class="annotation-notes" aria-label="Dashboard notes">
          <For each={annotations.notes()}>
            {(note, index) => (
              <li class="annotation-chip" title={`${note.page.title} › ${noteTarget(note)}: ${note.note}`}>
                <span class="annotation-chip-number">{index() + 1}</span>
                <Show when={annotationPageCount() > 1}>
                  <span class="annotation-chip-page">{note.page.title}</span>
                </Show>
                <span class="annotation-chip-target">{noteTarget(note)}</span>
                <span class="annotation-chip-note">{note.note}</span>
                <button
                  type="button"
                  class="annotation-chip-remove"
                  aria-label={`Remove note ${index() + 1}`}
                  onClick={() => annotations.remove(note.id)}
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true" />
                </button>
              </li>
            )}
          </For>
        </ul>
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
        <Show when={!threadId()}>
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
        </Show>
          <textarea
            ref={textareaRef}
            class="input"
            data-tour="composer"
            placeholder={
              impersonationStatus()?.active
                ? "Read-only — exit impersonation to send."
                : shell() && activeDashboardTitle() ? `Message about ${activeDashboardTitle()}…` : "Message..."
            }
            value={input()}
            disabled={impersonationStatus()?.active}
            onInput={(e) => {
              setInput(e.currentTarget.value);
              resizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
          />
          <Show when={!shell() && contextUsage()}>
            {(usage) => <ContextUsageRing inputTokens={usage().inputTokens} maxTokens={usage().maxTokens} />}
          </Show>
          <Show
            when={isStreaming()}
          fallback={
            <button
              class="pill-btn send-btn"
              data-tour="send"
              onClick={handleSend}
              disabled={
                impersonationStatus()?.active ||
                (!input().trim() && pendingFiles().length === 0 && annotations.notes().length === 0) ||
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
            onClick={() => void handleStop()}
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

      <Show when={contextWarning()}>
        {(warning) => <div class="context-warning">{warning()}</div>}
      </Show>
      </div>
      <Show when={memoryShown() || appViews.tabs().length > 0}>
        <ChatSidePanel durableShell={shell()}>
          <ChatPanelTabs appViews={appViews} agentId={params.agentId} gateway={chatGateway()} gatewayPending={agent.loading}
            sessionId={session.appSessionId()} onUserMessage={handleViewMessage}
            onSelectView={() => setMemoryActive(false)}
            memory={memoryShown() ? {
              active: memoryActive(),
              activate: () => setMemoryActive(true),
              close: () => { setMemoryOpen(false); setMemoryActive(false); },
              content: <MemoryPanel agentName={agent()?.name ?? "the agent"}
                data={memory()?.data} fetchedAt={memory()?.fetchedAt} loading={memoryRead.loading} error={memory()?.error}
                retry={() => void refreshMemory()} jump={jumpToMemoryRef} openThread={(id) => void threads.open(id)} />,
            } : undefined} />
        </ChatSidePanel>
      </Show>

      <style>{chatViewStyles}</style>
    </div>
  );

  return (
    <DashboardAnnotationsContext.Provider value={annotations}>
      <PageToolbar>{toolbar()}</PageToolbar>
      <div class="agent-settings-host">
        {body()}
        <Show when={settingsOpen() && !agent.error && agent.latest}>
          {(current) => <AgentSettingsSidebar agent={current()} onClose={requestSettingsClose} onDirty={setSettingsDirty}
            onSaving={setSettingsSaving}
            onAgentChanged={refreshAgentSettingsIdentity} onSaved={() => { closeSettings(); settingsButton?.focus(); }} />}
        </Show>
      </div>
      <discardSettings.Dialog />
    </DashboardAnnotationsContext.Provider>
  );
}
