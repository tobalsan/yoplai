import { createEffect, createMemo, createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import { useSession } from "../auth/client";
import {
  disconnectMcpServer,
  fetchMcpServerConfig,
  fetchMcpServer,
  fetchMcpServersFast,
  type McpServerList,
  mcpDisplayName,
  removeMcpServer,
  iconRefreshOutcome,
  refreshMcpServerIcon,
  saveMcpServerConfig,
  saveMcpServerLabel,
  setSharedMcpServer,
  type McpScope,
  type McpServer,
} from "../api/mcp-servers";
import { CredentialScopeTabs, preferredScope, STATUS_CONNECTED, STATUS_NOT_SET_UP, STATUS_RECONNECT, type ScopeStatus } from "../components/CredentialScopeTabs";
import { McpIcon } from "../components/McpExtensionCard";
import { OAUTH_CONNECT_CARD_STYLES } from "../components/OAuthConnectCard";
import { EXTENSION_DETAILS_STYLES } from "./ExtensionDetails";
import { onOAuthReturn } from "../lib/oauth-popup";
import { readOAuthResult } from "../lib/oauth-return";
import { showToast } from "../lib/toast";
import { ReconnectWarning, ScopeUsageNote, TEAM_MANAGED_NOTE } from "../components/ScopedConnectionNotes";

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
  const oauthResult = readOAuthResult();
  const [servers, { refetch: refetchFast }] = createResource(
    () => ({ agent: params.agentId, name: params.serverName }),
    async (key) => ({ ...key, list: await fetchMcpServersFast(key.agent, key.name) })
  );
  const fastStatus = createMemo(() => {
    const loaded = !servers.error && ["ready", "refreshing"].includes(servers.state) ? servers.latest : undefined;
    return loaded?.agent === params.agentId && loaded?.name === params.serverName ? loaded.list : undefined;
  });
  const [live, setLive] = createSignal<{ agent: string; name: string; list: McpServerList }>();
  const [checking, setChecking] = createSignal(false);
  const [statusFailed, setStatusFailed] = createSignal(false);
  let request = 0;
  const refetch = async () => {
    const agent = params.agentId;
    const name = params.serverName;
    const configured = fastStatus()?.servers.find((server) => server.name === name);
    if (!configured || (configured.shared && !configured.enabled)) return;
    const currentRequest = ++request;
    setChecking(true);
    setStatusFailed(false);
    const current = () => request === currentRequest && params.agentId === agent && params.serverName === name;
    try {
      const list = await fetchMcpServer(agent, name);
      if (current()) setLive({ agent, name, list });
    } catch {
      if (current()) setStatusFailed(true);
    } finally {
      if (current()) setChecking(false);
    }
  };
  onCleanup(() => { request++; });
  createEffect(() => {
    const list = fastStatus();
    request++;
    setLive(undefined);
    setChecking(false);
    setStatusFailed(false);
    const configured = list?.servers.find((server) => server.name === params.serverName);
    if (configured && (!configured.shared || configured.enabled)) void refetch();
  });
  const status = () => {
    const latest = live();
    return latest?.agent === params.agentId && latest.name === params.serverName ? latest.list : fastStatus();
  };
  const server = createMemo<McpServer | undefined>(() => status()?.servers.find((item) => item.name === params.serverName));
  if (oauthResult?.status === "connected") showToast(`Connected to ${mcpDisplayName(params.serverName, server()?.title)}`, "success");
  const canConfigureTeam = () => status()?.canConfigureTeam !== false;
  const canEditLabels = () => status()?.canEditLabels === true;
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  // Show feedback while the provider sign-in page loads. Reset it when Back restores this page from the bfcache.
  const [redirecting, setRedirecting] = createSignal(false);
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) setRedirecting(false); };
  window.addEventListener("pageshow", onPageShow);
  onCleanup(() => window.removeEventListener("pageshow", onPageShow));
  const [scope, setScope] = createSignal<McpScope>(oauthResult?.scope ?? "personal");
  let scopePicked = !!oauthResult;
  let scopeKey = JSON.stringify([params.agentId, params.serverName]);
  createEffect(() => {
    const key = JSON.stringify([params.agentId, params.serverName]);
    if (key !== scopeKey) {
      scopeKey = key;
      scopePicked = false;
      setScope("personal");
    }
  });

  createEffect(() => {
    onCleanup(onOAuthReturn(() => { void refetch(); }, { extension: "mcp" }));
  });

  const tabStatus = (target: McpScope): ScopeStatus | undefined => {
    const state = target === "personal" ? server()?.personalState : server()?.teamState;
    if (!server()) return oauthResult?.scope === target && oauthResult.status === "connected" ? STATUS_CONNECTED : undefined;
    if (state === "needs_reconnect") return STATUS_RECONNECT;
    return state === "connected" ? STATUS_CONNECTED : STATUS_NOT_SET_UP;
  };

  createEffect(() => {
    if (!server() || scopePicked || session().isPending) return;
    scopePicked = true;
    setScope(preferredScope({ personal: tabStatus("personal"), team: tabStatus("team") }, !!session().data?.user));
  });

  const scopedState = () => (scope() === "personal" ? server()?.personalState : server()?.teamState);
  const teamReadOnly = () => scope() === "team" && !canConfigureTeam();

  const connect = () => {
    setRedirecting(true);
    const returnTo = window.location.pathname + window.location.search + window.location.hash;
    window.location.assign(
      `/api/mcp/oauth/authorize?agent=${encodeURIComponent(params.agentId)}&server=${encodeURIComponent(params.serverName)}&scope=${scope()}&returnTo=${encodeURIComponent(returnTo)}`
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

  const setEnabled = async (enabled: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await setSharedMcpServer(params.agentId, params.serverName, enabled);
      await refetchFast();
    } catch (cause) {
      setError(errorMessage(cause, "Failed to update MCP server."));
    } finally { setBusy(false); }
  };

  const [iconOverride, setIconOverride] = createSignal<{ agent: string; name: string; iconUrl?: string }>();
  const [refreshingIcon, setRefreshingIcon] = createSignal(false);
  const [iconMessage, setIconMessage] = createSignal<string>();
  const [iconError, setIconError] = createSignal<string>();
  let iconRequest = 0;
  createEffect(() => {
    void params.agentId; void params.serverName;
    iconRequest++;
    setIconOverride(undefined);
    setRefreshingIcon(false);
    setIconMessage(undefined);
    setIconError(undefined);
  });
  onCleanup(() => { iconRequest++; });
  const refreshIcon = async () => {
    const agent = params.agentId;
    const name = params.serverName;
    const currentRequest = ++iconRequest;
    const current = () => iconRequest === currentRequest && params.agentId === agent && params.serverName === name;
    setRefreshingIcon(true);
    setIconMessage(undefined);
    setIconError(undefined);
    try {
      const result = await refreshMcpServerIcon(agent, name);
      if (!current()) return;
      setIconOverride({ agent, name, iconUrl: result.server.iconUrl });
      const outcome = iconRefreshOutcome(result, "Connect this server first, then refresh the icon");
      const list = live()?.agent === agent && live()?.name === name ? live()!.list : fastStatus();
      if (list) setLive({ agent, name, list: { ...list, servers: list.servers.map((item) => item.name === name ? { ...item, error: undefined, ...result.server } : item) } });
      if ("error" in outcome) setIconError(outcome.error);
      else setIconMessage(outcome.message);
    } catch (cause) {
      if (current()) setIconError(errorMessage(cause, "Failed to refresh MCP server icon."));
    } finally { if (current()) setRefreshingIcon(false); }
  };
  const iconUrl = () => {
    const saved = iconOverride();
    return saved?.agent === params.agentId && saved.name === params.serverName ? saved.iconUrl : server()?.iconUrl;
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
        <Show when={oauthResult?.status === "error" && oauthResult}>
          {(result) => <div class="oauth-error" role="alert">{result().error}</div>}
        </Show>
        <Show when={servers.loading && !server()}><div class="ext-details-status">Loading MCP server…</div></Show>
        <Show when={servers.error}><div class="ext-details-status ext-details-error" role="alert">Failed to load MCP server. <button type="button" class="oauth-btn" onClick={() => void refetchFast()}>Retry</button></div></Show>
        <Show when={!servers.loading && !servers.error && !server()}>
          <div class="ext-details-status ext-details-error">MCP server not found.</div>
        </Show>
        <Show when={server()}>
          {(current) => (
            <>
              <div class="mcp-details-head">
                <McpIcon src={iconUrl()} />
                <div>
                  <h1 class="ext-details-name">{mcpDisplayName(current().name, current().title)}</h1>
                  <Show when={current().description}>{(description) => <p class="ext-details-desc">{description()}</p>}</Show>
                  <p class="ext-details-desc">{current().url ?? "Local MCP server"}</p>
                </div>
                <div class="mcp-details-remove">
                  <Show when={!current().shared && current().type === "http"}>
                    <div class="mcp-icon-refresh">
                      <button type="button" class="oauth-btn" disabled={refreshingIcon()} onClick={() => void refreshIcon()}>{refreshingIcon() ? "Refreshing…" : "Refresh icon"}</button>
                      <Show when={iconMessage()}>{(text) => <p role="status">{text()}</p>}</Show>
                      <Show when={iconError()}>{(text) => <p class="ext-details-error" role="alert">{text()}</p>}</Show>
                    </div>
                  </Show>
                  <Show when={current().shared}>
                    <button type="button" class="oauth-btn" classList={{ "oauth-btn-primary": !current().enabled }} disabled={busy()} onClick={() => void setEnabled(!current().enabled)}>{current().enabled ? "Disable" : "Enable"}</button>
                  </Show>
                  <Show when={canConfigureTeam() && !current().shared}>
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
              <Show when={(!current().shared || current().enabled) && (checking() || statusFailed() || current().state === "unreachable" || (current().state === "connected" && current().auth !== "oauth"))}>
                <p role="status">
                  <Switch fallback="Connected">
                    <Match when={checking()}>Checking…</Match>
                    <Match when={statusFailed() || current().state === "unreachable"}>
                      {statusFailed() ? "Failed to check status." : "Unreachable"} <button type="button" class="oauth-btn" onClick={() => void refetch()}>Retry</button>
                    </Match>
                  </Switch>
                </p>
              </Show>
              <Show when={error()}>{(message) => <div class="oauth-error" role="alert">{message()}</div>}</Show>
              <Show when={current().shared && !current().enabled}>
                <p class="oauth-shared-note">Shared by your admins. Enable it to use its tools in this agent.</p>
              </Show>
              <Show when={!current().shared || current().enabled}>
              <Show when={current().auth !== "oauth"}>
                {current().shared
                  ? <p class="oauth-shared-note">This shared server has no sign-in or configuration here; a superadmin manages it.</p>
                  : <McpConfigEditor agentId={params.agentId} name={params.serverName} onSaved={() => void refetchFast()} />}
              </Show>
              </Show>

            </>
          )}
        </Show>
        <Show when={(server()?.auth === "oauth" || oauthResult) && (!server()?.shared || server()?.enabled)}>
          <CredentialScopeTabs
            value={scope()}
            personalDisabled={!session().data?.user}
            teamLocked={!canConfigureTeam()}
            status={{ personal: tabStatus("personal"), team: tabStatus("team") }}
            onChange={(next) => { scopePicked = true; setScope(next); }}
          >
            <Show when={server()}>
            <div class="oauth-card-head">
              <span class="oauth-provider-name">{mcpDisplayName(params.serverName, server()?.title)}</span>
              <Show when={!teamReadOnly()}>
                <Switch fallback={<button type="button" class="oauth-btn oauth-btn-primary" disabled={busy() || redirecting()} onClick={connect}>{redirecting() ? "Redirecting…" : `Connect ${mcpDisplayName(params.serverName, server()?.title)}`}</button>}>
                  <Match when={scopedState() === "connected"}>
                    <div class="oauth-actions">
                      <button type="button" class="oauth-btn oauth-btn-danger" disabled={busy()} onClick={() => void disconnect()}>Disconnect</button>
                    </div>
                  </Match>
                  <Match when={scopedState() === "needs_reconnect"}>
                    <div class="oauth-actions">
                      <button type="button" class="oauth-btn oauth-btn-primary" disabled={busy() || redirecting()} onClick={connect}>{redirecting() ? "Redirecting…" : "Reconnect"}</button>
                      <button type="button" class="oauth-btn oauth-btn-danger" disabled={busy()} onClick={() => void disconnect()}>Disconnect</button>
                    </div>
                  </Match>
                </Switch>
              </Show>
            </div>
            </Show>
            <Show when={teamReadOnly()}>
              <p class="oauth-shared-note">{TEAM_MANAGED_NOTE}</p>
            </Show>
            <Show when={scopedState() === "needs_reconnect" && !teamReadOnly()}>
              <ReconnectWarning />
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
              <ScopeUsageNote scope={scope()} />
            </Show>
          </CredentialScopeTabs>
        </Show>
        <Show when={server() && canEditLabels() && !server()?.shared}>
          <details class="mcp-edit-details">
            <summary>Edit MCP details</summary>
            <McpLabelForm agentId={params.agentId} name={params.serverName} label={server()?.manualLabel} onSaved={() => void refetchFast()} />
          </details>
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
        .mcp-icon-refresh { margin-bottom: 8px; }
        .mcp-details-remove .mcp-icon-refresh p { margin: 8px 0 0; }
        .mcp-details-remove-actions { display: flex; gap: 8px; justify-content: flex-end; }
        .mcp-edit-details { margin-top: 28px; font-size: 13px; color: var(--text-tertiary, var(--text-secondary)); }
        .mcp-edit-details summary { cursor: pointer; width: fit-content; user-select: none; }
        .mcp-edit-details summary:hover { color: var(--text-secondary); }
        .mcp-edit-details[open] summary { margin-bottom: 10px; }
        .mcp-label-form { display: grid; gap: 8px; margin-bottom: 16px; }
        .mcp-label-form label { display: grid; gap: 4px; font-size: 13px; color: var(--text-secondary); }
        .mcp-label-form input { padding: 8px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); color: var(--text-primary); }
        .mcp-label-form button { justify-self: start; }
        .mcp-config-editor textarea { width: 100%; min-height: 240px; box-sizing: border-box; padding: 10px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); color: var(--text-primary); font: 12px/1.5 ui-monospace, monospace; }
        .mcp-config-editor p { color: var(--text-secondary); font-size: 13px; margin: 8px 0; }
        @media (max-width: 768px) {
          .mcp-details-head { display: grid; grid-template-columns: 56px minmax(0, 1fr); gap: 12px 14px; }
          .mcp-details-head > div:not(.mcp-details-remove) { display: contents; }
          .mcp-details-head .ext-details-desc, .mcp-details-remove { grid-column: 1 / -1; }
          .mcp-details-remove { margin-left: 0; max-width: none; text-align: left; }
          .mcp-details-remove-actions { justify-content: flex-start; }
        }
      `}</style>
    </>
  );
}

function McpLabelForm(props: { agentId: string; name: string; label?: { displayName?: string; description?: string }; onSaved: () => void }) {
  const [displayName, setDisplayName] = createSignal(props.label?.displayName ?? "");
  const [description, setDescription] = createSignal(props.label?.description ?? "");
  const [error, setError] = createSignal<string>();
  const [saved, setSaved] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const save = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      await saveMcpServerLabel(props.agentId, props.name, { displayName: displayName(), description: description() });
      setSaved(true);
      props.onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "Failed to save name and description."));
    } finally { setSaving(false); }
  };
  return (
    <form class="mcp-label-form" onSubmit={(event) => void save(event)}>
      <label>Name <input type="text" maxLength={100} placeholder="Shown instead of the server-reported name" value={displayName()} onInput={(event) => { setDisplayName(event.currentTarget.value); setSaved(false); }} /></label>
      <label>Description <input type="text" maxLength={500} placeholder="Shown instead of the server-reported description" value={description()} onInput={(event) => { setDescription(event.currentTarget.value); setSaved(false); }} /></label>
      <Show when={error()}>{(message) => <div class="oauth-error" role="alert">{message()}</div>}</Show>
      <Show when={saved()}><p role="status">Saved.</p></Show>
      <button type="submit" class="oauth-btn" disabled={saving()}>{saving() ? "Saving…" : "Update name and description"}</button>
    </form>
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
