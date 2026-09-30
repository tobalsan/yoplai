import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";

type ConnectionState = "connected" | "needs_reconnect" | "disconnected";

type OAuthStatus = {
  state?: ConnectionState;
  connected: boolean;
  provider: string;
  account?: string;
  scopes?: string[];
};

const OAUTH_POPUP_MESSAGE_TYPES = new Set(["yoplai-oauth", "aihub-oauth"]);

function stateOf(status: OAuthStatus | undefined): ConnectionState {
  if (!status) return "disconnected";
  return status.state ?? (status.connected ? "connected" : "disconnected");
}

function providerLabel(provider: string): string {
  return provider === "google"
    ? "Google"
    : provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function OAuthConnectCard(props: {
  agentId: string;
  provider: string;
  scopes?: string[];
  label: string;
}) {
  const [status, setStatus] = createSignal<OAuthStatus>();
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const refreshStatus = async () => {
    if (!props.agentId) return;
    setLoading(true);
    try {
      const response = await fetch(
        `/api/oauth/${encodeURIComponent(props.provider)}/status?agent=${encodeURIComponent(props.agentId)}`
      );
      setStatus(
        response.ok
          ? ((await response.json()) as OAuthStatus)
          : { connected: false, provider: props.provider }
      );
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    if (props.agentId && props.provider) void refreshStatus();
  });

  createEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.data &&
        typeof event.data === "object" &&
        OAUTH_POPUP_MESSAGE_TYPES.has(event.data.type)
      ) {
        void refreshStatus();
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

  const lifecycle = () => stateOf(status());
  const hasRequiredScopes = () =>
    (props.scopes ?? []).every((scope) => status()?.scopes?.includes(scope));
  const connected = () => lifecycle() === "connected" && hasRequiredScopes();
  const needsGrant = () => lifecycle() === "connected" && !hasRequiredScopes();

  const connect = () => {
    if (!props.agentId) return;
    const query = new URLSearchParams({ agent: props.agentId });
    if (props.scopes?.length) query.set("scopes", props.scopes.join(","));
    window.open(
      `/api/oauth/${encodeURIComponent(props.provider)}/authorize?${query.toString()}`,
      "yoplai-oauth",
      "width=520,height=640"
    );
  };

  const disconnect = async () => {
    await fetch(
      `/api/oauth/${encodeURIComponent(props.provider)}/disconnect?agent=${encodeURIComponent(props.agentId)}`,
      { method: "POST" }
    );
    await refreshStatus();
  };

  return (
    <>
      <style>{OAUTH_CONNECT_CARD_STYLES}</style>
      <Show when={error()}>
        {(message) => <div class="oauth-error">{message()}</div>}
      </Show>
      <section class="oauth-card">
        <div class="oauth-card-head">
          <div class="oauth-provider">
            <span class="oauth-provider-name">{props.label}</span>
            <Switch
              fallback={
                <span class="oauth-badge oauth-badge-off">Not connected</span>
              }
            >
              <Match when={connected()}>
                <span class="oauth-badge oauth-badge-on">Connected</span>
              </Match>
              <Match when={needsGrant()}>
                <span class="oauth-badge oauth-badge-warn">Not granted</span>
              </Match>
              <Match when={lifecycle() === "needs_reconnect"}>
                <span class="oauth-badge oauth-badge-warn">
                  Needs reconnect
                </span>
              </Match>
            </Switch>
          </div>
          <Switch
            fallback={
              <button
                class="oauth-btn oauth-btn-primary"
                disabled={!props.agentId}
                onClick={connect}
              >
                Connect {props.label}
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
                <button class="oauth-btn oauth-btn-primary" onClick={connect}>
                  Grant {props.label} access
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
                <button class="oauth-btn oauth-btn-primary" onClick={connect}>
                  Reconnect
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
        </div>
        <Show when={lifecycle() === "needs_reconnect"}>
          <div class="oauth-connected-detail">
            <p class="oauth-warn-text">
              This connection can no longer refresh. Reconnect to restore
              access.
            </p>
          </div>
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
          <p class="oauth-shared-note">
            Shared by all {providerLabel(props.provider)} extensions on this
            agent — disconnecting removes access for all of them.
          </p>
        </Show>
        <Show when={loading() && !status()}>
          <div class="oauth-quiet">Checking connection…</div>
        </Show>
      </section>
    </>
  );
}

export const OAUTH_CONNECT_CARD_STYLES = `
.oauth-error { margin-bottom: 16px; padding: 10px 14px; border-radius: 10px; background: color-mix(in srgb, #ef4444 10%, transparent); border: 1px solid color-mix(in srgb, #ef4444 40%, transparent); color: var(--text-primary); font-size: 13px; }
.oauth-card { border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface); padding: 20px; }
.oauth-card-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.oauth-provider, .oauth-actions { display: flex; align-items: center; gap: 8px; }
.oauth-provider-name { font-size: 16px; font-weight: 600; color: var(--text-primary); }
.oauth-badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 3px 8px; border-radius: 999px; }
.oauth-badge-on { color: #137333; background: color-mix(in srgb, #137333 12%, transparent); }
.oauth-badge-off { color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 12%, transparent); }
.oauth-badge-warn { color: #b26a00; background: color-mix(in srgb, #f9ab00 18%, transparent); }
.oauth-btn { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border-default); background: var(--bg-base); color: var(--text-primary); font-size: 13px; cursor: pointer; }
.oauth-btn-primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
.oauth-btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.oauth-btn-danger { color: #c5221f; }
.oauth-connected-detail { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-default); }
.oauth-account { display: flex; flex-direction: column; gap: 2px; }
.oauth-account-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary); }
.oauth-account-value { font-size: 15px; color: var(--text-primary); font-weight: 500; }
.oauth-warn-text, .oauth-shared-note, .oauth-quiet { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.oauth-warn-text { margin: 0; } .oauth-shared-note { margin: 12px 0 0; } .oauth-quiet { margin-top: 12px; }
`;
