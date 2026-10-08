import { For, Show, createResource, createSignal } from "solid-js";
import {
  fetchAdminTopExtensions,
  saveTopExtensions,
  type AdminTopExtensions,
  type TopExtensions,
} from "../../api/top-extensions";
import AdminLayout from "./AdminLayout";
import { McpIcon } from "../../components/McpExtensionCard";

/** Extension icon, or the generic puzzle piece the Edit-Agent list uses. */
function ExtensionIcon(props: { src?: string }) {
  return (
    <span class="edit-agent-ext-icon">
      <Show
        when={props.src}
        fallback={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path
              d="M9 3.5a1.5 1.5 0 0 1 3 0V4h1.5A1.5 1.5 0 0 1 15 5.5V7h-1v2a2 2 0 1 1 0 4v2h1v1.5a1.5 1.5 0 0 1-1.5 1.5H13v-1a2 2 0 1 0-4 0v1H7.5A1.5 1.5 0 0 1 6 16.5V15h1v-2a2 2 0 1 0 0-4V7h1V5.5A1.5 1.5 0 0 1 9.5 4H9v-.5Z"
              stroke-linejoin="round"
            />
          </svg>
        }
      >
        {(src) => <img src={src()} alt="" class="edit-agent-ext-icon-img" />}
      </Show>
    </span>
  );
}

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function AdminExtensionsPage() {
  const [data, { mutate }] = createResource<AdminTopExtensions>(fetchAdminTopExtensions);
  const [pending, setPending] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function toggle(kind: "extensions" | "mcp", value: string) {
    const current = data.error ? undefined : data();
    if (!current) return;
    const next: TopExtensions = {
      extensions: kind === "extensions" ? toggled(current.extensions, value) : current.extensions,
      mcp: kind === "mcp" ? toggled(current.mcp, value) : current.mcp,
    };
    setPending(`${kind}:${value}`);
    setError(null);
    try {
      const saved = await saveTopExtensions(next);
      mutate({ ...current, ...saved });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      setPending(null);
    }
  }

  const star = (kind: "extensions" | "mcp", value: string, label: string) => {
    const on = () => (data.error ? false : data()?.[kind].includes(value) === true);
    return (
      <button
        type="button"
        class="top-star"
        classList={{ on: on() }}
        aria-pressed={on()}
        aria-label={`${on() ? "Unmark" : "Mark"} ${label} as top`}
        title={on() ? "Top: shown first and prompted to users" : "Mark as top"}
        disabled={pending() !== null}
        onClick={() => void toggle(kind, value)}
      >
        {on() ? "★" : "☆"}
      </button>
    );
  };

  return (
    <AdminLayout
      title="Top extensions"
      description="Star the extensions and MCP servers your team should connect first. They sort first and users are prompted to connect them."
    >
      <Show when={error()}>{(message) => <p class="top-error">{message()}</p>}</Show>
      <Show when={data.error}>
        <p class="top-error">{data.error instanceof Error ? data.error.message : "Failed to load."}</p>
      </Show>
      <Show when={!data.error && data()} fallback={<Show when={data.loading}><div class="top-empty">Loading…</div></Show>}>
        {(loaded) => (
          <>
            <h2 class="top-heading">Extensions</h2>
            <div class="top-panel">
              <Show when={loaded().candidates.extensions.length > 0} fallback={<div class="top-empty">No extensions.</div>}>
                <For each={loaded().candidates.extensions}>
                  {(ext) => (
                    <div class="top-row" data-extension={ext.id}>
                      {star("extensions", ext.id, ext.displayName)}
                      <ExtensionIcon src={ext.iconDataUri} />
                      <div class="top-info">
                        <span class="top-name">{ext.displayName}</span>
                        <span class="top-sub">{ext.description}</span>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <h2 class="top-heading">MCP servers</h2>
            <div class="top-panel">
              <Show when={loaded().candidates.mcp.length > 0} fallback={<div class="top-empty">No HTTP MCP servers configured.</div>}>
                <For each={loaded().candidates.mcp}>
                  {(server) => (
                    <div class="top-row" data-mcp={server.url}>
                      {star("mcp", server.url, server.displayName)}
                      <McpIcon src={server.iconUrl} />
                      <div class="top-info">
                        <span class="top-name">{server.displayName}</span>
                        <span class="top-sub">{server.url}</span>
                      </div>
                      <span class="top-count">
                        used by {server.agentCount} {server.agentCount === 1 ? "agent" : "agents"}
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </>
        )}
      </Show>
      <style>{`
        .top-heading { margin: 24px 0 10px; font-size: 1rem; color: var(--text-primary); }
        .top-panel {
          border: 1px solid var(--border-default);
          border-radius: 18px;
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          overflow: hidden;
        }
        .top-row {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 12px 18px;
          border-bottom: 1px solid var(--border-default);
        }
        .top-row:last-child { border-bottom: none; }
        .top-row .edit-agent-ext-icon {
          flex-shrink: 0;
          width: 36px;
          height: 36px;
          border-radius: 8px;
          background: #fff;
          padding: 5px;
          border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
          color: var(--text-tertiary);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .top-row .edit-agent-ext-icon svg { width: 20px; height: 20px; }
        .top-row .edit-agent-ext-icon-img { width: 100%; height: 100%; object-fit: contain; }
        .top-row .mcp-ext-icon-filled { padding: 0; }
        .top-row .mcp-ext-icon-filled .edit-agent-ext-icon-img { object-fit: cover; }
        .top-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .top-name { color: var(--text-primary); font-weight: 600; }
        .top-sub {
          color: var(--text-secondary);
          font-size: 0.82rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .top-count { color: var(--text-secondary); font-size: 0.82rem; white-space: nowrap; }
        .top-star {
          border: none;
          background: none;
          color: var(--text-secondary);
          font-size: 1.3rem;
          line-height: 1;
          cursor: pointer;
        }
        .top-star.on { color: var(--warning, #f59e0b); }
        .top-empty { padding: 16px 18px; color: var(--text-secondary); }
        .top-error { color: var(--error, #ef4444); }
      `}</style>
    </AdminLayout>
  );
}
