import { createSignal, For, onMount, Show } from "solid-js";
import { fetchAvatarStyles, generateAgentAvatar, type AvatarStyles } from "../api/agents";
import { Button } from "./ui/Button";

/** Style picker plus "Generate avatar" for one agent; reports the new image URL. */
export function AvatarGenerator(props: { agentId: string; hasAvatar: boolean; onGenerated: (url: string) => void }) {
  // Loaded outside Suspense: the agent page must not wait on, or fail with, the style list.
  const [styles, setStyles] = createSignal<AvatarStyles>();
  onMount(() => {
    fetchAvatarStyles().then(setStyles, () => undefined);
  });
  const [picked, setPicked] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const style = () => picked() ?? styles()?.default ?? "";

  const generate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      props.onGenerated((await generateAgentAvatar(props.agentId, style())).avatar);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={styles()}>
      {(loaded) => (
        <div class="avatar-generator">
          <select
            class="avatar-generator__style"
            aria-label="Avatar style"
            value={style()}
            disabled={busy()}
            onChange={(event) => setPicked(event.currentTarget.value)}
          >
            <For each={loaded().styles}>{(option) => <option value={option.id}>{option.label}</option>}</For>
          </select>
          <Button icon="fa-solid fa-wand-magic-sparkles" loading={busy()} loadingLabel="Generating…" disabled={busy() || !style()} onClick={() => void generate()}>
            {props.hasAvatar ? "New avatar" : "Generate avatar"}
          </Button>
          <Show when={busy()}>
            <span class="avatar-generator__hint">This can take a minute.</span>
          </Show>
          <Show when={error()}>
            {(message) => <span class="avatar-generator__error" role="alert">{message()}</span>}
          </Show>
          <style>{`
            .avatar-generator {
              display: flex;
              align-items: center;
              flex-wrap: wrap;
              gap: 8px;
              margin-top: 8px;
            }

            .avatar-generator__style {
              border: 1px solid var(--border-default);
              border-radius: 8px;
              background: var(--bg-overlay);
              color: var(--text-primary);
              padding: 6px 8px;
              font-size: 13px;
              font-family: inherit;
            }

            .avatar-generator__hint {
              color: var(--text-secondary);
              font-size: 12px;
            }

            .avatar-generator__error {
              color: var(--color-danger, #dc2626);
              font-size: 12px;
            }
          `}</style>
        </div>
      )}
    </Show>
  );
}
