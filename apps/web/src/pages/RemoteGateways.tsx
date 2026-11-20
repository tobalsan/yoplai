import { For, Match, Show, Switch, createEffect, createResource, createSignal, onCleanup } from "solid-js";
import { LeftNavShell } from "../components/LeftNavShell";
import {
  RelayLinkApiError,
  cancelLink,
  disconnectLink,
  fetchLinkRows,
  fetchLinkStatus,
  openConsentPage,
  startLink,
  type LinkAttemptView,
  type LinkConnectionState,
  type LinkKeyState,
  type LinkRow,
} from "../api/relay-link";
import { capabilities } from "../lib/capabilities";

const POLL_MS = 1500;
/** Wait between two reads of the link rows after a link, and the most reads in one cycle. */
const REFRESH_MS = 2000;
const REFRESH_TRIES = 30;

const KEY_LABEL: Record<LinkKeyState, string> = {
  active: "Key active",
  expired: "Key expired: link again",
  rejected: "Remote refused the key: link again",
  none: "No key (open gateway)",
  unknown: "Key state unknown (linked with a copied token)",
};

const CONNECTION_LABEL: Record<LinkConnectionState, string> = {
  connected: "Device connected",
  connecting: "Device connecting…",
  replaced: "Device link replaced by another device of the same account",
  unauthorized: "Device link refused by the remote",
  offline: "Device not connected",
};

const errorText = (cause: unknown): string => (cause instanceof RelayLinkApiError ? cause.message : "The request failed. Try again.");

const TERMINAL: LinkAttemptView["status"][] = ["linked", "denied", "cancelled", "expired", "failed", "uncertain"];

type Pending = { attemptId: string; controlToken: string; consentUrl: string; remote: string; name?: string };

function attemptMessage(view: LinkAttemptView): string {
  if (view.status === "linked") return `Linked ${view.name}.`;
  if (view.status === "denied") return "The link was refused on the remote gateway.";
  if (view.status === "cancelled") return "The link was cancelled.";
  if (view.status === "expired") return "The link request expired. Start again.";
  return view.message ?? "The link did not finish. Start again.";
}

/** The saved remote gateways of this computer, and the controls to link, link again, and disconnect. */
export function RemoteGateways() {
  const [rows, { refetch }] = createResource(fetchLinkRows);
  const [remote, setRemote] = createSignal("");
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [pending, setPending] = createSignal<Pending>();
  const [result, setResult] = createSignal<LinkAttemptView>();
  const [notice, setNotice] = createSignal<string>();
  const [error, setError] = createSignal<string>();
  /** A disconnect that the remote did not confirm. The row then offers the local-only removal. */
  const [failedDisconnect, setFailedDisconnect] = createSignal<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = 0;

  const stopPolling = () => {
    polling += 1;
    clearTimeout(timer);
  };
  onCleanup(stopPolling);

  // The device socket opens after the link is saved, on the next scan of the device manager. So the row reads
  // `offline` or `connecting` for a few seconds after a link. A refresh cycle reads the rows again until the
  // watched rows settle. Only a new link, a page load with a `connecting` row, or a disconnect (which ends the cycle)
  // changes the cycle.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshCycle = 0;
  // The rows of the running cycle. Such a row that reads `offline` shows "Device connecting…", not a failure.
  const [watching, setWatching] = createSignal<string[]>([]);
  let unmounted = false;
  const stopRefresh = () => {
    refreshCycle += 1;
    clearTimeout(refreshTimer);
    setWatching([]);
  };
  onCleanup(() => { unmounted = true; stopRefresh(); });
  // One read at a time: the timer and the link paths share the read that is pending.
  let pendingRead: Promise<void> | undefined;
  const readRows = (): Promise<void> => {
    if (unmounted) return Promise.resolve();
    pendingRead ??= (async () => {
      try { await refetch(); } catch { /* The error state of the resource tells the result. */ }
      finally { pendingRead = undefined; }
    })();
    return pendingRead;
  };
  const startRefresh = (names: string[]) => {
    stopRefresh();
    if (unmounted || names.length === 0) return;
    const cycle = refreshCycle;
    setWatching(names);
    let tries = 0;
    const settled = (list: LinkRow[]) =>
      names.every((watched) => {
        const row = list.find((item) => item.name === watched);
        return row !== undefined && row.connection !== "offline" && row.connection !== "connecting";
      });
    const next = () => {
      refreshTimer = setTimeout(async () => {
        if (unmounted || cycle !== refreshCycle) return;
        await readRows();
        if (unmounted || cycle !== refreshCycle) return;
        tries += 1;
        const list = rows.error ? undefined : rows.latest;
        if ((list && settled(list)) || tries >= REFRESH_TRIES) {
          setWatching([]);
          return;
        }
        next();
      }, REFRESH_MS);
    };
    next();
  };
  // On page load, a row that is `connecting` starts a cycle.
  let loadChecked = false;
  createEffect(() => {
    const list = rows.error ? undefined : rows.latest;
    if (!list || loadChecked) return;
    loadChecked = true;
    startRefresh(list.filter((row) => row.connection === "connecting").map((row) => row.name));
  });

  const poll = (attempt: Pending) => {
    const round = ++polling;
    const tick = async () => {
      try {
        const view = await fetchLinkStatus(attempt.attemptId, attempt.controlToken);
        if (round !== polling) return;
        if (TERMINAL.includes(view.status)) {
          setPending(undefined);
          setResult(view);
          await readRows();
          if (view.status === "linked" && view.name) startRefresh([view.name]);
          return;
        }
      } catch (cause) {
        if (round !== polling) return;
        setPending(undefined);
        setError(errorText(cause));
        return;
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
  };

  const begin = async (remoteAddress: string, gatewayName?: string) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    setNotice(undefined);
    stopPolling();
    try {
      const started = await startLink(remoteAddress, gatewayName);
      if (started.kind === "linked") {
        setNotice(`Linked ${started.name}. This gateway needs no sign-in.`);
        await readRows();
        startRefresh([started.name]);
        return;
      }
      const next: Pending = { attemptId: started.attemptId, controlToken: started.controlToken, consentUrl: started.consentUrl, remote: remoteAddress, name: gatewayName };
      setPending(next);
      if (started.recoveryNote) setNotice(started.recoveryNote);
      openConsentPage(started.consentUrl);
      poll(next);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    void begin(remote().trim(), name().trim() || undefined);
  };

  const cancel = async () => {
    const attempt = pending();
    if (!attempt) return;
    stopPolling();
    try {
      setResult(await cancelLink(attempt.attemptId, attempt.controlToken));
    } catch (cause) {
      setError(errorText(cause));
    }
    setPending(undefined);
  };

  const disconnect = async (row: LinkRow, localOnly: boolean) => {
    setError(undefined);
    setNotice(undefined);
    try {
      stopRefresh();
      await disconnectLink(row.name, localOnly);
      setFailedDisconnect(undefined);
      setNotice(localOnly ? `Removed ${row.name} from this computer. The remote key stays valid until it is revoked or it expires.` : `Disconnected ${row.name}.`);
      await refetch();
    } catch (cause) {
      setError(errorText(cause));
      if (row.kind === "browser" && !localOnly) setFailedDisconnect(row.name);
    }
  };

  return (
    <LeftNavShell>
      <main class="remote-gateways">
        <style>{REMOTE_GATEWAYS_STYLES}</style>
        <h1>Linked gateways</h1>
        <p>Link a remote gateway to use its agents here. You sign in on the remote gateway, and this computer keeps a key for it.</p>

        <Show
          when={capabilities.relayLink?.available === true}
          fallback={<p role="alert">Linking a new gateway needs this gateway to listen on 127.0.0.1 with linked gateways turned on. Saved links keep working.</p>}
        >
          <form class="remote-gateways-form" onSubmit={submit}>
            <label>
              Remote gateway address
              <input type="text" value={remote()} onInput={(event) => setRemote(event.currentTarget.value)} placeholder="https://gateway.example.com" autocomplete="off" required />
            </label>
            <label>
              Name (optional)
              <input type="text" value={name()} onInput={(event) => setName(event.currentTarget.value)} autocomplete="off" />
            </label>
            <button type="submit" disabled={busy() || pending() !== undefined || remote().trim() === ""}>
              Link gateway
            </button>
          </form>
        </Show>

        <Show when={pending()}>
          {(attempt) => (
            <section role="status" class="remote-gateways-pending">
              <p>
                Waiting for your approval on the remote gateway. Sign in there and approve this computer.
              </p>
              <p>
                <a href={attempt().consentUrl} target="_blank" rel="noopener noreferrer">
                  Open the sign-in page
                </a>
              </p>
              <button type="button" onClick={() => void cancel()}>
                Cancel
              </button>
            </section>
          )}
        </Show>

        <Show when={result()}>
          {(view) => (
            <section role={view().status === "linked" ? "status" : "alert"}>
              <p>{attemptMessage(view())}</p>
              <Show when={view().ownerPageUrl}>
                {(url) => (
                  <p>
                    <a href={url()} target="_blank" rel="noopener noreferrer">
                      Open the linked devices page on the remote gateway
                    </a>
                  </p>
                )}
              </Show>
            </section>
          )}
        </Show>
        <Show when={notice()}>{(text) => <p role="status">{text()}</p>}</Show>
        <Show when={error()}>{(text) => <p role="alert">{text()}</p>}</Show>

        <h2>Saved links</h2>
        <Switch>
          <Match when={rows.loading}>
            <p role="status">Loading linked gateways…</p>
          </Match>
          <Match when={rows.error}>
            <p role="alert">{errorText(rows.error)}</p>
          </Match>
          <Match when={rows()}>
            {(list) => (
              <Show when={list().length > 0} fallback={<p>No gateway is linked.</p>}>
                <ul class="remote-gateways-list">
                  <For each={list()}>
                    {(row) => (
                      <li class="remote-gateways-item">
                        <div>
                          <strong>{row.name}</strong>
                          <span>{row.remote}</span>
                          <span>
                            Account: {row.account ?? "unknown"} · Device: {row.deviceLabel ?? "unknown"}
                          </span>
                          <span>
                            {KEY_LABEL[row.keyState]}
                            <Show when={row.expiresAt}> · Expires {new Date(row.expiresAt!).toLocaleDateString()}</Show>
                          </span>
                          <span>{row.connection === "offline" && watching().includes(row.name) ? CONNECTION_LABEL.connecting : CONNECTION_LABEL[row.connection]}</span>
                        </div>
                        <div class="remote-gateways-actions">
                          <Show when={row.kind === "browser" && capabilities.relayLink?.available === true}>
                            <button type="button" aria-label={`Link ${row.name} again`} disabled={busy() || pending() !== undefined} onClick={() => void begin(row.remote, row.name)}>
                              Link again
                            </button>
                          </Show>
                          <button type="button" aria-label={`Disconnect ${row.name}`} onClick={() => void disconnect(row, false)}>
                            Disconnect
                          </button>
                          <Show when={failedDisconnect() === row.name}>
                            <button type="button" aria-label={`Remove ${row.name} from this computer only`} onClick={() => void disconnect(row, true)}>
                              Remove locally
                            </button>
                            <small>The remote key remains valid until revocation or expiry.</small>
                          </Show>
                        </div>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            )}
          </Match>
        </Switch>
      </main>
    </LeftNavShell>
  );
}

const REMOTE_GATEWAYS_STYLES = `
  .remote-gateways { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  .remote-gateways h1 { margin: 0 0 6px; color: var(--text-primary); font-size: 22px; }
  .remote-gateways h2 { margin: 28px 0 10px; color: var(--text-primary); font-size: 16px; }
  .remote-gateways p { margin: 0 0 16px; color: var(--text-secondary); font-size: 14px; }
  .remote-gateways [role="alert"] { color: var(--tone-error, #e55); }
  .remote-gateways-form { display: grid; gap: 10px; margin-bottom: 18px; }
  .remote-gateways-form label { display: grid; gap: 4px; color: var(--text-secondary); font-size: 13px; }
  .remote-gateways-form input { padding: 8px 10px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-surface); color: var(--text-primary); }
  .remote-gateways button { justify-self: start; border: 1px solid var(--border-default); border-radius: 7px; padding: 7px 10px; background: transparent; color: var(--text-primary); cursor: pointer; }
  .remote-gateways button:disabled { opacity: .55; cursor: default; }
  .remote-gateways-pending { margin-bottom: 18px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
  .remote-gateways-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .remote-gateways-item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
  .remote-gateways-item strong, .remote-gateways-item span { display: block; }
  .remote-gateways-item strong { color: var(--text-primary); font-size: 14px; }
  .remote-gateways-item span { margin-top: 4px; color: var(--text-secondary); font-size: 12px; }
  .remote-gateways-actions { display: grid; gap: 6px; justify-items: end; }
  .remote-gateways-actions small { max-width: 220px; color: var(--text-secondary); font-size: 11px; text-align: right; }
`;
