import { createEffect, createSignal, For, Show } from "solid-js";
import { useSession } from "../auth/client";
import { LeftNavShell } from "../components/LeftNavShell";
import { fetchSlackPairings, fetchSurfaceLinks, unpairSlackAccount, unlinkSurfaceAccount, type SlackPairing, type SurfaceLink } from "../api/connections";

export function AccountConnections() {
  const session = useSession();
  const [pairings, setPairings] = createSignal<SlackPairing[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal<string>();
  const [surfaceLinks, setSurfaceLinks] = createSignal<SurfaceLink[]>([]);
  const [surfaceLoading, setSurfaceLoading] = createSignal(false);
  const [surfaceError, setSurfaceError] = createSignal<string>();
  const [surfacePending, setSurfacePending] = createSignal<string>();
  let requestId = 0;
  let surfaceRequestId = 0;
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

  const refreshSurfaceLinks = async (userId: string) => {
    const currentRequest = ++surfaceRequestId;
    setSurfaceLoading(true);
    setSurfaceError(undefined);
    try {
      const next = await fetchSurfaceLinks();
      if (currentRequest === surfaceRequestId && activeUserId === userId) setSurfaceLinks(next);
    } catch (cause) {
      if (currentRequest === surfaceRequestId && activeUserId === userId) {
        setSurfaceLinks([]);
        setSurfaceError(cause instanceof Error ? cause.message : "Failed to load linked accounts");
      }
    } finally {
      if (currentRequest === surfaceRequestId && activeUserId === userId) setSurfaceLoading(false);
    }
  };

  createEffect(() => {
    const userId = session().data?.user?.id;
    activeUserId = userId;
    setPairings([]);
    setError(undefined);
    setSurfaceLinks([]);
    setSurfaceError(undefined);
    setSurfacePending(undefined);
    if (userId) {
      void refresh(userId);
      void refreshSurfaceLinks(userId);
    }
    else {
      requestId++;
      surfaceRequestId++;
      setLoading(false);
      setSurfaceLoading(false);
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

  const unlink = async (link: SurfaceLink) => {
    const userId = activeUserId;
    if (!userId) return;
    setSurfacePending(link.id);
    setSurfaceError(undefined);
    try {
      await unlinkSurfaceAccount(link.id);
      if (activeUserId === userId) await refreshSurfaceLinks(userId);
    } catch (cause) {
      if (activeUserId === userId) setSurfaceError(cause instanceof Error ? cause.message : "Failed to unlink account");
    } finally {
      if (activeUserId === userId) setSurfacePending(undefined);
    }
  };

  return (
    <LeftNavShell>
      <main class="account-connections">
        <style>{`
          .account-connections { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
          .account-connections h1 { margin: 0 0 6px; color: var(--text-primary); font-size: 22px; }
          .account-connections h2 { margin: 32px 0 8px; color: var(--text-primary); font-size: 18px; }
          .account-connections > p { margin: 0 0 22px; color: var(--text-secondary); font-size: 14px; }
          .account-pairing-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
          .account-pairing { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
          .account-pairing strong, .account-pairing span { display: block; }
          .account-pairing strong { color: var(--text-primary); font-size: 14px; }
          .account-pairing span { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
          .account-pairing button { border: 1px solid var(--border-default); border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-primary); cursor: pointer; }
          .account-pairing button:disabled { opacity: .55; cursor: default; }
          .surface-account-links .account-pairing > div { min-width: 0; overflow-wrap: anywhere; }
          .surface-account-links button { flex-shrink: 0; min-height: 40px; }
          .account-connections-error { color: var(--tone-error, #e55) !important; }
          @media (max-width: 768px) { .account-connections { padding-top: 64px; } }
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
        <h2>Threadit and Mattermost</h2>
        <p>Send <code>!pair</code> to an agent on Threadit or Mattermost to link an account.</p>
        <Show when={surfaceLoading()}><p role="status">Loading linked accounts…</p></Show>
        <Show when={surfaceError()}>{(message) => <p role="alert" class="account-connections-error">{message()}</p>}</Show>
        <Show when={!surfaceLoading() && !surfaceError() && surfaceLinks().length === 0 && session().data?.user?.id}>
          <p>No Threadit or Mattermost accounts are linked.</p>
        </Show>
        <ul class="account-pairing-list surface-account-links">
          <For each={surfaceLinks()}>{(link) => <li class="account-pairing">
            <div>
              <strong>{link.surface === "threadit" ? "Threadit" : "Mattermost"} @{link.username}</strong>
              <span>{link.scope} · Linked {new Date(link.linkedAt).toLocaleDateString()}</span>
            </div>
            <button type="button" disabled={surfacePending() !== undefined} onClick={() => void unlink(link)}>
              {surfacePending() === link.id ? "Removing…" : "Unlink"}
            </button>
          </li>}</For>
        </ul>
      </main>
    </LeftNavShell>
  );
}
