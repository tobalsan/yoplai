import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { A } from "@solidjs/router";
import { fetchAgentConfig, saveAgentConfig, type AgentConfig, type AgentConfigPatch } from "../api/agent-config";
import { fetchSkills, type SkillRow } from "../api/skills";
import { readModels, type Model } from "../desktop-setup/api";
import { ModelPicker } from "../desktop-setup/ModelPicker";
import "../desktop-setup/wizard.css";

type ModelRef = { provider: string | null; model: string };
type Draft = { name: string; description: string; model: ModelRef; instructions: string; globalSkills: boolean };

function draftOf(config: AgentConfig): Draft {
  return {
    name: config.name,
    description: config.description,
    model: config.model ?? { provider: null, model: "" },
    instructions: config.instructions ?? "",
    globalSkills: config.globalSkills,
  };
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.model === b.model && (a.provider ?? "") === (b.provider ?? "");
}

function patchFor(base: Draft, draft: Draft): AgentConfigPatch {
  const patch: AgentConfigPatch = {};
  if (draft.name.trim() !== base.name) patch.name = draft.name.trim();
  if (draft.description.trim() !== base.description) patch.description = draft.description.trim();
  if (!sameModel(draft.model, base.model) && draft.model.provider) patch.model = { provider: draft.model.provider, model: draft.model.model };
  if (draft.instructions !== base.instructions) patch.instructions = draft.instructions;
  if (draft.globalSkills !== base.globalSkills) patch.globalSkills = draft.globalSkills;
  return patch;
}

export function AgentConfigSidebar(props: { agentId: string }) {
  const [config, { refetch }] = createResource(() => props.agentId, fetchAgentConfig);
  const [models] = createResource(() => config()?.access.edit === true, (edit) => (edit ? readModels() : Promise.resolve([] as Model[])));
  const [skills] = createResource(() => props.agentId, (agentId) => fetchSkills().then((groups) => groups.agent.filter((row: SkillRow) => row.agentId === agentId)).catch(() => [] as SkillRow[]));
  const [base, setBase] = createSignal<Draft>();
  const [draft, setDraft] = createSignal<Draft>();
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [saved, setSaved] = createSignal(false);

  createEffect(on(config, (value) => {
    if (!value) return;
    setBase(draftOf(value));
    setDraft(draftOf(value));
  }));

  const dirty = () => {
    const current = draft();
    const original = base();
    return !!current && !!original && Object.keys(patchFor(original, current)).length > 0;
  };
  const edit = () => config()?.access.edit === true;
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setError("");
    setDraft((current) => current && { ...current, [key]: value });
  };
  const selectedModel = (): Model | undefined => {
    const ref = draft()?.model;
    if (!ref) return undefined;
    return (models() ?? []).find((model) => model.model === ref.model && (!ref.provider || model.provider === ref.provider));
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    const original = base();
    const current = draft();
    if (!original || !current || !dirty() || saving()) return;
    setSaving(true);
    setError("");
    try {
      await saveAgentConfig(props.agentId, patchFor(original, current));
      setSaved(true);
      await refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Yoplai could not save the agent. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <aside class="agent-config" aria-labelledby="agent-config-title">
      <h2 id="agent-config-title" class="agent-config-title">Agent config</h2>
      <Show when={config.error}>
        <p class="agent-config-error" role="alert">This agent config could not load.</p>
      </Show>
      <Show when={config()}>
        {(loaded) => (
          <form class="agent-config-form" onSubmit={save}>
            <Show when={!loaded().access.edit}>
              <p class="agent-config-note" role="status">Editing is off on this gateway.</p>
            </Show>

            <fieldset class="agent-config-section" disabled={!edit() || saving()}>
              <legend>Profile</legend>
              <label class="agent-config-field">
                <span>Name</span>
                <input required maxLength={60} value={draft()?.name ?? ""} disabled={!edit() || saving()} onInput={(event) => update("name", event.currentTarget.value)} />
              </label>
              <label class="agent-config-field">
                <span>Purpose</span>
                <input maxLength={280} value={draft()?.description ?? ""} disabled={!edit() || saving()} onInput={(event) => update("description", event.currentTarget.value)} />
              </label>
            </fieldset>

            <Show when={draft()}>
              {(current) => (
                <div class="agent-config-section">
                  <Show
                    when={edit()}
                    fallback={<p class="agent-config-value">Model: {current().model.model || "Hidden for your role"}</p>}
                  >
                    <Show when={models()} fallback={<p class="agent-config-hint" role="status">{models.error ? "Models could not load." : "Loading models…"}</p>}>
                      <div class="agent-config-picker">
                        <ModelPicker
                          models={models() ?? []}
                          selected={selectedModel()}
                          disabled={saving()}
                          onSelect={(value) => {
                            const [provider, model] = JSON.parse(value) as [string, string];
                            update("model", { provider, model });
                          }}
                        />
                      </div>
                    </Show>
                  </Show>
                </div>
              )}
            </Show>

            <fieldset class="agent-config-section" disabled={!edit() || saving()}>
              <legend>Instructions</legend>
              <label class="agent-config-field">
                <span>AGENTS.md</span>
                <textarea rows={9} value={draft()?.instructions ?? ""} disabled={!edit() || saving()} onInput={(event) => update("instructions", event.currentTarget.value)} />
              </label>
            </fieldset>

            <fieldset class="agent-config-section" disabled={!edit() || saving()}>
              <legend>Skills</legend>
              <label class="agent-config-check">
                <input type="checkbox" checked={draft()?.globalSkills ?? false} disabled={!edit() || saving()} onChange={(event) => update("globalSkills", event.currentTarget.checked)} />
                <span>Include shared skills <small>~/.agents/skills</small></span>
              </label>
              <Show
                when={(skills() ?? []).length > 0}
                fallback={
                  <p class="agent-config-hint">
                    No skills in this agent yet. <A href="/skills">Add a skill</A>
                  </p>
                }
              >
                <ul class="agent-config-skills">
                  <For each={skills()}>{(skill) => <li><strong>{skill.name}</strong><span>{skill.description}</span></li>}</For>
                </ul>
              </Show>
            </fieldset>

            <div class="agent-config-footer">
              <Show when={error()}><p class="agent-config-error" role="alert">{error()}</p></Show>
              <Show when={saved() && !dirty() && !error()}><p class="agent-config-hint" role="status">Saved.</p></Show>
              <button type="submit" class="agent-config-save" disabled={!edit() || !dirty() || saving()}>
                {saving() ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        )}
      </Show>
      <style>{`
        .agent-config { border-left: 1px solid var(--border-subtle); padding: 24px 20px; min-width: 0; position: sticky; top: 0; align-self: start; max-height: 100dvh; overflow-y: auto; }
        .agent-config-title { margin: 0 0 16px; font-size: 16px; font-weight: 600; color: var(--text-primary); }
        .agent-config-form { display: flex; flex-direction: column; gap: 20px; }
        .agent-config-section { display: flex; flex-direction: column; gap: 10px; border: 0; margin: 0; padding: 0; min-width: 0; }
        .agent-config-section legend { padding: 0; margin-bottom: 2px; font-size: 12px; font-weight: 600; color: var(--text-tertiary); }
        .agent-config-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
        .agent-config-field input, .agent-config-field textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-overlay); color: var(--text-primary); padding: 8px 10px; font: inherit; font-size: 13px; font-weight: 400; }
        .agent-config-field textarea { resize: vertical; line-height: 1.5; }
        .agent-config-check { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: var(--text-primary); }
        .agent-config-check small { color: var(--text-tertiary); font-size: 12px; }
        .agent-config-skills { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-subtle); border-radius: 8px; }
        .agent-config-skills li { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
        .agent-config-skills li:last-child { border-bottom: 0; }
        .agent-config-skills span { color: var(--text-tertiary); font-size: 12px; }
        .agent-config-picker > label { display: block; margin-bottom: 6px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
        .agent-config-value, .agent-config-hint, .agent-config-note { margin: 0; font-size: 13px; color: var(--text-secondary); }
        .agent-config-note { padding: 8px 10px; border-radius: 8px; background: var(--bg-raised); }
        .agent-config-hint a { color: var(--text-primary); }
        .agent-config-footer { position: sticky; bottom: 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--border-subtle); background: var(--bg-surface); }
        .agent-config-error { margin: 0; font-size: 13px; color: var(--tone-error, #dc2626); }
        .agent-config-save { border: 0; border-radius: 8px; background: var(--accent, #2563eb); color: #fff; font: inherit; font-size: 13px; font-weight: 600; padding: 8px 14px; cursor: pointer; }
        .agent-config-save:disabled { opacity: 0.5; cursor: not-allowed; }
        .agent-config input:focus-visible, .agent-config textarea:focus-visible, .agent-config-save:focus-visible, .agent-config a:focus-visible { outline: 2px solid rgba(59, 130, 246, 0.6); outline-offset: 2px; }
        @media (max-width: 900px) { .agent-config { border-left: 0; border-top: 1px solid var(--border-subtle); position: static; max-height: none; } }
      `}</style>
    </aside>
  );
}
