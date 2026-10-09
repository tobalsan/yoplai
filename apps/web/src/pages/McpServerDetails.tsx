import { createEffect, createMemo, createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import { useSession } from "../auth/client";
import {
  disconnectMcpServer,
  fetchMcpServerConfig,
  fetchMcpServers,
  cachedMcpServers,
  mcpDisplayName,
  removeMcpServer,
  saveMcpServerConfig,
  type McpScope,
  type McpServer,
} from "../api/mcp-servers";
import { CredentialScopeTabs, preferredScope, type ScopeStatus } from "../components/CredentialScopeTabs";
import { McpIcon } from "../components/McpExtensionCard";
import { OAUTH_CONNECT_CARD_STYLES } from "../components/OAuthConnectCard";
import { EXTENSION_DETAILS_STYLES } from "./ExtensionDetails";

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * Config page for one MCP server (`/agents/:agentId/mcp-servers/:serverName`),
 * reached from its card on the Edit-Agent list. OAuth servers get the same
 * Just me / Whole team connect UX as OAuth extensions; other HTTP servers get
 * a JSON editor for their mcp.json entry (shared by the whole team).
 */
export function McpServerDetails() {
  const params = useParams<{ agentId: string; serverName: string }>();
  const navigate = useNavigate();
  const session = useSession();
  const [servers, { refetch }] = createResource(() => params.agentId, fetchMcpServers);
  // `.latest` keeps background refetches (focus, OAuth popup) from suspending the page.
  // Read only settled values (via `.state`, which never suspends) and fall back to the cached list,
  // so slow live status checks never suspend the app into a blank screen.
  const status = () => (servers.error ? undefined : (["ready", "refreshing"].includes(servers.state) ? servers.latest : undefined) ?? cachedMcpServers(params.agentId));
  const server = createMemo<McpServer | undefined>(() => status()?.servers.find((item) => item.name === params.serverName));
  const canConfigureTeam = () => status()?.canConfigureTeam !== false;
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [scope, setScope] = createSignal<McpScope>("personal");
  let scopePicked = false;

  createEffect(() => {
    const onReturn = () => { void refetch(); };
    const onMessage = (event: MessageEvent) => {
      if (event.data?.extension === "mcp" && ["yoplai-oauth", "aihub-oauth"].includes(event.data.type)) onReturn();
    };
    window.addEventListener("focus", onReturn);
    window.addEventListener("message", onMessage);
    onCleanup(() => {
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("message", onMessage);
    });
  });

  const tabStatus = (target: McpScope): ScopeStatus | undefined => {
    const state = target === "personal" ? server()?.personalState : server()?.teamState;
    if (!server()) return undefined;
    if (state === "needs_reconnect") return { tone: "error", label: "Reconnect" };
    return state === "connected" ? { tone: "ok", label: "Connected" } : { tone: "off", label: "Not set up" };
  };

  createEffect(() => {
    if (!server() || scopePicked || session().isPending) return;
    scopePicked = true;
    setScope(preferredScope({ personal: tabStatus("personal"), team: tabStatus("team") }, !!session().data?.user));
  });

  const scopedState = () => (scope() === "personal" ? server()?.personalState : server()?.teamState);
  const teamReadOnly = () => scope() === "team" && !canConfigureTeam();

  const connect = () => {
    window.open(
      `/api/mcp/oauth/authorize?agent=${encodeURIComponent(params.agentId)}&server=${encodeURIComponent(params.serverName)}&scope=${scope()}`,
      "yoplai-oauth",
      "width=520,height=640"
    );
  };

  const disconnect = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await disconnectMcpServer(params.agentId, params.serverName, scope());
      await refetch();
    } catch (cause) {
      setError(errorMessage(cause, "Failed to disconnect MCP server."));
    } finally { setBusy(false); }
  };

  const [confirmRemove, setConfirmRemove] = createSignal(false);
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await removeMcpServer(params.agentId, params.serverName);
      navigate(`/agents/${encodeURIComponent(params.agentId)}/edit`);
    } catch (cause) {
      setError(errorMessage(cause, "Failed to remove MCP server."));
      setBusy(false);
    }
  };

  return (
    <>
      <div class="ext-details mcp-details">
        <A href={`/agents/${encodeURIComponent(params.agentId)}/edit`} class="ext-details-back" data-tour="back-to-agent">← Back to agent</A>
        <Show when={servers.loading && !server()}><div class="ext-details-status">Loading MCP server…</div></Show>
        <Show when={servers.error}><div class="ext-details-status ext-details-error">Failed to load MCP server.</div></Show>
        <Show when={!servers.loading && !servers.error && !server()}>
          <div class="ext-details-status ext-details-error">MCP server not found.</div>
        </Show>
        <Show when={server()}>
          {(current) => (
            <>
              <div class="mcp-details-head">
                <McpIcon src={current().iconUrl} />
                <div>
                  <h1 class="ext-details-name">{mcpDisplayName(current().name, current().title)}</h1>
                  <Show when={current().description}>{(description) => <p class="ext-details-desc">{description()}</p>}</Show>
                  <p class="ext-details-desc">{current().url ?? "Local MCP server"}</p>
                </div>
                <div class="mcp-details-remove">
                  <Show when={canConfigureTeam()}>
                  <Show when={confirmRemove()} fallback={
                    <button type="button" class="oauth-btn oauth-btn-danger" disabled={busy()} onClick={() => setConfirmRemove(true)}>Remove server</button>
                  }>
                    <p role="alert">Remove {mcpDisplayName(params.serverName, server()?.title)} entirely? This deletes the extension from this agent for all users, not just your connection. To keep it, use Disconnect instead.</p>
                    <div class="mcp-details-remove-actions">
                      <button type="button" class="oauth-btn" disabled={busy()} onClick={() => setConfirmRemove(false)}>Cancel</button>
                      <button type="button" class="oauth-btn oauth-btn-danger" disabled={busy()} onClick={() => void remove()}>{busy() ? "Removing…" : "Confirm remove"}</button>
                    </div>
                  </Show>
                  </Show>
                </div>
              </div>
              <Show when={error()}>{(message) => <div class="oauth-error" role="alert">{message()}</div>}</Show>
              <Show when={current().auth === "oauth"} fallback={<McpConfigEditor agentId={params.agentId} name={params.serverName} onSaved={() => void refetch()} />}>
                <CredentialScopeTabs
                  value={scope()}
                  personalDisabled={!session().data?.user}
                  teamLocked={!canConfigureTeam()}
                  status={{ personal: tabStatus("personal"), team: tabStatus("team") }}
                  onChange={(next) => { scopePicked = true; setScope(next); }}
                >
                  <div class="oauth-card-head">
                    <span class="oauth-provider-name">{mcpDisplayName(current().name, current().title)}</span>
                    <Show when={!teamReadOnly()}>
                      <Switch fallback={<button type="button" class="oauth-btn oauth-btn-primary" disabled={busy()} onClick={connect}>Connect {mcpDisplayName(current().name, current().title)}</button>}>
                        <Match when={scopedState() === "connected"}>
                          <div class="oauth-actions">
                            <button type="button" class="oauth-btn oauth-btn-danger" disabled={busy()} onClick={() => void disconnect()}>Disconnect</button>
                          </div>
                        </Match>
                        <Match when={scopedState() === "needs_reconnect"}>
                          <div class="oauth-actions">
                            <button type="button" class="oauth-btn oauth-btn-primary" disabled={busy()} onClick={connect}>Reconnect</button>
                            <button type="button" class="oauth-btn oauth-btn-danger" disabled={busy()} onClick={() => void disconnect()}>Disconnect</button>
                          </div>
                        </Match>
                      </Switch>
                    </Show>
                  </div>
                  <Show when={teamReadOnly()}>
                    <p class="oauth-shared-note">The whole team connection is managed by an admin.</p>
                  </Show>
                  <Show when={scopedState() === "needs_reconnect" && !teamReadOnly()}>
                    <div class="oauth-connected-detail"><p class="oauth-warn-text">This connection can no longer refresh. Reconnect to restore access.</p></div>
                  </Show>
                  <Show when={scopedState() === "connected"}>
                    <Show when={scope() === "personal" ? server()?.personalAccount : server()?.teamAccount}>
                      {(account) => (
                        <div class="oauth-account">
                          <span class="oauth-account-label">Connected as</span>
                          <span class="oauth-account-value">{account()}</span>
                        </div>
                      )}
                    </Show>
                    <p class="oauth-shared-note">
                      {scope() === "personal"
                        ? "Used only for your requests. Without it, your requests use the team connection when available."
                        : "Used by everyone on this agent who has no personal connection."}
                    </p>
                  </Show>
                </CredentialScopeTabs>
              </Show>
            </>
          )}
        </Show>
      </div>
      <style>{OAUTH_CONNECT_CARD_STYLES + EXTENSION_DETAILS_STYLES + `
        .mcp-details { max-width: 640px; }
        .mcp-details-head { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
        .mcp-details-head .edit-agent-ext-icon { width: 56px; height: 56px; flex: none; box-sizing: border-box; border-radius: 10px; background: #fff; padding: 8px; border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06)); color: var(--text-tertiary); display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .mcp-details-head .edit-agent-ext-icon svg { width: 28px; height: 28px; }
        .mcp-details-head .edit-agent-ext-icon-img { width: 100%; height: 100%; object-fit: contain; }
        .mcp-details-head .ext-details-desc { margin: 2px 0 0; overflow-wrap: anywhere; }
        .mcp-details-remove { margin-left: auto; align-self: flex-start; flex: none; max-width: 260px; text-align: right; }
        .mcp-details-remove p { color: var(--text-secondary); font-size: 13px; margin: 0 0 8px; }
        .mcp-details-remove-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .mcp-config-editor textarea { width: 100%; min-height: 240px; box-sizing: border-box; padding: 10px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); color: var(--text-primary); font: 12px/1.5 ui-monospace, monospace; }
        .mcp-config-editor p { color: var(--text-secondary); font-size: 13px; margin: 8px 0; }
      `}</style>
    </>
  );
}

function McpConfigEditor(props: { agentId: string; name: string; onSaved: () => void }) {
  const [view, { refetch }] = createResource(() => ({ agent: props.agentId, name: props.name }), (key) => fetchMcpServerConfig(key.agent, key.name));
  const [text, setText] = createSignal("");
  const [error, setError] = createSignal<string>();
  const [saved, setSaved] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const show = (config: Record<string, unknown>) => setText(JSON.stringify(config, null, 2));
  const loadedView = () => (["ready", "refreshing"].includes(view.state) ? view.latest : undefined);
  createEffect(() => { const loaded = loadedView(); if (loaded) show(loaded.config); });

  const save = async () => {
    let parsed: unknown;
    try { parsed = JSON.parse(text()); }
    catch (cause) { setError(`Invalid JSON: ${errorMessage(cause, "parse error")}`); setSaved(false); return; }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { setError("Config must be a JSON object."); setSaved(false); return; }
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      show((await saveMcpServerConfig(props.agentId, props.name, parsed)).config);
      setSaved(true);
      props.onSaved();
      void refetch();
    } catch (cause) {
      setError(errorMessage(cause, "Failed to save MCP server config."));
    } finally { setSaving(false); }
  };

  return (
    <div class="mcp-config-editor">
      <Show when={view.loading && !loadedView()}><div class="ext-details-status">Loading config…</div></Show>
      <Show when={view.error}><div class="ext-details-status ext-details-error" role="alert">Failed to load config.</div></Show>
      <Show when={loadedView()}>
        {(current) => (
          <>
            <p>
              {current().type === "stdio"
                ? "Local (stdio) servers are read-only here. Edit mcp.json directly to change them."
                : "Applies to the whole team. Header values are masked; leave a masked value unchanged to keep it."}
            </p>
            <textarea aria-label={`${props.name} config JSON`} spellcheck={false} readOnly={!current().editable} value={text()} onInput={(event) => { setText(event.currentTarget.value); setSaved(false); }} />
            <Show when={error()}>{(message) => <div class="oauth-error" role="alert">{message()}</div>}</Show>
            <Show when={saved()}><p role="status">Saved.</p></Show>
            <Show when={current().editable}>
              <button type="button" class="oauth-btn oauth-btn-primary" disabled={saving()} onClick={() => void save()}>{saving() ? "Saving…" : "Save"}</button>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}
