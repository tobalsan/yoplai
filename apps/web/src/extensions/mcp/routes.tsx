import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { Component } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { LeftNavShell } from "../../components/LeftNavShell";

type ServerAuth = "oauth" | "static";
type ServerState = "connected" | "disconnected" | "needs_reconnect" | "static";

export type McpServer = {
  name: string;
  url: string;
  auth: ServerAuth;
  state: ServerState;
  connectedAt?: string;
  expiresAt?: string;
};

type McpStatus = { servers: McpServer[] };

// The OAuth popup posts "yoplai-oauth", but a SPA left open across a gateway
// upgrade may still be running old listener code while a new gateway serves
// the popup (or vice versa), so accept the legacy "aihub-oauth" type too.
// Do not remove until that version-skew window is no longer a concern.
const OAUTH_POPUP_MESSAGE_TYPES = new Set(["yoplai-oauth", "aihub-oauth"]);

async function fetchStatus(agentId: string): Promise<McpStatus> {
  const res = await fetch(`/api/mcp/oauth/status?agent=${encodeURIComponent(agentId)}`);
  if (!res.ok) throw new Error("Failed to load MCP server status.");
  return (await res.json()) as McpStatus;
}

function badgeLabel(state: ServerState): string {
  switch (state) {
    case "connected": return "Connected";
    case "needs_reconnect": return "Needs reconnect";
    case "static": return "Configured";
    default: return "Not connected";
  }
}

export function McpConfigPage(): ReturnType<Component> {
  const params = useParams<{ agentId: string }>();
  const [servers, setServers] = createSignal<McpServer[]>();
  const [error, setError] = createSignal<string>();
  const [loading, setLoading] = createSignal(false);

  const refreshStatus = async () => {
    const agentId = params.agentId;
    if (!agentId) return;
    setLoading(true);
    try {
      setServers((await fetchStatus(agentId)).servers);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load MCP server status.");
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    void params.agentId;
    void refreshStatus();
  });

  createEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const result = event.data;
      if (!result || typeof result !== "object" || !OAUTH_POPUP_MESSAGE_TYPES.has(result.type) || result.extension !== "mcp") return;
      if (result.success) {
        void refreshStatus();
      } else {
        setError(`Could not connect ${result.server ?? "MCP server"}.`);
      }
    };
    const onFocus = () => void refreshStatus();
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    onCleanup(() => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
    });
  });

  const connect = (server: McpServer) => {
    const url = `/api/mcp/oauth/authorize?agent=${encodeURIComponent(params.agentId)}&server=${encodeURIComponent(server.name)}`;
    window.open(url, "yoplai-oauth", "width=520,height=640");
  };

  const disconnect = async (server: McpServer) => {
    try {
      const res = await fetch(
        `/api/mcp/oauth/disconnect?agent=${encodeURIComponent(params.agentId)}&server=${encodeURIComponent(server.name)}`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error(`Failed to disconnect ${server.name}.`);
      await refreshStatus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed to disconnect ${server.name}.`);
    }
  };

  return (
    <LeftNavShell>
      <div class="mcp-config-root">
        <style>{MCP_STYLES}</style>
        <A href={`/agents/${encodeURIComponent(params.agentId)}/edit`} class="mcp-config-back">← Back to agent</A>
        <header class="mcp-config-header">
          <h1>MCP servers</h1>
          <p>Connect OAuth-protected remote MCP servers for this agent.</p>
        </header>
        <Show when={error()}>{(message) => <div class="mcp-config-error">{message()}</div>}</Show>
        <Show when={loading() && !servers()}><div class="mcp-config-quiet">Checking servers…</div></Show>
        <Show when={servers()?.length === 0}><div class="mcp-config-empty">No remote MCP servers are configured for this agent.</div></Show>
        <div class="mcp-config-list">
          <For each={servers()}>{(server) => (
            <section class="mcp-config-card">
              <div class="mcp-config-server">
                <div>
                  <div class="mcp-config-name">{server.name}</div>
                  <div class="mcp-config-url">{server.url}</div>
                </div>
                <span class={`mcp-config-badge mcp-config-badge-${server.state}`}>{badgeLabel(server.state)}</span>
              </div>
              <Show when={server.auth === "oauth"}>
                <div class="mcp-config-actions">
                  <Show when={server.state === "connected"} fallback={
                    <button class="mcp-config-btn mcp-config-btn-primary" onClick={() => connect(server)}>
                      {server.state === "needs_reconnect" ? "Reconnect" : "Connect"}
                    </button>
                  }>
                    <button class="mcp-config-btn mcp-config-btn-danger" onClick={() => void disconnect(server)}>Disconnect</button>
                  </Show>
                </div>
              </Show>
            </section>
          )}</For>
        </div>
      </div>
    </LeftNavShell>
  );
}

const MCP_STYLES = `
.mcp-config-root { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
.mcp-config-back { display: inline-block; margin-bottom: 20px; font-size: 14px; color: var(--text-secondary); text-decoration: none; }
.mcp-config-header h1 { margin: 0 0 6px; font-size: 22px; color: var(--text-primary); }
.mcp-config-header p { margin: 0 0 24px; color: var(--text-secondary); font-size: 14px; }
.mcp-config-error, .mcp-config-empty { margin-bottom: 16px; padding: 10px 14px; border-radius: 10px; color: var(--text-primary); font-size: 13px; }
.mcp-config-error { background: color-mix(in srgb, #ef4444 10%, transparent); border: 1px solid color-mix(in srgb, #ef4444 40%, transparent); }
.mcp-config-empty { border: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-secondary); }
.mcp-config-quiet { color: var(--text-secondary); font-size: 13px; }
.mcp-config-list { display: grid; gap: 12px; }
.mcp-config-card { border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface); padding: 16px; }
.mcp-config-server { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
.mcp-config-name { font-size: 16px; font-weight: 600; color: var(--text-primary); }
.mcp-config-url { margin-top: 4px; color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.mcp-config-badge { flex: 0 0 auto; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 3px 8px; border-radius: 999px; }
.mcp-config-badge-connected { color: #137333; background: color-mix(in srgb, #137333 12%, transparent); }
.mcp-config-badge-disconnected, .mcp-config-badge-static { color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 12%, transparent); }
.mcp-config-badge-needs_reconnect { color: #b26a00; background: color-mix(in srgb, #f9ab00 18%, transparent); }
.mcp-config-actions { display: flex; justify-content: flex-end; margin-top: 16px; }
.mcp-config-btn { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 13px; cursor: pointer; }
.mcp-config-btn-primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
.mcp-config-btn-danger { color: #c5221f; }
`;

export const webRouteExtension = {
  extensionId: "mcp",
  routes: [],
  configRoute: {
    path: "/agents/:agentId/extensions/mcp",
    component: McpConfigPage,
  },
};
