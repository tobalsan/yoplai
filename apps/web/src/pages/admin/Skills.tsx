import { For, Show, createResource, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { deleteSkill, fetchAdminSkills, fetchSkillRecipients, setSkillAdminDisabled, type SkillRow } from "../../api/skills";
import { capabilities } from "../../lib/capabilities";
import { isSuperadmin } from "../../lib/roles";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import AdminLayout from "./AdminLayout";

const formatDate = (value: string | number | null) => value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

export default function AdminSkills() {
  const permitted = () => !capabilities.multiUser || isSuperadmin(capabilities.user?.role);
  const [skills, { refetch }] = createResource(permitted, fetchAdminSkills);
  const [recipients] = createResource(() => permitted() && capabilities.multiUser, () => fetchSkillRecipients().catch(() => ({ users: [] })));
  const data = () => skills.error ? undefined : skills.latest;
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [deleting, setDeleting] = createSignal<SkillRow>();
  const userName = (id: string) => recipients.latest?.users?.find((user) => user.id === id)?.name ?? "Unknown user";
  const platformWide = (row: SkillRow) => row.shares.some((share) => share.kind === "all");
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); await refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update skill."); }
    finally { setBusy(false); }
  };
  const header = (id: string, title: string, count: number, description: string) => <header class="admin-skills-section-header">
    <h2 id={id}>{title}</h2><span class="admin-skills-count">{count}</span><p>{description}</p>
  </header>;
  return <AdminLayout title="Skills" description="Review the skills on this platform. Disable or delete a skill that is shared with everyone.">
    <Show when={permitted()} fallback={<p class="admin-skills-notice" role="alert">Superadmin access required.</p>}>
      <Show when={skills.error || error()}><p class="admin-skills-notice admin-skills-error" role="alert">{error() || "Unable to load skills."} <button class="admin-skills-link-button" onClick={() => void refetch()}>Retry</button></p></Show>
      <Show when={skills.state === "pending"}><p class="admin-skills-notice" role="status">Loading skills…</p></Show>
      <Show when={data()}>{(result) => <>
        <section class="admin-skills-section" aria-labelledby="admin-skills-user">
          {header("admin-skills-user", "User skills", result().skills.length, "Skills that people upload, create or import. Each user turns them on for all the agents they can use.")}
          <div class="admin-skills-panel">
            <Show when={result().skills.length} fallback={<p class="admin-skills-empty">No user skills yet. They show here after someone uploads, creates or imports a skill.</p>}>
              <table class="admin-skills-table">
                <thead><tr><th scope="col">Skill</th><th scope="col">Owner</th><th scope="col">Access</th><th scope="col" class="admin-skills-num">Enabled by</th><th scope="col">Updated</th><th scope="col"><span class="admin-skills-sr">Actions</span></th></tr></thead>
                <tbody><For each={result().skills}>{(row) => <tr>
                  <td class="admin-skills-skill">
                    <A href={`/skills/${encodeURIComponent(row.id)}`}>{row.name}</A>
                    <p title={row.description}>{row.description}</p>
                    <Show when={row.disabledByAdmin || row.collisions.length}><div class="admin-skills-flags">
                      <Show when={row.disabledByAdmin}><span class="admin-skills-pill admin-skills-pill--warn">Disabled by admin</span></Show>
                      <Show when={row.collisions.length}><span class="admin-skills-pill admin-skills-pill--warn" title="A system skill with the same name takes precedence.">Same name as {row.collisions.join(", ")}</span></Show>
                    </div></Show>
                  </td>
                  <td>{row.ownerName}</td>
                  <td><Show when={row.shares.length} fallback={<span class="admin-skills-muted">Private</span>}><ul class="admin-skills-access">
                    <For each={row.shares}>{(share) => <li>{share.kind === "all" ? <span class="admin-skills-pill">Everyone · view</span> : <>{userName(share.id)} <span class="admin-skills-muted">· {share.mode === "write" ? "edit" : "view"}</span></>}</li>}</For>
                  </ul></Show></td>
                  <td class="admin-skills-num">{row.enabledCount} {row.enabledCount === 1 ? "user" : "users"}</td>
                  <td class="admin-skills-muted admin-skills-nowrap">{formatDate(row.updatedAt)}</td>
                  <td class="admin-skills-actions">
                    <Show when={row.disabledByAdmin || platformWide(row)}><Button variant="ghost" disabled={busy()} aria-label={`${row.disabledByAdmin ? "Restore" : "Disable"} ${row.name}`} onClick={() => void run(async () => { await setSkillAdminDisabled(row.id, !row.disabledByAdmin); })}>{row.disabledByAdmin ? "Restore" : "Disable"}</Button></Show>
                    <Show when={platformWide(row)}><Button variant="ghost" data-tone="danger" disabled={busy()} aria-label={`Delete ${row.name}`} onClick={() => setDeleting(row)}>Delete</Button></Show>
                  </td>
                </tr>}</For></tbody>
              </table>
            </Show>
          </div>
        </section>
        <section class="admin-skills-section" aria-labelledby="admin-skills-system">
          {header("admin-skills-system", "System skills", result().system.length, "Always on for every user. Operators add default skills in skill-library/default/.")}
          <div class="admin-skills-panel">
            <Show when={result().system.length} fallback={<p class="admin-skills-empty">No system skills.</p>}>
              <ul class="admin-skills-system">
                <For each={result().system}>{(row) => <li>
                  <div class="admin-skills-skill"><A href={`/skills/${encodeURIComponent(row.id)}`}>{row.name}</A><p title={row.description}>{row.description}</p></div>
                  <div class="admin-skills-system-meta">
                    <span class="admin-skills-pill">{row.kind === "builtin" ? "Built-in" : "Default"}</span>
                    <span class="admin-skills-muted">{row.agents?.length ? `Agents: ${row.agents.join(", ")}` : "All agents"}</span>
                  </div>
                </li>}</For>
              </ul>
            </Show>
          </div>
        </section>
      </>}</Show>
      <Show when={deleting()}>{(row) => <ConfirmDialog title="Delete platform-wide skill" description={`Delete ${row().name} for its owner and everyone it is shared with? This cannot be undone.`} confirmLabel="Delete" danger error={error()} onCancel={() => setDeleting(undefined)} onConfirm={() => run(async () => { await deleteSkill(row().id); setDeleting(undefined); })} />}</Show>
    </Show>
    <style>{`
      .admin-skills-section { max-width: 1120px; }
      .admin-skills-section + .admin-skills-section { margin-top: 40px; }
      .admin-skills-section-header { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; margin-bottom: 12px; }
      .admin-skills-section-header h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--text-primary); }
      .admin-skills-section-header p { flex-basis: 100%; margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); }
      .admin-skills-count { padding: 1px 8px; border-radius: 999px; background: var(--bg-raised); color: var(--text-secondary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .admin-skills-panel { border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); overflow-x: auto; }
      .admin-skills-table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: 14px; color: var(--text-primary); }
      .admin-skills-table th { padding: 10px 16px; text-align: left; font-size: 12px; font-weight: 500; color: var(--text-tertiary); border-bottom: 1px solid var(--border-default); white-space: nowrap; }
      .admin-skills-table td { padding: 14px 16px; vertical-align: top; border-bottom: 1px solid var(--border-subtle); }
      .admin-skills-table tbody tr:last-child td { border-bottom: 0; }
      .admin-skills-table tbody tr:hover td { background: color-mix(in srgb, var(--bg-raised) 40%, transparent); }
      .admin-skills-skill { min-width: 0; }
      .admin-skills-table .admin-skills-skill { width: 42%; }
      .admin-skills-skill a { font-weight: 600; color: var(--text-primary); text-decoration: none; overflow-wrap: anywhere; }
      .admin-skills-skill a:hover { text-decoration: underline; }
      .admin-skills-skill a:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 2px; border-radius: 3px; }
      .admin-skills-skill p { margin: 4px 0 0; font-size: 13px; line-height: 1.45; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 72ch; }
      .admin-skills-flags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
      .admin-skills-pill { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border-default); font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
      .admin-skills-pill--warn { border-color: color-mix(in srgb, #d97706 40%, transparent); background: color-mix(in srgb, #f59e0b 12%, transparent); color: var(--text-primary); }
      .admin-skills-access { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
      .admin-skills-muted { color: var(--text-tertiary); }
      .admin-skills-table .admin-skills-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .admin-skills-nowrap { white-space: nowrap; }
      .admin-skills-table .admin-skills-actions { padding-top: 9px; text-align: right; white-space: nowrap; }
      .admin-skills-actions .ui-button { padding: 5px 10px; }
      .admin-skills-actions [data-tone=danger] { color: var(--color-danger, #dc2626); }
      .admin-skills-system { list-style: none; margin: 0; padding: 0; }
      .admin-skills-system li { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
      .admin-skills-system li:last-child { border-bottom: 0; }
      .admin-skills-system-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; font-size: 13px; }
      .admin-skills-empty { margin: 0; padding: 20px 16px; font-size: 14px; color: var(--text-secondary); }
      .admin-skills-notice { max-width: 1120px; margin: 0 0 16px; padding: 12px 16px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); color: var(--text-secondary); font-size: 14px; }
      .admin-skills-error { color: var(--text-primary); background: color-mix(in srgb, #ef4444 10%, var(--bg-surface)); }
      .admin-skills-link-button { border: 0; padding: 0; background: none; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
      .admin-skills-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      @media (max-width: 720px) { .admin-skills-system li { flex-direction: column; gap: 8px; } .admin-skills-system-meta { flex-direction: row; align-items: center; } }
    `}</style>
  </AdminLayout>;
}
