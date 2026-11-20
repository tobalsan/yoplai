import { createEffect, For, Show, type Accessor } from "solid-js";
import { fetchSurfaceLinks, isSurfaceLinkUnavailable, unlinkSurfaceAccount, type SurfaceLink } from "../api/connections";
import type { GatewayName } from "../api/gateway";
import { createOwnerRows } from "./owner-rows";

/**
 * The Threadit and Mattermost section of the Pairings page. It lists the accounts that the owner linked with `!pair`.
 * It works on one gateway. It hides itself when the gateway cannot hold these links, and tells the page with
 * `onAvailable(false)`. After an uncertain remote unlink, no control works until a read of the same gateway works.
 */
export function SurfaceLinksSection(props: {
  gateway?: GatewayName;
  ownerId: Accessor<string | undefined>;
  onAvailable: (available: boolean) => void;
}) {
  const gateway = props.gateway;
  const { rows: links, loading, error, pending, unavailable, unknown, retry, remove } = createOwnerRows<SurfaceLink>({
    ownerId: props.ownerId,
    uncertainRemove: gateway !== undefined,
    list: () => fetchSurfaceLinks(gateway),
    remove: (link) => unlinkSurfaceAccount(link.id, gateway),
    // A local gateway always holds these links, so only a remote one can be unavailable.
    isUnavailable: (cause) => gateway !== undefined && isSurfaceLinkUnavailable(cause),
    onAvailable: (available) => { if (gateway !== undefined) props.onAvailable(available); },
    loadFailure: "Failed to load linked accounts",
    removeFailure: "Failed to unlink account",
  });

  const visible = () => gateway === undefined ? links().length > 0 : !unavailable();
  if (gateway === undefined) createEffect(() => props.onAvailable(visible()));

  return (
    <Show when={visible()}>
      <section class="pairing-section" aria-labelledby="pairing-section-surface">
        <h2 id="pairing-section-surface">Threadit and Mattermost</h2>
        <p>Send <code>!pair</code> to an agent on Threadit or Mattermost to link an account.</p>
        <Show when={loading()}><p role="status">Loading linked accounts…</p></Show>
        <Show when={error()}>{(message) => <p role="alert" class="account-connections-error">{message()}</p>}</Show>
        <Show when={unknown() && !loading()}><p role="alert" class="account-connections-error">The list could not be read after the error. <button type="button" onClick={() => void retry()}>Retry</button></p></Show>
        <Show when={!loading() && !error() && !unknown() && links().length === 0 && props.ownerId()}>
          <p>No Threadit or Mattermost accounts are linked.</p>
        </Show>
        <ul class="account-pairing-list surface-account-links">
          <For each={links()}>{(link) => <li class="account-pairing">
            <div>
              <strong>{link.surface === "threadit" ? "Threadit" : "Mattermost"} @{link.username}</strong>
              <span>{link.scope} · Linked {new Date(link.linkedAt).toLocaleDateString()}</span>
            </div>
            <button type="button" disabled={pending() !== undefined || unknown()} onClick={() => void remove(link, link.id)}>
              {pending() === link.id ? "Removing…" : "Unlink"}
            </button>
          </li>}</For>
        </ul>
      </section>
    </Show>
  );
}
