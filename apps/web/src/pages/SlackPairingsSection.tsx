import { createEffect, For, onCleanup, Show, type Accessor } from "solid-js";
import { createSignal } from "solid-js";
import { fetchSlackPairings, isSlackPairingUnavailable, unpairSlackAccount, type SlackPairing } from "../api/connections";
import type { GatewayName } from "../api/gateway";

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
  const [pairings, setPairings] = createSignal<SlackPairing[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [unavailable, setUnavailable] = createSignal(false);
  const [pending, setPending] = createSignal<string>();
  // After an uncertain remote unpair, no control works until a read of the same gateway works.
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
      const next = await fetchSlackPairings(gateway);
      if (disposed || currentRequest !== requestId || activeUserId !== userId) return false;
      setPairings(next);
      setUnavailable(false);
      props.onAvailable(true);
      return true;
    } catch (cause) {
      if (!disposed && currentRequest === requestId && activeUserId === userId) {
        setPairings([]);
        // After a failed remote unpair, an "unavailable" answer must not hide the error and Retry.
        if (isSlackPairingUnavailable(cause) && !unknown()) {
          setUnavailable(true);
          props.onAvailable(false);
        } else {
          setUnavailable(false);
          props.onAvailable(true);
          setError(cause instanceof Error ? cause.message : "Failed to load Slack pairings");
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
    setPairings([]);
    setError(undefined);
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

  const unpair = async (pairing: SlackPairing) => {
    const userId = activeUserId;
    if (!userId || unknown()) return;
    const key = `${pairing.workspaceId}:${pairing.slackUserId}`;
    setPending(key);
    setError(undefined);
    let failed = false;
    try {
      await unpairSlackAccount(pairing, gateway);
      if (!disposed && activeUserId === userId) await refresh(userId);
    } catch (cause) {
      failed = true;
      if (!disposed && activeUserId === userId) {
        setError(cause instanceof Error ? cause.message : "Failed to remove Slack pairing");
        // The remote can commit an unpair before its answer fails. Lock the controls before `pending` clears, so no
        // click starts another write while the recovery read runs.
        if (gateway !== undefined) setUnknown(true);
      }
    } finally {
      if (!disposed) setPending(undefined);
    }
    // The remote can commit an unpair before its answer fails. Read the same gateway before another write.
    if (failed && gateway !== undefined && !disposed && activeUserId === userId) {
      const message = error();
      const ok = await refresh(userId);
      // The lock stays until the same visit completes a successful read.
      if (!disposed && activeUserId === userId) {
        if (ok) setUnknown(false);
        if (message) setError(message);
      }
    }
  };

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
              <button type="button" disabled={pending() !== undefined || unknown()} onClick={() => void unpair(pairing)}>
                {pending() === key ? "Removing…" : "Unpair"}
              </button>
            </li>;
          }}</For>
        </ul>
      </section>
    </Show>
  );
}
