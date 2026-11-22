import { createResource, createSignal, Show } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { createAgent } from "../api/agent-config";
import { modelKey, readModels, type Model } from "../desktop-setup/api";
import { ModelPicker } from "../desktop-setup/ModelPicker";
import "../desktop-setup/wizard.css";
import { capabilities } from "../lib/capabilities";

const rank = (source: string) => (source === "owned" ? 0 : source === "environment" ? 2 : 1);
const randomFace = () => Math.floor(Math.random() * 10) + 1;

export function NewAgent() {
  const navigate = useNavigate();
  const [models] = createResource(readModels);
  const [name, setName] = createSignal("");
  const [purpose, setPurpose] = createSignal("");
  const [avatar, setAvatar] = createSignal(randomFace());
  const [picked, setPicked] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  // Reused on retry, so a lost response cannot create a second agent.
  const requestId = crypto.randomUUID();

  const defaultModel = (): Model | undefined =>
    [...(models() ?? [])].sort((a, b) => Number(!a.ready) - Number(!b.ready) || rank(a.source) - rank(b.source)).find((model) => model.default);
  const selected = (): Model | undefined =>
    (models() ?? []).find((model) => modelKey(model) === picked()) ?? defaultModel();
  const canSubmit = () => name().trim().length > 0 && !!selected() && !busy();

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const option = selected();
    if (!canSubmit() || !option) return;
    setBusy(true);
    setError("");
    try {
      const created = await createAgent({
        requestId,
        name: name().trim(),
        purpose: purpose().trim() || undefined,
        avatar: avatar(),
        model: { provider: option.provider, model: option.model },
      });
      navigate(`/agents/${encodeURIComponent(created.id)}/edit`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Yoplai could not save the agent. Try again.");
      setBusy(false);
    }
  };

  return (
    <div class="new-agent">
      <A href="/agents" class="new-agent-back">← Agents</A>
      <Show
        when={capabilities.agentConfig?.create}
        fallback={<p class="new-agent-off" role="status">Agent creation is off on this gateway.</p>}
      >
        <h1 class="new-agent-title">New agent</h1>
        <form class="new-agent-form" onSubmit={submit}>
          <div class="new-agent-face">
            <img src={`${import.meta.env.BASE_URL}avatars/default-${avatar()}.webp`} alt="" width="96" height="96" />
            <button type="button" class="new-agent-shuffle" disabled={busy()} onClick={() => setAvatar((old) => ((old + Math.floor(Math.random() * 8)) % 10) + 1)}>
              Shuffle face
            </button>
          </div>
          <div class="new-agent-fields">
            <label class="new-agent-field">
              <span>Name</span>
              <input required maxLength={60} value={name()} placeholder="Name your agent" disabled={busy()} onInput={(event) => setName(event.currentTarget.value)} />
            </label>
            <label class="new-agent-field">
              <span>Purpose <small>Optional</small></span>
              <input maxLength={280} value={purpose()} placeholder="Plan trips, compare options, or help with writing." disabled={busy()} onInput={(event) => setPurpose(event.currentTarget.value)} />
            </label>
            <Show
              when={models()}
              fallback={<p class="new-agent-hint" role="status">{models.error ? "Yoplai could not read the model list. Try again." : "Loading models…"}</p>}
            >
              <div class="new-agent-picker">
                <ModelPicker models={models() ?? []} selected={selected()} suggested={defaultModel()} disabled={busy()} onSelect={setPicked} />
              </div>
            </Show>
          </div>
          <div class="new-agent-actions">
            <Show when={error()}><p class="new-agent-error" role="alert">{error()}</p></Show>
            <button type="submit" class="new-agent-create" disabled={!canSubmit()}>{busy() ? "Creating…" : "Create agent"}</button>
          </div>
        </form>
      </Show>
      <style>{`
        .new-agent { max-width: 720px; padding: 24px; }
        .new-agent-back { display: inline-block; margin-bottom: 20px; font-size: 14px; color: var(--text-secondary); text-decoration: none; }
        .new-agent-back:focus-visible, .new-agent-shuffle:focus-visible, .new-agent-create:focus-visible, .new-agent-field input:focus-visible { outline: 2px solid rgba(59, 130, 246, 0.6); outline-offset: 2px; }
        .new-agent-title { margin: 0 0 20px; font-size: 22px; font-weight: 600; color: var(--text-primary); }
        .new-agent-off { color: var(--text-secondary); font-size: 14px; }
        .new-agent-form { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 24px; align-items: start; }
        .new-agent-face { display: flex; flex-direction: column; align-items: center; gap: 10px; }
        .new-agent-face img { width: 96px; height: 96px; border-radius: 16px; background: var(--bg-raised); }
        .new-agent-shuffle { border: 1px solid var(--border-default); border-radius: 8px; background: none; color: var(--text-secondary); font: inherit; font-size: 13px; padding: 6px 10px; cursor: pointer; }
        .new-agent-fields { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
        .new-agent-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
        .new-agent-field small { font-weight: 400; color: var(--text-tertiary); }
        .new-agent-field input { border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-overlay); color: var(--text-primary); padding: 9px 11px; font: inherit; font-size: 14px; font-weight: 400; }
        .new-agent-picker > label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
        .new-agent-hint { margin: 0; font-size: 13px; font-weight: 400; color: var(--text-tertiary); }
        .new-agent-actions { grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--border-subtle); padding-top: 16px; }
        .new-agent-error { margin: 0 auto 0 0; font-size: 13px; color: var(--tone-error, #dc2626); }
        .new-agent-create { border: 0; border-radius: 8px; background: var(--accent, #2563eb); color: #fff; font: inherit; font-size: 14px; font-weight: 600; padding: 9px 16px; cursor: pointer; }
        .new-agent-create:disabled, .new-agent-shuffle:disabled { opacity: 0.5; cursor: not-allowed; }
        @media (max-width: 640px) { .new-agent-form { grid-template-columns: 1fr; } .new-agent-face { flex-direction: row; } }
      `}</style>
    </div>
  );
}
