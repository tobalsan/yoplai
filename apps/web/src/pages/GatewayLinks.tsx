import { For, Match, Show, Switch, createResource, createSignal } from "solid-js";
import type { GatewayLinkStatus, GatewayLinkSummary } from "@yoplai/shared";
import { GatewayLinkApiError, describeGatewayLinkError, fetchGatewayLinks, revokeGatewayLink } from "../api/gateway-link";
import { LeftNavShell } from "../components/LeftNavShell";
import { capabilities } from "../lib/capabilities";

const STATUS_LABEL: Record<GatewayLinkStatus, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  blocked: "Blocked: link again to use it",
  issuing: "Being issued",
};

const errorText = (cause: unknown): string =>
  cause instanceof GatewayLinkApiError ? cause.message : describeGatewayLinkError("request_failed");

const formatDate = (value: string | null) => (value ? new Date(value).toLocaleDateString() : "");

/** Devices that a user linked to this remote, with a revoke control for each link that can still work. */
export function GatewayLinks() {
  // A gateway with no multi-user sign-in has no links to read, so the source is off and no request goes out.
  const [links, { refetch }] = createResource(() => (capabilities.multiUser ? true : undefined), () => fetchGatewayLinks());
  const [pending, setPending] = createSignal<string>();
  const [error, setError] = createSignal<string>();

  const revoke = async (link: GatewayLinkSummary) => {
    setPending(link.id);
    setError(undefined);
    try {
      await revokeGatewayLink(link.id);
      await refetch();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(undefined);
    }
  };

  return (
    <LeftNavShell>
      <main class="gateway-links">
        <style>{GATEWAY_LINKS_STYLES}</style>
        <h1>Linked devices</h1>
        <p>Devices that you linked to this gateway. Revoke a link to stop its key at once.</p>
        <Switch>
          <Match when={!capabilities.multiUser}>
            <p role="alert">Device links need a gateway with multi-user sign-in. This gateway has none.</p>
          </Match>
          <Match when={links.loading}>
            <p role="status">Loading linked devices…</p>
          </Match>
          <Match when={links.error}>
            <p role="alert">{errorText(links.error)}</p>
          </Match>
          <Match when={links()}>
            {(rows) => (
              <Show when={rows().length > 0} fallback={<p>No device is linked to your account.</p>}>
                <ul class="gateway-links-list">
                  <For each={rows()}>
                    {(link) => (
                      <li class="gateway-links-item">
                        <div>
                          <strong>{link.deviceLabel}</strong>
                          <span>
                            {STATUS_LABEL[link.status]} · Linked {formatDate(link.createdAt)}
                            <Show when={link.expiresAt}> · Expires {formatDate(link.expiresAt)}</Show>
                          </span>
                        </div>
                        <Show when={link.status === "active" || link.status === "blocked" || link.status === "issuing"}>
                          <button
                            type="button"
                            aria-label={`Revoke ${link.deviceLabel}`}
                            disabled={pending() !== undefined}
                            onClick={() => void revoke(link)}
                          >
                            {pending() === link.id ? "Revoking…" : "Revoke"}
                          </button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Match>
        </Switch>
        <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
      </main>
    </LeftNavShell>
  );
}

const GATEWAY_LINKS_STYLES = `
  .gateway-links { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  .gateway-links h1 { margin: 0 0 6px; color: var(--text-primary); font-size: 22px; }
  .gateway-links p { margin: 0 0 22px; color: var(--text-secondary); font-size: 14px; }
  .gateway-links [role="alert"] { color: var(--tone-error, #e55); }
  .gateway-links-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .gateway-links-item { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
  .gateway-links-item strong, .gateway-links-item span { display: block; }
  .gateway-links-item strong { color: var(--text-primary); font-size: 14px; }
  .gateway-links-item span { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
  .gateway-links-item button { border: 1px solid var(--border-default); border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-primary); cursor: pointer; }
  .gateway-links-item button:disabled { opacity: .55; cursor: default; }
`;
