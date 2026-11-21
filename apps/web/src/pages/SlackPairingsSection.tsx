import { For, Show, type Accessor } from "solid-js";
import { fetchSlackPairings, isSlackPairingUnavailable, unpairSlackAccount, type SlackPairing } from "../api/connections";
import type { GatewayName } from "../api/gateway";
import { createOwnerRows } from "./owner-rows";

/**
 * The Slack section of the Pairings page. It lists the Slack accounts that the owner linked, on one gateway.
 * It hides itself when the gateway cannot hold Slack pairings, and tells the page with `onAvailable(false)`.
 * The component mounts for one gateway. A change of owner starts a new list read.
 */
export function SlackPairingsSection(props: {
  gateway?: GatewayName;
  ownerId: Accessor<string | undefined>;
  onAvailable: (available: boolean) => void;
}) {
  const gateway = props.gateway;
  const { rows: pairings, loading, error, pending, unavailable, unknown, retry, remove } = createOwnerRows<SlackPairing>({
    ownerId: props.ownerId,
    uncertainRemove: gateway !== undefined,
    list: () => fetchSlackPairings(gateway),
    remove: (pairing) => unpairSlackAccount(pairing, gateway),
    isUnavailable: isSlackPairingUnavailable,
    onAvailable: props.onAvailable,
    loadFailure: "Failed to load Slack pairings",
    removeFailure: "Failed to remove Slack pairing",
  });

  return (
    <Show when={!unavailable()}>
      <section class="pairing-section" aria-labelledby="pairing-section-slack">
        <h2 id="pairing-section-slack">Slack</h2>
        <Show when={loading()}><p role="status">Loading…</p></Show>
        <Show when={error()}>{(message) => <p role="alert" class="account-connections-error">{message()}</p>}</Show>
        <Show when={unknown() && !loading()}><p role="alert" class="account-connections-error">The list could not be read after the error. <button type="button" onClick={() => void retry()}>Retry</button></p></Show>
        <Show when={!loading() && !error() && !unknown() && pairings().length === 0 && props.ownerId()}>
          <p>No pairings yet.</p>
        </Show>
        <ul class="account-pairing-list">
          <For each={pairings()}>{(pairing) => {
            const key = `${pairing.workspaceId}:${pairing.slackUserId}`;
            return <li class="account-pairing">
              <div>
                <strong>Slack user {pairing.slackUserId}</strong>
                <span>Workspace {pairing.workspaceId} · Paired {new Date(pairing.pairedAt).toLocaleDateString()}</span>
              </div>
              <button type="button" disabled={pending() !== undefined || unknown()} onClick={() => void remove(pairing, key)}>
                {pending() === key ? "Removing…" : "Unpair"}
              </button>
            </li>;
          }}</For>
        </ul>
      </section>
    </Show>
  );
}
