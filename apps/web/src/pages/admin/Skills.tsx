import { For, Show, createResource, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { deleteSkill, fetchAdminSkills, setSkillAdminDisabled, type SkillRow } from "../../api/skills";
import { capabilities } from "../../lib/capabilities";
import { isSuperadmin } from "../../lib/roles";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import AdminLayout from "./AdminLayout";

export default function AdminSkills() {
  const permitted = () => !capabilities.multiUser || isSuperadmin(capabilities.user?.role);
  const [skills, { refetch }] = createResource(permitted, fetchAdminSkills);
  const data = () => skills.error ? undefined : skills();
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [deleting, setDeleting] = createSignal<SkillRow>();
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); await refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update skill."); }
    finally { setBusy(false); }
  };
  return <AdminLayout title="Skills" description="Inspect user skills, sharing and enable counts. Disable or delete platform-wide skills.">
    <Show when={permitted()} fallback={<p role="alert">Superadmin access required.</p>}>
      <Show when={skills.error || error()}><p role="alert">{error() || "Unable to load skills."}<button onClick={() => void refetch()}>Retry</button></p></Show>
      <Show when={skills.loading}><p role="status">Loading skills…</p></Show>
      <div class="admin-skills-table"><table><thead><tr><th>Skill</th><th>Owner</th><th>Sharing</th><th>Enabled by</th><th>Updated</th><th>Collisions</th><th>Actions</th></tr></thead><tbody>
        <For each={data()?.skills ?? []}>{(row) => <tr><td><A href={`/skills/${encodeURIComponent(row.id)}`}>{row.name}</A><Show when={row.disabledByAdmin}><p>Disabled by admin</p></Show></td><td>{row.ownerName}</td><td>{row.shares.length ? row.shares.map((share) => share.kind === "all" ? "Platform-wide (read)" : `${share.id} (${share.mode})`).join(", ") : "Private"}</td><td>{row.enabledCount} users</td><td>{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "—"}</td><td>{row.collisions.join(", ") || "None"}</td><td>
          <Show when={row.disabledByAdmin || row.shares.some((share) => share.kind === "all")}><button disabled={busy()} aria-label={`${row.disabledByAdmin ? "Restore" : "Disable"} ${row.name}`} onClick={() => void run(async () => { await setSkillAdminDisabled(row.id, !row.disabledByAdmin); })}>{row.disabledByAdmin ? "Restore" : "Disable"}</button></Show>
          <Show when={row.shares.some((share) => share.kind === "all")}><button disabled={busy()} aria-label={`Delete ${row.name}`} onClick={() => setDeleting(row)}>Delete</button></Show>
        </td></tr>}</For>
      </tbody></table></div>
      <Show when={!skills.loading && data()?.skills.length === 0}><p>No user skills.</p></Show>
      <h2>System skills</h2><p>Always on for every user. Operators add defaults in <code>skill-library/default/</code>.</p>
      <div class="admin-skills-table"><table><thead><tr><th>Skill</th><th>Type</th><th>Agents</th></tr></thead><tbody>
        <For each={data()?.system ?? []}>{(row) => <tr><td><A href={`/skills/${encodeURIComponent(row.id)}`}>{row.name}</A><p>{row.description}</p></td><td>{row.kind === "builtin" ? "Built-in" : "Default"}</td><td>{row.agents?.join(", ") || "All agents"}</td></tr>}</For>
      </tbody></table></div>
      <Show when={deleting()}>{(row) => <ConfirmDialog title="Delete platform-wide skill" description={`Delete ${row().name} for its owner and everyone it is shared with? This cannot be undone.`} confirmLabel="Delete" danger error={error()} onCancel={() => setDeleting(undefined)} onConfirm={() => run(async () => { await deleteSkill(row().id); setDeleting(undefined); })} />}</Show>
    </Show>
    <style>{`.admin-skills-table{overflow:auto}.admin-skills-table table{width:100%;border-collapse:collapse;color:var(--text-primary)}.admin-skills-table th,.admin-skills-table td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid var(--border-subtle)}.admin-skills-table th{font-size:12px;color:var(--text-secondary)}.admin-skills-table a{color:var(--text-primary)}.admin-skills-table button{margin:0 8px 8px 0}`}</style>
  </AdminLayout>;
}
