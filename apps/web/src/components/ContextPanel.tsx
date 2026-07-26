import {
  Accessor,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onMount,
} from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { ActivityFeed } from "./ActivityFeed";
import { AgentChat } from "./AgentChat";
import { AgentDirectory } from "./AgentDirectory";
import { fetchAgents, fetchAllSubagents, fetchProjects } from "../api";
import { isExtensionEnabled } from "../lib/capabilities";
import { readMigratedLocal } from "../lib/local-storage";

type ContextPanelProps = {
  collapsed: Accessor<boolean>;
  onToggleCollapse: () => void;
  selectedAgent: Accessor<string | null>;
  onSelectAgent: (id: string) => void;
  onClearSelection: () => void;
  onOpenProject: (id: string) => void;
};

type PanelMode = "agents" | "feed" | "chat";
type RecentProjectView = {
  id: string;
  viewedAt: number;
  title?: string;
};

const RECENT_PROJECTS_STORAGE_KEY = "yoplai:recent-project-views";
const RECENT_PROJECTS_MAX = 5;

function relativeTime(timestampMs: number): string {
  const ms = Date.now() - timestampMs;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

const basePath = import.meta.env.BASE_URL?.replace(/\/+$/, "") ?? "";

function stripBase(pathname: string): string {
  if (basePath && pathname.startsWith(basePath)) {
    return pathname.slice(basePath.length) || "/";
  }
  return pathname;
}

function readProjectIdFromPathname(pathname: string): string | null {
  const match = /^\/projects\/([^/?#]+)/.exec(stripBase(pathname));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function readRecentProjectViews(): RecentProjectView[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = readMigratedLocal(RECENT_PROJECTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentProjectView =>
          !!item &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          item.id.length > 0 &&
          typeof item.viewedAt === "number" &&
          Number.isFinite(item.viewedAt) &&
          (item.title === undefined || typeof item.title === "string")
      )
      .slice(0, RECENT_PROJECTS_MAX);
  } catch {
    return [];
  }
}

function writeRecentProjectViews(items: RecentProjectView[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ignore localStorage failures
  }
}

export function ContextPanel(props: ContextPanelProps) {
  const location = useLocation();
  const [mode, setMode] = createSignal<PanelMode>("agents");
  const [agents] = createResource(fetchAgents);
  const [subagents] = createResource(fetchAllSubagents);
  const [projects] = createResource(
    () => isExtensionEnabled("projects"),
    async (enabled) => (enabled ? fetchProjects() : [])
  );
  const [recentViews, setRecentViews] = createSignal<RecentProjectView[]>(
    readRecentProjectViews()
  );
  const storageKey = "yoplai:context-panel:mode";
  let lastSelectedAgent: string | null | undefined;
  const projectTitleById = createMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects() ?? []) {
      map.set(project.id, project.title);
    }
    return map;
  });

  const agentType = createMemo(() => {
    const selected = props.selectedAgent();
    if (!selected) return null;
    if (selected.startsWith("PRO-")) return "subagent" as const;
    return "lead" as const;
  });

  const subagentInfo = createMemo(() => {
    const selected = props.selectedAgent();
    if (!selected || !selected.startsWith("PRO-")) return undefined;
    const [projectId, token] = selected.split("/");
    if (!projectId || !token) return undefined;
    const items = subagents()?.items ?? [];
    const match = items.find(
      (item) =>
        item.projectId === projectId &&
        (item.slug === token || item.cli === token)
    );
    if (!match) {
      const projectItems = items.filter((item) => item.projectId === projectId);
      if (projectItems.length === 1) {
        return {
          projectId,
          slug: projectItems[0].slug,
          cli: projectItems[0].cli,
          status: projectItems[0].status,
        };
      }
    }
    return {
      projectId,
      slug: match?.slug ?? token,
      cli: match?.cli,
      status: match?.status,
    };
  });

  const agentName = createMemo(() => {
    const selected = props.selectedAgent();
    if (!selected) return null;
    if (selected.startsWith("PRO-")) {
      const [projectId, token] = selected.split("/");
      const match = subagents()?.items.find(
        (item) =>
          item.projectId === projectId &&
          (item.slug === token || item.cli === token)
      );
      return `${projectId}/${match?.cli ?? token}`;
    }
    const match = agents()?.find((agent) => agent.id === selected);
    return match?.name ?? selected;
  });

  createEffect(() => {
    const selected = props.selectedAgent();
    if (selected && selected !== lastSelectedAgent) {
      setMode("chat");
    }
    lastSelectedAgent = selected;
  });

  createEffect(() => {
    const projectId = readProjectIdFromPathname(location.pathname);
    if (!projectId) return;
    const projectTitle = projectTitleById().get(projectId);
    setRecentViews((current) => {
      const next = [
        {
          id: projectId,
          viewedAt: Date.now(),
          title:
            projectTitle ??
            current.find((item) => item.id === projectId)?.title,
        },
        ...current.filter((item) => item.id !== projectId),
      ].slice(0, RECENT_PROJECTS_MAX);
      writeRecentProjectViews(next);
      return next;
    });
  });

  createEffect(() => {
    const titles = projectTitleById();
    if (titles.size === 0) return;
    setRecentViews((current) => {
      let changed = false;
      const next = current.map((item) => {
        const title = titles.get(item.id);
        if (!title || item.title === title) return item;
        changed = true;
        return { ...item, title };
      });
      if (changed) writeRecentProjectViews(next);
      return changed ? next : current;
    });
  });

  onMount(() => {
    const saved = readMigratedLocal(storageKey);
    if (saved === "agents" || saved === "feed" || saved === "chat") {
      setMode(saved);
    }
  });

  createEffect(() => {
    localStorage.setItem(storageKey, mode());
  });

  const expandAndShow = (nextMode: PanelMode) => {
    if (props.collapsed()) {
      props.onToggleCollapse();
    }
    setMode(nextMode);
  };

  const handleBack = () => {
    props.onClearSelection();
    setMode("agents");
  };

  return (
    <aside class="context-panel" classList={{ collapsed: props.collapsed() }}>
      <div class="context-panel-shell">
        <div class="panel-header">
          <button
            class="collapse-btn"
            type="button"
            onClick={props.onToggleCollapse}
          >
            »
          </button>
          <div class="panel-tabs">
            <button
              type="button"
              classList={{ active: mode() === "agents" }}
              onClick={() => setMode("agents")}
            >
              Agents
            </button>
            <button
              type="button"
              classList={{ active: mode() === "chat" }}
              onClick={() => setMode("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              classList={{ active: mode() === "feed" }}
              onClick={() => setMode("feed")}
            >
              Feed
            </button>
          </div>
        </div>

        <div class="collapsed-icons">
          <button
            type="button"
            classList={{ active: mode() === "agents" }}
            onClick={() => expandAndShow("agents")}
            title="Agents"
          >
            🤖
          </button>
          <button
            type="button"
            classList={{ active: mode() === "chat" }}
            onClick={() => expandAndShow("chat")}
            title="Chat"
          >
            💬
          </button>
          <button
            type="button"
            classList={{ active: mode() === "feed" }}
            onClick={() => expandAndShow("feed")}
            title="Activity Feed"
          >
            📋
          </button>
        </div>

        <div class="panel-content">
          <div
            class="panel-view"
            classList={{ hidden: mode() !== "agents" }}
            aria-hidden={mode() !== "agents"}
          >
            <AgentDirectory
              selectedAgent={props.selectedAgent}
              onSelectAgent={props.onSelectAgent}
              onOpenProject={props.onOpenProject}
            />
          </div>
          <Show when={mode() === "feed"}>
            <ActivityFeed
              onSelectAgent={props.onSelectAgent}
              onOpenProject={props.onOpenProject}
            />
          </Show>
          <Show when={mode() === "chat"}>
            <AgentChat
              agentId={agentType() === "lead" ? props.selectedAgent() : null}
              agentName={agentName()}
              agentType={agentType()}
              subagentInfo={subagentInfo()}
              onBack={handleBack}
              onOpenProject={props.onOpenProject}
            />
          </Show>
        </div>
        <Show
          when={
            mode() === "agents" &&
            isExtensionEnabled("projects") &&
            recentViews().length > 0
          }
        >
          <div class="panel-recent">
            <div class="panel-recent-label">Recent</div>
            <For each={recentViews()}>
              {(item) => {
                return (
                  <A
                    href={`/projects/${item.id}`}
                    class="recent-project-link"
                    classList={{
                      active: stripBase(location.pathname) === `/projects/${item.id}`,
                    }}
                  >
                    <span class="recent-project-title">
                      {item.id}: {item.title ?? item.id}
                    </span>
                    <span class="recent-project-time">
                      {relativeTime(item.viewedAt)}
                    </span>
                  </A>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <style>{`
        .context-panel {
          position: relative;
          z-index: 30;
          width: 480px;
          min-width: 480px;
          flex-shrink: 0;
          overflow: visible;
        }

        .context-panel-shell {
          position: relative;
          width: 100%;
          height: 100%;
          background: var(--bg-surface);
          border-left: 1px solid var(--border-default);
          display: flex;
          flex-direction: column;
          transition: width 0.2s ease, box-shadow 0.2s ease;
          overflow: hidden;
        }

        .context-panel.collapsed {
          width: 50px;
          min-width: 50px;
        }

        .context-panel.collapsed .context-panel-shell {
          position: absolute;
          inset: 0 0 0 auto;
          width: 50px;
        }

        .context-panel.collapsed:hover .context-panel-shell {
          width: 480px;
          box-shadow: -12px 0 24px var(--shadow-md);
        }

        .panel-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-default);
        }

        .context-panel .collapse-btn {
          width: 28px;
          height: 28px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-surface);
          color: var(--text-primary);
          cursor: pointer;
          margin-left: 0;
        }

        .context-panel .panel-tabs {
          margin-left: auto;
        }

        .context-panel .collapse-btn:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 2px;
        }

        .panel-tabs {
          display: flex;
          gap: 8px;
        }

        .panel-tabs button,
        .collapsed-icons button {
          background: none;
          color: var(--text-muted);
          padding: 8px 12px;
          border-radius: 6px;
          border: none;
          cursor: pointer;
        }

        .panel-tabs button:focus-visible,
        .collapsed-icons button:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 2px;
        }

        .panel-tabs button.active,
        .collapsed-icons button.active {
          background: var(--bg-raised);
          color: var(--text-primary);
        }

        .panel-content {
          flex: 1;
          min-height: 0;
          transition: opacity 0.2s ease;
        }

        .panel-view {
          height: 100%;
          min-height: 0;
        }

        .panel-view.hidden {
          display: none;
        }

        .panel-recent {
          border-top: 1px solid var(--border-default);
          padding: 8px 10px 10px;
        }

        .panel-recent-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          padding: 0 10px 6px;
          white-space: nowrap;
        }

        .recent-project-link {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 5px 10px;
          border-radius: 6px;
          color: var(--text-secondary);
          text-decoration: none;
          font-size: 13px;
          line-height: 1.3;
          transition: background 0.15s ease, color 0.15s ease;
          white-space: nowrap;
        }

        .recent-project-link:hover {
          background: var(--bg-raised);
          color: var(--text-primary);
        }

        .recent-project-link.active {
          background: var(--border-default);
          color: var(--text-primary);
        }

        .recent-project-title {
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }

        .recent-project-time {
          flex-shrink: 0;
          font-size: 11px;
          color: var(--text-secondary);
          opacity: 0.7;
        }

        .collapsed-icons {
          display: none;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 16px 0;
        }

        .context-panel.collapsed .panel-header,
        .context-panel.collapsed .panel-content,
        .context-panel.collapsed .panel-recent {
          opacity: 0;
          pointer-events: none;
        }

        .context-panel.collapsed .collapsed-icons {
          display: flex;
        }

        .context-panel.collapsed:hover .panel-header,
        .context-panel.collapsed:hover .panel-content,
        .context-panel.collapsed:hover .panel-recent {
          opacity: 1;
          pointer-events: auto;
        }

        .context-panel.collapsed:hover .collapsed-icons {
          display: none;
        }

        @media (max-width: 1399px) {
          /* --- Collapsed state: slim rail + hover-to-peek --- */
          .context-panel.collapsed {
            width: 50px;
            min-width: 50px;
          }

          .context-panel.collapsed:hover .context-panel-shell {
            width: 320px;
          }

          .context-panel.collapsed .panel-header,
          .context-panel.collapsed .panel-content,
          .context-panel.collapsed .panel-recent {
            opacity: 0;
            pointer-events: none;
          }

          .context-panel.collapsed .collapsed-icons {
            display: flex;
          }

          .context-panel.collapsed:hover .panel-header,
          .context-panel.collapsed:hover .panel-content,
          .context-panel.collapsed:hover .panel-recent {
            opacity: 1;
            pointer-events: auto;
          }

          .context-panel.collapsed:hover .collapsed-icons {
            display: none;
          }

          /* --- Expanded (sticky) state: always visible at narrower width --- */
          .context-panel:not(.collapsed) {
            width: 320px;
            min-width: 320px;
          }

          .context-panel:not(.collapsed) .context-panel-shell {
            width: 100%;
          }

          .context-panel:not(.collapsed) .panel-header,
          .context-panel:not(.collapsed) .panel-content,
          .context-panel:not(.collapsed) .panel-recent {
            opacity: 1;
            pointer-events: auto;
          }

          .context-panel:not(.collapsed) .collapsed-icons {
            display: none;
          }
        }

        @media (max-width: 768px) {
          .context-panel {
            display: none !important;
          }
        }
      `}</style>
    </aside>
  );
}
