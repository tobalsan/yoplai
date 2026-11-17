import { createEffect, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { fetchSurfaceLinks, isSurfaceLinkUnavailable, unlinkSurfaceAccount, type SurfaceLink } from "../api/connections";
import type { GatewayName } from "../api/gateway";

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
  const [links, setLinks] = createSignal<SurfaceLink[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal<string>();
  const [unavailable, setUnavailable] = createSignal(false);
  const [unknown, setUnknown] = createSignal(false);
  let requestId = 0;
  let activeUserId: string | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; requestId++; });

  const refresh = async (userId: string): Promise<boolean> => {
    const currentRequest = ++requestId;
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchSurfaceLinks(gateway);
      if (disposed || currentRequest !== requestId || activeUserId !== userId) return false;
      setLinks(next);
      setUnavailable(false);
      props.onAvailable(true);
      return true;
    } catch (cause) {
      if (!disposed && currentRequest === requestId && activeUserId === userId) {
        setLinks([]);
        // After a failed remote unlink, an "unavailable" answer must not hide the error and Retry.
        if (gateway !== undefined && isSurfaceLinkUnavailable(cause) && !unknown()) {
          setUnavailable(true);
          props.onAvailable(false);
        } else {
          setUnavailable(false);
          props.onAvailable(true);
          setError(cause instanceof Error ? cause.message : "Failed to load linked accounts");
        }
      }
      return false;
    } finally {
      if (!disposed && currentRequest === requestId && activeUserId === userId) setLoading(false);
    }
  };

  createEffect(() => {
    const userId = props.ownerId();
    activeUserId = userId;
    setLinks([]);
    setError(undefined);
    setPending(undefined);
    setUnknown(false);
    setUnavailable(false);
    if (userId) void refresh(userId);
    else {
      requestId++;
      setLoading(false);
    }
  });

  const retry = async () => {
    const userId = activeUserId;
    if (!userId) return;
    const ok = await refresh(userId);
    if (!disposed && activeUserId === userId && ok) setUnknown(false);
  };

  const unlink = async (link: SurfaceLink) => {
    const userId = activeUserId;
    if (!userId || unknown()) return;
    setPending(link.id);
    setError(undefined);
    let failed = false;
    try {
      await unlinkSurfaceAccount(link.id, gateway);
      if (!disposed && activeUserId === userId) await refresh(userId);
    } catch (cause) {
      failed = true;
      if (!disposed && activeUserId === userId) {
        setError(cause instanceof Error ? cause.message : "Failed to unlink account");
        // The remote can commit an unlink before its answer fails. Lock the controls before `pending` clears.
        if (gateway !== undefined) setUnknown(true);
      }
    } finally {
      if (!disposed && activeUserId === userId) setPending(undefined);
    }
    if (failed && gateway !== undefined && !disposed && activeUserId === userId) {
      const message = error();
      const ok = await refresh(userId);
      if (!disposed && activeUserId === userId) {
        if (ok) setUnknown(false);
        if (message) setError(message);
      }
    }
  };

  return (
    <Show when={!unavailable()}>
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
            <button type="button" disabled={pending() !== undefined || unknown()} onClick={() => void unlink(link)}>
              {pending() === link.id ? "Removing…" : "Unlink"}
            </button>
          </li>}</For>
        </ul>
      </section>
    </Show>
  );
}
