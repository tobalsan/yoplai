import {
  Accessor,
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import {
  fetchAgents,
  fetchAllSubagents,
  fetchAgentStatuses,
  fetchProjects,
  subscribeToFileChanges,
  subscribeToStatus,
} from "../api";
import type { SubagentGlobalListItem } from "../api/types";

type AgentDirectoryProps = {
  selectedAgent: Accessor<string | null>;
  onSelectAgent: (id: string) => void;
  onOpenProject: (id: string) => void;
};

type ActiveProjectItem = {
  id: string;
  title: string;
  status: "running" | "idle" | "error";
  lastActiveMs: number;
};

function parseIsoTimestamp(input?: string): number {
  if (!input) return 0;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relativeTime(timestampMs: number): string {
  if (timestampMs <= 0) return "-";
  const elapsed = Date.now() - timestampMs;
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function projectRunStatus(
  items: SubagentGlobalListItem[]
): ActiveProjectItem["status"] {
  if (items.some((item) => item.status === "running")) return "running";
  if (items.some((item) => item.status === "error")) return "error";
  return "idle";
}

function statusLabel(status: ActiveProjectItem["status"]): string {
  if (status === "running") return "RUNNING";
  if (status === "error") return "ERROR";
  return "IDLE";
}

function getInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function AgentDirectory(props: AgentDirectoryProps) {
  return (
    <div class="agent-directory">
      <LeadAgentsSection
        selectedAgent={props.selectedAgent}
        onSelectAgent={props.onSelectAgent}
      />
      <ActiveProjectsSection onOpenProject={props.onOpenProject} />

      <style>{`
        .agent-directory {
          height: 100%;
          padding: 14px 12px;
          display: flex;
          flex-direction: column;
          gap: 14px;
          overflow: auto;
        }

        .agent-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .section-title {
          font-size: 11px;
          color: var(--text-muted);
          letter-spacing: 0.5px;
        }

        .section-empty {
          font-size: 12px;
          color: var(--text-muted);
          padding: 4px 8px;
        }

        .agent-item {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 6px 8px;
          border-radius: 8px;
          border: none;
          background: transparent;
          color: var(--text-primary);
          cursor: pointer;
          text-align: left;
        }

        .agent-item:hover,
        .agent-item.selected {
          background: var(--bg-raised);
        }

        .agent-item:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.5);
          outline-offset: 2px;
        }

        .agent-avatar {
          width: 28px;
          height: 28px;
          border-radius: 6px;
          background: var(--bg-raised);
          flex: 0 0 auto;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          letter-spacing: 0.02em;
          transition: background 0.2s ease;
        }

        .agent-avatar.running {
          background: #166534;
          color: #a7f3d0;
        }

        .remote-mark {
          font-size: 10px;
          opacity: 0.7;
          white-space: nowrap;
        }

        .status-pill {
          margin-left: auto;
          padding: 2px 6px;
          border-radius: 999px;
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          flex: 0 0 auto;
          border: 1px solid transparent;
        }

        .status-pill.idle {
          background: var(--bg-raised);
          color: #9ca3af;
          border-color: #303030;
        }

        .status-pill.working {
          background: #bbf7d0;
          color: #065f46;
          border-color: #86efac;
        }

        .status-pill.error {
          background: #fee2e2;
          color: #991b1b;
          border-color: #fecaca;
        }

        .project-item {
          gap: 8px;
        }

        .project-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          flex: 0 0 auto;
          background: #9ca3af;
        }

        .project-dot.running {
          background: #22c55e;
        }

        .project-dot.idle {
          background: #94a3b8;
        }

        .project-dot.error {
          background: #ef4444;
        }

        .project-time {
          margin-left: auto;
          color: var(--text-muted);
          font-size: 11px;
          flex: 0 0 auto;
        }

        .agent-label {
          font-size: 14px;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 240px;
        }
      `}</style>
    </div>
  );
}

function LeadAgentsSection(props: {
  selectedAgent: Accessor<string | null>;
  onSelectAgent: (id: string) => void;
}) {
  const [agents] = createResource(fetchAgents);
  const [statuses, setStatuses] = createSignal<
    Record<string, "streaming" | "idle">
  >({});

  const refreshStatuses = () => {
    void fetchAgentStatuses().then((res) => {
      setStatuses(res.statuses);
    });
  };

  createEffect(() => {
    refreshStatuses();
  });

  createEffect(() => {
    const unsubscribe = subscribeToStatus({
      onStatus: (agentId, status) => {
        setStatuses((prev) => ({ ...prev, [agentId]: status }));
      },
      onReconnect: () => {
        refreshStatuses();
      },
    });
    onCleanup(unsubscribe);
  });

  const getAgentStatus = (agentId: string) =>
    statuses()[agentId] === "streaming" ? "running" : "idle";

  return (
    <div class="agent-section">
      <div class="section-title">LEAD AGENTS</div>
      <Show when={agents()}>
        <For each={agents() ?? []}>
          {(agent) => {
            const isRunning = () => getAgentStatus(agent.id) === "running";
            return (
              <button
                class="agent-item"
                type="button"
                classList={{ selected: props.selectedAgent() === agent.id }}
                onClick={() => props.onSelectAgent(agent.id)}
              >
                <span class="agent-avatar" classList={{ running: isRunning() }}>
                  {getInitials(agent.name)}
                </span>
                <span class="agent-label">{agent.name}</span>
                <Show when={agent.gateway}>
                  <span class="remote-mark" title={`Remote agent on ${agent.gateway}`}>
                    @{agent.gateway}
                  </span>
                </Show>
                <span
                  class="status-pill"
                  classList={{ working: isRunning(), idle: !isRunning() }}
                >
                  {isRunning() ? "WORKING" : "IDLE"}
                </span>
              </button>
            );
          }}
        </For>
      </Show>
    </div>
  );
}

function ActiveProjectsSection(props: { onOpenProject: (id: string) => void }) {
  const [subagents, setSubagents] = createSignal<Awaited<
    ReturnType<typeof fetchAllSubagents>
  > | null>(null);
  const [projects, setProjects] = createSignal<
    Awaited<ReturnType<typeof fetchProjects>>
  >([]);

  const refreshSubagents = async () => {
    setSubagents(await fetchAllSubagents());
  };

  const refreshProjects = async () => {
    setProjects(await fetchProjects());
  };

  createEffect(() => {
    void refreshSubagents();
    void refreshProjects();
  });

  createEffect(() => {
    let refreshTimer: number | undefined;
    const unsubscribe = subscribeToFileChanges({
      onFileChanged: () => {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          void refreshProjects();
          refreshTimer = undefined;
        }, 500);
      },
      onAgentChanged: () => {
        if (refreshTimer) window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          void refreshSubagents();
          void refreshProjects();
          refreshTimer = undefined;
        }, 500);
      },
    });
    onCleanup(() => {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      unsubscribe();
    });
  });

  const activeProjects = createMemo<ActiveProjectItem[]>(() => {
    const projectById = new Map(
      (projects() ?? []).map((item) => [item.id, item])
    );
    const grouped = new Map<string, SubagentGlobalListItem[]>();
    for (const item of subagents()?.items ?? []) {
      if (!item.projectId) continue;
      const existing = grouped.get(item.projectId);
      if (existing) existing.push(item);
      else grouped.set(item.projectId, [item]);
    }

    const items: ActiveProjectItem[] = [];
    for (const [projectId, entries] of grouped.entries()) {
      const project = projectById.get(projectId);
      if (!project) continue;
      if (!entries.some((entry) => entry.status === "running")) continue;
      const lastActiveMs = entries.reduce(
        (latest, entry) =>
          Math.max(latest, parseIsoTimestamp(entry.lastActive)),
        0
      );
      items.push({
        id: projectId,
        title: project.title,
        status: projectRunStatus(entries),
        lastActiveMs,
      });
    }

    return items.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  });

  return (
    <div class="agent-section">
      <div class="section-title">ACTIVE PROJECTS</div>
      <Show
        when={activeProjects().length > 0}
        fallback={<div class="section-empty">No active projects</div>}
      >
        <For each={activeProjects()}>
          {(item) => (
            <button
              class="agent-item project-item"
              type="button"
              onClick={() => props.onOpenProject(item.id)}
              title={`${item.id}: ${item.title} (${item.status})`}
            >
              <span
                class="project-dot"
                classList={{
                  running: item.status === "running",
                  idle: item.status === "idle",
                  error: item.status === "error",
                }}
                aria-hidden="true"
              />
              <span class="agent-label">
                {item.id}: {item.title}
              </span>
              <span class="project-time">
                {relativeTime(item.lastActiveMs)}
              </span>
              <span
                class="status-pill"
                classList={{
                  working: item.status === "running",
                  idle: item.status === "idle",
                  error: item.status === "error",
                }}
              >
                {statusLabel(item.status)}
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  );
}
