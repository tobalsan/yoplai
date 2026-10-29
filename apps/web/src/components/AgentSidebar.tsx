import {
  Accessor,
  type JSX,
  For,
  Suspense,
  Show,
  createEffect,
  createResource,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  on,
  lazy,
} from "solid-js";
import { Portal } from "solid-js/web";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { theme, toggleTheme } from "../theme";
import { capabilities, isExtensionEnabled } from "../lib/capabilities";
import { openConnectPrompt, restartTour } from "../onboarding/state";
import { EMPTY_TOP_EXTENSIONS, fetchTopExtensions } from "../api/top-extensions";
import { chatRouteSession, stripBase } from "../lib/path";
import {
  deleteAgentSession,
  fetchAgentSessions,
  renameAgentSession,
  pinAgentSession,
  archiveAgentSession,
  UnauthenticatedError,
} from "../api";
import { fetchChatProjects, moveChatToProject, deleteChatProject, renameChatProject, type ChatProject } from "../api/chat-projects";
import { CreateProjectModal } from "./project/CreateProjectModal";
import { Modal } from "./ui/Modal";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { TextField } from "./ui/Field";
import { Button } from "./ui/Button";
import type { SessionSummary } from "../api/types";
import { hasStaffRole as hasAdminRole } from "../lib/roles";
import { showToast } from "../lib/toast";
import { openSessionSearch } from "./SessionSearch";
import { captureChatReads, isChatUnread, observeChatSessions } from "../lib/chat-notifications";

type AgentSidebarProps = {
  collapsed: Accessor<boolean>;
  onToggleCollapse: () => void;
};

const LazySidebarAccountPanel = lazy(
  () => import("../auth/SidebarAccountPanel")
);

function readCollapsedProjects(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("yoplai:collapsed-chat-projects") ?? "[]");
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
  } catch { return []; }
}

export function positionSidebarMenu(
  trigger: { top: number; bottom: number; right: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const below = trigger.bottom + 4;
  const above = trigger.top - size.height - 4;
  const top = below + size.height > viewport.height - 8 && above >= 8 ? above : below;
  return {
    left: Math.max(8, Math.min(trigger.right - size.width, viewport.width - size.width - 8)),
    top: Math.max(8, Math.min(top, viewport.height - size.height - 8)),
  };
}

function relativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function groupLabel(timestamp: number, currentTime: number): string {
  const date = new Date(timestamp);
  const now = new Date(currentTime);
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86400000;
  if (timestamp >= startToday) return "Today";
  if (timestamp >= startYesterday) return "Yesterday";
  if (timestamp >= startToday - 6 * 86400000) return "Earlier this week";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return "Earlier this month";
  }
  return date.toLocaleString(undefined, { month: "long", year: "numeric" });
}

export function AgentSidebar(props: AgentSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  // "Connect tools" only makes sense once a superadmin starred something;
  // re-read on each agent chat so new stars show without a reload.
  const [topExtensions] = createResource(
    () => (capabilities.multiUser && capabilities.user ? chatRouteSession(location.pathname, location.search).agentId : null),
    () => fetchTopExtensions().catch(() => EMPTY_TOP_EXTENSIONS)
  );
  const hasTopExtensions = () => {
    const top = topExtensions();
    return !!top && top.extensions.length + top.mcp.length > 0;
  };
  const [sessions, setSessions] = createSignal<SessionSummary[]>([], {
    equals: (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
  });
  const [projects, setProjects] = createSignal<ChatProject[]>([], { equals: (previous, next) => JSON.stringify(previous) === JSON.stringify(next) });
  const [collapsedProjects, setCollapsedProjects] = createSignal<string[]>(readCollapsedProjects());
  const [movingSession, setMovingSession] = createSignal<SessionSummary | null>(null);
  const [sessionError, setSessionError] = createSignal("");
  const [showCreateProject, setShowCreateProject] = createSignal(false);
  const [renamingProject, setRenamingProject] = createSignal<ChatProject | null>(null);
  const [deletingProject, setDeletingProject] = createSignal<ChatProject | null>(null);
  const [renamingSession, setRenamingSession] = createSignal<SessionSummary | null>(null);
  const [deletingSession, setDeletingSession] = createSignal<SessionSummary | null>(null);
  const [projectNameInput, setProjectNameInput] = createSignal("");
  const [sessionTitleInput, setSessionTitleInput] = createSignal("");
  const [renaming, setRenaming] = createSignal(false);
  const [deleting, setDeleting] = createSignal(false);
  const [renameChatError, setRenameChatError] = createSignal("");
  const [renameProjectError, setRenameProjectError] = createSignal("");
  const [deleteProjectError, setDeleteProjectError] = createSignal("");
  const [moveChatError, setMoveChatError] = createSignal("");
  const [currentTime, setCurrentTime] = createSignal(Date.now());
  const [listScrolling, setListScrolling] = createSignal(false);
  const [sidebarHovered, setSidebarHovered] = createSignal(false);
  const [tooltip, setTooltip] = createSignal<{ session: SessionSummary; row: HTMLElement } | null>(null);
  const [openMenu, setOpenMenu] = createSignal<HTMLDetailsElement | null>(null);
  let menuPanel: HTMLDivElement | undefined;
  const closeMenu = () => {
    openMenu()?.removeAttribute("open");
    setOpenMenu(null);
    menuPanel = undefined;
  };
  createEffect(on(props.collapsed, (collapsed) => {
    if (collapsed) closeMenu();
  }));
  const SidebarMenu = (menuProps: { label: string; children: JSX.Element }) => {
    let owner!: HTMLDetailsElement;
    onCleanup(() => { if (openMenu() === owner) closeMenu(); });
    return (
      <details class="session-actions" ref={owner} onToggle={(event) => {
        if (event.currentTarget.open) {
          if (openMenu() !== owner) closeMenu();
          hideTooltip();
          setOpenMenu(owner);
        } else if (openMenu() === owner) closeMenu();
      }}>
        <summary aria-label={menuProps.label}>⋯</summary>
        <Show when={openMenu() === owner}>
          <Portal>
            <div class="session-menu" role="group" aria-label={`${menuProps.label} actions`} onClick={closeMenu} ref={(element) => {
              menuPanel = element;
              queueMicrotask(() => {
                if (!element.isConnected) return;
                const trigger = owner.querySelector("summary")!.getBoundingClientRect();
                const position = positionSidebarMenu(trigger, element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
                element.style.left = `${position.left}px`;
                element.style.top = `${position.top}px`;
                element.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
              });
            }}>
              {menuProps.children}
            </div>
          </Portal>
        </Show>
      </details>
    );
  };
  let tooltipTimer: ReturnType<typeof setTimeout> | undefined;
  const hideTooltip = () => {
    clearTimeout(tooltipTimer);
    setTooltip(null);
  };
  const showTooltip = (session: SessionSummary, row: HTMLElement) => {
    if (!props.collapsed() || sidebarHovered()) setTooltip({ session, row });
  };
  const queueTooltip = (session: SessionSummary, row: HTMLElement) => {
    hideTooltip();
    tooltipTimer = setTimeout(() => showTooltip(session, row), 450);
  };
  createEffect(() => {
    if (props.collapsed() && !sidebarHovered()) hideTooltip();
  });
  const sessionLabel = (session: SessionSummary) => session.title || session.firstUserMessage || session.sessionId;
  const sessionDetails = (session: SessionSummary) => (
    <>
      <strong>{sessionLabel(session)}</strong>
      <span>{relativeTime(session.lastActivity, currentTime())} · {session.agentId}</span>
      <Show when={session.isMain}><b>MAIN</b></Show>
      <Show when={session.pinned != null}><span>Pinned</span></Show>
    </>
  );
  let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
  const onListScroll = () => {
    setListScrolling(true);
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => setListScrolling(false), 700);
  };

  let pollStopped = false;

  const refreshSessions = async () => {
    if (pollStopped || document.visibilityState !== "visible") return;
    const userId = capabilities.user?.id;
    const readsAtStart = captureChatReads();
    try {
      const res = await fetchAgentSessions({ strict: true });
      if (userId !== capabilities.user?.id || pollStopped) return;
      observeChatSessions(res.items, readsAtStart);
      setSessions(res.items);
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        pollStopped = true;
        navigate("/login");
      }
    }
  };

  const refreshProjects = async () => {
    if (pollStopped || document.visibilityState !== "visible") return;
    try { setProjects((await fetchChatProjects()).items); }
    catch { setSessionError("Unable to load projects. Try again."); }
  };
  const refresh = () => { void refreshSessions(); void refreshProjects(); };
  createEffect(refresh);
  window.addEventListener("chat-projects-changed", refresh);
  onCleanup(() => window.removeEventListener("chat-projects-changed", refresh));
  const poll = window.setInterval(refresh, 3000);
  const clock = window.setInterval(() => setCurrentTime(Date.now()), 60000);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  onCleanup(() => {
    clearTimeout(tooltipTimer);
    clearTimeout(scrollIdleTimer);
    window.clearInterval(poll);
    window.clearInterval(clock);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  });

  // The popup is portalled, so outside clicks must check both it and its trigger.
  onMount(() => {
    const handleClickOutside = (event: MouseEvent) => {
      hideTooltip();
      const target = event.target as Node;
      if (!openMenu()?.contains(target) && !menuPanel?.contains(target)) closeMenu();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hideTooltip();
        const trigger = openMenu()?.querySelector("summary");
        closeMenu();
        trigger?.focus();
      }
    };
    const handleScroll = (event: Event) => {
      hideTooltip();
      if (!(event.target instanceof Node && menuPanel?.contains(event.target))) closeMenu();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", closeMenu);
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", closeMenu);
    });
  });

  const sessionsInSection = (pinned: boolean) =>
    sessions().filter((item) => !projects().some((project) => project.id === item.projectId) && (item.pinned != null) === pinned);
  const groupLabels = (pinned: boolean) =>
    [...new Set(sessionsInSection(pinned).map((session) => groupLabel(session.lastActivity, currentTime())))];
  const sessionsInGroup = (pinned: boolean, label: string) =>
    sessionsInSection(pinned).filter((session) => groupLabel(session.lastActivity, currentTime()) === label);

  const currentChat = () => chatRouteSession(location.pathname, location.search);
  const selectSession = (session: SessionSummary) => {
    navigate(`/chat/${encodeURIComponent(session.agentId)}?session=${encodeURIComponent(session.sessionId)}`);
  };

  const renderSession = (session: SessionSummary) => {
    const selected = () =>
      currentChat().agentId === session.agentId &&
      currentChat().sessionId === session.sessionId;
    const descriptionId = createUniqueId();
    return (
      <div
        class="session-row-wrap"
        onMouseEnter={(event) => queueTooltip(session, event.currentTarget)}
        onMouseMove={(event) => queueTooltip(session, event.currentTarget)}
        onMouseLeave={hideTooltip}
      >
        <button
          type="button"
          class="session-row"
          classList={{ active: selected() }}
          aria-describedby={descriptionId}
          onFocus={(event) => showTooltip(session, event.currentTarget)}
          onBlur={hideTooltip}
          onClick={() => { hideTooltip(); selectSession(session); }}
        >
          <span class="session-avatar">
            <Show
              when={session.avatar}
              fallback={session.agentId[0]?.toUpperCase()}
            >
              {(avatar) => (
                <Show
                  when={avatar().startsWith("/") || /^https?:\/\//i.test(avatar())}
                  fallback={avatar()}
                >
                  <img src={avatar()} alt="" />
                </Show>
              )}
            </Show>
          </span>
          <Show when={isChatUnread(session)}>
            <span class="session-unread-dot" role="img" aria-label="Unread messages" />
          </Show>
          <span class="session-main">
            <span class="session-title">
              <span class="session-title-text">{sessionLabel(session)}</span>
            </span>
          </span>
        </button>
        <span id={descriptionId} class="session-description">{sessionDetails(session)}</span>
        <SidebarMenu label="Session menu">
          <button
            type="button"
            class="session-action"
            onClick={async () => {
              closeMenu();
              setSessionError("");
              try {
                await pinAgentSession(session.agentId, session.sessionId, session.pinned == null);
                await refreshSessions();
                window.dispatchEvent(new Event("chat-projects-changed"));
              } catch {
                setSessionError("Failed to update session pin. Try again.");
              }
            }}
          >
            <i class="fa-solid fa-thumbtack" aria-hidden="true" />
            {session.pinned == null ? "Pin" : "Unpin"}
          </button>
          <button type="button" class="session-action" onClick={() => {
            closeMenu();
            setMoveChatError("");
            setMovingSession(session);
          }}>
            <i class="fa-solid fa-folder" aria-hidden="true" />
            Move to project…
          </button>
          <Show when={session.projectId}>
            <button type="button" class="session-action" onClick={async () => {
              closeMenu();
              try { await moveChatToProject(session.agentId, session.sessionId, null); await refreshSessions(); window.dispatchEvent(new Event("chat-projects-changed")); setSessionError(""); }
              catch { setSessionError("Unable to remove chat from project. Try again."); }
            }}>
              <i class="fa-solid fa-folder-minus" aria-hidden="true" />
              Remove from project
            </button>
          </Show>
          <button
            type="button"
            class="session-action"
            aria-label="Rename session"
            onClick={() => {
              closeMenu();
              setRenameChatError("");
              setSessionTitleInput(session.title ?? session.firstUserMessage ?? "");
              setRenamingSession(session);
            }}
          >
            <i class="fa-solid fa-pen" aria-hidden="true" />
            Rename
          </button>
          <Show when={!session.isMain}>
            <button
              type="button"
              class="session-action"
              aria-label="Archive session"
              onClick={async () => {
                closeMenu();
                setSessionError("");
                try {
                  await archiveAgentSession(session.agentId, session.sessionId, true);
                  setSessions((prev) => prev.filter((s) => s.sessionId !== session.sessionId));
                  if (chatRouteSession(location.pathname, location.search).sessionId === session.sessionId) {
                    navigate(`/chat/${session.agentId}`);
                  }
                  showToast("Chat archived", "success");
                  window.dispatchEvent(new Event("chat-projects-changed"));
                } catch (err) {
                  setSessionError(err instanceof Error ? err.message : "Failed to archive session. Try again.");
                }
              }}
            >
              <i class="fa-solid fa-box-archive" aria-hidden="true" />
              Archive
            </button>
          </Show>
          <hr class="session-menu-separator" />
          <button
            type="button"
            class="session-action danger"
            aria-label="Delete session"
            onClick={() => {
              closeMenu();
              setDeletingSession(session);
            }}
          >
            <i class="fa-solid fa-trash" aria-hidden="true" />
            Delete
          </button>
        </SidebarMenu>
      </div>
    );
  };
  return (
    <aside class="agent-sidebar" classList={{ collapsed: props.collapsed(), "menu-open": !!openMenu() }} onMouseEnter={() => setSidebarHovered(true)} onMouseLeave={() => { setSidebarHovered(false); hideTooltip(); }}>
      <Show when={tooltip()}>{(details) => (
        <div class="session-tooltip" role="tooltip" ref={(element) => queueMicrotask(() => {
          if (!element.isConnected) return;
          const rect = details().row.getBoundingClientRect();
          element.style.left = `${Math.max(8, Math.min(rect.right + 8, window.innerWidth - element.offsetWidth - 8))}px`;
          element.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - element.offsetHeight - 8))}px`;
        })}>
          {sessionDetails(details().session)}
        </div>
      )}</Show>
      <div class="agent-sidebar-shell">
        <div class="sidebar-header">
          <A class="sidebar-logo" href="/">
            <Show
              when={capabilities.branding?.name || capabilities.branding?.logo}
              fallback={
                <>
                  <span class="logo-full">Yoplai</span>
                  <span class="logo-short">Yo</span>
                </>
              }
            >
              <Show when={capabilities.branding?.logo}>
                <img class="sidebar-brand-logo" src={capabilities.branding!.logo} alt="" />
              </Show>
              <Show when={capabilities.branding?.name}>
                <span class="logo-full">{capabilities.branding!.name}</span>
                <span class="logo-short">{capabilities.branding!.name!.substring(0, 2).toUpperCase()}</span>
              </Show>
            </Show>
          </A>
          <Show when={import.meta.env.VITE_YOPLAI_DEV === "true" || import.meta.env.VITE_AIHUB_DEV === "true"}>
            <span class="dev-badge">DEV</span>
          </Show>
          <button
            class="collapse-btn"
            type="button"
            onClick={props.onToggleCollapse}
          >
            «
          </button>
        </div>
        <div class="sidebar-content">
          <nav class="sidebar-nav" aria-label="Primary">
            <button type="button" class="nav-link sidebar-search" aria-label="Search" title="Search (Cmd/Ctrl+K)" onClick={openSessionSearch}>
              <i class="fa-solid fa-magnifying-glass nav-icon" aria-hidden="true" />
              <span class="nav-full">Search</span>
            </button>
            <Show when={isExtensionEnabled("projects")}>
              <A
                href="/projects"
                class="nav-link"
                classList={{
                  active: stripBase(location.pathname).startsWith("/projects"),
                }}
                title="Board"
              >
                <i class="fa-solid fa-folder-tree nav-icon" aria-hidden="true" />
                <span class="nav-full">Board</span>
              </A>
            </Show>
            <Show when={isExtensionEnabled("orchestrator")}>
              <A
                href="/orchestrator"
                class="nav-link"
                classList={{
                  active: stripBase(location.pathname).startsWith("/orchestrator"),
                }}
                title="Orchestrator"
              >
                <i class="fa-solid fa-diagram-project nav-icon" aria-hidden="true" />
                <span class="nav-full">Orchestrator</span>
              </A>
            </Show>
            <A
              href="/agents"
              class="nav-link"
              classList={{
                active:
                  stripBase(location.pathname).startsWith("/agents") ||
                  stripBase(location.pathname).startsWith("/chat"),
              }}
              title="Agents"
            >
              <i class="fa-solid fa-comments nav-icon" aria-hidden="true" />
              <span class="nav-full">Agents</span>
            </A>
            <A href="/skills" class="nav-link" classList={{ active: stripBase(location.pathname).startsWith("/skills") }} title="Skills" data-tour="nav-skills">
              <i class="fa-solid fa-book-open nav-icon" aria-hidden="true" />
              <span class="nav-full">Skills</span>
            </A>
            <A href="/dashboards" class="nav-link" classList={{ active: stripBase(location.pathname).startsWith("/dashboards") }} title="Dashboards">
              <i class="fa-solid fa-chart-line nav-icon" aria-hidden="true" />
              <span class="nav-full">Dashboards</span>
            </A>
            <Show when={capabilities.multiUser && capabilities.forkedAgents}>
              <A
                href="/teams"
                class="nav-link"
                classList={{
                  active: stripBase(location.pathname).startsWith("/teams"),
                }}
                title="Teams"
              >
                <i class="fa-solid fa-users nav-icon" aria-hidden="true" />
                <span class="nav-full">Teams</span>
              </A>
            </Show>
            <Show
              when={
                !capabilities.multiUser || hasAdminRole(capabilities.user?.role)
              }
            >
              <A
                href={capabilities.multiUser ? "/admin/users" : "/admin/extensions"}
                class="nav-link"
                classList={{
                  active: stripBase(location.pathname).startsWith("/admin/"),
                }}
                title="Admin"
              >
                <i class="fa-solid fa-shield-halved nav-icon" aria-hidden="true" />
                <span class="nav-full">Admin</span>
              </A>
            </Show>
          </nav>
          <section class="sidebar-sessions" aria-label="Sessions">
            <Show when={sessionError()}>
              <div role="alert">{sessionError()}</div>
            </Show>
            <div class="sessions-list" classList={{ scrolling: listScrolling() }} onScroll={onListScroll}>
              <section class="sessions-section" aria-label="Projects">
                <div class="sessions-header">
                  <span>Projects</span>
                  <button
                    type="button"
                    class="new-project-btn"
                    aria-label="New project"
                    onClick={() => setShowCreateProject(true)}
                  >
                    <i class="fa-solid fa-plus" aria-hidden="true" />
                  </button>
                </div>
                <For each={projects()}>{(project) => {
                  const isActive = () => location.pathname === `/p/${project.id}`;
                  return (
                    <div class="chat-project">
                    <div class="session-row-wrap">
                      <button type="button" class="chat-project-header" classList={{ active: isActive() }} aria-label={project.name} aria-current={isActive() ? "page" : undefined} aria-expanded={!collapsedProjects().includes(project.id)} onClick={() => {
                          const next = collapsedProjects().includes(project.id) ? collapsedProjects().filter((id) => id !== project.id) : [...collapsedProjects(), project.id];
                          setCollapsedProjects(next);
                          localStorage.setItem("yoplai:collapsed-chat-projects", JSON.stringify(next));
                        }}>
                        <i class="fa-solid fa-folder project-icon" aria-hidden="true" />
                        <Show when={collapsedProjects().includes(project.id) && sessions().some((session) => session.projectId === project.id && isChatUnread(session))}>
                          <span class="session-unread-dot" role="img" aria-label="Unread messages" />
                        </Show>
                        <span class="project-name">{project.name}</span>
                      </button>
                      <SidebarMenu label="Project menu">
                          <A href={`/p/${project.id}`} class="session-action" onClick={closeMenu}>Open</A>
                          <button
                            type="button"
                            class="session-action"
                            onClick={() => {
                              closeMenu();
                              setRenameProjectError("");
                              setProjectNameInput(project.name);
                              setRenamingProject(project);
                            }}
                          >
                            Rename…
                          </button>
                          <button
                            type="button"
                            class="session-action danger"
                            onClick={() => {
                              closeMenu();
                              setDeleteProjectError("");
                              setDeletingProject(project);
                            }}
                          >
                            Delete…
                          </button>
                      </SidebarMenu>
                    </div>
                      <Show when={!collapsedProjects().includes(project.id)}>
                        <div class="chat-project-sessions">
                          <For each={sessions().filter((session) => session.projectId === project.id).sort((a, b) => Number(b.pinned != null) - Number(a.pinned != null) || b.lastActivity - a.lastActivity)}>{renderSession}</For>
                        </div>
                      </Show>
                    </div>
                  );
                }}</For>
              </section>
              <For each={sessionsInSection(true).length > 0 ? [true, false] : [false]}>
                {(pinned) => (
                  <section class="sessions-section" aria-label={pinned ? "Pinned" : "Recent"}>
                    <div class="sessions-header">{pinned ? "Pinned" : "Recent"}</div>
                    <For each={groupLabels(pinned)}>
                      {(group) => (
                        <div class="sessions-group">
                          <div class="sessions-group-label">{group}</div>
                          <For each={sessionsInGroup(pinned, group)}>
                            {renderSession}
                          </For>
                        </div>
                      )}
                    </For>
                  </section>
                )}
              </For>
            </div>
          </section>
        </div>
        <Show when={showCreateProject()}>
          <CreateProjectModal
            onClose={() => setShowCreateProject(false)}
            onSuccess={() => void refreshProjects()}
          />
        </Show>
        <Show when={renamingProject()}>{(proj) => (
          <Modal
            title="Rename project"
            onClose={() => setRenamingProject(null)}
            size="sm"
            dismissible={!renaming()}
            error={renameProjectError()}
            footer={
              <>
                <Button variant="secondary" onClick={() => setRenamingProject(null)} disabled={renaming()}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={async () => {
                    const trimmed = projectNameInput().trim();
                    if (!trimmed) return;
                    setRenaming(true);
                    setRenameProjectError("");
                    try {
                      await renameChatProject(proj().id, trimmed);
                      await refreshProjects();
                      window.dispatchEvent(new Event("chat-projects-changed"));
                      setRenamingProject(null);
                    } catch {
                      setRenameProjectError("Unable to rename project. Try again.");
                    } finally {
                      setRenaming(false);
                    }
                  }}
                  disabled={!projectNameInput().trim() || renaming()}
                  loading={renaming()}
                >
                  Rename
                </Button>
              </>
            }
          >
            <TextField
              label="Name"
              value={projectNameInput()}
              onInput={(e) => setProjectNameInput(e.currentTarget.value)}
              disabled={renaming()}
              autofocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && projectNameInput().trim()) {
                  e.preventDefault();
                  document.querySelector<HTMLButtonElement>(".ui-modal__footer .ui-button--primary")?.click();
                }
              }}
            />
          </Modal>
        )}</Show>
        <Show when={deletingProject()}>{(proj) => (
          <ConfirmDialog
            title={`Delete "${proj().name}"?`}
            description="Its chats are kept and go back to Recent."
            confirmLabel="Delete project"
            danger
            dismissible={!deleting()}
            onConfirm={async () => {
              setDeleting(true);
              setDeleteProjectError("");
              try {
                await deleteChatProject(proj().id);
                await refreshProjects();
                window.dispatchEvent(new Event("chat-projects-changed"));
                if (location.pathname === `/p/${proj().id}`) {
                  navigate("/agents");
                }
                setDeletingProject(null);
              } catch {
                setDeleteProjectError("Unable to delete project. Try again.");
              } finally {
                setDeleting(false);
              }
            }}
            onCancel={() => setDeletingProject(null)}
            error={deleteProjectError()}
          />
        )}</Show>
        <Show when={renamingSession()}>{(sess) => (
          <Modal
            title="Rename chat"
            onClose={() => setRenamingSession(null)}
            size="sm"
            dismissible={!renaming()}
            error={renameChatError()}
            footer={
              <>
                <Button variant="secondary" onClick={() => setRenamingSession(null)} disabled={renaming()}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={async () => {
                    setRenaming(true);
                    setRenameChatError("");
                    try {
                      await renameAgentSession(sess().agentId, sess().sessionId, sessionTitleInput());
                      await refreshSessions();
                      window.dispatchEvent(new Event("chat-projects-changed"));
                      setRenamingSession(null);
                    } catch {
                      setRenameChatError("Unable to rename chat. Try again.");
                    } finally {
                      setRenaming(false);
                    }
                  }}
                  disabled={renaming()}
                  loading={renaming()}
                >
                  Rename
                </Button>
              </>
            }
          >
            <TextField
              label="Title"
              value={sessionTitleInput()}
              onInput={(e) => setSessionTitleInput(e.currentTarget.value)}
              disabled={renaming()}
              autofocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  document.querySelector<HTMLButtonElement>(".ui-modal__footer .ui-button--primary")?.click();
                }
              }}
            />
          </Modal>
        )}</Show>
        <Show when={deletingSession()}>{(sess) => (
          <ConfirmDialog
            title="Delete this chat?"
            description="This can't be undone."
            confirmLabel="Delete chat"
            danger
            onConfirm={async () => {
              const selected = currentChat().agentId === sess().agentId && currentChat().sessionId === sess().sessionId;
              await deleteAgentSession(sess().agentId, sess().sessionId);
              setSessions((items) =>
                items.filter((item) => item.sessionId !== sess().sessionId || item.agentId !== sess().agentId)
              );
              window.dispatchEvent(new Event("chat-projects-changed"));
              if (selected) navigate(`/chat/${encodeURIComponent(sess().agentId)}`);
              setDeletingSession(null);
            }}
            onCancel={() => setDeletingSession(null)}
          />
        )}</Show>
        <Show when={movingSession()}>{(session) => (
          <Modal
            title="Move to project"
            onClose={() => setMovingSession(null)}
            size="sm"
            error={moveChatError()}
            footer={
              <Button variant="secondary" onClick={() => setMovingSession(null)}>
                Cancel
              </Button>
            }
          >
            <div class="project-move-list">
              <Show when={projects().length === 0}>
                <p class="project-move-empty">No projects available.</p>
              </Show>
              <For each={projects()}>{(project) => (
                <button
                  type="button"
                  class="project-move-row"
                  onClick={async () => {
                    setMoveChatError("");
                    try {
                      await moveChatToProject(session().agentId, session().sessionId, project.id);
                      setMovingSession(null);
                      await refreshSessions();
                      window.dispatchEvent(new Event("chat-projects-changed"));
                    } catch {
                      setMoveChatError("Unable to move chat. Try again.");
                    }
                  }}
                >
                  <i class="fa-solid fa-folder" aria-hidden="true" />
                  <span>{project.name}</span>
                </button>
              )}</For>
              <Show when={session().projectId}>
                <button
                  type="button"
                  class="project-move-row project-move-row--remove"
                  onClick={async () => {
                    setMoveChatError("");
                    try {
                      await moveChatToProject(session().agentId, session().sessionId, null);
                      setMovingSession(null);
                      await refreshSessions();
                      window.dispatchEvent(new Event("chat-projects-changed"));
                    } catch {
                      setMoveChatError("Unable to remove chat from project. Try again.");
                    }
                  }}
                >
                  Remove from project
                </button>
              </Show>
            </div>
          </Modal>
        )}</Show>
        <div class="sidebar-footer">
          <Show when={capabilities.multiUser}>
            <Suspense>
              <LazySidebarAccountPanel collapsed={props.collapsed} />
            </Suspense>
          </Show>
          <Show when={!capabilities.multiUser}>
            <A href="/archive" class="archive-link" title="Archive">
              <i class="fa-solid fa-box-archive" aria-hidden="true" />
              <span class="archive-label">Archive</span>
            </A>
          </Show>
          <button
            class="theme-toggle"
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme() === "dark" ? "light" : "dark"} mode`}
          >
            <Show
              when={theme() === "dark"}
              fallback={
                <svg class="theme-icon" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
                </svg>
              }
            >
              <svg class="theme-icon" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fill-rule="evenodd"
                  d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z"
                  clip-rule="evenodd"
                />
              </svg>
            </Show>
            <span class="theme-label">
              {theme() === "dark" ? "Light" : "Dark"}
            </span>
          </button>
          <Show when={capabilities.multiUser && capabilities.user}>
            <div class="tour-links">
              <button
                type="button"
                class="tour-restart"
                onClick={() => {
                  void restartTour()
                    .then(() => navigate("/"))
                    .catch(() => undefined);
                }}
              >
                Restart tour
              </button>
              <Show when={hasTopExtensions() && chatRouteSession(location.pathname, location.search).agentId}>
                {(agentId) => (
                  <button
                    type="button"
                    class="tour-restart"
                    onClick={() => openConnectPrompt(agentId())}
                  >
                    Connect tools
                  </button>
                )}
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <style>{`
        .chat-project-header {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          min-width: 0;
          padding: 8px 40px 8px 6px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: var(--text-primary);
          font: inherit;
          font-size: 12px;
          text-align: left;
          cursor: pointer;
        }
        .chat-project-header:hover,
        .chat-project-header.active {
          background: var(--bg-raised);
        }
        .chat-project-header:focus-visible {
          outline: 2px solid var(--text-secondary);
          outline-offset: -2px;
        }
        .project-icon {
          flex-shrink: 0;
          font-size: 11px;
          color: var(--text-tertiary);
        }
        .project-name {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .project-move-list {
          display: flex;
          flex-direction: column;
          gap: 0;
        }
        .project-move-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 12px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: var(--text-primary);
          font-size: 13px;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          transition: background 150ms;
        }
        .project-move-row:hover {
          background: var(--bg-raised);
        }
        .project-move-row i {
          color: var(--text-tertiary);
          font-size: 12px;
        }
        .project-move-row--remove {
          margin-top: 8px;
          padding-top: 12px;
          border-top: 1px solid var(--border-subtle);
          color: var(--tone-error, #dc2626);
        }
        .project-move-empty {
          margin: 0 0 12px;
          padding: 12px;
          text-align: center;
          font-size: 13px;
          color: var(--text-secondary);
        }
        .agent-sidebar {
          position: relative;
          z-index: 40;
          width: 250px;
          min-width: 250px;
          flex-shrink: 0;
          overflow: visible;
        }

        .agent-sidebar-shell {
          position: relative;
          width: 100%;
          height: 100%;
          background: var(--bg-surface);
          border-right: 1px solid var(--border-default);
          display: flex;
          flex-direction: column;
          transition: width 0.2s ease, box-shadow 0.2s ease;
          overflow: hidden;
        }

        .agent-sidebar.collapsed {
          width: 50px;
          min-width: 50px;
        }

        .agent-sidebar.collapsed .agent-sidebar-shell {
          position: absolute;
          inset: 0 auto 0 0;
          width: 50px;
        }

        .agent-sidebar.collapsed:is(:hover, .menu-open) .agent-sidebar-shell {
          width: 250px;
          box-shadow: 12px 0 24px var(--shadow-md);
        }

        .sidebar-header {
          padding: 10px 10px;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .dev-badge {
          background: #f59e0b;
          color: #fff;
          font-size: 10px;
          font-weight: 700;
          padding: 2px 6px;
          border-radius: 4px;
          letter-spacing: 0.05em;
          flex-shrink: 0;
          transition: opacity 0.2s ease;
        }

        .collapse-btn {
          margin-left: auto;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-surface);
          color: var(--text-primary);
          cursor: pointer;
          flex-shrink: 0;
        }

        .collapse-btn:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 2px;
        }

        .sidebar-content {
          flex: 1;
          min-height: 0;
          padding: 8px 10px 14px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .sidebar-sessions {
          flex: 1;
          min-height: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
          overflow: hidden;
        }

        .sessions-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11px;
          font-weight: 700;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.08em;
        }

        .sessions-header button,
        .session-action {
          border: none;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
        }

        .sessions-header .new-project-btn {
          display: grid;
          place-items: center;
          flex: 0 0 28px;
          width: 28px;
          height: 28px;
          padding: 0;
          border: 1px solid var(--border-default);
          border-radius: 6px;
          background: var(--bg-surface);
          font-size: 12px;
          line-height: 1;
        }

        .new-project-btn:hover,
        .session-actions summary:hover,
        .session-action:hover {
          background: var(--bg-raised);
          color: var(--text-primary);
        }

        .new-project-btn:focus-visible,
        .session-actions summary:focus-visible,
        .session-action:focus-visible {
          outline: 2px solid var(--text-secondary);
          outline-offset: -2px;
        }

        .sessions-list {
          flex: 1;
          min-height: 0;
          overflow: auto;
          /* Put the scrollbar gutter in the sidebar padding so right space matches left. */
          margin-right: -10px;
          padding-right: 10px;
          overflow-x: hidden;
          display: flex;
          flex-direction: column;
          gap: 10px;
          scrollbar-width: thin;
          scrollbar-color: transparent transparent;
          transition: scrollbar-color 300ms ease;
        }

        .sessions-list::-webkit-scrollbar {
          width: 6px;
        }

        .sessions-list::-webkit-scrollbar-thumb {
          background: transparent;
          border-radius: 999px;
        }

        .sessions-list.scrolling {
          scrollbar-color: var(--border-default) transparent;
        }

        .sessions-list.scrolling::-webkit-scrollbar-thumb {
          background: var(--border-default);
        }

        .sessions-group-label {
          margin: 6px 0 4px;
          font-size: 11px;
          color: var(--text-tertiary);
        }

        .session-row-wrap {
          position: relative;
          min-width: 0;
        }

        .session-row {
          width: 100%;
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 40px 7px 6px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: var(--text-primary);
          text-align: left;
          cursor: pointer;
        }

        .session-row:hover,
        .session-row.active {
          background: var(--bg-raised);
        }

        .session-avatar {
          width: 22px;
          height: 22px;
          border-radius: 999px;
          display: inline-grid;
          place-items: center;
          background: var(--accent-bg, rgba(59, 130, 246, 0.14));
          color: var(--accent, #3b82f6);
          font-size: 11px;
          font-weight: 700;
          flex-shrink: 0;
          overflow: hidden;
        }

        .session-avatar img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .session-main {
          min-width: 0;
          flex: 1;
        }

        .session-unread-dot {
          width: 6px;
          height: 6px;
          flex-shrink: 0;
          border-radius: 50%;
          background: var(--accent, #3b82f6);
        }

        .session-title {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .session-title {
          font-size: 12px;
        }

        .session-description {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip-path: inset(50%);
          white-space: nowrap;
        }

        .session-tooltip {
          position: fixed;
          z-index: 1000;
          width: 280px;
          max-width: calc(100vw - 16px);
          box-sizing: border-box;
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding: 10px 12px;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: 0 4px 12px var(--shadow-md);
          color: var(--text-secondary);
          font-size: 11px;
          pointer-events: none;
        }

        .session-tooltip strong,
        .session-tooltip > span:first-of-type {
          width: 100%;
          overflow-wrap: anywhere;
        }

        .session-tooltip strong {
          color: var(--text-primary);
          font-size: 12px;
        }

        .session-tooltip b {
          color: var(--accent, #3b82f6);
          font-size: 10px;
        }

        .session-actions {
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          display: flex;
          align-items: center;
          padding-left: 18px;
          padding-right: 4px;
          gap: 2px;
          opacity: 0;
          pointer-events: none;
          background: linear-gradient(to right, transparent, var(--bg-raised) 40%);
          border-radius: 0 8px 8px 0;
        }

        .session-row-wrap:hover .session-actions,
        .session-row-wrap:focus-within .session-actions {
          opacity: 1;
          pointer-events: auto;
        }

        .session-actions[open] {
          opacity: 1;
          pointer-events: auto;
          z-index: 1;
        }

        .session-actions summary {
          display: grid;
          place-items: center;
          width: 28px;
          height: 28px;
          border-radius: 6px;
          cursor: pointer;
          list-style: none;
          font-size: 18px;
          line-height: 1;
        }

        .session-actions summary::-webkit-details-marker {
          display: none;
        }

        .chat-project-sessions {
          padding-left: 14px;
        }

        .session-menu {
          white-space: nowrap;
          min-width: min(160px, calc(100vw - 16px));
          max-width: calc(100vw - 16px);
          max-height: calc(100dvh - 16px);
          box-sizing: border-box;
          overflow: auto;
          position: fixed;
          z-index: 1000;
          display: flex;
          flex-direction: column;
          padding: 4px;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--bg-surface);
          box-shadow: 0 4px 12px var(--shadow-md);
        }

        .session-action {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          text-align: left;
          text-decoration: none;
          font-family: inherit;
          font-size: 12px;
        }

        .session-action i {
          width: 16px;
          text-align: center;
        }

        .session-action.danger {
          color: #ef4444;
        }

        .session-menu-separator {
          margin: 4px 0;
          border: none;
          border-top: 1px solid var(--border-default);
        }

        .agent-sidebar.collapsed:not(:hover):not(.menu-open) .sidebar-sessions {
          display: none;
        }

        .sidebar-footer {
          padding: 8px 10px 10px;
          border-top: 1px solid var(--border-default);
        }

        .archive-link {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 8px 10px;
          border-radius: 8px;
          background: transparent;
          color: var(--text-secondary);
          text-decoration: none;
          cursor: pointer;
          font-size: 14px;
          line-height: 1.2;
          transition: background 0.2s ease, color 0.2s ease;
          white-space: nowrap;
        }

        .archive-link:hover {
          background: var(--bg-raised);
          color: var(--text-primary);
        }

        .archive-link i {
          width: 16px;
          text-align: center;
        }

        .agent-sidebar.collapsed .archive-label {
          display: none;
        }

        .theme-toggle {
          display: flex;
          align-items: center;
          gap: 8px;
          width: 100%;
          padding: 8px 10px;
          border-radius: 8px;
          border: none;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 14px;
          line-height: 1.2;
          transition: background 0.2s ease, color 0.2s ease;
          white-space: nowrap;
        }

        .theme-toggle:hover {
          background: var(--bg-raised);
          color: var(--text-primary);
        }

        .tour-links {
          display: flex;
          gap: 10px;
          margin: 2px 0 0 10px;
        }

        .tour-restart {
          display: block;
          margin: 0;
          padding: 0;
          border: none;
          background: none;
          color: var(--text-muted, var(--text-secondary));
          opacity: 0.6;
          font-size: 11px;
          cursor: pointer;
        }

        .tour-restart:hover {
          opacity: 1;
          text-decoration: underline;
        }

        .theme-icon {
          width: 16px;
          height: 16px;
          flex-shrink: 0;
        }

        .sidebar-logo {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          color: var(--text-primary);
          text-decoration: none;
          font-size: 20px;
          font-weight: 600;
          line-height: 1.1;
          letter-spacing: 0.02em;
          transition: opacity 0.2s ease, transform 0.2s ease;
          transform-origin: left center;
          white-space: nowrap;
        }

        .logo-full {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .sidebar-brand-logo {
          height: 22px;
          width: auto;
          flex-shrink: 0;
          object-fit: contain;
        }

        .sidebar-logo:hover {
          color: var(--text-secondary);
        }

        .sidebar-nav {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .nav-link {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 8px 10px;
          border-radius: 8px;
          color: var(--text-secondary);
          text-decoration: none;
          font-size: 14px;
          line-height: 1.2;
          transition: background 0.2s ease, color 0.2s ease;
          white-space: nowrap;
        }

        .nav-link:hover {
          background: var(--bg-raised);
          color: var(--text-primary);
        }

        .sidebar-search {
          width: 100%;
          border: none;
          background: transparent;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
        }

        .sidebar-search:focus-visible {
          outline: 2px solid var(--text-secondary);
          outline-offset: -2px;
        }

        .nav-link.active {
          background: var(--border-default);
          color: var(--text-primary);
        }

        .nav-icon {
          width: 16px;
          flex: 0 0 16px;
          text-align: center;
        }

        /* Collapsed/expanded toggle for dual-content elements */
        .logo-short {
          display: none;
        }

        .agent-sidebar.collapsed .logo-full,
        .agent-sidebar.collapsed .nav-full,
        .agent-sidebar.collapsed .dev-badge,
        .agent-sidebar.collapsed .collapse-btn,
        .agent-sidebar.collapsed .theme-label,
        .agent-sidebar.collapsed .sidebar-recent {
          display: none;
        }

        .agent-sidebar.collapsed .logo-short {
          display: inline;
        }

        .agent-sidebar.collapsed .sidebar-header {
          justify-content: center;
          padding: 10px 0;
        }

        .agent-sidebar.collapsed .sidebar-logo {
          gap: 0;
          justify-content: center;
          width: 100%;
        }

        .agent-sidebar.collapsed .sidebar-logo .logo-short {
          display: none;
        }

        .agent-sidebar.collapsed .nav-link {
          justify-content: center;
          padding: 8px 4px;
        }

        .agent-sidebar.collapsed .theme-toggle {
          justify-content: center;
        }

        /* Hover to expand: restore full content */
        .agent-sidebar.collapsed:is(:hover, .menu-open) .logo-full,
        .agent-sidebar.collapsed:is(:hover, .menu-open) .nav-full,
        .agent-sidebar.collapsed:is(:hover, .menu-open) .dev-badge,
        .agent-sidebar.collapsed:is(:hover, .menu-open) .collapse-btn,
        .agent-sidebar.collapsed:is(:hover, .menu-open) .theme-label,
        .agent-sidebar.collapsed:is(:hover, .menu-open) .sidebar-recent {
          display: revert;
        }

        .agent-sidebar.collapsed:is(:hover, .menu-open) .logo-short {
          display: none;
        }

        .agent-sidebar.collapsed:is(:hover, .menu-open) .sidebar-header {
          justify-content: unset;
          padding: 10px 10px;
        }

        .agent-sidebar.collapsed:is(:hover, .menu-open) .sidebar-logo {
          flex: 1;
          gap: 8px;
          justify-content: unset;
          width: auto;
        }

        .agent-sidebar.collapsed:is(:hover, .menu-open) .nav-link {
          justify-content: flex-start;
          padding: 8px 10px;
        }

        .agent-sidebar.collapsed:is(:hover, .menu-open) .theme-toggle {
          justify-content: unset;
        }

        @media (max-width: 768px) {
          .agent-sidebar {
            position: fixed;
            top: 0;
            left: 0;
            width: 250px;
            min-width: 250px;
            height: 100%;
            height: 100dvh;
            z-index: 850;
            transform: translateX(0);
            transition: transform 0.2s ease;
          }

          .agent-sidebar-shell {
            width: 100%;
            box-shadow: 12px 0 24px var(--shadow-md);
          }

          .agent-sidebar.collapsed {
            width: 250px;
            min-width: 250px;
            transform: translateX(-100%);
          }

          .agent-sidebar.collapsed .agent-sidebar-shell,
          .agent-sidebar.collapsed:is(:hover, .menu-open) .agent-sidebar-shell {
            position: relative;
            inset: auto;
            width: 100%;
            box-shadow: none;
          }
        }
      `}</style>
    </aside>
  );
}
