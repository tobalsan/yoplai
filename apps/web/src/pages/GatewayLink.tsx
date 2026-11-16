import { A, useSearchParams } from "@solidjs/router";
import { Match, Show, Switch, createResource, createSignal } from "solid-js";
import type { GatewayLinkConsentView } from "@yoplai/shared";
import {
  GatewayLinkApiError,
  approveGatewayLink,
  denyGatewayLink,
  describeGatewayLinkError,
  fetchGatewayLinkConsent,
  openLocalCallback,
} from "../api/gateway-link";
import { capabilities } from "../lib/capabilities";

const errorText = (cause: unknown): string =>
  cause instanceof GatewayLinkApiError ? cause.message : describeGatewayLinkError("request_failed");

const STATUS_TEXT: Record<Exclude<GatewayLinkConsentView["status"], "pending">, string> = {
  expired: "This link request has expired. Start again from your gateway.",
  used: "This link request was already used. Start again from your gateway.",
  denied: "You refused this link request.",
  approved: "You approved this link request. The gateway on your computer finishes the link.",
};

/**
 * Consent page of the remote. A local gateway sends the browser here with `?request=<id>`. The page shows who asks and
 * what the key can do, and it never approves by itself. After an answer, the page opens the callback address that the
 * remote returns, which belongs to the local gateway on this computer.
 */
export function GatewayLink() {
  const [params] = useSearchParams();
  const requestId = () => (typeof params.request === "string" && params.request.length > 0 ? params.request : undefined);
  // A gateway with no multi-user sign-in, or an address with no request, reads nothing.
  const [consent] = createResource(
    () => (capabilities.multiUser ? requestId() : undefined),
    (id) => fetchGatewayLinkConsent(id),
  );
  const [busy, setBusy] = createSignal(false);
  const [answered, setAnswered] = createSignal<"approve" | "deny">();
  const [error, setError] = createSignal<string>();

  const answer = async (view: GatewayLinkConsentView, action: "approve" | "deny") => {
    setBusy(true);
    setError(undefined);
    try {
      const redirectUrl = await (action === "approve" ? approveGatewayLink : denyGatewayLink)(view.requestId, view.nonce);
      setAnswered(action);
      openLocalCallback(redirectUrl);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <main class="gateway-link">
      <style>{GATEWAY_LINK_STYLES}</style>
      <section class="gateway-link-card">
        <h1>Link a device</h1>
        <Switch>
          <Match when={!capabilities.multiUser}>
            <p role="alert">Device links need a gateway with multi-user sign-in. This gateway has none.</p>
          </Match>
          <Match when={!requestId()}>
            <p role="alert">This page needs a link request. Start the link from the Yoplai app on your computer.</p>
          </Match>
          <Match when={consent.loading}>
            <p role="status">Loading the link request…</p>
          </Match>
          <Match when={consent.error}>
            <p role="alert">{errorText(consent.error)}</p>
          </Match>
          <Match when={consent()}>
            {(view) => (
              <Show
                when={view().status === "pending"}
                fallback={<p role="status">{STATUS_TEXT[view().status as keyof typeof STATUS_TEXT]}</p>}
              >
                <p>
                  A device called <strong>{view().deviceLabel}</strong> asks to connect to{" "}
                  <strong>{window.location.origin}</strong> as <strong>{view().account.email ?? view().account.name}</strong>.
                </p>
                <p>
                  If you approve, the device gets the full access of your account on this gateway. It can use every
                  agent that you can use. Approve only a request that you started yourself.
                </p>
                <Show when={view().replaces}>
                  {(replaced) => <p>This replaces your link for {replaced().deviceLabel}. The old key stops working.</p>}
                </Show>
                <Show when={view().replaceConflict}>
                  <p role="alert">{describeGatewayLinkError("replace_not_allowed")}</p>
                </Show>
                <p class="gateway-link-meta">The request expires at {new Date(view().expiresAt).toLocaleTimeString()}.</p>
                <Show when={!answered()} fallback={<p role="status">Returning to the gateway on your computer…</p>}>
                  <div class="gateway-link-actions">
                    <button type="button" disabled={busy() || view().replaceConflict} onClick={() => void answer(view(), "approve")}>
                      Approve
                    </button>
                    <button type="button" disabled={busy()} onClick={() => void answer(view(), "deny")}>
                      Refuse
                    </button>
                  </div>
                </Show>
                <Show when={error()}>{(message) => <p role="alert">{message()}</p>}</Show>
                <p class="gateway-link-meta">
                  <A href="/account/gateway-links">Manage linked devices</A>
                </p>
              </Show>
            )}
          </Match>
        </Switch>
      </section>
    </main>
  );
}

const GATEWAY_LINK_STYLES = `
  .gateway-link { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg-primary); }
  .gateway-link-card { width: min(520px, 100%); padding: 28px; border: 1px solid var(--border-default); border-radius: 18px; background: var(--bg-surface); }
  .gateway-link-card h1 { margin: 0 0 14px; font-size: 1.5rem; color: var(--text-primary); }
  .gateway-link-card p { margin: 0 0 14px; color: var(--text-secondary); line-height: 1.5; }
  .gateway-link-card strong { color: var(--text-primary); }
  .gateway-link-card [role="alert"] { color: var(--tone-error, #e55); }
  .gateway-link-actions { display: flex; gap: 10px; margin: 18px 0; }
  .gateway-link-actions button { min-height: 40px; padding: 0 18px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-primary); color: var(--text-primary); font-weight: 600; cursor: pointer; }
  .gateway-link-actions button:first-child { background: var(--accent, #3b82f6); border-color: transparent; color: #fff; }
  .gateway-link-actions button:disabled { opacity: .55; cursor: default; }
  .gateway-link-meta { font-size: 13px; }
`;
