import { createResource, createSignal, For, Show } from "solid-js";
import { Modal } from "../ui/Modal";
import { TextField, TextAreaField } from "../ui/Field";
import { Button } from "../ui/Button";
import {
  createAgent,
  fetchAgentModels,
  type AgentModelOption,
} from "../../api/agent-config";

type Props = {
  onClose: () => void;
  onCreated: (agentId: string) => void;
};

const AVATARS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function CreateAgentModal(props: Props) {
  const [name, setName] = createSignal("");
  const [purpose, setPurpose] = createSignal("");
  const [avatar, setAvatar] = createSignal(1);
  const [selected, setSelected] = createSignal("");
  const [creating, setCreating] = createSignal(false);
  const [error, setError] = createSignal("");
  const [models] = createResource(fetchAgentModels);

  const modelOptions = (): AgentModelOption[] => models() ?? [];
  const modelKey = (m: AgentModelOption) =>
    JSON.stringify([m.provider, m.model]);
  const chosenModel = (): AgentModelOption | undefined =>
    modelOptions().find((m) => modelKey(m) === selected()) ??
    modelOptions()[0];

  const handleCreate = async () => {
    const trimmed = name().trim();
    const model = chosenModel();
    if (!trimmed || !model || creating()) return;
    setCreating(true);
    setError("");
    try {
      const result = await createAgent({
        requestId: crypto.randomUUID(),
        name: trimmed,
        purpose: purpose().trim() || undefined,
        avatar: avatar(),
        model: { provider: model.provider, model: model.model },
      });
      props.onCreated(result.id);
      props.onClose();
    } catch {
      setError("Could not create the agent. Check the fields and try again.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal title="New agent" onClose={props.onClose} size="md">
      <form
        class="create-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <div class="create-agent-preview">
          <img src={`${import.meta.env.BASE_URL}avatars/default-${avatar()}.webp`} alt="" />
          <div>
            <strong>{name().trim() || "New agent"}</strong>
            <span>{purpose().trim() || "No purpose yet"}</span>
          </div>
        </div>
        <TextField
          label="Name"
          value={name()}
          maxlength={60}
          required
          onInput={(event) => setName(event.currentTarget.value)}
        />
        <TextAreaField
          label="Purpose"
          value={purpose()}
          maxlength={280}
          rows={2}
          placeholder="What should this agent do?"
          onInput={(event) => setPurpose(event.currentTarget.value)}
        />
        <div class="create-agent-avatars" role="group" aria-label="Avatar">
          <span class="ui-field__label">Avatar</span>
          <div class="create-agent-avatar-row">
            <For each={AVATARS}>
              {(n) => (
                <button
                  type="button"
                  classList={{ "is-selected": avatar() === n }}
                  aria-label={`Avatar ${n}`}
                  aria-pressed={avatar() === n}
                  onClick={() => setAvatar(n)}
                >
                  <img
                    src={`${import.meta.env.BASE_URL}avatars/default-${n}.webp`}
                    alt=""
                  />
                </button>
              )}
            </For>
          </div>
        </div>
        <label class="ui-field">
          <span class="ui-field__label">Model</span>
          <select
            class="ui-field__input"
            disabled={models.loading}
            onChange={(event) => setSelected(event.currentTarget.value)}
          >
            <For each={modelOptions()}>
              {(m) => (
                <option
                  value={modelKey(m)}
                  selected={modelKey(m) === (selected() || modelKey(chosenModel()!))}
                >
                  {m.provider} / {m.model}
                </option>
              )}
            </For>
          </select>
          <Show when={models.loading}>
            <span class="ui-field__label">Loading models…</span>
          </Show>
        </label>
        <Show when={error()}>
          <p role="alert" class="create-agent-error">
            {error()}
          </p>
        </Show>
        <div class="create-agent-actions">
          <Button type="button" variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={creating()}
            loadingLabel="Creating…"
            disabled={!name().trim() || !chosenModel()}
          >
            Create agent
          </Button>
        </div>
      </form>
      <style>{`
        .create-agent-form { display: flex; flex-direction: column; gap: 16px; }
        .create-agent-preview { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-surface); }
        .create-agent-preview img { width: 44px; height: 44px; border-radius: 8px; flex: none; }
        .create-agent-preview strong { display: block; font-size: 15px; font-weight: 600; }
        .create-agent-preview span { display: block; font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
        .create-agent-avatars { display: flex; flex-direction: column; gap: 6px; }
        .create-agent-avatar-row { display: flex; gap: 6px; flex-wrap: wrap; }
        .create-agent-avatar-row button { border: 2px solid transparent; border-radius: 8px; background: none; padding: 2px; cursor: pointer; transition: transform 0.16s cubic-bezier(0.23,1,0.32,1); }
        .create-agent-avatar-row button:hover { transform: scale(1.06); }
        .create-agent-avatar-row button:active { transform: scale(0.97); }
        .create-agent-avatar-row button:focus-visible { outline: 2px solid rgba(59,130,246,0.6); outline-offset: 2px; }
        .create-agent-avatar-row button.is-selected { border-color: var(--text-primary); }
        .create-agent-avatar-row img { width: 40px; height: 40px; border-radius: 6px; display: block; }
        .create-agent-error { color: var(--tone-error, #dc2626); font-size: 13px; margin: 0; }
        .create-agent-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; border-top: 1px solid var(--border-default); }
      `}</style>
    </Modal>
  );
}
