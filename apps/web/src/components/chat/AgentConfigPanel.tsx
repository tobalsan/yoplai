import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import {
  fetchAgentConfig, fetchAgentConfigSkills, fetchManagementModels, saveAgentConfig, saveUserSkills,
  type AgentConfigPatch, type ConfigSkill, type ThinkingLevel,
} from "../../api/agent-management";
import { showToast } from "../../lib/toast";
import { Button } from "../ui/Button";

const REASONING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVELS = [
  { id: "gateway", title: "Gateway skills", hint: "Always on for every agent." },
  { id: "agent", title: "Agent workspace skills", hint: "Files in this agent's skills folder. On by default." },
  { id: "user", title: "Your skills", hint: "Your own and shared skills. Off until you turn them on for this agent." },
] as const;
const modelValue = (model: { provider: string; model: string }) => JSON.stringify([model.provider, model.model]);
const avatarNumber = (avatar: string | null) => /default-(\d+)\.webp/.exec(avatar ?? "")?.[1];
const skillKey = (skill: ConfigSkill) => skill.id ?? skill.name;

/**
 * Right side panel of the chat page. Every user with access to the agent sets their own skills here.
 * Only a user who may edit the agent sees the other fields.
 */
export function AgentConfigPanel(props: { agentId: string; onClose: () => void; onSaved: () => void }) {
  const [skills, { refetch: refetchSkills }] = createResource(() => props.agentId, fetchAgentConfigSkills);
  const canEdit = () => skills.state === "ready" && skills()?.canEditAgent === true;
  const [config, { refetch: refetchConfig }] = createResource(() => (canEdit() ? props.agentId : null), fetchAgentConfig);
  const [models] = createResource(() => (canEdit() ? props.agentId : null), () => fetchManagementModels().catch(() => []));
  // Only changed fields live in the draft, so Save sends a minimal patch.
  const [draft, setDraft] = createSignal<AgentConfigPatch>({});
  const [skillDraft, setSkillDraft] = createSignal<Record<string, boolean>>({});
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const set = <K extends keyof AgentConfigPatch>(key: K, value: AgentConfigPatch[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const current = createMemo(() => (config.state === "ready" ? config() : undefined));
  const value = <K extends "name" | "description" | "role" | "instructions">(key: K) => (draft()[key] as string | undefined) ?? current()?.[key] ?? "";
  const dirty = () => Object.keys(draft()).length > 0 || Object.keys(skillDraft()).length > 0;
  const allSkills = () => (skills.state === "ready" ? skills()?.skills ?? [] : []);
  const modelOptions = createMemo(() => {
    const rows = models.state === "ready" ? models() ?? [] : [];
    const active = current()?.model;
    const known = active && rows.some((row) => row.provider === active.provider && row.model === active.model);
    return { rows, orphan: active && !known ? active : undefined };
  });
  const skillEnabled = (skill: ConfigSkill) => skillDraft()[skillKey(skill)] ?? skill.enabled;

  const save = async () => {
    if (saving()) return;
    const patch: AgentConfigPatch = { ...draft() };
    const changed = (level: ConfigSkill["level"]) => allSkills().filter((skill) => skill.level === level && skillKey(skill) in skillDraft());
    const workspaceChanged = changed("agent").length > 0;
    if (workspaceChanged) patch.skills = { disabled: allSkills().filter((skill) => skill.level === "agent" && !skillEnabled(skill)).map((skill) => skill.name) };
    const userChanged = changed("user").length > 0;
    setSaving(true);
    setError("");
    try {
      if (Object.keys(patch).length > 0) await saveAgentConfig(props.agentId, patch);
      if (userChanged) await saveUserSkills(props.agentId, allSkills().filter((skill) => skill.level === "user" && skillEnabled(skill)).map((skill) => skill.id!));
      setDraft({});
      setSkillDraft({});
      await Promise.all([refetchSkills(), canEdit() ? refetchConfig() : undefined]);
      props.onSaved();
      showToast("Agent saved", "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the agent. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section class="agent-config" aria-label="Agent settings">
      <header class="agent-config-head">
        <strong>Agent settings</strong>
        <button type="button" class="agent-config-close" aria-label="Close agent settings" onClick={props.onClose}><i class="fa-solid fa-xmark" aria-hidden="true" /></button>
      </header>
      <Show when={skills.error || config.error}><p class="agent-config-error" role="alert">Could not load the agent settings.</p></Show>
      <Show when={skills.state === "ready"}>
        <form class="agent-config-body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <Show when={canEdit() && current()}>{(detail) => (<>
            <div class="agent-config-identity">
              <div>
                <img src={`${import.meta.env.BASE_URL}avatars/default-${avatarNumber(detail().avatar) ?? "1"}.webp`} alt="" width="48" height="48" />
              </div>
              <label>Face
                <select aria-label="Face" value={String(draft().avatar ?? avatarNumber(detail().avatar) ?? "")} onChange={(event) => set("avatar", Number(event.currentTarget.value))}>
                  <Show when={!avatarNumber(detail().avatar)}><option value="">Custom</option></Show>
                  <For each={Array.from({ length: 10 }, (_, index) => index + 1)}>{(n) => <option value={String(n)}>Face {n}</option>}</For>
                </select>
              </label>
            </div>
            <label>Name<input maxlength={60} value={value("name")} onInput={(event) => set("name", event.currentTarget.value)} /></label>
            <label>Role<input maxlength={60} placeholder="Sales assistant" value={value("role")} onInput={(event) => set("role", event.currentTarget.value)} /></label>
            <label>Description<input maxlength={280} value={value("description")} onInput={(event) => set("description", event.currentTarget.value)} /></label>
            <label>Model
              <select aria-label="Model" value={modelValue(draft().model ?? detail().model)} onChange={(event) => { const [provider, model] = JSON.parse(event.currentTarget.value) as [string, string]; set("model", { provider, model }); }}>
                <Show when={modelOptions().orphan}>{(orphan) => <option value={modelValue(orphan())} selected>{orphan().provider} / {orphan().model} (no credentials)</option>}</Show>
                {/* The options load after the form, so each one marks itself selected. */}
                <For each={modelOptions().rows}>{(row) => <option value={modelValue(row)} selected={modelValue(row) === modelValue(draft().model ?? detail().model)}>{row.provider} / {row.name}</option>}</For>
              </select>
            </label>
            <label>Reasoning
              <select aria-label="Reasoning" value={draft().reasoning === undefined ? detail().reasoning ?? "" : draft().reasoning ?? ""} onChange={(event) => set("reasoning", (event.currentTarget.value || null) as ThinkingLevel | null)}>
                <option value="">Default</option>
                <For each={REASONING}>{(level) => <option value={level}>{level}</option>}</For>
              </select>
            </label>
            <label>Instructions<textarea rows={10} value={value("instructions")} onInput={(event) => set("instructions", event.currentTarget.value)} /></label>
          </>)}</Show>
          <fieldset class="agent-config-skills">
            <legend>Skills</legend>
            <For each={LEVELS}>{(level) => {
              const rows = () => allSkills().filter((skill) => skill.level === level.id);
              return <Show when={rows().length > 0}>
                <h3>{level.title}</h3>
                <p class="agent-config-hint">{level.hint}</p>
                <For each={rows()}>{(skill) => (
                  <label class="agent-config-skill" title={skill.description}>
                    <input type="checkbox" checked={skillEnabled(skill)} disabled={skill.locked}
                      onChange={(event) => setSkillDraft((old) => ({ ...old, [skillKey(skill)]: event.currentTarget.checked }))} />
                    <span>{skill.name}</span>
                  </label>
                )}</For>
              </Show>;
            }}</For>
            <Show when={allSkills().length === 0}><p class="agent-config-hint">No skills to configure.</p></Show>
          </fieldset>
          <Show when={error()}><p class="agent-config-error" role="alert">{error()}</p></Show>
          <footer class="agent-config-foot">
            <Button type="submit" variant="primary" disabled={!dirty() || saving()} loading={saving()}>Save</Button>
            <Button type="button" variant="ghost" disabled={!dirty() || saving()} onClick={() => { setDraft({}); setSkillDraft({}); }}>Reset</Button>
          </footer>
        </form>
      </Show>
      <style>{`
        .agent-config { display: flex; flex-direction: column; min-height: 0; flex: 1; font-size: 13px; color: var(--text-primary); }
        .agent-config-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border-default); }
        .agent-config-close { border: 0; background: transparent; color: var(--text-secondary); cursor: pointer; padding: 4px 6px; }
        .agent-config-body { display: flex; flex-direction: column; gap: 12px; padding: 14px; overflow-y: auto; min-height: 0; flex: 1; }
        .agent-config-body label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: var(--text-secondary); }
        .agent-config-body input:not([type="checkbox"]), .agent-config-body select, .agent-config-body textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-overlay); color: var(--text-primary); padding: 7px 9px; font: inherit; font-weight: 400; }
        .agent-config-body textarea { resize: vertical; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
        .agent-config-identity { display: flex; align-items: flex-end; gap: 12px; }
        .agent-config-identity > label { flex: 1; }
        .agent-config-identity img { border-radius: 50%; display: block; }
        .agent-config-skills { border: 1px solid var(--border-default); border-radius: 6px; padding: 8px 12px 12px; margin: 0; }
        .agent-config-skills legend { font-size: 12px; font-weight: 600; color: var(--text-secondary); padding: 0 4px; }
        .agent-config-skills h3 { margin: 10px 0 0; font-size: 12px; }
        .agent-config-body .agent-config-skill { flex-direction: row; align-items: center; gap: 8px; font-weight: 400; color: var(--text-primary); font-size: 13px; padding: 2px 0; }
        .agent-config-hint { margin: 2px 0 4px; font-size: 11px; color: var(--text-secondary); }
        .agent-config-error { margin: 0; padding: 0 14px; color: var(--danger, #c33); }
        .agent-config-body .agent-config-error { padding: 0; }
        .agent-config-foot { display: flex; gap: 8px; position: sticky; bottom: 0; padding-top: 8px; background: var(--surface-0); }
      `}</style>
    </section>
  );
}
