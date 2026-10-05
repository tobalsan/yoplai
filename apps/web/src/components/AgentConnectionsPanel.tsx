import { createEffect, createSignal, For, Show } from "solid-js";
import {
  disconnectMcpConnection,
  disconnectAgentConnection,
  fetchAgentMcpConnections,
  fetchAgentConnections,
  type AgentConnection,
} from "../api/connections";
import type { ExtensionCatalogEntry } from "../api/extensions";
import { useSession } from "../auth/client";
import { ScopeIcon, STATUS_PILL_STYLES, StatusPill, type ScopeStatus } from "./CredentialScopeTabs";

export function AgentConnectionsPanel(props: {
  agentId: string;
  includeMcp?: boolean;
  /** Agent extension catalog, used to show each connection's extension icon. */
  extensions?: ExtensionCatalogEntry[];
}) {
  const [connections, setConnections] = createSignal<AgentConnection[]>([]);
  const [mcpConnections, setMcpConnections] = createSignal<AgentConnection[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [mcpLoading, setMcpLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [mcpError, setMcpError] = createSignal<string>();
  const [pending, setPending] = createSignal<string>();
  const session = useSession();
  let requestId = 0;

  const refresh = async (agentId: string, userId?: string) => {
    const currentRequest = ++requestId;
    setLoading(true);
    setError(undefined);
    setMcpError(undefined);
    if (props.includeMcp) {
      setMcpLoading(true);
      void fetchAgentMcpConnections(agentId, Boolean(userId))
        .then((next) => {
          if (currentRequest === requestId) setMcpConnections(next);
        })
        .catch((cause) => {
          if (currentRequest === requestId) {
            setMcpConnections([]);
            setMcpError(cause instanceof Error ? cause.message : "Failed to load MCP connection status");
          }
        })
        .finally(() => {
          if (currentRequest === requestId) setMcpLoading(false);
        });
    } else {
      setMcpConnections([]);
      setMcpLoading(false);
    }
    try {
      const next = await fetchAgentConnections(agentId);
      if (currentRequest === requestId) setConnections(next);
    } catch (cause) {
      if (currentRequest === requestId) {
        setConnections([]);
        setError(cause instanceof Error ? cause.message : "Failed to load connections");
      }
    } finally {
      if (currentRequest === requestId) setLoading(false);
    }
  };

  createEffect(() => {
    const agentId = props.agentId;
    const userId = session().data?.user?.id;
    setConnections([]);
    setMcpConnections([]);
    if (agentId) void refresh(agentId, userId);
  });

  const disconnect = async (connection: AgentConnection) => {
    const agentId = props.agentId;
    const userId = session().data?.user?.id;
    const key = `${connection.kind}:${connection.id}`;
    setPending(key);
    if (connection.kind === "mcp") setMcpError(undefined);
    else setError(undefined);
    try {
      if (connection.kind === "mcp") await disconnectMcpConnection(agentId, connection.id);
      else await disconnectAgentConnection(agentId, connection.kind, connection.id);
      if (agentId === props.agentId && userId === session().data?.user?.id) await refresh(agentId, userId);
    } catch (cause) {
      if (connection.kind === "mcp") setMcpError(cause instanceof Error ? cause.message : "Failed to disconnect MCP connection");
      else setError(cause instanceof Error ? cause.message : "Failed to disconnect connection");
    } finally {
      setPending(undefined);
    }
  };

  const rows = () => [...connections(), ...mcpConnections()];

  return (
    <section class="agent-connections" aria-label="My connections">
      <style>{STATUS_PILL_STYLES + AGENT_CONNECTIONS_STYLES}</style>
      <header class="agent-connections-head">
        <h2>My connections</h2>
        <p>Your own connections sit next to the team fallback. Disconnecting removes only yours; the team connection stays.</p>
      </header>
      <Show when={loading()}><p class="agent-connections-note" role="status">Loading connections…</p></Show>
      <Show when={error()}>{(message) => <p role="alert" class="agent-connections-error">{message()}</p>}</Show>
      <Show when={mcpLoading()}><p class="agent-connections-note" role="status">Loading MCP connections…</p></Show>
      <Show when={mcpError()}>{(message) => <p role="alert" class="agent-connections-error">MCP connections unavailable: {message()}</p>}</Show>
      <Show when={!loading() && !error() && !mcpLoading() && !mcpError() && rows().length === 0}>
        <p class="agent-connections-note">No connections are configured for this agent.</p>
      </Show>
      <Show when={rows().length > 0}>
        <ul class="agent-connection-list">
          <For each={rows()}>{(connection) => {
            const key = `${connection.kind}:${connection.id}`;
            const name = displayName(connection);
            return (
              <li class="agent-connection">
                <div class="agent-connection-service">
                  <span class="agent-connection-mark" aria-hidden="true">
                    <Show when={iconFor(connection, props.extensions)} fallback={name.charAt(0).toUpperCase()}>
                      {(src) => <img src={src()} alt="" />}
                    </Show>
                  </span>
                  <span class="agent-connection-text">
                    <span class="agent-connection-name">{name}</span>
                    <span class="agent-connection-kind">{KIND_LABELS[connection.kind]}</span>
                  </span>
                </div>
                <div class="agent-connection-scope" data-scope="personal">
                  <ScopeIcon scope="personal" class="agent-connection-scope-icon" />
                  <span class="agent-connection-scope-text">
                    <span class="agent-connection-scope-label">Just me</span>
                    <StatusPill status={connection.personal ? CONNECTED : NOT_CONNECTED} />
                  </span>
                  <Show when={connection.personal}>
                    <button
                      type="button"
                      class="agent-connection-disconnect"
                      aria-label={`Disconnect your personal ${name} connection`}
                      title="Remove your personal connection. The team connection is not affected."
                      disabled={pending() !== undefined}
                      onClick={() => void disconnect(connection)}
                    >
                      {pending() === key ? "Disconnecting…" : "Disconnect"}
                    </button>
                  </Show>
                </div>
                <div class="agent-connection-scope" data-scope="team">
                  <ScopeIcon scope="team" class="agent-connection-scope-icon" />
                  <span class="agent-connection-scope-text">
                    <span class="agent-connection-scope-label">Whole team</span>
                    <StatusPill status={connection.team ? CONNECTED : NOT_CONNECTED} />
                  </span>
                </div>
              </li>
            );
          }}</For>
        </ul>
      </Show>
    </section>
  );
}

const CONNECTED: ScopeStatus = { tone: "ok", label: "Connected" };
const NOT_CONNECTED: ScopeStatus = { tone: "error", label: "Not connected" };

const KIND_LABELS: Record<AgentConnection["kind"], string> = {
  oauth: "Account sign-in",
  extension: "API credentials",
  mcp: "MCP server",
};

/** Icon of the extension behind a connection: same id, same OAuth provider, or the MCP extension. */
function iconFor(connection: AgentConnection, extensions: ExtensionCatalogEntry[] = []): string | undefined {
  const matches = extensions.filter((extension) =>
    connection.kind === "extension" ? extension.id === connection.id
      : connection.kind === "oauth" ? extension.oauth?.provider === connection.id
        : extension.id === "mcp"
  );
  return (matches.find((extension) => extension.enabled) ?? matches[0])?.iconDataUri;
}

function displayName(connection: AgentConnection): string {
  const name = connection.kind === "mcp" ? connection.name.replace(/\s*\(MCP\)$/, "") : connection.name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const AGENT_CONNECTIONS_STYLES = `
.agent-connections { max-width: 860px; margin-top: 28px; }
.agent-connections-head h2 { margin: 0 0 4px; color: var(--text-primary); font-size: 18px; font-weight: 650; letter-spacing: -0.01em; }
.agent-connections-head p { margin: 0 0 18px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.agent-connections-note { margin: 0 0 12px; color: var(--text-secondary); font-size: 13px; }
.agent-connections-error { margin: 0 0 12px; color: var(--tone-error, #dc2626); font-size: 13px; }
.agent-connection-list {
  margin: 0; padding: 0; list-style: none; overflow: hidden;
  border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface);
}
.agent-connection {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 260px) minmax(0, 190px); align-items: center; gap: 20px;
  padding: 14px 18px; transition: background-color .15s ease;
}
.agent-connection + .agent-connection { border-top: 1px solid var(--border-subtle, var(--border-default)); }
.agent-connection:hover { background: color-mix(in srgb, var(--text-primary) 2.5%, transparent); }
.agent-connection-service { display: flex; align-items: center; gap: 12px; min-width: 0; }
.agent-connection-mark {
  flex: 0 0 auto; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
  font-size: 14px; font-weight: 700; color: var(--text-primary);
  background: var(--bg-inset, color-mix(in srgb, var(--text-primary) 6%, transparent));
  border: 1px solid var(--border-subtle, var(--border-default));
}
.agent-connection-mark img { width: 22px; height: 22px; object-fit: contain; }
.agent-connection-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.agent-connection-name { color: var(--text-primary); font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-connection-kind { color: var(--text-tertiary, var(--text-secondary)); font-size: 12px; }
.agent-connection-scope { display: flex; align-items: center; gap: 10px; min-width: 0; }
.agent-connection-scope[data-scope="team"] { padding-left: 20px; border-left: 1px solid var(--border-subtle, var(--border-default)); }
.agent-connection-scope-icon {
  flex: 0 0 auto; width: 28px; height: 28px; padding: 5px; border-radius: 8px;
  fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round;
  color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 10%, transparent);
}
.agent-connection-scope-text { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; }
.agent-connection-scope-label { color: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; }
.agent-connection-disconnect {
  margin-left: 2px; padding: 5px 10px; border: 1px solid var(--border-default); border-radius: 8px;
  background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
  transition: color .15s ease, border-color .15s ease, background-color .15s ease;
}
.agent-connection-disconnect:hover:not(:disabled) {
  color: #dc2626; border-color: color-mix(in srgb, #dc2626 45%, transparent); background: color-mix(in srgb, #dc2626 6%, transparent);
}
.agent-connection-disconnect:focus-visible { outline: 2px solid color-mix(in srgb, #dc2626 50%, transparent); outline-offset: 2px; }
.agent-connection-disconnect:disabled { opacity: .55; cursor: default; }
@media (max-width: 720px) {
  .agent-connection { grid-template-columns: 1fr 1fr; gap: 12px 16px; }
  .agent-connection-service { grid-column: 1 / -1; }
  .agent-connection-scope[data-scope="team"] { padding-left: 0; border-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .agent-connection, .agent-connection-disconnect { transition: none; }
}
`;
