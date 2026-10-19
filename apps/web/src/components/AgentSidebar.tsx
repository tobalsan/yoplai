import {
  Accessor,
  For,
  Suspense,
  Show,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  lazy,
} from "solid-js";
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

/** Slide an overflowing session title left so its tail clears the hover action icons. */
function revealTitle(wrap: HTMLElement): void {
  const title = wrap.querySelector<HTMLElement>(".session-title");
  const text = wrap.querySelector<HTMLElement>(".session-title-text");
  const actions = wrap.querySelector<HTMLElement>(".session-actions");
  if (!title || !text) return;
  // Only titles clipped at rest scroll; a fitting title stays put even if the
  // hover icons cover its tail.
  const overflowing = text.scrollWidth > title.clientWidth;
  wrap.classList.toggle("overflowing", overflowing);
  if (!overflowing) return;
  const reserve = actions?.offsetWidth ?? 0;
  const shift = text.scrollWidth + reserve - title.clientWidth;
  // Forward travel fills 30% of the loop (see keyframes); the rest is pauses and the return.
  const travelMs = Math.max(1200, shift * 16);
  wrap.style.setProperty("--title-shift", `${shift}px`);
  wrap.style.setProperty("--title-loop-ms", `${Math.round(travelMs / 0.3)}ms`);
}

function resetTitle(wrap: HTMLElement): void {
  wrap.classList.remove("overflowing");
  wrap.style.removeProperty("--title-shift");
  wrap.style.removeProperty("--title-loop-ms");
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
  const [search, setSearch] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [listScrolling, setListScrolling] = createSignal(false);
  let scrollIdleTimer: ReturnType<typeof setTimeout> | undefined;
  const onListScroll = () => {
    setListScrolling(true);
    clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => setListScrolling(false), 700);
  };

  let pollStopped = false;

  const refreshSessions = async () => {
    if (pollStopped || document.visibilityState !== "visible") return;
    try {
      const res = await fetchAgentSessions();
      setSessions(res.items);
    } catch (err) {
      if (err instanceof UnauthenticatedError) {
        pollStopped = true;
        navigate("/login");
      }
    }
  };

  const refreshProjects = async () => {
    try { setProjects((await fetchChatProjects()).items); }
    catch { setSessionError("Unable to load projects. Try again."); }
  };
  const refresh = () => { void refreshSessions(); void refreshProjects(); };
  createEffect(refresh);
  window.addEventListener("chat-projects-changed", refresh);
  onCleanup(() => window.removeEventListener("chat-projects-changed", refresh));
  const poll = window.setInterval(refresh, 3000);
  const clock = window.setInterval(() => setCurrentTime(Date.now()), 60000);
  window.addEventListener("focus", refreshSessions);
  document.addEventListener("visibilitychange", refreshSessions);
  onCleanup(() => {
    clearTimeout(scrollIdleTimer);
    window.clearInterval(poll);
    window.clearInterval(clock);
    window.removeEventListener("focus", refreshSessions);
    document.removeEventListener("visibilitychange", refreshSessions);
  });

  // Close session/project menus on outside click or Escape
  onMount(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const openMenus = document.querySelectorAll<HTMLDetailsElement>("details.session-actions[open]");
      openMenus.forEach((menu) => {
        if (!menu.contains(event.target as Node)) {
          menu.removeAttribute("open");
        }
      });
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        const openMenus = document.querySelectorAll<HTMLDetailsElement>("details.session-actions[open]");
        openMenus.forEach((menu) => menu.removeAttribute("open"));
      }
    };

    // Close other menus when opening one
    const handleToggle = (event: Event) => {
      const menu = event.target as HTMLDetailsElement;
      if (menu.open && menu.classList.contains("session-actions")) {
        document.querySelectorAll<HTMLDetailsElement>("details.session-actions[open]").forEach((otherMenu) => {
          if (otherMenu !== menu) {
            otherMenu.removeAttribute("open");
          }
        });
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("toggle", handleToggle, true);

    onCleanup(() => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("toggle", handleToggle, true);
    });
  });

  const visibleSessions = () => {
    const query = search().trim().toLowerCase();
    return query
      ? sessions().filter((item) =>
          `${item.title ?? ""} ${item.firstUserMessage}`.toLowerCase().includes(query)
        )
      : sessions();
  };

  const sessionsInSection = (pinned: boolean) =>
    visibleSessions().filter((item) => !projects().some((project) => project.id === item.projectId) && (item.pinned != null) === pinned);
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
    const label = () => session.title || session.firstUserMessage || session.sessionId;
    return (
      <div
        class="session-row-wrap"
        onMouseEnter={(e) => revealTitle(e.currentTarget)}
        onMouseLeave={(e) => resetTitle(e.currentTarget)}
        onFocusIn={(e) => revealTitle(e.currentTarget)}
        onFocusOut={(e) => resetTitle(e.currentTarget)}
      >
        <button
          type="button"
          class="session-row"
          classList={{ active: selected() }}
          onClick={() => selectSession(session)}
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
          <span class="session-main">
            <span class="session-title">
              <span class="session-title-text">{label()}</span>
            </span>
            <span class="session-meta">
              {relativeTime(session.lastActivity, currentTime())} · {session.agentId}
              <Show when={session.isMain}> <b>MAIN</b></Show>
              <Show when={session.pinned != null}> <i class="fa-solid fa-thumbtack session-pin" aria-label="Pinned" /></Show>
            </span>
          </span>
        </button>
        <details class="session-actions">
          <summary aria-label="Session menu">⋯</summary>
          <div class="session-menu">
            <button
              type="button"
              class="session-action"
              onClick={async (event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
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
            <button type="button" class="session-action" onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              setMoveChatError("");
              setMovingSession(session);
            }}>
              <i class="fa-solid fa-folder" aria-hidden="true" />
              Move to project…
            </button>
            <Show when={session.projectId}>
              <button type="button" class="session-action" onClick={async () => {
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
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
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
                onClick={async (event) => {
                  event.currentTarget.closest("details")?.removeAttribute("open");
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
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                setDeletingSession(session);
              }}
            >
              <i class="fa-solid fa-trash" aria-hidden="true" />
              Delete
            </button>
          </div>
        </details>
      </div>
    );
  };
  return (
    <aside class="agent-sidebar" classList={{ collapsed: props.collapsed() }}>
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
            <div class="sessions-header">
              <span>Sessions</span>
              <button
                type="button"
                aria-label="Search sessions"
                aria-pressed={searchOpen()}
                onClick={() => {
                  setSearchOpen((open) => !open);
                  if (searchOpen()) return;
                  setSearch("");
                }}
              >
                ⌕
              </button>
            </div>
            <Show when={sessionError()}>
              <div role="alert">{sessionError()}</div>
            </Show>
            <Show when={searchOpen()}>
              <input
                class="sessions-search"
                placeholder="Search sessions"
                value={search()}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
            </Show>
            <div class="sessions-list" classList={{ scrolling: listScrolling() }} onScroll={onListScroll}>
              <section class="sessions-section" aria-label="Projects">
                <div class="sessions-header">
                  <span>Projects</span>
                  <button
                    type="button"
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
                      <div class="chat-project-header">
                        <button type="button" class="project-chevron" aria-label={`Toggle ${project.name}`} aria-expanded={!collapsedProjects().includes(project.id)} onClick={() => {
                          const next = collapsedProjects().includes(project.id) ? collapsedProjects().filter((id) => id !== project.id) : [...collapsedProjects(), project.id];
                          setCollapsedProjects(next);
                          localStorage.setItem("yoplai:collapsed-chat-projects", JSON.stringify(next));
                        }}>{collapsedProjects().includes(project.id) ? "▸" : "▾"}</button>
                        <i class="fa-solid fa-folder project-icon" aria-hidden="true" />
                        <A href={`/p/${project.id}`} class="project-link" classList={{ active: isActive() }}>{project.name}</A>
                      </div>
                      <details class="session-actions">
                        <summary aria-label="Project menu">⋯</summary>
                        <div class="session-menu">
                          <button
                            type="button"
                            class="session-action"
                            onClick={(event) => {
                              event.currentTarget.closest("details")?.removeAttribute("open");
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
                            onClick={(event) => {
                              event.currentTarget.closest("details")?.removeAttribute("open");
                              setDeleteProjectError("");
                              setDeletingProject(project);
                            }}
                          >
                            Delete…
                          </button>
                        </div>
                      </details>
                    </div>
                      <Show when={!collapsedProjects().includes(project.id)}>
                        <div class="chat-project-sessions">
                          <For each={visibleSessions().filter((session) => session.projectId === project.id).sort((a, b) => Number(b.pinned != null) - Number(a.pinned != null) || b.lastActivity - a.lastActivity)}>{renderSession}</For>
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
          padding: 6px;
        }
        .project-chevron,
        .project-icon {
          flex-shrink: 0;
        }
        .project-chevron {
          border: none;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          padding: 2px 4px;
          font-size: 11px;
        }
        .project-icon {
          font-size: 11px;
          color: var(--text-tertiary);
        }
        .project-link {
          flex: 1;
          min-width: 0;
          color: var(--text-primary);
          text-decoration: none;
          font-size: 12px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          padding: 2px 4px;
          border-radius: 4px;
        }
        .project-link.active {
          background: var(--bg-raised);
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

        .agent-sidebar.collapsed:hover .agent-sidebar-shell {
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

        .sessions-search {
          width: 100%;
          box-sizing: border-box;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          background: var(--bg-surface);
          color: var(--text-primary);
          padding: 7px 8px;
          font-size: 12px;
        }

        .sessions-list {
          flex: 1;
          min-height: 0;
          overflow: auto;
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
          padding: 7px 6px;
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
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .session-title,
        .session-meta {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .session-title {
          font-size: 12px;
        }

        .session-title-text {
          display: inline-block;
        }

        .session-row-wrap.overflowing:hover .session-title-text,
        .session-row-wrap.overflowing:focus-within .session-title-text {
          animation: session-title-scroll var(--title-loop-ms, 3000ms) ease-in-out infinite;
        }

        /* Short pause at the start, slide to the tail, long pause to finish reading, slide back. */
        @keyframes session-title-scroll {
          0%, 8% { transform: translateX(0); }
          38%, 78% { transform: translateX(calc(-1 * var(--title-shift, 0px))); }
          100% { transform: translateX(0); }
        }

        .session-row-wrap:hover .session-title,
        .session-row-wrap:focus-within .session-title {
          text-overflow: clip;
        }

        .session-meta {
          font-size: 11px;
          color: var(--text-tertiary);
        }

        .session-meta b {
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
          cursor: pointer;
          list-style: none;
          padding: 4px;
        }

        .session-pin {
          font-size: 10px;
          color: var(--text-tertiary);
        }

        .chat-project-sessions {
          padding-left: 14px;
        }

        .session-menu {
          white-space: nowrap;
          min-width: 160px;
          position: absolute;
          top: 100%;
          right: 0;
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
        }

        .session-action i {
          width: 16px;
          text-align: center;
        }

        @media (prefers-reduced-motion: reduce) {
          .session-row-wrap.overflowing:hover .session-title-text,
          .session-row-wrap.overflowing:focus-within .session-title-text {
            animation: none;
          }
        }

        .session-action.danger {
          color: #ef4444;
        }

        .session-menu-separator {
          margin: 4px 0;
          border: none;
          border-top: 1px solid var(--border-default);
        }

        .agent-sidebar.collapsed:not(:hover) .sidebar-sessions {
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
        .agent-sidebar.collapsed:hover .logo-full,
        .agent-sidebar.collapsed:hover .nav-full,
        .agent-sidebar.collapsed:hover .dev-badge,
        .agent-sidebar.collapsed:hover .collapse-btn,
        .agent-sidebar.collapsed:hover .theme-label,
        .agent-sidebar.collapsed:hover .sidebar-recent {
          display: revert;
        }

        .agent-sidebar.collapsed:hover .logo-short {
          display: none;
        }

        .agent-sidebar.collapsed:hover .sidebar-header {
          justify-content: unset;
          padding: 10px 10px;
        }

        .agent-sidebar.collapsed:hover .sidebar-logo {
          flex: 1;
          gap: 8px;
          justify-content: unset;
          width: auto;
        }

        .agent-sidebar.collapsed:hover .nav-link {
          justify-content: flex-start;
          padding: 8px 10px;
        }

        .agent-sidebar.collapsed:hover .theme-toggle {
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
          .agent-sidebar.collapsed:hover .agent-sidebar-shell {
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
