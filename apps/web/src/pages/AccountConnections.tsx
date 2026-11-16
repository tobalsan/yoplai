import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { useSession } from "../auth/client";
import { LeftNavShell } from "../components/LeftNavShell";
import { GatewaySelect } from "../components/GatewaySelect";
import { fetchSlackPairings, unpairSlackAccount, type SlackPairing } from "../api/connections";
import { missingGatewayText, useGatewayChoice } from "../lib/gateway-choice";
import { useRequester } from "../lib/requester";
import type { GatewayName } from "../api/gateway";

/**
 * Slack pairings of the local account, or of the account that the linked bearer names on one linked gateway
 * (`?gateway=<name>`). The view below mounts again for each gateway, so every list, error, and unpair attempt belongs
 * to one visit. A gateway that is not configured makes no call and never means Local.
 */
export function AccountConnections() {
  const choice = useGatewayChoice();
  const visitKey = createMemo(() => (choice.ready() ? JSON.stringify([choice.gateway() ?? null]) : undefined));
  const missing = () => { const selection = choice.selection(); return selection.state === "missing" ? selection : undefined; };
  return (
    <LeftNavShell>
      <main class="account-connections">
        <style>{ACCOUNT_CONNECTIONS_STYLES}</style>
        <h1>Account connections</h1>
        <GatewaySelect value={choice.chosen()} names={choice.names()} onChange={choice.choose} />
        <Show when={missing()}>{(selection) => <p role="alert" class="account-connections-error">{missingGatewayText(selection())}</p>}</Show>
        <Show when={choice.selection().state === "loading"}><p role="status">Loading linked gateways…</p></Show>
        <Show when={visitKey()} keyed>{(_visit) => <PairingsView gateway={choice.gateway()} />}</Show>
      </main>
    </LeftNavShell>
  );
}

function PairingsView(props: { gateway?: GatewayName }) {
  // One view is one visit: the gateway is fixed for its life. On Local the owner is the signed-in user. On a linked
  // gateway the owner is the account of the linked bearer, which the remote capabilities name.
  const gateway = props.gateway;
  const session = useSession();
  const requester = useRequester(() => gateway);
  const [pairings, setPairings] = createSignal<SlackPairing[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal<string>();
  // After an uncertain remote unpair, no control works until a read of the same gateway works.
  const [unknown, setUnknown] = createSignal(false);
  let requestId = 0;
  let activeUserId: string | undefined;
  let disposed = false;
  onCleanup(() => { disposed = true; requestId++; });
  const ownerId = () => (gateway === undefined ? session().data?.user?.id : requester().user?.id);
  // A linked gateway gives no owner when its capabilities fail or name no user. The reason shows, and nothing is called.
  const ownerProblem = () => {
    if (gateway === undefined) return undefined;
    const current = requester();
    if (!current.ready) return undefined;
    if (current.unknown) return "Could not read the account of the remote gateway.";
    return current.user?.id ? undefined : "The remote gateway has no multi-user sign-in, so it cannot hold Slack pairings.";
  };

  const refresh = async (userId: string): Promise<boolean> => {
    const currentRequest = ++requestId;
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchSlackPairings(gateway);
      if (disposed || currentRequest !== requestId || activeUserId !== userId) return false;
      setPairings(next);
      return true;
    } catch (cause) {
      if (!disposed && currentRequest === requestId && activeUserId === userId) {
        setPairings([]);
        setError(cause instanceof Error ? cause.message : "Failed to load Slack pairings");
      }
      return false;
    } finally {
      if (!disposed && currentRequest === requestId && activeUserId === userId) setLoading(false);
    }
  };

  createEffect(() => {
    const userId = ownerId();
    activeUserId = userId;
    setPairings([]);
    setError(undefined);
    setUnknown(false);
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
      if (!disposed && activeUserId === userId && ok) {
        setUnknown(false);
        if (message) setError(message);
      }
    }
  };

  return (
    <>
      <p>Manage the Slack accounts linked to {gateway === undefined ? "your Yoplai account" : `your account on ${gateway}`}.</p>
      <Show when={loading()}><p role="status">Loading Slack pairings…</p></Show>
      <Show when={error()}>{(message) => <p role="alert" class="account-connections-error">{message()}</p>}</Show>
      <Show when={ownerProblem()}>{(message) => <p role="alert" class="account-connections-error">{message()} <Show when={requester().unknown}><button type="button" onClick={() => requester().retry()}>Retry</button></Show></p>}</Show>
      <Show when={unknown() && !loading()}><p role="alert" class="account-connections-error">The list could not be read after the error. <button type="button" onClick={() => void retry()}>Retry</button></p></Show>
      <Show when={gateway === undefined && !session().data?.user?.id}><p role="status">Sign in to manage Slack pairings.</p></Show>
      <Show when={!loading() && !error() && !unknown() && pairings().length === 0 && ownerId()}>
        <p>No Slack accounts are paired.</p>
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
    </>
  );
}

const ACCOUNT_CONNECTIONS_STYLES = `
  .account-connections { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  .account-connections h1 { margin: 0 0 6px; color: var(--text-primary); font-size: 22px; }
  .account-connections > p, .account-connections p { margin: 0 0 22px; color: var(--text-secondary); font-size: 14px; }
  .account-pairing-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .account-pairing { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
  .account-pairing strong, .account-pairing span { display: block; }
  .account-pairing strong { color: var(--text-primary); font-size: 14px; }
  .account-pairing span { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
  .account-pairing button { border: 1px solid var(--border-default); border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-primary); cursor: pointer; }
  .account-pairing button:disabled { opacity: .55; cursor: default; }
  .account-connections-error { color: var(--tone-error, #e55) !important; }
`;
