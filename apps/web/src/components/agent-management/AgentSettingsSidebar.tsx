import { For, Show, createEffect, createMemo, createResource, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import type { ThinkLevel } from "@yoplai/shared/types";
import {
  fetchAgentModels, fetchAgentSettings, saveAgentSettings, savePersonalSkills, saveWorkspaceSkills,
  type AgentSettings, type AgentSettingsPatch, type ModelChoice,
} from "../../api/agent-management";
import type { Agent } from "../../api/types";
import { defaultAvatarNumber, defaultAvatarUrl } from "../../lib/default-avatar";
import { Button } from "../ui/Button";
import { AvatarField, AvatarPreview, preventFileNavigation, type AvatarDraft } from "./AvatarField";
import { ModelField, ReasoningField } from "./ModelField";
import { FallbackModelPicker } from "../../desktop-setup/ModelPicker";

type SidebarProps = {
  agent: Agent;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
  onSaving: (saving: boolean) => void;
  onAgentChanged: () => void;
  onSaved: () => void;
};

export function AgentSettingsSidebar(props: SidebarProps) {
  const [settings, { refetch }] = createResource(() => fetchAgentSettings(props.agent.id, props.agent.gateway));
  const titleId = createUniqueId();
  let close: HTMLButtonElement | undefined;
  onMount(() => close?.focus());
  preventFileNavigation();
  return <div class="agent-settings-overlay">
    <button class="agent-settings-backdrop" type="button" tabIndex={-1} aria-label="Close settings backdrop" onClick={props.onClose} />
    <aside class="agent-settings-drawer" role="dialog" aria-labelledby={titleId}>
      <header class="agent-settings-header">
        <h2 id={titleId}>Agent settings</h2>
        <button class="agent-settings-close" type="button" aria-label="Close agent settings" ref={close} onClick={props.onClose}>
          <i aria-hidden="true" class="fa-solid fa-xmark" />
        </button>
      </header>
      <Show when={settings.error}><div class="agent-settings-content">
        <p class="agent-form-error" role="alert">Could not load agent settings. <button type="button" onClick={() => void refetch()}>Retry</button></p>
      </div></Show>
      <Show when={settings.loading}><p class="agent-settings-content" role="status">Loading agent settings…</p></Show>
      <Show when={settings.state === "ready" ? settings() : undefined} keyed>
        {(initial) => <SettingsForm {...props} initial={initial} />}
      </Show>
    </aside>
  </div>;
}

type Fields = Pick<AgentSettingsPatch, "name" | "description" | "reasoning" | "instructions" | "public">;

function SettingsForm(props: SidebarProps & { initial: AgentSettings }) {
  const initial = props.initial;
  const [models, { refetch: retryModels }] = createResource(
    () => initial.canEditAgent,
    () => fetchAgentModels(props.agent.gateway),
    // On the first load, .latest needs an initial value to avoid suspending the chat page.
    { initialValue: [] },
  );
  const initialFields: Fields = {
    name: initial.name, description: initial.description ?? "",
    reasoning: initial.reasoning ?? null, instructions: initial.instructions ?? "", public: initial.public,
  };
  const agentId = props.agent.id;
  const gateway = props.agent.gateway;
  const initialAvatar: AvatarDraft = { face: initial.defaultFace ?? defaultAvatarNumber(agentId), existing: props.agent.avatar };
  const initialDisabled = initial.skills.agent.filter((skill) => !skill.enabled).map((skill) => skill.name);
  const initialUserSkills = initial.skills.user.filter((skill) => skill.enabled).map((skill) => skill.id);

  const [fields, setFields] = createSignal(initialFields);
  const [model, setModel] = createSignal(initial.model);
  const [fallbackOn, setFallbackOn] = createSignal(!!initial.fallbackModel);
  const [fallback, setFallback] = createSignal(initial.fallbackModel ?? undefined);
  const [avatar, setAvatar] = createSignal(initialAvatar);
  const [disabled, setDisabled] = createSignal(initialDisabled);
  const [selected, setSelected] = createSignal(initialUserSkills);
  const [savedFields, setSavedFields] = createSignal(initialFields);
  const [savedModel, setSavedModel] = createSignal(initial.model);
  const [savedFallback, setSavedFallback] = createSignal(initial.fallbackModel ?? undefined);
  const [savedAvatar, setSavedAvatar] = createSignal(initialAvatar);
  const [savedDisabled, setSavedDisabled] = createSignal(initialDisabled);
  const [savedSelected, setSavedSelected] = createSignal(initialUserSkills);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let disposed = false;
  onCleanup(() => { disposed = true; props.onDirty(false); props.onSaving(false); });

  const edit = <Key extends keyof Fields,>(key: Key, value: Fields[Key]) =>
    setFields((current) => ({ ...current, [key]: value }));
  const toggleSkill = (ids: string[], id: string) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id];
  const differentSkills = (a: string[], b: string[]) => a.length !== b.length || a.some((id) => !b.includes(id));
  const workspaceChanged = () => differentSkills(disabled(), savedDisabled());
  const personalChanged = () => differentSkills(selected(), savedSelected());
  const identityPatch = createMemo<AgentSettingsPatch>(() => {
    const patch: AgentSettingsPatch = {};
    const next = fields();
    const before = savedFields();
    if (next.name !== before.name) patch.name = next.name;
    if (next.description !== before.description) patch.description = next.description;
    if (next.reasoning !== before.reasoning) patch.reasoning = next.reasoning;
    if (next.instructions !== before.instructions) patch.instructions = next.instructions;
    if (next.public !== before.public) patch.public = next.public;
    const current = model();
    const last = savedModel();
    if (current?.provider && (current.provider !== last?.provider || current.model !== last?.model || current.source !== last?.source)) patch.model = current as ModelChoice;
    const nextFallback = fallbackOn() ? fallback() : undefined;
    const lastFallback = savedFallback();
    if (!fallbackOn() && lastFallback) patch.fallbackModel = null;
    if (nextFallback?.provider && (nextFallback.provider !== lastFallback?.provider || nextFallback.model !== lastFallback?.model)) {
      patch.fallbackModel = { provider: nextFallback.provider, model: nextFallback.model };
    }
    const nextAvatar = avatar();
    const previous = savedAvatar();
    if (nextAvatar.file !== previous.file || nextAvatar.existing !== previous.existing || nextAvatar.face !== previous.face) patch.avatar = nextAvatar.face;
    return patch;
  });
  const dirty = () => fallbackOn() !== !!savedFallback() || !!(Object.keys(identityPatch()).length || workspaceChanged() || personalChanged());
  const saveDisabled = () => !dirty() || saving() || !fields().name?.trim() || (fallbackOn() && !fallback());
  createEffect(() => props.onDirty(dirty()));

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saveDisabled()) return;
    setSaving(true);
    props.onSaving(true);
    setError("");
    let identitySaved = false;
    try {
      const patch = identityPatch();
      if (Object.keys(patch).length) {
        await saveAgentSettings(agentId, patch, gateway, patch.avatar === undefined ? undefined : avatar().file);
        if (disposed) return;
        setSavedFields(fields());
        setSavedModel(model());
        setSavedFallback(fallbackOn() ? fallback() : undefined);
        setSavedAvatar(avatar());
        identitySaved = true;
      }
      if (workspaceChanged()) {
        await saveWorkspaceSkills(agentId, disabled(), gateway);
        if (disposed) return;
        setSavedDisabled(disabled());
      }
      if (personalChanged()) {
        await savePersonalSkills(agentId, selected(), gateway);
        if (disposed) return;
        setSavedSelected(selected());
      }
      props.onSaved();
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Could not save settings.");
    } finally {
      if (identitySaved) props.onAgentChanged();
      if (!disposed) {
        setSaving(false);
        props.onSaving(false);
      }
    }
  };

  return <form class="agent-settings-form" onSubmit={save}>
    <div class="agent-settings-content">
      <section>
        <h3>Identity</h3>
        <Show when={initial.canEditAgent} fallback={<div class="agent-identity-readonly">
          <AvatarPreview image={props.agent.avatar ?? defaultAvatarUrl(agentId)} />
          <div><h4>{initial.name}</h4>
            <Show when={initial.description}><p>{initial.description}</p></Show>
          </div>
        </div>}>
          <div class="agent-edit-fields">
            <AvatarField value={avatar()} custom={initial.hasCustomAvatar} onChange={setAvatar} disabled={saving()} />
            <label class="agent-form-field">Name<input required maxLength={60} placeholder="Name your agent"
              value={fields().name} disabled={saving()} onInput={(event) => edit("name", event.currentTarget.value)} /></label>
            <label class="agent-form-field">Description<textarea placeholder="Describe the agent"
              value={fields().description} disabled={saving()} onInput={(event) => edit("description", event.currentTarget.value)} /></label>
          </div>
        </Show>
      </section>
      <Show when={initial.canSetPublic}>
        <section>
          <h3>Sharing</h3>
          <div class="agent-skill-row">
            <span>Everyone in the company can chat with this agent</span>
            <SkillSwitch label="Everyone in the company can chat with this agent" checked={fields().public === true} disabled={saving()}
              onChange={() => edit("public", !fields().public)} />
          </div>
        </section>
      </Show>
      <Show when={initial.canEditAgent}>
        <section class="agent-edit-fields">
          <h3>Model and reasoning</h3>
          <ModelField models={models.error ? [] : models.latest ?? []} value={model()} authMode={props.agent.authMode}
            disabled={models.state !== "ready" || saving()} local={!props.agent.gateway} onAccessChanged={retryModels} onChange={setModel} />
          <Show when={models.error}><p role="alert" class="agent-form-error">Could not load models. <button type="button" onClick={() => void retryModels()}>Retry</button></p></Show>
          <ReasoningField value={fields().reasoning ?? null} disabled={saving()} onChange={(value: ThinkLevel | null) => edit("reasoning", value)} />
          <label class="agent-fallback-toggle">
            <input type="checkbox" checked={fallbackOn()} disabled={saving()} onChange={(event) => setFallbackOn(event.currentTarget.checked)} />
            Use a fallback model
          </label>
          <Show when={fallbackOn()}>
            <div>
              <FallbackModelPicker models={models.error ? [] : models.latest ?? []} value={fallback()}
                disabled={models.state !== "ready" || saving()} onSelect={setFallback} />
              <p>Used when the main model fails, for example during an outage or a rate limit.</p>
            </div>
          </Show>
        </section>
        <section>
          <h3>Instructions</h3>
          <label class="agent-form-field">System prompt<textarea class="agent-system-prompt" placeholder="Give the agent instructions."
            value={fields().instructions} disabled={saving()} onInput={(event) => edit("instructions", event.currentTarget.value)} /></label>
        </section>
      </Show>
      <section class="agent-skill-groups">
        <h3>Skills</h3>
        <div>
          <h4>Global skills</h4><p>Always on for every agent.</p>
          <For each={initial.skills.global}>{(skill) => <div class="agent-skill-row"><span title={skill.description}>{skill.name}</span>
            <span class="agent-skill-status"><i class="fa-solid fa-lock" aria-hidden="true" /> Always on</span>
          </div>}</For>
        </div>
        <div>
          <h4>Agent skills</h4><p>These skills start on for this agent.</p>
          <For each={initial.skills.agent}>{(skill) => <div class="agent-skill-row"><span title={skill.description}>{skill.name}</span>
            <Show when={initial.canEditAgent} fallback={<span class="agent-skill-status">{skill.enabled ? "On" : "Off"}</span>}>
              <SkillSwitch label={skill.name} checked={!disabled().includes(skill.name)} disabled={saving()} onChange={() => setDisabled((ids) => toggleSkill(ids, skill.name))} />
            </Show>
          </div>}</For>
        </div>
        <div>
          <h4>User skills</h4><p>Your own and shared skills start off for this agent.</p>
          <For each={initial.skills.user}>{(skill) => <div class="agent-skill-row"><span title={skill.description}>{skill.name}</span>
            <SkillSwitch label={skill.name} checked={selected().includes(skill.id)} disabled={saving()} onChange={() => setSelected((ids) => toggleSkill(ids, skill.id))} />
          </div>}</For>
        </div>
      </section>
    </div>
    <footer class="agent-settings-footer">
      <Show when={error()}><p class="agent-form-error" role="alert">{error()}</p></Show>
      <div class="agent-form-actions">
        <Button onClick={props.onClose} disabled={!dirty() || saving()}>Discard</Button>
        <Button type="submit" variant="primary" disabled={saveDisabled()} loading={saving()} loadingLabel="Saving…">Save</Button>
      </div>
    </footer>
  </form>;
}

function SkillSwitch(props: { label: string; checked: boolean; disabled: boolean; onChange: () => void }) {
  return <button type="button" role="switch" class="agent-skill-switch" aria-label={props.label}
    aria-checked={props.checked} disabled={props.disabled} onClick={props.onChange}><span /></button>;
}
