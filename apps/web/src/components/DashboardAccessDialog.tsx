import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { fetchDashboardRecipients, saveDashboardShares, type DashboardRow, type DashboardShare } from "../api/dashboards";
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";
import { UserPicker } from "./UserPicker";
import { UserAvatar } from "./UserAvatar";
import { useSession } from "../auth/client";

type Mode = "read" | "write";
type UserShare = Extract<DashboardShare, { kind: "user" }>;

export function DashboardAccessDialog(props: {
  dashboard: Pick<DashboardRow, "id" | "title" | "shares">;
  onClose: () => void; onSaved: () => void | Promise<void>;
  loadRecipients?: typeof fetchDashboardRecipients;
  saveShares?: (id: string, shares: DashboardShare[]) => Promise<unknown>;
  platformReadOnly?: boolean;
  note?: string;
}) {
  const session = useSession();
  const owner = () => session().data?.user;
  const initial = props.dashboard.shares ?? [];
  const [recipients] = createResource(props.loadRecipients ?? fetchDashboardRecipients);
  const [userShares, setUserShares] = createSignal<UserShare[]>(initial.filter((share): share is UserShare => share.kind === "user"));
  const [everyoneMode, setEveryoneMode] = createSignal<Mode | null>(initial.find((share) => share.kind === "all")?.mode ?? null);
  const [selected, setSelected] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const users = () => recipients.error ? [] : recipients()?.users ?? [];
  const shares = createMemo<DashboardShare[]>(() => {
    const mode = everyoneMode();
    return [...userShares(), ...(mode ? [{ kind: "all" as const, mode }] : [])];
  });
  // Order does not matter: re-adding a removed person must not count as a change.
  const normalize = (list: DashboardShare[]) =>
    JSON.stringify(list.map((share) => `${share.kind === "all" ? "*" : share.id}:${share.mode}`).sort());
  const original = normalize(initial);
  const changed = () => normalize(shares()) !== original;
  const add = () => {
    const id = selected();
    if (!id) return;
    setUserShares([...userShares(), { kind: "user", id, mode: "read" }]);
    setSelected("");
  };
  const save = async () => {
    setBusy(true); setError(undefined);
    try { await (props.saveShares ?? saveDashboardShares)(props.dashboard.id, shares()); await props.onSaved(); props.onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to save access."); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`Share "${props.dashboard.title}"`} onClose={props.onClose} dismissible={!busy()} error={error()}
      footer={<><Button variant="secondary" disabled={busy()} onClick={props.onClose}>Cancel</Button><Button variant="primary" disabled={busy() || !changed() || recipients.loading || !!recipients.error} onClick={() => void save()}>{busy() ? "Saving…" : "Save"}</Button></>}>
      <Show when={recipients.error}><p role="alert">Unable to load users.</p></Show>
      <div class="share-add">
        <UserPicker class="share-select" value={selected()} onChange={setSelected} onEnter={add} disabled={busy() || recipients.loading}
          users={users().filter((user) => !userShares().some((share) => share.id === user.id)).map((user) => ({ id: user.id, label: `${user.name} (${user.email})`, name: user.name, image: user.image }))} />
        <Button variant="primary" disabled={busy() || !selected()} onClick={add}>Add</Button>
      </div>
      <h3 class="share-heading">People with access</h3>
      <ul class="share-list">
        <li class="share-person">
          <UserAvatar class="share-avatar" name={owner()?.name ?? "You"} email={owner()?.email} image={owner()?.image} />
          <span class="share-person__text"><strong>You</strong></span>
          <span class="share-owner">Owner</span>
        </li>
        <For each={userShares()}>{(share, index) => {
          const user = () => users().find((candidate) => candidate.id === share.id);
          const name = () => user()?.name ?? "Unavailable account";
          return (
            <li class="share-person">
              <UserAvatar class="share-avatar" name={user()?.name} email={user()?.email} image={user()?.image} />
              <span class="share-person__text">
                <strong>{name()}</strong>
                <Show when={user()}><span>{user()!.email}</span></Show>
              </span>
              <select class="share-select" aria-label={`Permission for ${name()}`} value={share.mode} disabled={busy()}
                onChange={(event) => { const mode = event.currentTarget.value as Mode; setUserShares(userShares().map((entry, i) => i === index() ? { ...entry, mode } : entry)); }}>
                <option value="read">Can view</option><option value="write">Can edit</option>
              </select>
              <button type="button" class="share-remove" aria-label={`Remove ${name()}`} disabled={busy()}
                onClick={() => setUserShares(userShares().filter((_, i) => i !== index()))}>
                <i class="fa-solid fa-xmark" aria-hidden="true" />
              </button>
            </li>
          );
        }}</For>
      </ul>
      <h3 class="share-heading">General access</h3>
      <div class="share-general">
        <span class="share-avatar" aria-hidden="true"><i class={everyoneMode() ? "fa-solid fa-globe" : "fa-solid fa-lock"} /></span>
        <select class="share-select" aria-label="General access" disabled={busy()} value={everyoneMode() ? "all" : "restricted"}
          onChange={(event) => setEveryoneMode(event.currentTarget.value === "all" ? everyoneMode() ?? "read" : null)}>
          <option value="restricted">Only people with access</option>
          <option value="all">Everyone on the platform</option>
        </select>
        <Show when={everyoneMode()}>
          <select class="share-select" aria-label="Everyone permission" disabled={busy()} value={everyoneMode()!}
            onChange={(event) => setEveryoneMode(event.currentTarget.value as Mode)}>
            <option value="read">Can view</option><Show when={!props.platformReadOnly}><option value="write">Can edit</option></Show>
          </select>
        </Show>
      </div>
      <p class="share-note"><i class="fa-solid fa-circle-info" aria-hidden="true" />{props.note ?? "People see this page and its live data. Editors see drafts. Publishing also needs access to the agent."}</p>
      <style>{`
        .share-add, .share-person, .share-general { display: flex; align-items: center; gap: 10px; }
        .share-add .share-select { flex: 1; min-width: 0; }
        .share-heading { margin: 20px 0 8px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
        .share-list { list-style: none; margin: 0; padding: 0; }
        .share-person { padding: 8px 0; border-bottom: 1px solid var(--border-subtle); }
        .share-person__text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .share-person__text strong { font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
        .share-person__text span, .share-owner { font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
        .share-avatar { flex: none; width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--bg-raised); color: var(--text-secondary); border: 1px solid var(--border-subtle); }
        .share-general { padding-top: 4px; flex-wrap: wrap; }
        .share-select { padding: 7px 8px; font: inherit; font-size: 13px; color: var(--text-primary); background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 6px; }
        .share-select:hover:not(:disabled) { background: var(--bg-raised); }
        .share-select:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 1px; }
        .share-remove { flex: none; width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); cursor: pointer; }
        .share-remove:hover:not(:disabled) { background: var(--bg-raised); color: var(--text-primary); }
        .share-remove:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 1px; }
        .share-note { display: flex; gap: 8px; margin: 20px 0 0; font-size: 12px; color: var(--text-secondary); }
        .share-note i { margin-top: 2px; }
      `}</style>
    </Modal>
  );
}
