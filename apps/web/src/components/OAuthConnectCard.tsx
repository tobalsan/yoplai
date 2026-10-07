import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { useSession } from "../auth/client";
import { CredentialScopeTabs, preferredScope, type CredentialScope, type ScopeStatus } from "./CredentialScopeTabs";

type ConnectionState = "connected" | "needs_reconnect" | "disconnected";

type OAuthStatus = {
  state?: ConnectionState;
  connected: boolean;
  provider: string;
  account?: string;
  scopes?: string[];
  canConfigureTeam?: boolean;
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
  /** Called after each status load with whether any scope is connected. */
  onStatus?: (connected: boolean) => void;
}) {
  const [statuses, setStatuses] = createSignal<Partial<Record<CredentialScope, OAuthStatus>>>({});
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const session = useSession();
  const [scope, setScope] = createSignal<"team" | "personal">("personal");
  const [canConfigureTeam, setCanConfigureTeam] = createSignal(true);
  let scopePicked = false;
  let statusRequest = 0;

  const refreshStatus = async () => {
    if (!props.agentId) return;
    const request = ++statusRequest;
    setLoading(true);
    try {
      // Both scopes are loaded so each tab can show its own state.
      const load = async (target: CredentialScope): Promise<OAuthStatus> => {
        const response = await fetch(
          `/api/oauth/${encodeURIComponent(props.provider)}/status?agent=${encodeURIComponent(props.agentId)}&scope=${target}`
        );
        return response.ok
          ? ((await response.json()) as OAuthStatus)
          : { connected: false, provider: props.provider };
      };
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

  const status = () => statuses()[scope()];
  const lifecycle = () => stateOf(status());
  const hasRequiredScopes = () =>
    (props.scopes ?? []).every((scope) => status()?.scopes?.includes(scope));
  const connected = () => lifecycle() === "connected" && hasRequiredScopes();
  const needsGrant = () => lifecycle() === "connected" && !hasRequiredScopes();

  const tabStatus = (target: CredentialScope): ScopeStatus | undefined => {
    const current = statuses()[target];
    if (!current) return undefined;
    const state = stateOf(current);
    if (state === "needs_reconnect") return { tone: "error", label: "Reconnect" };
    if (state !== "connected") return { tone: "off", label: "Not set up" };
    return (props.scopes ?? []).every((scope) => current.scopes?.includes(scope))
      ? { tone: "ok", label: "Connected" }
      : { tone: "error", label: "Not granted" };
  };

  // Non-admins can see, but not change, the admin-managed team connection.
  const teamReadOnly = () => scope() === "team" && !canConfigureTeam();

  const connect = () => {
    if (!props.agentId) return;
    const query = new URLSearchParams({ agent: props.agentId });
    if (props.scopes?.length) query.set("scopes", props.scopes.join(","));
    query.set("scope", scope());
    window.open(
      `/api/oauth/${encodeURIComponent(props.provider)}/authorize?${query.toString()}`,
      "yoplai-oauth",
      "width=520,height=640"
    );
  };

  const disconnect = async () => {
    await fetch(
      `/api/oauth/${encodeURIComponent(props.provider)}/disconnect?agent=${encodeURIComponent(props.agentId)}&scope=${scope()}`,
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
          </Show>
        </div>
        <Show when={teamReadOnly()}>
          <p class="oauth-shared-note">
            {connected() || needsGrant()
              ? "The whole team connection is managed by an admin."
              : lifecycle() === "needs_reconnect"
                ? "The whole team connection needs reconnecting. An admin must reconnect it."
                : "The whole team connection is not set up. An admin must connect it."}
          </p>
        </Show>
        <Show when={lifecycle() === "needs_reconnect" && !teamReadOnly()}>
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
            {scope() === "personal"
              ? "Used only for your requests. Without it, your requests use the team connection when available."
              : "Used by everyone on this agent who has no personal connection."}
          </p>
        </Show>
        <Show when={loading() && !status()}>
          <div class="oauth-quiet">Checking connection…</div>
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
.oauth-account { display: flex; flex-direction: column; gap: 2px; }
.oauth-account-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary); }
.oauth-account-value { font-size: 15px; color: var(--text-primary); font-weight: 500; }
.oauth-warn-text, .oauth-shared-note, .oauth-quiet { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.oauth-warn-text { margin: 0; } .oauth-shared-note { margin: 12px 0 0; } .oauth-quiet { margin-top: 12px; }
`;
