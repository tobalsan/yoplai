import { fetchCreationGateways } from "../api/agent-management";
import { isDesktopWindow } from "../lib/desktop-window";
import "../components/agent-management/agent-management.css";
import { setupRepairHref } from "../desktop-setup/repair";
import { createEffect, createMemo, createResource, createSignal, For, Show, onCleanup } from "solid-js";
import { RemoteAgentMark } from "../components/RemoteAgentMark";
import { A, useNavigate } from "@solidjs/router";
import { fetchAgents } from "../api";
import { startNewChat } from "../api/chat";
import { capabilities } from "../lib/capabilities";
import { subscribeToRealtime } from "../api/realtime-client";
import { fetchMainAgentPreference, saveMainAgentPreference } from "../api/main-agent";
import { showToast } from "../lib/toast";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { ScheduleAlertDot } from "../components/ScheduleAlertDot";
import { defaultAvatarUrl } from "../lib/default-avatar";

function isEmoji(str: string): boolean {
  return /^\p{Emoji}/u.test(str) && str.length <= 4;
}

export function AgentCatalog(props: { hideHeading?: boolean }) {
  const [mainAgent, { mutate: setMainAgent }] = createResource(() => fetchMainAgentPreference().catch(() => null));
  const [savingMain, setSavingMain] = createSignal<string | null>(null);
  const navigate = useNavigate();
  const [pendingMain, setPendingMain] = createSignal<{ agentId: string; name: string } | null>(null);
  const [mainAgentError, setMainAgentError] = createSignal("");
  const [creationGateways] = createResource(fetchCreationGateways);
  const [agents, { refetch: refetchAgents }] = createResource(fetchAgents);
  const loadedAgents = () => agents.error ? undefined : agents();
  createEffect(() => {
    if (typeof window === "undefined") return;
    const unsubscribe = subscribeToRealtime({ interests: [{ type: "project" }], onEvent: (event) => { if (event.type === "agent_changed" && event.projectId === "membership") void refetchAgents(); } });
    onCleanup(unsubscribe);
  });
  const isMainCard = (agentId: string) => mainAgent()?.accessible === true && mainAgent()?.mainAgentId === agentId;
  // Main agent first; Array.sort is stable so the rest keep their order.
  const sortedAgents = createMemo(() => [...(loadedAgents() ?? [])].sort((a, b) => Number(isMainCard(b.id)) - Number(isMainCard(a.id))));
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
      <Show when={!props.hideHeading}><h1 class="catalog-heading">Agents</h1></Show>
      <Show when={pendingMain()}>{(pending) => (
        <ConfirmDialog
          title={`Make ${pending().name} your main agent?`}
          description={`Home opens a fresh chat with ${pending().name}. Every agent stays available.`}
          confirmLabel="Make main agent"
          error={mainAgentError()}
          onConfirm={() => makeMainAgent(pending().agentId, pending().name)}
          onCancel={() => { setPendingMain(null); setMainAgentError(""); }}
        />
      )}</Show>

      <Show when={agents.loading}>
        <div class="loading">Loading agents...</div>
      </Show>

      <Show when={agents.error}>
        <div class="error">Failed to load agents</div>
      </Show>

      <Show when={capabilities.desktopSetup && !capabilities.multiUser && loadedAgents()?.length === 0}>
        <h2>Create your first agent</h2>
        <button type="button" onClick={() => navigate(setupRepairHref("agent", "/agents"))}>Create agent</button>
      </Show>

      <Show when={loadedAgents()}>
        <div class="catalog-grid" data-tour="agent-grid">
          <For each={sortedAgents()}>
            {(agent, index) => (
              <div
                class="catalog-card"
                classList={{ "is-main": isMainCard(agent.id) }}
                data-tour={index() === 0 ? "agent-card" : undefined}
                // Whole-card click starts a chat; the Chat link stays the keyboard path.
                onClick={(event) => {
                  if ((event.target as Element).closest("a, button")) return;
                  startNewChat(agent.id);
                  navigate(`/chat/${agent.id}`);
                }}
              >
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
                <button
                  type="button"
                  class="catalog-star"
                  classList={{ "is-main": isMainCard(agent.id) }}
                  disabled={isMainCard(agent.id)}
                  aria-pressed={isMainCard(agent.id)}
                  aria-label={isMainCard(agent.id) ? `${agent.name} is your main agent` : `Make ${agent.name} your main agent`}
                  title={isMainCard(agent.id) ? "Main agent" : "Make main agent"}
                  onClick={() => { setMainAgentError(""); setPendingMain({ agentId: agent.id, name: agent.name }); }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill={isMainCard(agent.id) ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" /></svg>
                </button>
                <Show when={agent.avatar} fallback={<div class="catalog-avatar"><img src={defaultAvatarUrl(agent.id)} alt={agent.name} class="avatar-img" /></div>}>
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
                <div class="catalog-name">{agent.name}<RemoteAgentMark gateway={agent.gateway} /><ScheduleAlertDot agentId={agent.id} gateway={agent.gateway} /></div>
                <Show when={agent.description}>
                  <div class="catalog-description">{agent.description}</div>
                </Show>
                <div class="catalog-divider" />
                <A
                  href={`/chat/${agent.id}`}
                  class="catalog-chat-link"
                  data-tour={index() === 0 ? "agent-chat" : undefined}
                  onClick={() => startNewChat(agent.id)}
                >
                  Chat
                </A>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={isDesktopWindow() || !!creationGateways()?.length}>
        <button type="button" class="agent-create-fab" aria-label="New agent" title="New agent" onClick={() => navigate("/agents/new")}>
          <i class="fa-solid fa-plus" aria-hidden="true" />
        </button>
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
          cursor: pointer;
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

        @media (max-width: 768px) {
          .catalog-grid {
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          }
        }
      `}</style>
    </div>
  );
}
