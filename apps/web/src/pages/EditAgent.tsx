import {
  createMemo,
  createResource,
  createEffect,
  createSignal,
  For,
  Show,
} from "solid-js";
import { A, useParams } from "@solidjs/router";
import { fetchAgentDashboards, fetchAgents, fetchPool } from "../api";
import {
  detailsPath,
  fetchAgentExtensions,
  type ExtensionCatalogEntry,
} from "../api/extensions";
import {
  fetchForks,
  fetchPoolActions,
  fetchTeams,
  setForkTeams,
  type AgentFork,
  type Team,
} from "../api/teams";
import { useSession } from "../auth/client";
import { capabilities, isExtensionEnabled } from "../lib/capabilities";
import { SchedulesPanel } from "./SchedulesPanel";
import { AgentConnectionsPanel } from "../components/AgentConnectionsPanel";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

const STAFF_ROLES = ["admin", "superadmin"];

function hasAdminRole(role: string | string[] | null | undefined): boolean {
  if (Array.isArray(role)) return role.some((r) => STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

// Team assignment for the edit page: assign a never-forked pool agent to a
// team, or move an already-forked agent between teams. Reuses the same
// admin-guarded fork APIs the catalog cards used before this control moved here.
function TeamAssignment(props: {
  poolId: string;
  teams: Team[];
  fork: AgentFork | undefined;
  onChanged: () => void;
}) {
  const [selected, setSelected] = createSignal<string[]>(props.fork?.assignment?.mode === "list" ? props.fork.assignment.teamIds : []);
  const [allTeams, setAllTeams] = createSignal(props.fork?.assignment?.mode === "all");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    const assignment = props.fork?.assignment;
    setAllTeams(assignment?.mode === "all");
    setSelected(assignment?.mode === "list" ? assignment.teamIds : []);
  });

  const handleAssign = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await setForkTeams(props.poolId, allTeams() ? { mode: "all" } : { mode: "list", teamIds: selected() });
      props.onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to assign.");
    } finally {
      setBusy(false);
    }
  };

  // Dirty state compares current selection against the last-synced fork
  // assignment, so the Save/Cancel row only appears when there's something
  // to persist or discard.
  const baseline = () => {
    const a = props.fork?.assignment;
    return { all: a?.mode === "all", ids: a?.mode === "list" ? a.teamIds : [] };
  };
  const dirty = createMemo(() => {
    const b = baseline();
    if (allTeams() !== b.all) return true;
    if (allTeams()) return false;
    const ids = selected();
    return ids.length !== b.ids.length || ids.some((id) => !b.ids.includes(id));
  });
  const reset = () => {
    const b = baseline();
    setAllTeams(b.all);
    setSelected(b.ids);
  };

  return (
    <section class="edit-agent-team">
      <div class="edit-agent-team-head">
        <h2 class="edit-agent-section-title">Teams</h2>
        <Show when={dirty()}>
          <div class="edit-agent-team-actions">
            <button type="button" class="edit-agent-team-cancel" disabled={busy()} onClick={reset}>Cancel</button>
            <button type="button" class="edit-agent-team-button" disabled={busy()} onClick={() => void handleAssign()}>Save</button>
          </div>
        </Show>
      </div>
      <div class="edit-agent-team-pills">
        <button
          type="button"
          class="edit-agent-team-pill"
          classList={{ selected: allTeams() }}
          aria-pressed={allTeams()}
          disabled={busy()}
          onClick={() => { const next = !allTeams(); setAllTeams(next); if (next) setSelected([]); }}
        >
          All teams
        </button>
        <For each={props.teams}>{(team) => (
          <button
            type="button"
            class="edit-agent-team-pill"
            classList={{ selected: !allTeams() && selected().includes(team.id) }}
            aria-pressed={!allTeams() && selected().includes(team.id)}
            disabled={busy() || allTeams()}
            onClick={() => setSelected((ids) => ids.includes(team.id) ? ids.filter((id) => id !== team.id) : [...ids, team.id])}
          >
            {team.name}
          </button>
        )}</For>
      </div>
      <Show when={error()}>
        {(message) => <p class="edit-agent-team-error">{message()}</p>}
      </Show>
    </section>
  );
}

export function EditAgent() {
  const params = useParams<{ agentId: string }>();
  const session = useSession();
  const isAdmin = createMemo(() =>
    hasAdminRole(
      (session().data?.user as { role?: string | string[] } | undefined)?.role
    )
  );

  const [agents] = createResource(() =>
    capabilities.forkedAgents ? fetchPool() : fetchAgents()
  );
  const agent = createMemo(() =>
    (agents() ?? []).find((candidate) => candidate.id === params.agentId)
  );

  const [teams] = createResource(() =>
    isAdmin() && capabilities.forkedAgents
      ? fetchTeams()
      : Promise.resolve([] as Team[])
  );
  const [forks, { refetch: refetchForks }] = createResource(() =>
    isAdmin() && capabilities.forkedAgents
      ? fetchForks()
      : Promise.resolve([] as AgentFork[])
  );
  const fork = createMemo(() =>
    (forks() ?? []).find((entry) => entry.sourcePoolId === params.agentId)
  );
  const [poolActions] = createResource(
    () => capabilities.forkedAgents && !isAdmin(),
    (enabled) => enabled ? fetchPoolActions() : Promise.resolve([])
  );
  const dashboardAgentId = createMemo(() =>
    capabilities.forkedAgents
      ? fork()?.forkAgentId ?? (poolActions.error ? undefined : poolActions())?.find((entry) =>
          entry.poolId === params.agentId && entry.action === "chat"
        )?.chatAgentId
      : params.agentId
  );
  const [tab, setTab] = createSignal<"extensions" | "connections" | "dashboards" | "schedules">("extensions");
  const [dashboards] = createResource(
    () => tab() === "dashboards" ? dashboardAgentId() : null,
    fetchAgentDashboards
  );
  const [copiedSlug, setCopiedSlug] = createSignal<string | null>(null);
  const copyDashboardLink = async (slug: string, link: string) => {
    try {
      await navigator.clipboard.writeText(new URL(link, window.location.origin).href);
      setCopiedSlug(slug);
    } catch {
      setCopiedSlug(null);
    }
  };

  const [extensions, { refetch: refetchExtensions }] =
    createResource(() => fetchAgentExtensions(params.agentId));

  // Set up = credentials exist for Just me or Whole team (OAuth connection or
  // secrets). Extensions without settings are a plain on/off, flipped on their
  // details page.
  const isExtensionSetUp = (ext: ExtensionCatalogEntry) => {
    if (ext.oauth) return !!ext.oauthConnected;
    if (ext.tier === "toggle-only") return ext.enabled;
    const secretFields = ext.requiredSecrets ?? [];
    if (secretFields.length === 0) return ext.enabled && ext.configured;
    const team = secretFields.some((field) => ext.configValues?.[field] != null);
    return team || (ext.personalSecretFields?.length ?? 0) > 0;
  };

  // One click reaches the settings: bespoke pages directly, everything else
  // on the details page, which renders OAuth and auto-form settings inline.
  const extensionPath = (ext: ExtensionCatalogEntry) =>
    ext.tier === "bespoke-route" && ext.configRoutePath
      ? ext.configRoutePath
      : detailsPath(params.agentId, ext.id);

  return (
    <Show when={!session().isPending}>
      <div class="edit-agent">
        <A href="/agents" class="edit-agent-back">
          ← Back to agents
        </A>

        <Show when={agents.loading}>
          <div class="loading">Loading agent…</div>
        </Show>

        <Show when={!agents.loading && !agent()}>
          <div class="error">Agent not found.</div>
        </Show>

        <Show when={agent()}>
          {(current) => (
            <div class="edit-agent-header">
              <Show when={current().avatar}>
                {(avatar) => (
                  <div class="edit-agent-avatar">
                    {isEmoji(avatar()) ? (
                      <span class="avatar-emoji">{avatar()}</span>
                    ) : (
                      <img
                        src={avatar()}
                        alt={current().name}
                        class="avatar-img"
                      />
                    )}
                  </div>
                )}
              </Show>
              <div class="edit-agent-identity">
                <h1 class="edit-agent-name">{current().name}</h1>
                <Show when={current().role}>
                  <div class="edit-agent-role">{current().role}</div>
                </Show>
              </div>
            </div>
          )}
        </Show>

        <Show when={isAdmin() && capabilities.forkedAgents && agent()}>
          <TeamAssignment
            poolId={params.agentId}
            teams={teams() ?? []}
            fork={fork()}
            onChanged={() => {
              void refetchForks();
              void refetchExtensions();
            }}
          />
        </Show>

        <Show when={agent()}>
          <div class="edit-agent-tabs" role="tablist" aria-label="Agent sections">
            <button type="button" role="tab" aria-selected={tab() === "extensions"} onClick={() => setTab("extensions")}>Extensions</button>
            <button type="button" role="tab" aria-selected={tab() === "connections"} onClick={() => setTab("connections")}>My connections</button>
            <Show when={dashboardAgentId()}><button type="button" role="tab" aria-selected={tab() === "dashboards"} onClick={() => setTab("dashboards")}>Dashboards</button></Show>
            <Show when={dashboardAgentId() && isExtensionEnabled("scheduler")}><button type="button" role="tab" aria-selected={tab() === "schedules"} onClick={() => setTab("schedules")}>Scheduled jobs</button></Show>
          </div>
        </Show>

        <Show when={agent() && tab() === "connections"}>
          <AgentConnectionsPanel agentId={params.agentId} includeMcp={isExtensionEnabled("mcp")} extensions={extensions()} />
        </Show>

        <Show when={agent() && tab() === "schedules" && dashboardAgentId() && isExtensionEnabled("scheduler")}>
          <SchedulesPanel agentId={dashboardAgentId()!} agentName={agent()!.name} />
        </Show>

        <Show when={agent() && tab() === "dashboards" && dashboardAgentId()}>
          <section class="edit-agent-dashboards" role="tabpanel">
            <Show when={dashboards.loading}><p>Loading dashboards…</p></Show>
            <Show when={dashboards.error}><p>Failed to load dashboards.</p></Show>
            <Show when={!dashboards.loading && !dashboards.error && dashboards()?.length === 0}>
              <p>No dashboards yet.</p>
            </Show>
            <Show when={!dashboards.error}>
              <ul class="edit-agent-dashboard-list">
                <For each={dashboards() ?? []}>{(dashboard) => (
                  <li class="edit-agent-dashboard">
                    <div>
                      <strong>{dashboard.title}</strong>
                      <span>{dashboard.slug} · Updated {new Date(dashboard.updatedAt).toLocaleString()}</span>
                    </div>
                    <div class="edit-agent-dashboard-actions">
                      <a href={dashboard.link} target="_blank" rel="noopener noreferrer">Open</a>
                      <button type="button" onClick={() => void copyDashboardLink(dashboard.slug, dashboard.link)}>
                        {copiedSlug() === dashboard.slug ? "Copied" : "Copy link"}
                      </button>
                    </div>
                  </li>
                )}</For>
              </ul>
            </Show>
          </section>
        </Show>

        <Show when={agent() && tab() === "extensions"}>
          <section class="edit-agent-extensions">
            <h2 class="edit-agent-section-title">Extensions</h2>
            <Show when={extensions.loading}>
              <div class="edit-agent-ext-empty">Loading extensions…</div>
            </Show>
            <Show when={extensions.error}>
              <div class="edit-agent-ext-empty">
                Failed to load extensions.
              </div>
            </Show>
            <Show
              when={
                !extensions.loading && (extensions() ?? []).length === 0
              }
            >
              <div class="edit-agent-ext-empty">No extensions available.</div>
            </Show>
            <ul class="edit-agent-ext-list">
              <For each={extensions() ?? []}>
                {(ext) => (
                  <li class="edit-agent-ext-item">
                    <A
                      href={extensionPath(ext)}
                      class="edit-agent-ext-open"
                    >
                      <div class="edit-agent-ext-icon">
                        <Show
                          when={ext.iconDataUri}
                          fallback={
                            <svg
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="1.6"
                              aria-hidden="true"
                            >
                              <path
                                d="M9 3.5a1.5 1.5 0 0 1 3 0V4h1.5A1.5 1.5 0 0 1 15 5.5V7h-1v2a2 2 0 1 1 0 4v2h1v1.5a1.5 1.5 0 0 1-1.5 1.5H13v-1a2 2 0 1 0-4 0v1H7.5A1.5 1.5 0 0 1 6 16.5V15h1v-2a2 2 0 1 0 0-4V7h1V5.5A1.5 1.5 0 0 1 9.5 4H9v-.5Z"
                                stroke-linejoin="round"
                              />
                            </svg>
                          }
                        >
                          {(src) => (
                            <img src={src()} alt="" class="edit-agent-ext-icon-img" />
                          )}
                        </Show>
                      </div>
                      <div class="edit-agent-ext-body">
                        <div class="edit-agent-ext-main">
                          <span class="edit-agent-ext-name">
                            {ext.displayName}
                          </span>
                          <span class="edit-agent-ext-desc">
                            {ext.description}
                          </span>
                          <Show when={ext.enabled && ext.configured === false}>
                            <span class="edit-agent-ext-desc">Needs configuration</span>
                          </Show>
                        </div>
                      </div>
                    </A>
                    <Show
                      when={isExtensionSetUp(ext)}
                      fallback={
                        <A
                          href={extensionPath(ext)}
                          class="edit-agent-ext-add"
                          aria-label={`Set up ${ext.displayName}`}
                          title={`Set up ${ext.displayName}`}
                        >
                          +
                        </A>
                      }
                    >
                      <span
                        class="edit-agent-ext-check"
                        role="img"
                        aria-label={`${ext.displayName} configured`}
                        title="Configured"
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                          <path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>

      <style>{`
        .edit-agent {
          padding: 24px;
        }

        .edit-agent-tabs {
          display: flex;
          gap: 16px;
          margin-top: 28px;
          border-bottom: 1px solid var(--border-default);
        }

        .edit-agent-tabs button {
          padding: 8px 2px;
          border: 0;
          border-bottom: 2px solid transparent;
          background: none;
          color: var(--text-secondary);
          cursor: pointer;
        }

        .edit-agent-tabs button[aria-selected="true"] {
          border-bottom-color: var(--accent, #3b82f6);
          color: var(--text-primary);
        }

        .edit-agent-dashboards {
          max-width: 800px;
          color: var(--text-secondary);
        }

        .edit-agent-dashboard-list {
          list-style: none;
          padding: 0;
        }

        .edit-agent-dashboard {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          padding: 14px 0;
          border-bottom: 1px solid var(--border-default);
        }

        .edit-agent-dashboard strong, .edit-agent-dashboard span { display: block; }
        .edit-agent-dashboard strong { color: var(--text-primary); }
        .edit-agent-dashboard span { margin-top: 4px; font-size: 12px; }
        .edit-agent-dashboard-actions { display: flex; gap: 12px; white-space: nowrap; }
        .edit-agent-dashboard-actions a, .edit-agent-dashboard-actions button {
          border: 0;
          background: none;
          color: var(--accent, #3b82f6);
          cursor: pointer;
          font: inherit;
          text-decoration: none;
        }

        .edit-agent-back {
          display: inline-block;
          margin-bottom: 20px;
          font-size: 14px;
          color: var(--text-secondary);
          text-decoration: none;
        }

        .edit-agent-back:hover {
          color: var(--text-primary);
        }

        .loading, .error {
          padding: 24px 0;
          color: var(--text-tertiary);
        }

        .error {
          color: #e55;
        }

        .edit-agent-header {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .edit-agent-avatar {
          width: 72px;
          height: 72px;
          border-radius: 14px;
          background: var(--bg-raised);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          flex-shrink: 0;
        }

        .avatar-emoji {
          font-size: 44px;
          line-height: 1;
        }

        .avatar-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .edit-agent-identity {
          min-width: 0;
        }

        .edit-agent-name {
          margin: 0;
          font-size: 24px;
          font-weight: 700;
          color: var(--text-primary);
        }

        .edit-agent-role {
          margin-top: 4px;
          font-size: 14px;
          color: var(--text-tertiary);
        }

        .edit-agent-team {
          margin-top: 28px;
          max-width: 520px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .edit-agent-section-title {
          margin: 0 0 4px;
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .edit-agent-team-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
        }

        .edit-agent-team-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .edit-agent-team-pills {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }

        .edit-agent-team-pill {
          padding: 5px 12px;
          border-radius: 999px;
          border: 1px solid var(--border-default);
          background: transparent;
          color: var(--text-tertiary);
          font-size: 13px;
          cursor: pointer;
          transition: color 0.15s ease-out, border-color 0.15s ease-out, background 0.15s ease-out;
        }

        .edit-agent-team-pill:hover:not(:disabled) {
          color: var(--text-primary);
          border-color: var(--text-tertiary);
        }

        .edit-agent-team-pill.selected {
          background: color-mix(in oklab, var(--accent, #3b82f6) 14%, transparent);
          border-color: color-mix(in oklab, var(--accent, #3b82f6) 45%, transparent);
          color: var(--text-primary);
        }

        .edit-agent-team-pill:disabled {
          opacity: 0.45;
          cursor: default;
        }

        .edit-agent-team-pill.selected:disabled {
          opacity: 1;
        }

        .edit-agent-team-cancel {
          border: none;
          background: none;
          padding: 0;
          font-size: 13px;
          color: var(--text-tertiary);
          cursor: pointer;
        }

        .edit-agent-team-cancel:hover {
          color: var(--text-primary);
        }

        .edit-agent-team-select {
          flex: 1 1 200px;
          min-width: 0;
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-raised);
          color: var(--text-primary);
          font-size: 14px;
        }

        .edit-agent-team-warning {
          font-size: 13px;
          color: #d97706;
          margin: 0;
        }

        .edit-agent-team-button {
          padding: 4px 14px;
          border-radius: 999px;
          border: none;
          background: var(--accent, #3b82f6);
          color: #fff;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
        }

        .edit-agent-team-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .edit-agent-team-error {
          font-size: 13px;
          color: #e55;
          margin: 0;
        }

        .edit-agent-extensions {
          margin-top: 28px;
          max-width: 900px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .edit-agent-ext-empty {
          font-size: 13px;
          color: var(--text-tertiary);
        }

        .edit-agent-ext-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .edit-agent-ext-item {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          padding: 14px;
          min-height: 120px;
          border-radius: 10px;
          border: 1px solid var(--border-default);
          background: var(--bg-raised);
        }

        .edit-agent-ext-open {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          flex: 1;
          min-width: 0;
          margin: -4px;
          padding: 4px;
          border-radius: 8px;
          color: inherit;
          text-decoration: none;
          cursor: pointer;
          transition: background-color 0.15s ease;
        }

        .edit-agent-ext-open:hover {
          background: var(--bg-hover, rgba(120, 120, 120, 0.08));
        }

        .edit-agent-ext-icon {
          flex-shrink: 0;
          width: 44px;
          height: 44px;
          border-radius: 8px;
          background: #fff;
          padding: 6px;
          border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
          color: var(--text-tertiary);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }

        .edit-agent-ext-icon svg {
          width: 24px;
          height: 24px;
        }

        .edit-agent-ext-icon-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .edit-agent-ext-body {
          display: flex;
          flex-direction: column;
          gap: 8px;
          min-width: 0;
          flex: 1;
        }

        .edit-agent-ext-main {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }

        .edit-agent-ext-name {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .edit-agent-ext-desc {
          font-size: 12px;
          color: var(--text-tertiary);
          overflow: hidden;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
        }

        .edit-agent-ext-add,
        .edit-agent-ext-check {
          align-self: center;
          flex-shrink: 0;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .edit-agent-ext-add {
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
          font-size: 20px;
          line-height: 1;
          text-decoration: none;
          transition: background-color 0.15s ease, color 0.15s ease;
        }

        .edit-agent-ext-add:hover {
          background: var(--bg-hover, rgba(120, 120, 120, 0.08));
          color: var(--text-primary);
        }

        .edit-agent-ext-check {
          background: rgba(22, 163, 74, 0.12);
          color: #16a34a;
        }

        .edit-agent-ext-check svg {
          width: 16px;
          height: 16px;
        }

      `}</style>
    </Show>
  );
}
