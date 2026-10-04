import { createEffect, createSignal, For, Show } from "solid-js";
import { useSession } from "../auth/client";
import { LeftNavShell } from "../components/LeftNavShell";
import { fetchSlackPairings, unpairSlackAccount, type SlackPairing } from "../api/connections";

export function AccountConnections() {
  const session = useSession();
  const [pairings, setPairings] = createSignal<SlackPairing[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal<string>();
  let requestId = 0;
  let activeUserId: string | undefined;

  const refresh = async (userId: string) => {
    const currentRequest = ++requestId;
    setLoading(true);
    setError(undefined);
    try {
      const next = await fetchSlackPairings();
      if (currentRequest === requestId && activeUserId === userId) setPairings(next);
    } catch (cause) {
      if (currentRequest === requestId && activeUserId === userId) {
        setPairings([]);
        setError(cause instanceof Error ? cause.message : "Failed to load Slack pairings");
      }
    } finally {
      if (currentRequest === requestId && activeUserId === userId) setLoading(false);
    }
  };

  createEffect(() => {
    const userId = session().data?.user?.id;
    activeUserId = userId;
    setPairings([]);
    setError(undefined);
    if (userId) void refresh(userId);
    else {
      requestId++;
      setLoading(false);
    }
  });

  const unpair = async (pairing: SlackPairing) => {
    const userId = activeUserId;
    if (!userId) return;
    const key = `${pairing.workspaceId}:${pairing.slackUserId}`;
    setPending(key);
    setError(undefined);
    try {
      await unpairSlackAccount(pairing);
      if (activeUserId === userId) await refresh(userId);
    } catch (cause) {
      if (activeUserId === userId) setError(cause instanceof Error ? cause.message : "Failed to remove Slack pairing");
    } finally {
      setPending(undefined);
    }
  };

  return (
    <LeftNavShell>
      <main class="account-connections">
        <style>{`
          .account-connections { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
          .account-connections h1 { margin: 0 0 6px; color: var(--text-primary); font-size: 22px; }
          .account-connections > p { margin: 0 0 22px; color: var(--text-secondary); font-size: 14px; }
          .account-pairing-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
          .account-pairing { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
          .account-pairing strong, .account-pairing span { display: block; }
          .account-pairing strong { color: var(--text-primary); font-size: 14px; }
          .account-pairing span { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
          .account-pairing button { border: 1px solid var(--border-default); border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-primary); cursor: pointer; }
          .account-pairing button:disabled { opacity: .55; cursor: default; }
          .account-connections-error { color: var(--tone-error, #e55) !important; }
        `}</style>
        <h1>Account connections</h1>
        <p>Manage the Slack accounts linked to your Yoplai account.</p>
        <Show when={loading()}><p role="status">Loading Slack pairings…</p></Show>
        <Show when={error()}>{(message) => <p role="alert" class="account-connections-error">{message()}</p>}</Show>
        <Show when={!session().data?.user?.id}><p role="status">Sign in to manage Slack pairings.</p></Show>
        <Show when={!loading() && !error() && pairings().length === 0 && session().data?.user?.id}>
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
              <button type="button" disabled={pending() !== undefined} onClick={() => void unpair(pairing)}>
                {pending() === key ? "Removing…" : "Unpair"}
              </button>
            </li>;
          }}</For>
        </ul>
      </main>
    </LeftNavShell>
  );
}
