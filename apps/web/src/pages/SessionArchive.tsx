import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { LeftNavShell } from "../components/LeftNavShell";
import {
  fetchAgentSessions,
  archiveAgentSession,
  deleteAgentSession,
} from "../api";
import type { SessionSummary } from "../api/types";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { showToast } from "../lib/toast";
import { AgentAvatarFill } from "../components/AgentAvatarFill";

function relativeTime(timestamp: number, now: number): string {
  const diff = now - timestamp;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < week) return `${Math.floor(diff / day)}d ago`;
  if (diff < 4 * week) return `${Math.floor(diff / week)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function SessionArchive() {
  const navigate = useNavigate();
  const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [deletingSession, setDeletingSession] = createSignal<SessionSummary>();
  const [currentTime, setCurrentTime] = createSignal(Date.now());
  let requestId = 0;

  // Update time every minute for relative timestamps
  const intervalId = setInterval(() => setCurrentTime(Date.now()), 60000);
  onCleanup(() => clearInterval(intervalId));

  const refresh = async () => {
    const currentRequest = ++requestId;
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchAgentSessions({ includeArchived: true });
      if (currentRequest === requestId) {
        setSessions(response.items.filter((s) => s.archived !== null));
      }
    } catch (cause) {
      if (currentRequest === requestId) {
        setSessions([]);
        setError(
          cause instanceof Error
            ? cause.message
            : "Failed to load archived sessions"
        );
      }
    } finally {
      if (currentRequest === requestId) setLoading(false);
    }
  };

  createEffect(() => {
    void refresh();
  });

  const onSessionsChanged = () => void refresh();
  window.addEventListener("chat-projects-changed", onSessionsChanged);
  onCleanup(() => window.removeEventListener("chat-projects-changed", onSessionsChanged));

  const restore = async (session: SessionSummary) => {
    setError(undefined);
    try {
      await archiveAgentSession(session.agentId, session.sessionId, false);
      setSessions((prev) =>
        prev.filter((s) => s.sessionId !== session.sessionId)
      );
      showToast("Chat restored", "success");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to restore session"
      );
    }
  };

  const handleDelete = async () => {
    const session = deletingSession();
    if (!session) return;
    setError(undefined);
    try {
      await deleteAgentSession(session.agentId, session.sessionId);
      setSessions((prev) =>
        prev.filter((s) => s.sessionId !== session.sessionId)
      );
      showToast("Chat deleted", "success");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to delete session"
      );
    } finally {
      setDeletingSession(undefined);
    }
  };

  return (
    <LeftNavShell>
      <main class="session-archive">
        <style>{`
          .session-archive {
            max-width: 820px;
            margin: 0 auto;
            padding: 32px 24px;
          }
          .session-archive h1 {
            margin: 0 0 24px;
            color: var(--text-primary);
            font-size: 24px;
            font-weight: 600;
          }
          .archive-session-list {
            display: grid;
            gap: 12px;
            margin: 0;
            padding: 0;
            list-style: none;
          }
          .archive-session {
            display: grid;
            grid-template-columns: 40px 1fr auto;
            gap: 12px;
            align-items: center;
            padding: 16px;
            border: 1px solid var(--border-default);
            border-radius: 10px;
            background: var(--bg-surface);
          }
          .archive-session-avatar {
            width: 40px;
            height: 40px;
            border-radius: 8px;
            background: var(--bg-raised);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
            font-weight: 600;
            color: var(--text-secondary);
            overflow: hidden;
          }
          .archive-session-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
          }
          .archive-session-content {
            min-width: 0;
          }
          .archive-session-title {
            display: block;
            color: var(--text-primary);
            font-size: 15px;
            font-weight: 500;
            margin-bottom: 4px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .archive-session-meta {
            display: block;
            color: var(--text-secondary);
            font-size: 13px;
          }
          .archive-session-actions {
            display: flex;
            gap: 8px;
          }
          .archive-session-actions button {
            padding: 8px 14px;
            border: 1px solid var(--border-default);
            border-radius: 7px;
            background: transparent;
            color: var(--text-primary);
            font-size: 14px;
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.2s ease, color 0.2s ease;
          }
          .archive-session-actions button:hover {
            background: var(--bg-raised);
          }
          .archive-session-actions button.danger {
            color: #ef4444;
          }
          .archive-session-actions button.danger:hover {
            background: rgb(239 68 68 / 0.1);
          }
          .archive-empty {
            padding: 48px 24px;
            text-align: center;
            color: var(--text-secondary);
            font-size: 15px;
          }
          .archive-error {
            padding: 12px 16px;
            margin-bottom: 16px;
            border: 1px solid #ef4444;
            border-radius: 8px;
            background: rgb(239 68 68 / 0.1);
            color: #ef4444;
            font-size: 14px;
          }
        `}</style>
        <h1>Archive</h1>
        <Show when={error()}>
          {(message) => (
            <div role="alert" class="archive-error">
              {message()}
            </div>
          )}
        </Show>
        <Show when={loading()}>
          <p role="status" class="archive-empty">
            Loading archived chats…
          </p>
        </Show>
        <Show when={!loading() && sessions().length === 0}>
          <p class="archive-empty">No archived chats.</p>
        </Show>
        <Show when={!loading() && sessions().length > 0}>
          <ul class="archive-session-list">
            <For each={sessions()}>
              {(session) => {
                const title = () =>
                  session.title || session.firstUserMessage || session.sessionId;
                return (
                  <li class="archive-session">
                    <div class="archive-session-avatar">
                      <AgentAvatarFill avatar={session.avatar} agentId={session.agentId} />
                    </div>
                    <div class="archive-session-content">
                      <span class="archive-session-title">{title()}</span>
                      <span class="archive-session-meta">
                        {session.agentId} · Archived{" "}
                        {relativeTime(session.archived!, currentTime())}
                      </span>
                    </div>
                    <div class="archive-session-actions">
                      <button
                        type="button"
                        onClick={() =>
                          navigate(
                            `/chat/${session.agentId}?session=${session.sessionId}`
                          )
                        }
                      >
                        Open
                      </button>
                      <button type="button" onClick={() => restore(session)}>
                        Restore
                      </button>
                      <button
                        type="button"
                        class="danger"
                        onClick={() => setDeletingSession(session)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
        <Show when={deletingSession()}>
          <ConfirmDialog
            title="Delete archived chat?"
            description="This will permanently delete the chat and all its history."
            confirmLabel="Delete"
            danger
            onConfirm={handleDelete}
            onCancel={() => setDeletingSession(undefined)}
          />
        </Show>
      </main>
    </LeftNavShell>
  );
}
