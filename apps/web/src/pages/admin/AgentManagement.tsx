import { useSearchParams } from "@solidjs/router";
import { For, Show, createResource, createSignal } from "solid-js";
import { fetchManagementMode, saveManagementMode, type ManagementMode, type ManagementModeSetting } from "../../api/agent-management";
import { Button } from "../../components/ui/Button";
import { capabilities } from "../../lib/capabilities";
import { isSuperadmin } from "../../lib/roles";
import AdminLayout from "./AdminLayout";

const choices: readonly { value: ManagementMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "superadmin", label: "Superadmins only" },
  { value: "admin", label: "Admins and superadmins" },
  { value: "anyone", label: "Anyone (members edit their own agents)" },
];

export function AgentManagementForm(props: { setting: ManagementModeSetting; onSaved(setting: ManagementModeSetting): void }) {
  const [choice, setChoice] = createSignal<ManagementMode>();
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const selected = () => choice() ?? props.setting.mode;
  const dirty = () => selected() !== props.setting.mode;
  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (saving() || props.setting.locked || !dirty()) return;
    setSaving(true);
    setError("");
    try {
      props.onSaved(await saveManagementMode(selected()));
      setChoice(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the mode.");
    } finally {
      setSaving(false);
    }
  };
  return <form class="agent-management-mode" onSubmit={save}>
    <fieldset disabled={props.setting.locked || saving()}>
      <legend>Who can create and edit agents</legend>
      <For each={choices}>{(option) => <label>
        <input name="agent-management-mode" type="radio" value={option.value} checked={selected() === option.value} onChange={() => setChoice(option.value)} />
        {option.label}
      </label>}</For>
    </fieldset>
    <Show when={props.setting.locked}>
      <p>Set in yoplai.json. Remove <code>agentManagement</code> there to manage it here.</p>
    </Show>
    <Show when={error()}><p role="alert">{error()}</p></Show>
    <Button type="submit" variant="primary" disabled={!dirty() || saving() || props.setting.locked} loading={saving()} loadingLabel="Saving…">Save</Button>
    <style>{`
      .agent-management-mode { max-width: 520px; color: var(--text-primary); }
      .agent-management-mode fieldset { display: grid; gap: 0; padding: 0; border: 0; margin: 0 0 16px; }
      .agent-management-mode legend { margin-bottom: 8px; font-size: 15px; font-weight: 600; }
      .agent-management-mode label { display: flex; align-items: center; gap: 9px; min-height: 36px; font-size: 14px; }
      .agent-management-mode input { accent-color: var(--accent); }
      .agent-management-mode [disabled] label, .agent-management-mode p { color: var(--text-secondary); }
      .agent-management-mode p { font-size: 13px; }
    `}</style>
  </form>;
}

export default function AgentManagement() {
  const [params] = useSearchParams();
  const gateway = () => typeof params.gateway === "string" && params.gateway ? params.gateway : undefined;
  const permitted = () => gateway() === undefined && capabilities.multiUser && isSuperadmin(capabilities.user?.role);
  const [setting, { mutate, refetch }] = createResource(permitted, fetchManagementMode);
  return <AdminLayout title="Agent management" gateway={gateway()}>
    <Show when={permitted()} fallback={<p role="alert">Local superadmin access required.</p>}>
      <Show when={setting.loading}><p role="status">Loading agent management…</p></Show>
      <Show when={setting.error}><p role="alert">Could not load agent management. <Button onClick={() => void refetch()}>Retry</Button></p></Show>
      <Show when={setting.state === "ready" ? setting() : undefined}>
        {(current) => <AgentManagementForm setting={current()} onSaved={mutate} />}
      </Show>
    </Show>
  </AdminLayout>;
}
