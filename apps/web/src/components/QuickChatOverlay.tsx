import { For, Show, createMemo } from "solid-js";
import type { Agent } from "../api/types";
import { AgentChat } from "./AgentChat";

type QuickChatOverlayProps = {
  open: boolean;
  mobile: boolean;
  agents: Agent[];
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onMinimize: () => void;
  onClose: () => void;
};

function toInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "A";
  return trimmed[0].toUpperCase();
}

export function QuickChatOverlay(props: QuickChatOverlayProps) {
  const selectedAgent = createMemo(() =>
    props.agents.find((agent) => agent.id === props.selectedAgentId) ?? null
  );

  return (
    <div
      class="quick-chat-overlay-shell"
      classList={{ open: props.open, mobile: props.mobile }}
      aria-hidden={!props.open}
    >
      <section
        id="quick-chat-overlay"
        class="quick-chat-overlay-panel"
        role="dialog"
        aria-label="Lead agent quick chat"
      >
        <header class="quick-chat-overlay-header">
          <div class="quick-chat-overlay-header-main">
            <div class="quick-chat-overlay-avatar" aria-hidden="true">
              {toInitial(selectedAgent()?.name ?? "Agent")}
            </div>
            <div class="quick-chat-overlay-agent-select-wrap">
              <label class="quick-chat-overlay-agent-label" for="quick-chat-agent-select">
                Lead Agent
              </label>
              <select
                id="quick-chat-agent-select"
                class="quick-chat-overlay-agent-select"
                value={selectedAgent()?.id ?? ""}
                onChange={(e) => {
                  const next = e.currentTarget.value;
                  if (!next) return;
                  props.onSelectAgent(next);
                }}
                disabled={props.agents.length === 0}
              >
                <For each={props.agents}>
                  {(agent) => <option value={agent.id}>{agent.name}</option>}
                </For>
              </select>
            </div>
          </div>
          <div class="quick-chat-overlay-actions">
            <button
              type="button"
              class="quick-chat-overlay-action"
              aria-label="Minimize quick chat"
              onClick={props.onMinimize}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M5 11h14v2H5z" />
              </svg>
            </button>
            <button
              type="button"
              class="quick-chat-overlay-action"
              aria-label="Close quick chat"
              onClick={props.onClose}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M18.3 5.71L12 12l6.3 6.29-1.41 1.42L10.59 13.4l-6.3 6.31-1.41-1.42L9.17 12 2.88 5.71 4.29 4.29l6.3 6.3 6.3-6.3z"
                />
              </svg>
            </button>
          </div>
        </header>

        <div class="quick-chat-overlay-body">
          <Show
            when={selectedAgent()}
            fallback={<div class="quick-chat-overlay-empty">No lead agents configured.</div>}
          >
            {(agent) => (
              <div class="quick-chat-overlay-chat-shell">
                <AgentChat
                  agentType="lead"
                  agentId={agent().id}
                  agentName={agent().name}
                  fullscreen={props.mobile}
                  showHeader={false}
                  viewed={props.open}
                  onBack={() => {}}
                />
              </div>
            )}
          </Show>
        </div>
      </section>

      <style>{`
        .quick-chat-overlay-shell {
          position: fixed;
          right: 24px;
          bottom: 84px;
          width: min(380px, calc(100vw - 24px));
          height: min(520px, calc(100vh - 120px));
          z-index: 810;
          pointer-events: none;
        }

        .quick-chat-overlay-panel {
          width: 100%;
          height: 100%;
          border-radius: 18px;
          border: 1px solid color-mix(in srgb, var(--border-default) 78%, transparent);
          background: color-mix(in srgb, var(--bg-overlay) 88%, var(--bg-surface) 12%);
          box-shadow:
            0 22px 48px color-mix(in srgb, var(--shadow-md) 84%, transparent),
            0 8px 22px color-mix(in srgb, var(--shadow-md) 55%, transparent);
          backdrop-filter: blur(8px);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          transform: translateY(18px) scale(0.98);
          opacity: 0;
          transition: opacity 0.2s ease-out, transform 0.2s ease-out;
        }

        .quick-chat-overlay-shell.open {
          pointer-events: auto;
        }

        .quick-chat-overlay-shell.open .quick-chat-overlay-panel {
          opacity: 1;
          transform: translateY(0) scale(1);
        }

        .quick-chat-overlay-header {
          height: 58px;
          border-bottom: 1px solid var(--border-default);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 12px;
          background: color-mix(in srgb, var(--bg-surface) 78%, transparent);
          flex-shrink: 0;
        }

        .quick-chat-overlay-header-main {
          min-width: 0;
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 1;
        }

        .quick-chat-overlay-avatar {
          width: 30px;
          height: 30px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 700;
          color: color-mix(in srgb, var(--text-primary) 92%, #9ec4ff 8%);
          background: color-mix(in srgb, var(--bg-raised) 78%, #6fa0ff 22%);
          border: 1px solid color-mix(in srgb, var(--border-default) 74%, transparent);
          flex-shrink: 0;
        }

        .quick-chat-overlay-agent-select-wrap {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .quick-chat-overlay-agent-label {
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--text-tertiary);
        }

        .quick-chat-overlay-agent-select {
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-primary);
          font-size: 13px;
          font-weight: 600;
          padding: 0;
          max-width: 210px;
        }

        .quick-chat-overlay-agent-select:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 2px;
          border-radius: 6px;
        }

        .quick-chat-overlay-actions {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .quick-chat-overlay-action {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--text-secondary);
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: background 0.15s ease-out, color 0.15s ease-out, border-color 0.15s ease-out;
        }

        .quick-chat-overlay-action svg {
          width: 16px;
          height: 16px;
        }

        .quick-chat-overlay-action:hover {
          color: var(--text-primary);
          background: color-mix(in srgb, var(--bg-raised) 82%, transparent);
          border-color: color-mix(in srgb, var(--border-default) 78%, transparent);
        }

        .quick-chat-overlay-action:focus-visible {
          outline: 2px solid rgba(59, 130, 246, 0.6);
          outline-offset: 2px;
        }

        .quick-chat-overlay-body {
          flex: 1;
          min-height: 0;
          background: transparent;
        }

        .quick-chat-overlay-chat-shell {
          height: 100%;
          min-height: 0;
        }

        .quick-chat-overlay-empty {
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          font-size: 13px;
          padding: 24px;
          text-align: center;
        }

        @media (max-width: 768px) {
          .quick-chat-overlay-shell {
            inset: 0;
            width: 100vw;
            height: 100vh;
            right: auto;
            bottom: auto;
          }

          .quick-chat-overlay-panel {
            border-radius: 0;
            border: 0;
            box-shadow: none;
            background: color-mix(in srgb, var(--bg-base) 95%, var(--bg-overlay) 5%);
          }
        }
      `}</style>
    </div>
  );
}
