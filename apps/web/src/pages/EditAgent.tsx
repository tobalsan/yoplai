import {
  createMemo,
  createResource,
  createEffect,
  createSignal,
  For,
  Show,
} from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import { fetchAgents, fetchPool } from "../api";
import {
  autoFormPath,
  detailsPath,
  fetchAgentExtensions,
  patchAgentExtension,
  type ExtensionCatalogEntry,
} from "../api/extensions";
import {
  fetchForks,
  fetchTeams,
  setForkTeams,
  type AgentFork,
  type Team,
} from "../api/teams";
import { useSession } from "../auth/client";
import { capabilities } from "../lib/capabilities";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

const STAFF_ROLES = ["admin", "superadmin"];
const ASSIGN_TO_ENABLE_MESSAGE =
  "The agent must be assigned to a team to enable this extension";
const AGENT_FOLDER_MISSING_MESSAGE = "Agent folder missing";

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

  return (
    <section class="edit-agent-team">
      <h2 class="edit-agent-section-title">Team assignment</h2>
      <div class="edit-agent-team-current">{allTeams() ? `All teams (${props.teams.length} teams)` : `${selected().length} team${selected().length === 1 ? "" : "s"}`}</div>
      <div class="edit-agent-team-row">
        <label><input type="checkbox" checked={allTeams()} disabled={busy()} onChange={(event) => { setAllTeams(event.currentTarget.checked); if (event.currentTarget.checked) setSelected([]); }} /> All teams</label>
        <For each={props.teams}>{(team) => <label><input type="checkbox" disabled={busy() || allTeams()} checked={selected().includes(team.id)} onChange={(event) => setSelected((ids) => event.currentTarget.checked ? [...ids, team.id] : ids.filter((id) => id !== team.id))} /> {team.name}</label>}</For>
        <button
          type="button"
          class="edit-agent-team-button"
          disabled={busy()}
          onClick={() => void handleAssign()}
        >
          Save
        </button>
      </div>
      <Show when={error()}>
        {(message) => <p class="edit-agent-team-error">{message()}</p>}
      </Show>
    </section>
  );
}

export function EditAgent() {
  const params = useParams<{ agentId: string }>();
  const navigate = useNavigate();
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

  const [extensions, { mutate: mutateExtensions, refetch: refetchExtensions }] =
    createResource(() => fetchAgentExtensions(params.agentId));
  const [pending, setPending] = createSignal<string | null>(null);
  const [extError, setExtError] = createSignal<string | null>(null);
  const disabledEnableMessage = createMemo(() =>
    capabilities.forkedAgents
      ? fork()
        ? AGENT_FOLDER_MISSING_MESSAGE
        : ASSIGN_TO_ENABLE_MESSAGE
      : AGENT_FOLDER_MISSING_MESSAGE
  );

  // Route an extension enable to its config surface per the 3-tier contract
  // (catalog `tier`):
  //  - toggle-only: flip inline, instant, no redirect.
  //  - bespoke-route: the extension self-registered an agent-keyed config route;
  //    persist the enable, then redirect there so it owns its custom config UI.
  //  - auto-form: the extension exposes a config schema; persist the enable,
  //    then surface its schema-driven form path (renderer lands in ALG-355).
  // Disabling is always an inline flip regardless of tier — turning a config
  // surface off never redirects into it.
  const toggleExtension = async (ext: ExtensionCatalogEntry) => {
    if (pending()) return;
    if (ext.managedAtRoot) return;
    if (!ext.enabled && ext.configurable === false) return;
    setPending(ext.id);
    setExtError(null);
    try {
      const enabling = !ext.enabled;
      const next = await patchAgentExtension(params.agentId, ext.id, {
        enabled: enabling,
      });
      mutateExtensions(next);
      if (enabling && ext.tier === "bespoke-route" && ext.configRoutePath) {
        void navigate(ext.configRoutePath);
      } else if (enabling && ext.tier === "auto-form") {
        void navigate(autoFormPath(params.agentId, ext.id));
      }
    } catch (cause) {
      setExtError(
        cause instanceof Error ? cause.message : "Failed to update extension."
      );
    } finally {
      setPending(null);
    }
  };

  const extensionPath = (ext: ExtensionCatalogEntry) => {
    if (ext.enabled && ext.configured === false) {
      if (ext.tier === "bespoke-route" && ext.configRoutePath) return ext.configRoutePath;
      if (ext.tier === "auto-form") return autoFormPath(params.agentId, ext.id);
    }
    return detailsPath(params.agentId, ext.id);
  };

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
                    <button
                      type="button"
                      role="switch"
                      class="edit-agent-ext-state"
                      classList={{ "is-on": ext.enabled }}
                      disabled={
                        pending() !== null ||
                        ext.managedAtRoot ||
                        (!ext.enabled && ext.configurable === false)
                      }
                      title={
                        ext.managedAtRoot
                          ? "Configured in agent.yaml — edit the file to change."
                          : !ext.enabled && ext.configurable === false
                          ? disabledEnableMessage()
                          : undefined
                      }
                      aria-checked={ext.enabled}
                      aria-label={`Enable ${ext.displayName}`}
                      onClick={() => void toggleExtension(ext)}
                    >
                      <span
                        class="edit-agent-ext-state-knob"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                )}
              </For>
            </ul>
            <Show when={extError()}>
              {(message) => (
                <p class="edit-agent-ext-error">{message()}</p>
              )}
            </Show>
          </section>
        </Show>
      </div>

      <style>{`
        .edit-agent {
          padding: 24px;
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
          max-width: 320px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .edit-agent-section-title {
          margin: 0 0 4px;
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .edit-agent-team-current {
          font-size: 13px;
          color: var(--text-tertiary);
        }

        .edit-agent-team-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
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
          flex-shrink: 0;
          padding: 8px 16px;
          border-radius: 6px;
          border: none;
          background: var(--accent, #3b82f6);
          color: #fff;
          font-size: 14px;
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
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
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

        .edit-agent-ext-state {
          align-self: center;
          flex-shrink: 0;
          position: relative;
          width: 40px;
          height: 22px;
          padding: 0;
          border-radius: 999px;
          border: none;
          cursor: pointer;
          background: var(--bg-sunken, rgba(120, 120, 120, 0.12));
          transition: background-color 0.2s ease;
        }

        .edit-agent-ext-state:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .edit-agent-ext-state.is-on {
          background: #16a34a;
        }

        .edit-agent-ext-state-knob {
          position: absolute;
          top: 2px;
          left: 2px;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
          transition: transform 0.2s ease;
        }

        .edit-agent-ext-state.is-on .edit-agent-ext-state-knob {
          transform: translateX(18px);
        }

        .edit-agent-ext-error {
          font-size: 13px;
          color: #e55;
          margin: 4px 0 0;
        }
      `}</style>
    </Show>
  );
}
