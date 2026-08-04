import { createEffect, createMemo, createResource, For, Show, onCleanup } from "solid-js";
import { A } from "@solidjs/router";
import { fetchAgents, fetchPool } from "../api";
import {
  fetchPoolActions,
  type PoolCatalogEntry,
} from "../api/teams";
import { useSession } from "../auth/client";
import { capabilities } from "../lib/capabilities";
import { subscribeToRealtime } from "../api/realtime-client";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

const STAFF_ROLES = ["admin", "superadmin"];

const UNASSIGNED_MESSAGE = "This agent has not been assigned to a team.";

// Reason-specific copy for a "none" action card. Never mentions forking.
function unavailableMessage(entry: PoolCatalogEntry | undefined, isAdmin: boolean): string {
  switch (entry?.reason) {
    case "unassigned":
      return UNASSIGNED_MESSAGE;
    case "no_workspace":
      return isAdmin
        ? "This agent has no workspace."
        : entry.teamName
          ? `${entry.teamName} Team`
          : UNASSIGNED_MESSAGE;
    case "other_team":
      return entry.teamName ? `${entry.teamName} Team` : UNASSIGNED_MESSAGE;
    default:
      return UNASSIGNED_MESSAGE;
  }
}

function hasAdminRole(role: string | string[] | null | undefined): boolean {
  if (Array.isArray(role)) return role.some((r) => STAFF_ROLES.includes(r));
  return typeof role === "string" && STAFF_ROLES.includes(role);
}

export function AgentCatalog() {
  const [agents] = createResource(() =>
    capabilities.forkedAgents ? fetchPool() : fetchAgents()
  );
  const session = useSession();
  const isAdmin = createMemo(() =>
    hasAdminRole(
      (session().data?.user as { role?: string | string[] } | undefined)?.role
    )
  );
  // The per-user action state for every pool card, resolved by the gateway
  // (chat / assign_to_team / none).
  const [actions, { refetch: refetchActions }] = createResource(
    () => capabilities.forkedAgents,
    (enabled) => (enabled ? fetchPoolActions() : Promise.resolve([]))
  );
  createEffect(() => {
    if (typeof window === "undefined") return;
    const unsubscribe = subscribeToRealtime({ interests: [{ type: "project" }], onEvent: (event) => { if (event.type === "agent_changed" && event.projectId === "membership") void refetchActions(); } });
    onCleanup(unsubscribe);
  });
  const actionByPool = createMemo(() => {
    const map = new Map<string, PoolCatalogEntry>();
    for (const entry of actions() ?? []) map.set(entry.poolId, entry);
    return map;
  });
  const canEditAgent = (entry: PoolCatalogEntry | undefined) =>
    !capabilities.forkedAgents || isAdmin() || entry?.action === "chat";

  return (
    <div class="agent-catalog">
      <h1 class="catalog-heading">Agents</h1>

      <Show when={agents.loading}>
        <div class="loading">Loading agents...</div>
      </Show>

      <Show when={agents.error}>
        <div class="error">Failed to load agents</div>
      </Show>

      <Show when={agents()}>
        <div class="catalog-grid">
          <For each={agents()}>
            {(agent) => (
              <div class="catalog-card">
                <Show when={canEditAgent(actionByPool().get(agent.id))}>
                  <A
                    href={`/agents/${agent.id}/edit`}
                    class="catalog-edit"
                    aria-label={`Edit ${agent.name}`}
                    title="Edit agent"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </A>
                </Show>
                <Show when={agent.avatar}>
                  {(avatar) => (
                    <div class="catalog-avatar">
                      {isEmoji(avatar()) ? (
                        <span class="avatar-emoji">{avatar()}</span>
                      ) : (
                        <img src={avatar()} alt={agent.name} class="avatar-img" />
                      )}
                    </div>
                  )}
                </Show>
                <div class="catalog-name">{agent.name}</div>
                <Show when={agent.role}>
                  <div class="catalog-role">{agent.role}</div>
                </Show>
                <Show when={agent.description}>
                  <div class="catalog-description">{agent.description}</div>
                </Show>
                <div class="catalog-divider" />
                {(() => {
                  const entry = actionByPool().get(agent.id);
                  if (!capabilities.forkedAgents) {
                    return (
                      <A href={`/chat/${agent.id}`} class="catalog-chat-link">
                        Chat
                      </A>
                    );
                  }
                  // Chat: a fork exists and this user can chat it (member or
                  // staff). Route to the fork agent id, never the pool id.
                  return (
                    <Show
                      when={entry?.action === "chat"}
                      fallback={
                        <Show
                          when={
                            entry?.action === "none" ||
                            entry?.action === "assign_to_team"
                          }
                          fallback={null}
                        >
                          <span class="catalog-unavailable">
                            {unavailableMessage(entry, isAdmin())}
                          </span>
                        </Show>
                      }
                    >
                      <A
                        href={`/chat/${entry?.chatAgentId ?? agent.id}`}
                        class="catalog-chat-link"
                      >
                        Chat
                      </A>
                    </Show>
                  );
                })()}
              </div>
            )}
          </For>
        </div>
      </Show>

      <style>{`
        .agent-catalog {
          padding: 24px;
        }

        .catalog-heading {
          font-size: 24px;
          font-weight: 600;
          color: var(--text-primary);
          margin-bottom: 20px;
        }

        .loading, .error {
          padding: 24px;
          text-align: center;
          color: var(--text-tertiary);
        }

        .error {
          color: #e55;
        }

        .catalog-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 16px;
        }

        .catalog-card {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
          height: 100%;
          padding: 20px 16px;
          background: var(--bg-surface);
          border: 1px solid var(--scrollbar-thumb);
          border-radius: 12px;
          transition: border-color 0.2s ease, background 0.2s ease;
        }

        .catalog-card:hover,
        .catalog-card:focus-within {
          border-color: var(--border-default);
          background: var(--bg-raised);
        }

        .catalog-edit {
          position: absolute;
          top: 8px;
          right: 8px;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 8px;
          color: var(--text-secondary);
          background: color-mix(in srgb, var(--bg-surface) 80%, transparent);
          text-decoration: none;
          opacity: 0;
          transition: opacity 0.2s ease, background 0.2s ease, color 0.2s ease;
        }

        .catalog-card:hover .catalog-edit,
        .catalog-card:focus-within .catalog-edit,
        .catalog-edit:focus-visible {
          opacity: 1;
        }

        .catalog-edit:hover {
          background: var(--border-default);
          color: var(--text-primary);
        }

        .catalog-avatar {
          width: calc(100% + 32px);
          aspect-ratio: 1 / 1;
          border-radius: 12px 12px 0 0;
          background: var(--bg-raised);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          margin: -20px -16px 12px -16px;
        }

        .avatar-emoji {
          font-size: 96px;
          line-height: 1;
        }

        .avatar-img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .catalog-name {
          font-size: 16px;
          font-weight: 700;
          color: var(--text-primary);
        }

        .catalog-role {
          font-size: 13px;
          color: var(--text-tertiary);
          margin-top: 2px;
        }

        .catalog-description {
          font-size: 12px;
          color: var(--text-tertiary);
          margin-top: 6px;
        }

        .catalog-divider {
          width: 100%;
          height: 1px;
          background: var(--border-default);
          margin: 14px 0;
          margin-top: auto;
        }

        .catalog-chat-link {
          display: inline-block;
          padding: 8px 20px;
          border-radius: 8px;
          background: var(--bg-raised);
          color: var(--text-primary);
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: background 0.2s ease;
        }

        .catalog-chat-link:hover {
          background: var(--border-default);
        }

        .catalog-unavailable {
          display: inline-block;
          padding: 8px 20px;
          font-size: 13px;
          color: var(--text-tertiary);
          font-style: italic;
        }

        @media (max-width: 768px) {
          .catalog-grid {
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          }
        }
      `}</style>
    </div>
  );
}
