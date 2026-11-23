import { createComputed, createEffect, createMemo, createResource, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
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
import { onOAuthReturn, openOAuthPopup } from "../lib/oauth-popup";
import { isDesktopWindow } from "../lib/desktop-window";
import { readOAuthResult } from "../lib/oauth-return";
import { showToast } from "../lib/toast";
import { decodeRouteParam } from "../lib/path";
import { useAgentTarget } from "../lib/agent-target";
import { useRequester } from "../lib/requester";
import { createOAuthPopupFlow, type OAuthVerdict } from "../lib/oauth-popup-flow";
import { fetchMcpStatus, type McpServerStatus } from "../api/connections";
import { startRemoteOAuth } from "../api/oauth";
import { gatewayKey } from "../api/gateway";
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
  const routeParams = useParams<{ agentId: string; serverName: string }>();
  // Router params keep the raw path segment. A server name is an arbitrary user string.
  const params = {
    get agentId() { return decodeRouteParam(routeParams.agentId); },
    get serverName() { return decodeRouteParam(routeParams.serverName); },
  };
  const navigate = useNavigate();
  const { target, retry } = useAgentTarget(() => params.agentId);
  const targetReady = () => target().state === "ready";
  const gateway = () => { const current = target(); return current.state === "ready" ? current.gateway : undefined; };
  const requester = useRequester(gateway);
  const flow = createOAuthPopupFlow();
  const oauthResult = readOAuthResult();
  const [servers, { refetch: refetchFast }] = createResource(
    () => { const current = target(); return current.state === "ready" ? { agent: params.agentId, name: params.serverName, gateway: current.gateway } : null; },
    async (key) => ({ ...key, list: await fetchMcpServersFast(key.agent, key.name, key.gateway) })
  );
  const fastStatus = createMemo(() => {
    const loaded = !servers.error && ["ready", "refreshing"].includes(servers.state) ? servers.latest : undefined;
    return loaded?.agent === params.agentId && loaded?.name === params.serverName && loaded?.gateway === gateway() ? loaded.list : undefined;
  });
  const [live, setLive] = createSignal<{ agent: string; name: string; gateway: string | undefined; list: McpServerList }>();
  const [checking, setChecking] = createSignal(false);
  const [statusFailed, setStatusFailed] = createSignal(false);
  let request = 0;
  const refetch = async () => {
    const agent = params.agentId;
    const name = params.serverName;
    const host = gateway();
    const configured = fastStatus()?.servers.find((server) => server.name === name);
    if (!configured || (configured.shared && !configured.enabled)) return;
    const currentRequest = ++request;
    setChecking(true);
    setStatusFailed(false);
    const current = () => request === currentRequest && params.agentId === agent && params.serverName === name && gateway() === host;
    try {
      const list = await fetchMcpServer(agent, name, host);
      if (current()) setLive({ agent, name, gateway: host, list });
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
    return latest?.agent === params.agentId && latest.name === params.serverName && latest.gateway === gateway() ? latest.list : fastStatus();
  };
  const server = createMemo<McpServer | undefined>(() => status()?.servers.find((item) => item.name === params.serverName));
  if (oauthResult?.status === "connected") showToast(`Connected to ${mcpDisplayName(params.serverName, server()?.title)}`, "success");
  const canConfigureTeam = () => status()?.canConfigureTeam !== false;
  const canEditLabels = () => status()?.canEditLabels === true;
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  // The identity of this page: gateway, agent, and server. Each change starts a new generation, so a late
  // result of an older identity changes no state, starts no navigation, and refreshes no other target.
  const identity = createMemo(() => { const current = target(); return current.state === "ready" ? gatewayKey(current.gateway, current.agentId, params.serverName) : undefined; });
  let generation = 0;
  createComputed(() => {
    void identity();
    generation++;
    setBusy(false);
    setError(undefined);
    setConfirmRemove(false);
  });
  // The page ends all mutation authority when it closes: no navigation, error, or refresh follows.
  onCleanup(() => { generation++; });
  /** The resolved target for one mutation, or nothing while the target is unknown. */
  const mutation = () => {
    const key = identity();
    const current = target();
    if (!key || current.state !== "ready") return undefined;
    const mine = generation;
    return { agentId: current.agentId, gateway: current.gateway, name: params.serverName, live: () => generation === mine && identity() === key };
  };
  // Show feedback while the provider sign-in page loads. Reset it when Back restores this page from the bfcache.
  const [redirecting, setRedirecting] = createSignal(false);
  const [desktopPopup, setDesktopPopup] = createSignal<Window | null>(null);
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) setRedirecting(false); };
  window.addEventListener("pageshow", onPageShow);
  onCleanup(() => window.removeEventListener("pageshow", onPageShow));
  const [pickedScope, setScope] = createSignal<McpScope>(oauthResult?.scope ?? "personal");
  const singleUser = () => requester().ready && !requester().unknown && !requester().multiUser;
  const scope = () => singleUser() ? "team" : pickedScope();
  let scopePicked = !!oauthResult;
  let scopeKey = JSON.stringify([params.agentId, params.serverName, gateway()]);
  createEffect(() => {
    const key = JSON.stringify([params.agentId, params.serverName, gateway()]);
    if (key !== scopeKey) {
      scopeKey = key;
      scopePicked = false;
      setScope("personal");
    }
  });
  // A new agent, gateway, server, or tab ends the sign-in of the old one.
  createEffect(() => {
    void [params.agentId, params.serverName, gateway(), scope()];
    flow.cancel();
    onCleanup(() => {
      desktopPopup()?.close();
      setDesktopPopup(null);
    });
  });

  createEffect(() => {
    const popup = desktopPopup();
    if (!popup) return;
    const timer = setInterval(() => {
      if (!popup.closed) return;
      setDesktopPopup(null);
      void refetch();
    }, 300);
    onCleanup(() => clearInterval(timer));
  });

  createEffect(() => {
    onCleanup(onOAuthReturn((event) => {
      if (event instanceof MessageEvent && event.source === desktopPopup()) setDesktopPopup(null);
      void refetch();
    }, { extension: "mcp" }));
  });

  const tabStatus = (target: McpScope): ScopeStatus | undefined => {
    const state = target === "personal" ? server()?.personalState : server()?.teamState;
    if (!server()) return oauthResult?.scope === target && oauthResult.status === "connected" ? STATUS_CONNECTED : undefined;
    if (state === "needs_reconnect") return STATUS_RECONNECT;
    return state === "connected" ? STATUS_CONNECTED : STATUS_NOT_SET_UP;
  };

  createEffect(() => {
    if (!server() || scopePicked || !requester().ready) return;
    scopePicked = true;
    setScope(preferredScope({ personal: tabStatus("personal"), team: tabStatus("team") }, !!requester().user));
  });

  const scopedState = () => (scope() === "personal" ? server()?.personalState : server()?.teamState);
  const teamReadOnly = () => scope() === "team" && !canConfigureTeam();

  /** Remote connect: the click opens the popup first. Status checks through the relay decide the result. */
  const connectRemote = () => {
    const host = gateway()!;
    const agent = params.agentId;
    const name = params.serverName;
    const credentialScope = scope();
    setError(undefined);
    const stateOf = (statuses: McpServerStatus[]) => statuses.find((item) => item.name === name)?.state;
    void flow.begin<McpServerStatus[]>({
      read: (signal) => fetchMcpStatus(agent, credentialScope, host, signal),
      start: (signal) => startRemoteOAuth(host, agent, credentialScope, { kind: "mcp", server: name }, signal),
      verdict: (before, now): OAuthVerdict => stateOf(now) === "connected" && stateOf(before) !== "connected" ? "connected" : "pending",
      // This status carries no connection time, so a connected server cannot show a new grant.
      canProve: (before) => stateOf(before) !== "connected",
      onConnected: () => refetch(),
    });
  };
  const flowBusy = () => flow.state().phase === "preparing" || flow.state().phase === "waiting";
  const waitingForSignIn = () => flowBusy() || desktopPopup() !== null;
  const pendingConnect = () => redirecting() || waitingForSignIn();
  const connectingLabel = () => (waitingForSignIn() ? "Waiting for sign-in…" : "Redirecting…");

  const connect = () => {
    if (gateway() !== undefined) return connectRemote();
    const authorizeUrl = `/api/mcp/oauth/authorize?agent=${encodeURIComponent(params.agentId)}&server=${encodeURIComponent(params.serverName)}&scope=${scope()}`;
    if (isDesktopWindow()) {
      const popup = openOAuthPopup(authorizeUrl);
      setDesktopPopup(popup);
      setError(popup ? undefined : "Could not open the sign-in window. Try again.");
      return;
    }
    setRedirecting(true);
    const returnTo = window.location.pathname + window.location.search + window.location.hash;
    window.location.assign(`${authorizeUrl}&returnTo=${encodeURIComponent(returnTo)}`);
  };

  const disconnect = async () => {
    const run = mutation();
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      await disconnectMcpServer(run.agentId, run.name, scope(), run.gateway);
      if (run.live()) await refetch();
    } catch (cause) {
      if (run.live()) setError(errorMessage(cause, "Failed to disconnect MCP server."));
    } finally { if (run.live()) setBusy(false); }
  };

  const setEnabled = async (enabled: boolean) => {
    const run = mutation();
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      await setSharedMcpServer(run.agentId, run.name, enabled, run.gateway);
      if (run.live()) await refetchFast();
    } catch (cause) {
      if (run.live()) setError(errorMessage(cause, "Failed to update MCP server."));
    } finally { if (run.live()) setBusy(false); }
  };

  const [iconOverride, setIconOverride] = createSignal<{ agent: string; name: string; gateway: string | undefined; iconUrl?: string }>();
  const [refreshingIcon, setRefreshingIcon] = createSignal(false);
  const [iconMessage, setIconMessage] = createSignal<string>();
  const [iconError, setIconError] = createSignal<string>();
  let iconRequest = 0;
  createEffect(() => {
    void params.agentId; void params.serverName; void gateway();
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
    const host = gateway();
    const currentRequest = ++iconRequest;
    const current = () => iconRequest === currentRequest && params.agentId === agent && params.serverName === name && gateway() === host;
    setRefreshingIcon(true);
    setIconMessage(undefined);
    setIconError(undefined);
    try {
      const result = await refreshMcpServerIcon(agent, name, host);
      if (!current()) return;
      setIconOverride({ agent, name, gateway: host, iconUrl: result.server.iconUrl });
      const outcome = iconRefreshOutcome(result, "Connect this server first, then refresh the icon");
      const list = live()?.agent === agent && live()?.name === name && live()?.gateway === host ? live()!.list : fastStatus();
      if (list) setLive({ agent, name, gateway: host, list: { ...list, servers: list.servers.map((item) => item.name === name ? { ...item, error: undefined, ...result.server } : item) } });
      if ("error" in outcome) setIconError(outcome.error);
      else setIconMessage(outcome.message);
    } catch (cause) {
      if (current()) setIconError(errorMessage(cause, "Failed to refresh MCP server icon."));
    } finally { if (current()) setRefreshingIcon(false); }
  };
  const iconUrl = () => {
    const saved = iconOverride();
    return saved?.agent === params.agentId && saved.name === params.serverName && saved.gateway === gateway() ? saved.iconUrl : server()?.iconUrl;
  };

  const remove = async () => {
    const run = mutation();
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      await removeMcpServer(run.agentId, run.name, run.gateway);
      // Leave for the edit page only when this is still the page that asked.
      if (run.live()) navigate(`/agents/${encodeURIComponent(run.agentId)}/edit`);
    } catch (cause) {
      if (run.live()) {
        setError(errorMessage(cause, "Failed to remove MCP server."));
        setBusy(false);
      }
    }
  };

  return (
    <>
      <div class="ext-details mcp-details">
        <A href={`/agents/${encodeURIComponent(params.agentId)}/edit`} class="ext-details-back" data-tour="back-to-agent">← Back to agent</A>
        <Show when={oauthResult?.status === "error" && oauthResult}>
          {(result) => <div class="oauth-error" role="alert">{result().error}</div>}
        </Show>
        <Show when={target().state === "missing"}>
          <div class="ext-details-status ext-details-error" role="alert">This agent is unavailable. Check that its gateway is online. <button type="button" class="oauth-btn" onClick={retry}>Retry</button></div>
        </Show>
        <Show when={(target().state === "loading" || servers.loading) && !server()}><div class="ext-details-status">Loading MCP server…</div></Show>
        <Show when={servers.error}><div class="ext-details-status ext-details-error" role="alert">Failed to load MCP server. <button type="button" class="oauth-btn" onClick={() => void refetchFast()}>Retry</button></div></Show>
        <Show when={targetReady() && !servers.loading && !servers.error && !server()}>
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
                  <Show when={canConfigureTeam() && !current().shared && current().type === "http"}>
                    <div class="mcp-icon-refresh">
                      <button type="button" class="oauth-btn" disabled={refreshingIcon()} onClick={() => void refreshIcon()}>{refreshingIcon() ? "Refreshing…" : "Refresh icon"}</button>
                      <Show when={iconMessage()}>{(text) => <p role="status">{text()}</p>}</Show>
                      <Show when={iconError()}>{(text) => <p class="ext-details-error" role="alert">{text()}</p>}</Show>
                    </div>
                  </Show>
                  <Show when={canConfigureTeam() && current().shared}>
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
                <p class="oauth-shared-note">Shared by your admins.{canConfigureTeam() ? " Enable it to use its tools in this agent." : ""}</p>
              </Show>
              <Show when={!current().shared || current().enabled}>
              <Show when={current().auth !== "oauth"}>
                {current().shared
                  ? <p class="oauth-shared-note">This shared server has no sign-in or configuration here; a superadmin manages it.</p>
                  : <Show when={identity()} keyed>{(_id) => <McpConfigEditor agentId={params.agentId} gateway={gateway()} name={params.serverName} onSaved={() => void refetchFast()} />}</Show>}
              </Show>
              </Show>

            </>
          )}
        </Show>
        <Show when={(server()?.auth === "oauth" || oauthResult) && (!server()?.shared || server()?.enabled)}>
          <Show when={desktopPopup()}>
            <div class="oauth-quiet" role="status">Finish the sign-in in the new window.</div>
          </Show>
          <Show when={flowBusy()}>
            <div class="oauth-quiet" role="status">Finish the sign-in in the new window. This page confirms the connection. <button type="button" class="oauth-btn" onClick={() => flow.cancel()}>Cancel</button></div>
          </Show>
          <Show when={(() => { const current = flow.state(); return current.phase === "failed" ? current.message : undefined; })()}>
            {(message) => <div class="oauth-error" role="alert">{message()}</div>}
          </Show>
          <CredentialScopeTabs
            value={scope()}
            personalDisabled={!requester().user}
            hidePersonal={singleUser()}
            teamLocked={!canConfigureTeam()}
            status={{ personal: tabStatus("personal"), team: tabStatus("team") }}
            onChange={(next) => { scopePicked = true; setScope(next); }}
          >
            <Show when={server()}>
            <div class="oauth-card-head">
              <span class="oauth-provider-name">{mcpDisplayName(params.serverName, server()?.title)}</span>
              <Show when={!teamReadOnly()}>
                <Switch fallback={<button type="button" class="oauth-btn oauth-btn-primary" disabled={busy() || pendingConnect()} onClick={connect}>{pendingConnect() ? connectingLabel() : `Connect ${mcpDisplayName(params.serverName, server()?.title)}`}</button>}>
                  <Match when={scopedState() === "connected"}>
                    <div class="oauth-actions">
                      <button type="button" class="oauth-btn oauth-btn-danger" disabled={busy()} onClick={() => void disconnect()}>Disconnect</button>
                    </div>
                  </Match>
                  <Match when={scopedState() === "needs_reconnect"}>
                    <div class="oauth-actions">
                      <button type="button" class="oauth-btn oauth-btn-primary" disabled={busy() || pendingConnect()} onClick={connect}>{pendingConnect() ? connectingLabel() : "Reconnect"}</button>
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
            <Show when={identity()} keyed>{(_id) => <McpLabelForm agentId={params.agentId} gateway={gateway()} name={params.serverName} label={server()?.manualLabel} onSaved={() => void refetchFast()} />}</Show>
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

function McpLabelForm(props: { agentId: string; gateway?: string; name: string; label?: { displayName?: string; description?: string }; onSaved: () => void }) {
  // The parent mounts a new form for each gateway, agent, and server. This form reads that identity once.
  const bound = { agentId: props.agentId, gateway: props.gateway, name: props.name };
  let disposed = false;
  onCleanup(() => { disposed = true; });
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
      await saveMcpServerLabel(bound.agentId, bound.name, { displayName: displayName(), description: description() }, bound.gateway);
      if (disposed) return;
      setSaved(true);
      props.onSaved();
    } catch (cause) {
      if (!disposed) setError(errorMessage(cause, "Failed to save name and description."));
    } finally { if (!disposed) setSaving(false); }
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

function McpConfigEditor(props: { agentId: string; gateway?: string; name: string; onSaved: () => void }) {
  // The parent mounts a new editor for each gateway, agent, and server. This editor reads that identity once.
  const bound = { agent: props.agentId, name: props.name, gateway: props.gateway };
  let disposed = false;
  onCleanup(() => { disposed = true; });
  const [view, { refetch }] = createResource(() => bound, (key) => fetchMcpServerConfig(key.agent, key.name, key.gateway));
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
      const result = await saveMcpServerConfig(bound.agent, bound.name, parsed, bound.gateway);
      if (disposed) return;
      show(result.config);
      setSaved(true);
      props.onSaved();
      void refetch();
    } catch (cause) {
      if (!disposed) setError(errorMessage(cause, "Failed to save MCP server config."));
    } finally { if (!disposed) setSaving(false); }
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
            <textarea aria-label={`${bound.name} config JSON`} spellcheck={false} readOnly={!current().editable} value={text()} onInput={(event) => { setText(event.currentTarget.value); setSaved(false); }} />
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
