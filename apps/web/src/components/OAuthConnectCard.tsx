import {
  createEffect,
  children,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { useSession } from "../auth/client";
import { disconnectOAuth, fetchOAuthStatus, oauthAuthorizeUrl, type OAuthConnectionState, type OAuthStatus } from "../api/oauth";
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
  const session = useSession();
  const [ownScope, setOwnScope] = createSignal<CredentialScope>(oauthResult?.scope ?? "personal");
  const scope = () => props.scope ?? ownScope();
  const setScope = (next: CredentialScope) => {
    setOwnScope(next);
    props.onScopeChange?.(next);
  };
  const scopesFor = (target: CredentialScope) => (target === "personal" ? props.personalScopes ?? props.scopes : props.scopes) ?? [];
  const [canConfigureTeam, setCanConfigureTeam] = createSignal(true);
  let scopePicked = !!oauthResult;
  if (oauthResult) props.onScopeChange?.(oauthResult.scope);
  let statusRequest = 0;

  const refreshStatus = async () => {
    if (!props.agentId) return;
    const request = ++statusRequest;
    setLoading(true);
    try {
      // Both scopes are loaded so each tab can show its own state.
      const load = (target: CredentialScope): Promise<OAuthStatus> =>
        fetchOAuthStatus(props.agentId, props.provider, target);
      const [team, personal] = await Promise.all([
        load("team"),
        session().data?.user ? load("personal") : undefined,
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
    if (props.agentId && props.provider) void refreshStatus();
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

  const connect = async () => {
    if (!props.agentId) return;
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
    await disconnectOAuth(props.agentId, props.provider, scope());
    await refreshStatus();
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
      <CredentialScopeTabs
        value={scope()}
        personalDisabled={!session().data?.user}
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
                data-tour="oauth-connect"
                disabled={!props.agentId || redirecting()}
                onClick={() => void connect()}
              >
                {redirecting() ? "Redirecting…" : `Connect ${props.label}`}
              </button>
            }
          >
            <Match when={connected()}>
              <div class="oauth-actions" data-tour="oauth-connected">
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
                <button class="oauth-btn oauth-btn-primary" data-tour="oauth-grant" disabled={redirecting()} onClick={() => void connect()}>
                  {redirecting() ? "Redirecting…" : `Grant ${props.label} access`}
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
                <button class="oauth-btn oauth-btn-primary" disabled={redirecting()} onClick={() => void connect()}>
                  {redirecting() ? "Redirecting…" : "Reconnect"}
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
        <Show when={loading() && !status()}>
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
