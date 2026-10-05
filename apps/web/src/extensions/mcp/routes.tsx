import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { Component } from "solid-js";
import { A, useParams } from "@solidjs/router";
import { useSession } from "../../auth/client";
import { LeftNavShell } from "../../components/LeftNavShell";
import { CredentialScopeTabs } from "../../components/CredentialScopeTabs";

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

type McpStatus = { servers: McpServer[]; canConfigureTeam?: boolean };

// The OAuth popup posts "yoplai-oauth", but a SPA left open across a gateway
// upgrade may still be running old listener code while a new gateway serves
// the popup (or vice versa), so accept the legacy "aihub-oauth" type too.
// Do not remove until that version-skew window is no longer a concern.
const OAUTH_POPUP_MESSAGE_TYPES = new Set(["yoplai-oauth", "aihub-oauth"]);

async function fetchStatus(agentId: string, scope: "team" | "personal"): Promise<McpStatus> {
  const res = await fetch(`/api/mcp/oauth/status?agent=${encodeURIComponent(agentId)}&scope=${scope}`);
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
  const session = useSession();
  const requestedScope = new URLSearchParams(window.location.search).get("scope");
  const [scope, setScope] = createSignal<"team" | "personal">(
    requestedScope === "personal" ? "personal" : "team"
  );
  const [canConfigureTeam, setCanConfigureTeam] = createSignal(true);
  let scopePicked = requestedScope === "team";
  let statusRequest = 0;

  const refreshStatus = async () => {
    const agentId = params.agentId;
    if (!agentId) return;
    const request = ++statusRequest;
    setLoading(true);
    try {
      const status = await fetchStatus(agentId, scope());
      if (request !== statusRequest) return;
      if (status.canConfigureTeam === false) {
        setCanConfigureTeam(false);
        if (scope() === "team" && !scopePicked) {
          // Non-admins start on the connections they can manage.
          setScope("personal");
          void refreshStatus();
          return;
        }
      }
      setServers(status.servers);
      setError(undefined);
    } catch (cause) {
      if (request === statusRequest) setError(cause instanceof Error ? cause.message : "Failed to load MCP server status.");
    } finally {
      if (request === statusRequest) setLoading(false);
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

  // Non-admins can see, but not change, admin-managed team connections.
  const teamReadOnly = () => scope() === "team" && !canConfigureTeam();

  const connect = (server: McpServer) => {
    const url = `/api/mcp/oauth/authorize?agent=${encodeURIComponent(params.agentId)}&server=${encodeURIComponent(server.name)}&scope=${scope()}`;
    window.open(url, "yoplai-oauth", "width=520,height=640");
  };

  const disconnect = async (server: McpServer) => {
    try {
      const res = await fetch(
        `/api/mcp/oauth/disconnect?agent=${encodeURIComponent(params.agentId)}&server=${encodeURIComponent(server.name)}&scope=${scope()}`,
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
          <p>Connect OAuth-protected remote MCP servers for yourself or for the whole team.</p>
        </header>
        <CredentialScopeTabs
          value={scope()}
          personalDisabled={!session().data?.user}
          teamLocked={!canConfigureTeam()}
          onChange={(next) => {
            setServers(undefined);
            setError(undefined);
            scopePicked = true;
            setScope(next);
          }}
        >
        <p class="mcp-config-quiet mcp-config-scope-note">
          {scope() === "personal"
            ? "Your connections are used only for your requests. Without one, your requests use the team connection when available."
            : "Team connections are used by everyone on this agent who has no personal connection."}
        </p>
        <Show when={teamReadOnly()}>
          <p class="mcp-config-quiet">Whole team connections are managed by an admin. Servers not connected here must be connected by an admin.</p>
        </Show>
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
              <Show when={server.auth === "oauth" && !teamReadOnly()}>
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
        </CredentialScopeTabs>
      </div>
    </LeftNavShell>
  );
}

const MCP_STYLES = `
.mcp-config-root { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
.mcp-config-back { display: inline-block; margin-bottom: 20px; font-size: 14px; color: var(--text-secondary); text-decoration: none; }
.mcp-config-header h1 { margin: 0 0 6px; font-size: 22px; color: var(--text-primary); }
.mcp-config-header p { margin: 0 0 24px; color: var(--text-secondary); font-size: 14px; }
.mcp-config-scope-note { margin: 0 0 16px; line-height: 1.5; }
.mcp-config-error, .mcp-config-empty { margin-bottom: 16px; padding: 10px 14px; border-radius: 10px; color: var(--text-primary); font-size: 13px; }
.mcp-config-error { background: color-mix(in srgb, #ef4444 10%, transparent); border: 1px solid color-mix(in srgb, #ef4444 40%, transparent); }
.mcp-config-empty { border: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-secondary); }
.mcp-config-quiet { color: var(--text-secondary); font-size: 13px; }
.mcp-config-list { display: grid; gap: 12px; }
.mcp-config-card { border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-base); padding: 16px; }
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
