import { Match, Show, Switch, createResource, createSignal } from "solid-js";
import { getDurableMode, saveDurableMode } from "../api/durable-mode";
import { showToast } from "../lib/toast";
import { Button } from "../components/ui/Button";

export function AccountSettings() {
  const [mode, { mutate, refetch }] = createResource(getDurableMode);
  const [saving, setSaving] = createSignal(false);

  async function toggle() {
    const previous = mode();
    if (!previous || saving()) return;
    const enabled = !previous.enabled;
    setSaving(true);
    mutate({ ...previous, enabled });
    try {
      mutate(await saveDurableMode(enabled));
    } catch {
      mutate(previous);
      showToast("Could not save Durable mode. Try again.", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main class="account-settings">
      <style>{styles}</style>
      <h1>Account settings</h1>
      <Switch>
        <Match when={mode.loading}><p role="status">Loading settings…</p></Match>
        <Match when={mode.error}>
          <p role="alert">Could not load account settings.</p>
          <Button onClick={() => void refetch()}>Retry</Button>
        </Match>
        <Match when={mode()}>
          {(setting) => (
            <div class="account-settings-row">
              <div>
                <strong id="durable-mode-label">Durable mode</strong>
                <p id="durable-mode-description">Use Durable Main for non-sandboxed agents on this gateway and linked gateways.</p>
                <Show when={setting().unsynced?.length}>
                  <p id="durable-mode-sync-status" role="status">Not updated on {setting().unsynced?.join(", ")}. Syncs on reconnect.</p>
                </Show>
              </div>
              <button
                class="account-settings-switch"
                type="button"
                role="switch"
                aria-labelledby="durable-mode-label"
                aria-describedby={setting().unsynced?.length
                  ? "durable-mode-description durable-mode-sync-status"
                  : "durable-mode-description"}
                aria-checked={setting().enabled}
                aria-busy={saving()}
                disabled={saving()}
                onClick={() => void toggle()}
              >
                <span aria-hidden="true" />
              </button>
            </div>
          )}
        </Match>
      </Switch>
    </main>
  );
}

const styles = `
  .account-settings { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  .account-settings h1 { margin: 0 0 16px; color: var(--text-primary); font-size: 22px; }
  .account-settings p { margin: 4px 0 0; color: var(--text-secondary); font-size: 14px; }
  .account-settings [role="alert"] { margin-bottom: 8px; }
  #durable-mode-sync-status { overflow-wrap: anywhere; }
  .account-settings-row {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    min-height: 64px; padding: 8px 0; border-block: 1px solid var(--border-default);
    color: var(--text-primary);
  }
  .account-settings-switch {
    display: grid; place-items: center; flex: 0 0 48px; height: 44px;
    padding: 0; border: 0; border-radius: 8px; background: transparent; cursor: pointer;
  }
  .account-settings-switch span {
    display: flex; align-items: center; width: 36px; height: 22px; padding: 3px;
    border-radius: 999px; background: color-mix(in srgb, var(--text-secondary) 48%, var(--bg-base));
  }
  .account-settings-switch span::before {
    content: ""; width: 16px; height: 16px; border-radius: 50%; background: var(--text-primary);
    transition: transform 150ms ease-out;
  }
  .account-settings-switch[aria-checked="true"] span { background: var(--tone-live); }
  .account-settings-switch[aria-checked="true"] span::before { background: var(--bg-base); transform: translateX(14px); }
  .account-settings-switch:hover:not(:disabled) { background: var(--bg-raised); }
  .account-settings-switch:focus-visible { outline: 2px solid var(--tone-live); outline-offset: 2px; }
  .account-settings-switch:disabled { cursor: progress; opacity: .65; }
  @media (prefers-reduced-motion: reduce) {
    .account-settings-switch span::before { transition: none; }
  }
`;
