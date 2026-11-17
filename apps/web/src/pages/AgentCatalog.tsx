import { createEffect, createMemo, createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { RemoteAgentMark } from "../components/RemoteAgentMark";
import { A, useNavigate } from "@solidjs/router";
import { fetchAgents, fetchPool } from "../api";
import { startNewChat } from "../api/chat";
import {
  fetchPoolActions,
  type PoolCatalogEntry,
} from "../api/teams";
import { useSession } from "../auth/client";
import { capabilities } from "../lib/capabilities";
import { subscribeToRealtime } from "../api/realtime-client";
import { hasStaffRole as hasAdminRole, isSuperadmin as hasSuperadminRole } from "../lib/roles";
import { fetchMainAgentPreference, saveMainAgentPreference } from "../api/main-agent";
import { showToast } from "../lib/toast";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { ScheduleAlertDot } from "../components/ScheduleAlertDot";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

const UNASSIGNED_MESSAGE = "This agent has not been assigned to a team.";

// Copy for a card with no Chat: an admin's unforked card or a superadmin's inert card.
function unavailableMessage(entry: PoolCatalogEntry | undefined): string {
  return entry?.reason === "no_workspace"
    ? "This agent has no workspace."
    : UNASSIGNED_MESSAGE;
}

export function AgentCatalog() {
  const [mainAgent, { mutate: setMainAgent }] = createResource(() => fetchMainAgentPreference().catch(() => null));
  const [savingMain, setSavingMain] = createSignal<string | null>(null);
  const navigate = useNavigate();
  const [pendingMain, setPendingMain] = createSignal<{ chatAgentId: string; name: string } | null>(null);
  const [mainAgentError, setMainAgentError] = createSignal("");
  const [agents] = createResource(() =>
    capabilities.forkedAgents ? fetchPool() : fetchAgents()
  );
  const session = useSession();
  const isAdmin = createMemo(() =>
    hasAdminRole(
      (session().data?.user as { role?: string | string[] } | undefined)?.role
    )
  );
  const isSuperadmin = createMemo(() =>
    hasSuperadminRole(
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
  // Users and admins only see agents they can chat; admins also see unforked
  // agents they can assign. Superadmins see every card. Inaccessible cards are
  // held back until actions resolve so they don't flash in.
  const visibleAgents = createMemo(() => {
    const list = agents() ?? [];
    if (!capabilities.forkedAgents || isSuperadmin()) return list;
    if (!actions()) return [];
    return list.filter((agent) => {
      const action = actionByPool().get(agent.id)?.action;
      return action === "chat" || (isAdmin() && action === "assign_to_team");
    });
  });
  const isMainCard = (agentId: string) => {
    const chatAgentId = mainAgentIdFor(agentId);
    return !!chatAgentId && mainAgent()?.accessible === true && mainAgent()?.mainAgentId === chatAgentId;
  };
  // Main agent first; Array.sort is stable so the rest keep their order.
  const sortedAgents = createMemo(() => [...visibleAgents()].sort((a, b) => Number(isMainCard(b.id)) - Number(isMainCard(a.id))));
  const canEditAgent = (entry: PoolCatalogEntry | undefined) =>
    !capabilities.forkedAgents || isSuperadmin() || entry?.action === "chat" || entry?.action === "assign_to_team";
  const mainAgentIdFor = (agentId: string) => {
    if (!capabilities.forkedAgents) return agentId;
    const entry = actionByPool().get(agentId);
    return entry?.action === "chat" ? entry.chatAgentId : null;
  };
  const makeMainAgent = async (agentId: string, name: string) => {
    if (savingMain()) return;
    setSavingMain(agentId);
    setMainAgentError("");
    try {
      setMainAgent(await saveMainAgentPreference({ mainAgentId: agentId }));
      showToast(`${name} is your main agent`, "success");
      setPendingMain(null);
    } catch (error) {
      setMainAgentError(error instanceof Error ? error.message : "Could not save your main agent. Try again.");
    } finally {
      setSavingMain(null);
    }
  };

  return (
    <div class="agent-catalog">
      <h1 class="catalog-heading">Agents</h1>
      <Show when={pendingMain()}>{(pending) => (
        <ConfirmDialog
          title={`Make ${pending().name} your main agent?`}
          description={`Home opens a fresh chat with ${pending().name}. Every agent stays available.`}
          confirmLabel="Make main agent"
          error={mainAgentError()}
          onConfirm={() => makeMainAgent(pending().chatAgentId, pending().name)}
          onCancel={() => { setPendingMain(null); setMainAgentError(""); }}
        />
      )}</Show>

      <Show when={agents.loading}>
        <div class="loading">Loading agents...</div>
      </Show>

      <Show when={agents.error}>
        <div class="error">Failed to load agents</div>
      </Show>

      <Show when={agents()}>
        <div class="catalog-grid" data-tour="agent-grid">
          <For each={sortedAgents()}>
            {(agent, index) => (
              <div
                class="catalog-card"
                classList={{ "is-main": isMainCard(agent.id), "is-chattable": !!mainAgentIdFor(agent.id) }}
                data-tour={index() === 0 ? "agent-card" : undefined}
                // Whole-card click starts a chat; the Chat link stays the keyboard path.
                onClick={(event) => {
                  const chatAgentId = mainAgentIdFor(agent.id);
                  if (!chatAgentId || (event.target as Element).closest("a, button")) return;
                  startNewChat(chatAgentId);
                  navigate(`/chat/${chatAgentId}`);
                }}
              >
                <Show when={canEditAgent(actionByPool().get(agent.id))}>
                  <A
                    href={`/agents/${agent.id}/edit`}
                    class="catalog-edit"
                    data-tour={index() === 0 ? "agent-edit" : undefined}
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
                <Show when={mainAgentIdFor(agent.id)}>{(chatAgentId) => (
                  <button
                    type="button"
                    class="catalog-star"
                    classList={{ "is-main": isMainCard(agent.id) }}
                    disabled={isMainCard(agent.id)}
                    aria-pressed={isMainCard(agent.id)}
                    aria-label={isMainCard(agent.id) ? `${agent.name} is your main agent` : `Make ${agent.name} your main agent`}
                    title={isMainCard(agent.id) ? "Main agent" : "Make main agent"}
                    onClick={() => { setMainAgentError(""); setPendingMain({ chatAgentId: chatAgentId(), name: agent.name }); }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill={isMainCard(agent.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" /></svg>
                  </button>
                )}</Show>
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
                <div class="catalog-name">{agent.name}<RemoteAgentMark gateway={agent.gateway} /><ScheduleAlertDot agentId={mainAgentIdFor(agent.id)} /></div>
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
                      <A
                        href={`/chat/${agent.id}`}
                        class="catalog-chat-link"
                        data-tour={index() === 0 ? "agent-chat" : undefined}
                        onClick={() => startNewChat(agent.id)}
                      >
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
                            {unavailableMessage(entry)}
                          </span>
                        </Show>
                      }
                    >
                      <A
                        href={`/chat/${entry?.chatAgentId ?? agent.id}`}
                        class="catalog-chat-link"
                        data-tour={index() === 0 ? "agent-chat" : undefined}
                        onClick={() => startNewChat(entry?.chatAgentId ?? agent.id)}
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

        .catalog-card.is-chattable { cursor: pointer; }

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
        .catalog-edit:focus-visible,
        .catalog-card:hover .catalog-star,
        .catalog-card:focus-within .catalog-star,
        .catalog-star:focus-visible,
        .catalog-star.is-main {
          opacity: 1;
        }

        .catalog-card.is-main,
        .catalog-card.is-main:hover,
        .catalog-card.is-main:focus-within {
          border-color: var(--tone-user);
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--tone-user) 35%, transparent), 0 0 18px color-mix(in srgb, var(--tone-user) 28%, transparent);
        }

        .catalog-star {
          position: absolute;
          top: 8px;
          left: 8px;
          z-index: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          padding: 0;
          border: 0;
          border-radius: 8px;
          color: var(--text-secondary);
          background: color-mix(in srgb, var(--bg-surface) 80%, transparent);
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.2s ease, background 0.2s ease, color 0.2s ease;
        }

        .catalog-star:hover:not(:disabled) {
          background: var(--border-default);
          color: var(--text-primary);
        }

        .catalog-star.is-main {
          color: var(--tone-user);
          cursor: default;
        }

        .catalog-star:focus-visible { outline: 2px solid var(--tone-user); outline-offset: 2px; }

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
