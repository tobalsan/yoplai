import {
  Accessor,
  For,
  Suspense,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  lazy,
} from "solid-js";
import { A, useLocation, useNavigate } from "@solidjs/router";
import { theme, toggleTheme } from "../theme";
import { capabilities, isExtensionEnabled } from "../lib/capabilities";
import {
  deleteAgentSession,
  fetchAgentSessions,
  renameAgentSession,
  UnauthenticatedError,
} from "../api";
import type { SessionSummary } from "../api/types";

type AgentSidebarProps = {
  collapsed: Accessor<boolean>;
  onToggleCollapse: () => void;
};

const LazySidebarAccountPanel = lazy(
  () => import("../auth/SidebarAccountPanel")
);

const STAFF_ROLES = ["admin", "superadmin"];

function hasAdminRole(role: string | string[] | null | undefined): boolean {
  if (Array.isArray(role)) return role.some((r) => STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

const basePath = import.meta.env.BASE_URL?.replace(/\/+$/, "") ?? "";

/** Strip the Vite base prefix from a router pathname. */
function stripBase(pathname: string): string {
  if (basePath && pathname.startsWith(basePath)) {
    return pathname.slice(basePath.length) || "/";
  }
  return pathname;
}

function relativeTime(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function groupLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
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

function chatRouteSession(pathname: string, search: string): { agentId?: string; sessionId?: string } {
  const match = stripBase(pathname).match(/^\/chat\/([^/?]+)/);
  const params = new URLSearchParams(search);
  return {
    agentId: match ? decodeURIComponent(match[1]) : undefined,
    sessionId: params.get("session") ?? undefined,
  };
}

export function AgentSidebar(props: AgentSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const [search, setSearch] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);

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

  createEffect(refreshSessions);
  const poll = window.setInterval(refreshSessions, 3000);
  window.addEventListener("focus", refreshSessions);
  document.addEventListener("visibilitychange", refreshSessions);
  onCleanup(() => {
    window.clearInterval(poll);
    window.removeEventListener("focus", refreshSessions);
    document.removeEventListener("visibilitychange", refreshSessions);
  });

  const visibleSessions = () => {
    const query = search().trim().toLowerCase();
    return query
      ? sessions().filter((item) =>
          `${item.title ?? ""} ${item.firstUserMessage}`.toLowerCase().includes(query)
        )
      : sessions();
  };

  const groupedSessions = () => {
    const groups: Array<{ label: string; items: SessionSummary[] }> = [];
    for (const session of visibleSessions()) {
      const label = groupLabel(session.lastActivity);
      let group = groups.find((item) => item.label === label);
      if (!group) {
        group = { label, items: [] };
        groups.push(group);
      }
      group.items.push(session);
    }
    return groups;
  };

  const currentChat = () => chatRouteSession(location.pathname, location.search);
  const selectSession = (session: SessionSummary) => {
    navigate(`/chat/${encodeURIComponent(session.agentId)}?session=${encodeURIComponent(session.sessionId)}`);
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
              >
                <span class="nav-full">Projects</span>
                <span class="nav-short">Pr</span>
              </A>
            </Show>
            <Show when={isExtensionEnabled("orchestrator")}>
              <A
                href="/orchestrator"
                class="nav-link"
                classList={{
                  active: stripBase(location.pathname).startsWith("/orchestrator"),
                }}
              >
                <span class="nav-full">Orchestrator</span>
                <span class="nav-short">Or</span>
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
            >
              <span class="nav-full">Agents</span>
              <span class="nav-short">Ag</span>
            </A>
            <Show when={capabilities.multiUser && capabilities.forkedAgents}>
              <A
                href="/teams"
                class="nav-link"
                classList={{
                  active: stripBase(location.pathname).startsWith("/teams"),
                }}
              >
                <span class="nav-full">Teams</span>
                <span class="nav-short">Te</span>
              </A>
            </Show>
            <Show
              when={
                capabilities.multiUser && hasAdminRole(capabilities.user?.role)
              }
            >
              <A
                href="/admin/users"
                class="nav-link"
                classList={{
                  active: stripBase(location.pathname).startsWith("/admin/"),
                }}
              >
                <span class="nav-full">Admin</span>
                <span class="nav-short">Ad</span>
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
            <Show when={searchOpen()}>
              <input
                class="sessions-search"
                placeholder="Search sessions"
                value={search()}
                onInput={(event) => setSearch(event.currentTarget.value)}
              />
            </Show>
            <div class="sessions-list">
              <For each={groupedSessions()}>
                {(group) => (
                  <div class="sessions-group">
                    <div class="sessions-group-label">{group.label}</div>
                    <For each={group.items}>
                      {(session) => {
                        const selected = () =>
                          currentChat().agentId === session.agentId &&
                          currentChat().sessionId === session.sessionId;
                        const label = () => session.title || session.firstUserMessage || session.sessionId;
                        return (
                          <div class="session-row-wrap">
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
                                <span class="session-title">{label()}</span>
                                <span class="session-meta">
                                  {relativeTime(session.lastActivity)} · {session.agentId}
                                  <Show when={session.isMain}> <b>MAIN</b></Show>
                                </span>
                              </span>
                            </button>
                            <button
                              type="button"
                              class="session-action"
                              aria-label="Rename session"
                              onClick={async () => {
                                const title = prompt("Session title", session.title ?? session.firstUserMessage);
                                if (title === null) return;
                                await renameAgentSession(session.agentId, session.sessionId, title);
                                refreshSessions();
                              }}
                            >
                              ✎
                            </button>
                            <button
                              type="button"
                              class="session-action danger"
                              aria-label="Delete session"
                              onClick={async () => {
                                if (!confirm("Delete session?")) return;
                                await deleteAgentSession(session.agentId, session.sessionId);
                                setSessions((items) => items.filter((item) => item.sessionId !== session.sessionId || item.agentId !== session.agentId));
                                if (selected()) navigate(`/chat/${encodeURIComponent(session.agentId)}`);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </section>
        </div>
        <div class="sidebar-footer">
          <Show when={capabilities.multiUser}>
            <Suspense>
              <LazySidebarAccountPanel collapsed={props.collapsed} />
            </Suspense>
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
        </div>
      </div>

      <style>{`
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
        }

        .sessions-group-label {
          margin: 6px 0 4px;
          font-size: 11px;
          color: var(--text-tertiary);
        }

        .session-row-wrap {
          display: grid;
          grid-template-columns: 1fr auto auto;
          align-items: center;
          gap: 2px;
        }

        .session-row {
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

        .session-meta {
          font-size: 11px;
          color: var(--text-tertiary);
        }

        .session-meta b {
          color: var(--accent, #3b82f6);
          font-size: 10px;
        }

        .session-action {
          opacity: 0;
          padding: 4px;
        }

        .session-row-wrap:hover .session-action {
          opacity: 1;
        }

        .session-action.danger {
          color: #ef4444;
        }

        .agent-sidebar.collapsed:not(:hover) .sidebar-sessions {
          display: none;
        }

        .sidebar-footer {
          padding: 8px 10px 10px;
          border-top: 1px solid var(--border-default);
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
          display: block;
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

        /* Collapsed/expanded toggle for dual-content elements */
        .logo-short,
        .nav-short {
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

        .agent-sidebar.collapsed .logo-short,
        .agent-sidebar.collapsed .nav-short {
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
          text-align: center;
          padding: 8px 4px;
          font-weight: 600;
          font-size: 13px;
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

        .agent-sidebar.collapsed:hover .logo-short,
        .agent-sidebar.collapsed:hover .nav-short {
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
          text-align: unset;
          padding: 8px 10px;
          font-weight: unset;
          font-size: 14px;
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
