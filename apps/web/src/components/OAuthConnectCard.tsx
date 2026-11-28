import {
  createEffect,
  children,
  type Accessor,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { disconnectOAuth, fetchOAuthStatus, oauthAuthorizeUrl, readOAuthStatus, startRemoteOAuth, type OAuthConnectionState, type OAuthStatus } from "../api/oauth";
import { RequesterFailure } from "../lib/page-visit";
import type { Requester } from "../lib/requester";
import { createOAuthPopupFlow, type OAuthVerdict } from "../lib/oauth-popup-flow";
import { CredentialScopeTabs, preferredScope, STATUS_CONNECTED, STATUS_NOT_SET_UP, STATUS_RECONNECT, type CredentialScope, type ScopeStatus } from "./CredentialScopeTabs";
import { onOAuthReturn } from "../lib/oauth-popup";
import { readOAuthResult } from "../lib/oauth-return";
import { showToast } from "../lib/toast";
import { ReconnectWarning, ScopeUsageNote, TEAM_MANAGED_NOTE } from "./ScopedConnectionNotes";

type ConnectionState = OAuthConnectionState;

function stateOf(status: OAuthStatus | undefined): ConnectionState {
  if (!status) return "disconnected";
  return status.state ?? (status.connected ? "connected" : "disconnected");
}

function providerLabel(provider: string): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function OAuthConnectCard(props: {
  agentId: string;
  /** Linked gateway that hosts the agent. Absent for a local agent. */
  gateway?: string;
  /** Who asks, on the gateway of the agent. The page owns it, so the card and the page never read it twice. */
  requester: Accessor<Requester>;
  provider: string;
  /** Scopes required for the Whole team tab. */
  scopes?: string[];
  /** Scopes required for the Just me tab; defaults to `scopes`. */
  personalScopes?: string[];
  label: string;
  /** Selected tab, when the parent shares it with other controls. */
  scope?: CredentialScope;
  onScopeChange?: (scope: CredentialScope) => void;
  /** True when the selected tab has settings that change the required scopes but are not saved yet. */
  hasUnsavedSettings?: () => boolean;
  /** Saves those settings and returns the selected tab's scopes afterwards. */
  saveSettings?: () => Promise<string[] | undefined>;
  /** Called after each status load with whether any scope is connected. */
  onStatus?: (connected: boolean) => void;
  /** Settings shown in the selected tab's panel, below the connect row. */
  children?: JSX.Element;
}) {
  const settings = children(() => props.children);
  const oauthResult = readOAuthResult();
  if (oauthResult?.status === "connected") showToast(`Connected to ${props.label}`, "success");
  const [statuses, setStatuses] = createSignal<Partial<Record<CredentialScope, OAuthStatus>>>({});
  const [loading, setLoading] = createSignal(false);
  // Show feedback while the provider sign-in page loads. Reset it when Back restores this page from the bfcache.
  const [redirecting, setRedirecting] = createSignal(false);
  const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) setRedirecting(false); };
  window.addEventListener("pageshow", onPageShow);
  onCleanup(() => window.removeEventListener("pageshow", onPageShow));
  const [error, setError] = createSignal<string>();
  const requester = () => props.requester();
  const flow = createOAuthPopupFlow();
  const [ownScope, setOwnScope] = createSignal<CredentialScope>(oauthResult?.scope ?? "personal");
  const singleUser = () => requester().ready && !requester().unknown && !requester().multiUser;
  const scope = () => singleUser() ? "team" : props.scope ?? ownScope();
  const setScope = (next: CredentialScope) => {
    setOwnScope(next);
    props.onScopeChange?.(next);
  };
  const scopesFor = (target: CredentialScope) => (target === "personal" ? props.personalScopes ?? props.scopes : props.scopes) ?? [];
  const [canConfigureTeam, setCanConfigureTeam] = createSignal(true);
  let scopePicked = !!oauthResult;
  if (oauthResult) props.onScopeChange?.(oauthResult.scope);
  let statusRequest = 0;
  // A status answer that arrives after the card is gone must not call back into the page.
  let disposed = false;
  onCleanup(() => { statusRequest++; disposed = true; });

  // The tabs and the default scope depend on who asks. Until the requester is known, nothing is read or chosen.
  const requesterKnown = () => requester().ready && !requester().unknown;

  const refreshStatus = async () => {
    if (!props.agentId || !requesterKnown()) return;
    const request = ++statusRequest;
    setLoading(true);
    try {
      // Both scopes are loaded so each tab can show its own state.
      // A remote read keeps a refusal or an offline gateway apart from "not connected".
      const load = (target: CredentialScope): Promise<OAuthStatus> =>
        props.gateway === undefined
          ? fetchOAuthStatus(props.agentId, props.provider, target)
          : readOAuthStatus(props.agentId, props.provider, target, props.gateway);
      const [team, personal] = await Promise.all([
        load("team"),
        !singleUser() && requester().user ? load("personal") : undefined,
      ]);
      if (request !== statusRequest) return;
      if (team.canConfigureTeam === false) setCanConfigureTeam(false);
      setStatuses({ team, personal });
      props.onStatus?.(stateOf(team) === "connected" || stateOf(personal) === "connected");
      if (!scopePicked) {
        scopePicked = true;
        setScope(preferredScope({ personal: tabStatus("personal"), team: tabStatus("team") }, !!personal));
      }
      setError(undefined);
    } catch (cause) {
      if (request === statusRequest) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === statusRequest) setLoading(false);
    }
  };

  createEffect(() => {
    // A new agent, gateway, provider, or tab ends the sign-in of the old one.
    void [props.agentId, props.gateway, props.provider, scope()];
    flow.cancel();
  });

  createEffect(() => {
    void props.gateway;
    if (props.agentId && props.provider && requesterKnown()) void refreshStatus();
  });

  createEffect(() => {
    onCleanup(onOAuthReturn(() => void refreshStatus()));
  });

  const status = () => statuses()[scope()];
  const lifecycle = () => stateOf(status());
  const hasRequiredScopes = () =>
    scopesFor(scope()).every((required) => status()?.scopes?.includes(required));
  const connected = () => lifecycle() === "connected" && hasRequiredScopes();
  const needsGrant = () => lifecycle() === "connected" && !hasRequiredScopes();

  const tabStatus = (target: CredentialScope): ScopeStatus | undefined => {
    const current = statuses()[target];
    if (!current) return undefined;
    const state = stateOf(current);
    if (state === "needs_reconnect") return STATUS_RECONNECT;
    if (state !== "connected") return STATUS_NOT_SET_UP;
    return scopesFor(target).every((required) => current.scopes?.includes(required))
      ? STATUS_CONNECTED
      : { tone: "error", label: "Not granted" };
  };

  // Non-admins can see, but not change, the admin-managed team connection.
  const teamReadOnly = () => scope() === "team" && !canConfigureTeam();

  const authorizeUrl = (target: CredentialScope, scopes: string[]) =>
    oauthAuthorizeUrl(props.agentId, props.provider, target, scopes, window.location.pathname + window.location.search + window.location.hash);

  const requiredScopes = (target: CredentialScope, saved?: string[]) => saved ?? scopesFor(target);

  /** Remote connect: the click opens the popup first. Status checks through the relay decide the result. */
  const connectRemote = () => {
    const gateway = props.gateway!;
    const { agentId, provider } = props;
    const target = scope();
    let required: string[] = [];
    setError(undefined);
    void flow.begin<OAuthStatus>({
      read: (signal) => readOAuthStatus(agentId, provider, target, gateway, signal),
      start: async (signal) => {
        const saved = props.hasUnsavedSettings?.() ? await props.saveSettings?.() : undefined;
        required = requiredScopes(target, saved);
        return startRemoteOAuth(gateway, agentId, target, { kind: "core", provider, scopes: required }, signal);
      },
      verdict: (before, now): OAuthVerdict => {
        if (stateOf(now) !== "connected") return "pending";
        if (stateOf(before) === "connected" && (before.connectedAt === undefined || now.connectedAt === before.connectedAt)) return "pending";
        return required.every((scopeName) => now.scopes?.includes(scopeName)) ? "connected" : "denied";
      },
      canProve: (before) => stateOf(before) !== "connected" || before.connectedAt !== undefined,
      onConnected: () => refreshStatus(),
    });
  };

  const flowBusy = () => flow.state().phase === "preparing" || flow.state().phase === "waiting";
  const pendingConnect = () => redirecting() || flowBusy();
  const connectingLabel = () => (flowBusy() ? "Waiting for sign-in…" : "Redirecting…");

  const connect = async () => {
    if (!props.agentId) return;
    if (props.gateway !== undefined) return connectRemote();
    const target = scope();
    setRedirecting(true);
    try {
      const scopes = props.hasUnsavedSettings?.() ? await props.saveSettings?.() : undefined;
      window.location.assign(authorizeUrl(target, scopes ?? scopesFor(target)));
      setError(undefined);
    } catch (cause) {
      setRedirecting(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const disconnect = async () => {
    // An answer for another agent, gateway, or provider changes nothing here.
    const { agentId, provider, gateway } = props;
    const same = () => !disposed && props.agentId === agentId && props.provider === provider && props.gateway === gateway;
    try {
      await disconnectOAuth(agentId, provider, scope(), gateway);
      if (same()) await refreshStatus();
    } catch (cause) {
      if (same()) setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <style>{OAUTH_CONNECT_CARD_STYLES}</style>
      <Show when={oauthResult?.status === "error" && oauthResult}>
        {(result) => <div class="oauth-error" role="alert">{result().error}</div>}
      </Show>
      <Show when={error()}>
        {(message) => <div class="oauth-error">{message()}</div>}
      </Show>
      <Show when={requester().ready && requester().unknown}>
        <RequesterFailure requester={props.requester} class="oauth-error">Could not read who you are on {props.gateway ?? "this gateway"}.</RequesterFailure>
      </Show>
      <Show when={flowBusy()}>
        <div class="oauth-quiet" role="status">
          Finish the sign-in in the new window. This page confirms the connection.{" "}
          <button type="button" class="oauth-btn" onClick={() => flow.cancel()}>Cancel</button>
        </div>
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
        onChange={(next) => {
          scopePicked = true;
          setScope(next);
        }}
      >
        <div class="oauth-card-head">
          <div class="oauth-provider">
            <span class="oauth-provider-name">{props.label}</span>
          </div>
          <Show when={!teamReadOnly()}>
          <Switch
            fallback={
              <button
                class="oauth-btn oauth-btn-primary"
                disabled={!props.agentId || pendingConnect()}
                onClick={() => void connect()}
              >
                {pendingConnect() ? connectingLabel() : `Connect ${props.label}`}
              </button>
            }
          >
            <Match when={connected()}>
              <div class="oauth-actions">
                <button class="oauth-btn" onClick={() => void refreshStatus()}>
                  Refresh
                </button>
                <button
                  class="oauth-btn oauth-btn-danger"
                  onClick={() => void disconnect()}
                >
                  Disconnect {providerLabel(props.provider)}
                </button>
              </div>
            </Match>
            <Match when={needsGrant()}>
              <div class="oauth-actions">
                <button class="oauth-btn oauth-btn-primary" disabled={pendingConnect()} onClick={() => void connect()}>
                  {pendingConnect() ? connectingLabel() : `Grant ${props.label} access`}
                </button>
                <button
                  class="oauth-btn oauth-btn-danger"
                  onClick={() => void disconnect()}
                >
                  Disconnect {providerLabel(props.provider)}
                </button>
              </div>
            </Match>
            <Match when={lifecycle() === "needs_reconnect"}>
              <div class="oauth-actions">
                <button class="oauth-btn oauth-btn-primary" disabled={pendingConnect()} onClick={() => void connect()}>
                  {pendingConnect() ? connectingLabel() : "Reconnect"}
                </button>
                <button
                  class="oauth-btn oauth-btn-danger"
                  onClick={() => void disconnect()}
                >
                  Disconnect {providerLabel(props.provider)}
                </button>
              </div>
            </Match>
          </Switch>
          </Show>
        </div>
        <Show when={teamReadOnly()}>
          <p class="oauth-shared-note">
            {connected() || needsGrant()
              ? TEAM_MANAGED_NOTE
              : lifecycle() === "needs_reconnect"
                ? "The whole team connection needs reconnecting. An admin must reconnect it."
                : "The whole team connection is not set up. An admin must connect it."}
          </p>
        </Show>
        <Show when={lifecycle() === "needs_reconnect" && !teamReadOnly()}>
          <ReconnectWarning />
        </Show>
        <Show when={(connected() || needsGrant()) && status()?.account}>
          <div class="oauth-connected-detail">
            <div class="oauth-account">
              <span class="oauth-account-label">Connected as</span>
              <span class="oauth-account-value">{status()!.account}</span>
            </div>
          </div>
        </Show>
        <Show when={connected() || needsGrant()}>
          <ScopeUsageNote scope={scope()} />
        </Show>
        <Show when={(loading() || !requester().ready) && !status()}>
          <div class="oauth-quiet">Checking connection…</div>
        </Show>
        <Show when={settings()}>
          <div class="oauth-card-settings">{settings()}</div>
        </Show>
      </CredentialScopeTabs>
    </>
  );
}

export const OAUTH_CONNECT_CARD_STYLES = `
.oauth-error { margin-bottom: 16px; padding: 10px 14px; border-radius: 10px; background: color-mix(in srgb, #ef4444 10%, transparent); border: 1px solid color-mix(in srgb, #ef4444 40%, transparent); color: var(--text-primary); font-size: 13px; }
.oauth-card-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.oauth-provider, .oauth-actions { display: flex; align-items: center; gap: 8px; }
.oauth-provider-name { font-size: 16px; font-weight: 600; color: var(--text-primary); }
.oauth-btn { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 13px; cursor: pointer; }
.oauth-btn-primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
.oauth-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.oauth-btn-danger { color: #c5221f; }
.oauth-connected-detail { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-default); }
.oauth-card-settings { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-default); }
.oauth-account { display: flex; flex-direction: column; gap: 2px; }
.oauth-account-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary); }
.oauth-account-value { font-size: 15px; color: var(--text-primary); font-weight: 500; }
.oauth-warn-text, .oauth-shared-note, .oauth-quiet { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.oauth-warn-text { margin: 0; } .oauth-shared-note { margin: 12px 0 0; } .oauth-quiet { margin-top: 12px; }
`;
