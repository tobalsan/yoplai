import { createEffect, createSignal, For, Show } from "solid-js";
import {
  disconnectMcpConnection,
  disconnectAgentConnection,
  fetchAgentMcpConnections,
  fetchAgentConnections,
  type AgentConnection,
} from "../api/connections";
import { useSession } from "../auth/client";

export function AgentConnectionsPanel(props: { agentId: string; includeMcp?: boolean }) {
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

  return (
    <section class="agent-connections" aria-label="My connections">
      <style>{`
        .agent-connections { max-width: 760px; }
        .agent-connections h2 { margin: 0 0 6px; color: var(--text-primary); font-size: 18px; }
        .agent-connections p { margin: 0 0 16px; color: var(--text-secondary); font-size: 13px; }
        .agent-connection-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
        .agent-connection { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
        .agent-connection-name { display: block; color: var(--text-primary); font-size: 14px; font-weight: 600; }
        .agent-connection-status { display: block; margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
        .agent-connection button { border: 1px solid var(--border-default); border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-primary); cursor: pointer; }
        .agent-connection button:disabled { opacity: .55; cursor: default; }
        .agent-connections-error { color: var(--tone-error, #e55) !important; }
      `}</style>
      <h2>My connections</h2>
      <p>See your personal connections and whether a team connection is available. Disconnecting removes only your own access.</p>
      <Show when={loading()}><p role="status">Loading connections…</p></Show>
      <Show when={error()}>{(message) => <p role="alert" class="agent-connections-error">{message()}</p>}</Show>
      <Show when={mcpLoading()}><p role="status">Loading MCP connections…</p></Show>
      <Show when={mcpError()}>{(message) => <p role="alert" class="agent-connections-error">MCP connections unavailable: {message()}</p>}</Show>
      <Show when={!loading() && !error() && !mcpLoading() && !mcpError() && connections().length + mcpConnections().length === 0}>
        <p>No connections are configured for this agent.</p>
      </Show>
      <ul class="agent-connection-list">
        <For each={[...connections(), ...mcpConnections()]}>{(connection) => (
          <li class="agent-connection">
            <div>
              <span class="agent-connection-name">{connection.name}</span>
              <span class="agent-connection-status">
                {connection.personal ? "Personal connection connected" : "No personal connection"}
                {" · "}{connection.team ? "Team connection available" : "No team connection"}
              </span>
            </div>
            <Show when={connection.personal}>
              <button
                type="button"
                disabled={pending() !== undefined}
                onClick={() => void disconnect(connection)}
              >
                {pending() === `${connection.kind}:${connection.id}` ? "Disconnecting…" : "Disconnect"}
              </button>
            </Show>
          </li>
        )}</For>
      </ul>
    </section>
  );
}
