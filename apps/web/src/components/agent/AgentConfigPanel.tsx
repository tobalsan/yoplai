import { createResource, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { TextField, TextAreaField } from "../ui/Field";
import { Button } from "../ui/Button";
import { showToast } from "../../lib/toast";
import {
  fetchAgentConfig,
  fetchAgentModels,
  saveAgentConfig,
  type AgentModelOption,
} from "../../api/agent-config";

type Props = {
  agentId: string;
  agentName: string;
  onClose: () => void;
  onSaved: () => void;
};

const REASONING = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const modelKey = (m: AgentModelOption) => JSON.stringify([m.provider, m.model]);

export function AgentConfigPanel(props: Props) {
  const [config, { refetch }] = createResource(
    () => props.agentId,
    fetchAgentConfig
  );
  const [models] = createResource(fetchAgentModels);
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [avatar, setAvatar] = createSignal("");
  const [reasoning, setReasoning] = createSignal("");
  const [queueMode, setQueueMode] = createSignal<"queue" | "interrupt">("queue");
  const [globalSkills, setGlobalSkills] = createSignal(false);
  const [instructions, setInstructions] = createSignal("");
  const [selectedModel, setSelectedModel] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let seeded = false;

  createResource(config, (value) => {
    if (seeded || !value) return;
    seeded = true;
    setName(value.name);
    setDescription(value.description ?? "");
    setAvatar(value.avatar ?? "");
    setReasoning(value.reasoning ?? "");
    setQueueMode(value.queueMode);
    setGlobalSkills(value.globalSkills);
    setInstructions(value.instructions);
    if (value.model) setSelectedModel(modelKey(value.model));
  });

  const canEdit = () => config()?.canEdit === true;
  const modelOptions = (): AgentModelOption[] => models() ?? [];
  const chosenModel = (): AgentModelOption | undefined =>
    modelOptions().find((m) => modelKey(m) === selectedModel());

  const handleSave = async () => {
    if (!name().trim() || saving()) return;
    setSaving(true);
    setError("");
    try {
      await saveAgentConfig(props.agentId, {
        name: name().trim(),
        description: description().trim() || null,
        avatar: avatar().trim() || undefined,
        model: chosenModel(),
        reasoning: reasoning() ? (reasoning() as never) : undefined,
        queueMode: queueMode(),
        globalSkills: globalSkills(),
        instructions: instructions(),
      });
      showToast("Agent config saved", "success");
      props.onSaved();
      await refetch();
    } catch {
      setError("Could not save the config. Check the fields and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
      <div
        class="agent-config-overlay"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) props.onClose();
        }}
      >
        <aside
          class="agent-config-panel"
          role="dialog"
          aria-label={`${props.agentName} config`}
        >
          <header>
            <div class="agent-config-id">
              <span class="agent-config-badge">{config()?.avatar && /^[\p{Emoji}]+$/u.test(config()!.avatar!) ? config()!.avatar : props.agentName.slice(0, 1)}</span>
              <div>
                <h2>{config()?.name ?? props.agentName}</h2>
                <span>Agent config</span>
              </div>
            </div>
            <button
              type="button"
              class="agent-config-close"
              aria-label="Close config"
              onClick={props.onClose}
            >
              ×
            </button>
          </header>
          <Show
            when={config()}
            fallback={
              <p class="agent-config-state">
                {config.error ? "Could not load the config." : "Loading…"}
              </p>
            }
          >
            <Show when={!canEdit()}>
              <p class="agent-config-state">
                You can view this config. A manager or the creator can edit it.
              </p>
            </Show>
            <form
              class="agent-config-form"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <p class="agent-config-section">Basics</p>
              <TextField
                label="Name"
                value={name()}
                maxlength={60}
                required
                disabled={!canEdit()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
              <TextField
                label="Description"
                value={description()}
                maxlength={280}
                disabled={!canEdit()}
                onInput={(event) => setDescription(event.currentTarget.value)}
              />
              <TextField
                label="Avatar"
                value={avatar()}
                placeholder="Emoji or image URL"
                disabled={!canEdit()}
                onInput={(event) => setAvatar(event.currentTarget.value)}
              />
              <p class="agent-config-section">Model</p>
              <label class="ui-field">
                <span class="ui-field__label">Model</span>
                <select
                  class="ui-field__input"
                  disabled={!canEdit() || models.loading}
                  onChange={(event) => setSelectedModel(event.currentTarget.value)}
                >
                  <For each={modelOptions()}>
                    {(m) => (
                      <option
                        value={modelKey(m)}
                        selected={modelKey(m) === selectedModel()}
                      >
                        {m.provider} / {m.model}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label class="ui-field">
                <span class="ui-field__label">Reasoning</span>
                <select
                  class="ui-field__input"
                  disabled={!canEdit()}
                  onChange={(event) => setReasoning(event.currentTarget.value)}
                >
                  <option value="">Default</option>
                  <For each={REASONING}>
                    {(level) => (
                      <option value={level} selected={level === reasoning()}>
                        {level}
                      </option>
                    )}
                  </For>
                </select>
              </label>
              <label class="ui-field">
                <span class="ui-field__label">Queue mode</span>
                <select
                  class="ui-field__input"
                  disabled={!canEdit()}
                  onChange={(event) =>
                    setQueueMode(event.currentTarget.value as "queue" | "interrupt")
                  }
                >
                  <option value="queue" selected={queueMode() === "queue"}>
                    Queue
                  </option>
                  <option value="interrupt" selected={queueMode() === "interrupt"}>
                    Interrupt
                  </option>
                </select>
              </label>
              <label class="agent-config-check">
                <input
                  type="checkbox"
                  checked={globalSkills()}
                  disabled={!canEdit()}
                  onChange={(event) => setGlobalSkills(event.currentTarget.checked)}
                />
                Include global skills (~/.agents/skills)
              </label>
              <p class="agent-config-section">Skills</p>
              <section class="agent-config-skills">
                <Show
                  when={config()?.skills.length}
                  fallback={<p class="agent-config-state">No skills in this workspace.</p>}
                >
                  <ul>
                    <For each={config()?.skills ?? []}>
                      {(skill) => (
                        <li>
                          <strong>{skill.name}</strong>
                          <span>{skill.description}</span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
              <p class="agent-config-section">Instructions</p>
              <TextAreaField
                label="Instructions (AGENTS.md)"
                value={instructions()}
                rows={8}
                disabled={!canEdit()}
                onInput={(event) => setInstructions(event.currentTarget.value)}
              />
              <Show when={error()}>
                <p role="alert" class="agent-config-error">
                  {error()}
                </p>
              </Show>
            </form>
            <Show when={canEdit()}>
              <div class="agent-config-actions">
                <Button type="button" variant="ghost" onClick={props.onClose}>
                  Close
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  loading={saving()}
                  loadingLabel="Saving…"
                  disabled={!name().trim()}
                  onClick={() => void handleSave()}
                >
                  Save config
                </Button>
              </div>
            </Show>
          </Show>
        </aside>
      </div>
      <style>{`
        .agent-config-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.32); z-index: 60; display: flex; justify-content: flex-end; }
        .agent-config-panel { width: min(420px, 100vw); height: 100%; overflow: hidden; background: var(--bg-base, #fff); color: var(--text-primary); padding: 20px; display: flex; flex-direction: column; border-left: 1px solid var(--border-default); }
        .agent-config-panel header { display: flex; align-items: center; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid var(--border-default); }
        .agent-config-id { display: flex; align-items: center; gap: 10px; }
        .agent-config-badge { width: 36px; height: 36px; border-radius: 8px; background: var(--bg-surface); border: 1px solid var(--border-default); display: flex; align-items: center; justify-content: center; font-size: 16px; flex: none; }
        .agent-config-id h2 { font-size: 16px; font-weight: 600; margin: 0; text-wrap: balance; }
        .agent-config-id span { font-size: 12px; color: var(--text-secondary); }
        .agent-config-close { border: none; background: none; font-size: 22px; cursor: pointer; color: var(--text-secondary); width: 32px; height: 32px; border-radius: 8px; }
        .agent-config-close:hover { color: var(--text-primary); background: var(--bg-surface); }
        .agent-config-close:focus-visible { outline: 2px solid rgba(59,130,246,0.6); outline-offset: 2px; }
        .agent-config-form { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding-top: 16px; flex: 1; }
        .agent-config-section { font-size: 11px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-tertiary, var(--text-secondary)); margin: 8px 0 -4px; }
        .agent-config-state { color: var(--text-secondary); font-size: 13px; }
        .agent-config-check { display: flex; gap: 8px; align-items: center; font-size: 13px; }
        .agent-config-skills ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .agent-config-skills li { display: flex; flex-direction: column; }
        .agent-config-skills li span { color: var(--text-secondary); font-size: 12px; }
        .agent-config-error { color: var(--tone-error, #dc2626); font-size: 13px; margin: 0; }
        .agent-config-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border-default); }
        .agent-config-skills li { padding: 8px 10px; border: 1px solid var(--border-default); border-radius: 8px; }
      `}</style>
    </Portal>
  );
}
