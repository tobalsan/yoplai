import { For, Show, createResource, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { checkSkillDefault, deleteSkill, fetchAdminSkills, fetchSkillRecipients, makeSkillDefault, setSkillAdminDisabled, setSkillSystem, transferSkillOwner, type SkillRow } from "../../api/skills";
import { capabilities } from "../../lib/capabilities";
import { isSuperadmin } from "../../lib/roles";
import { Button } from "../../components/ui/Button";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog";
import { AgentSkillTabs } from "../../components/AgentSkillTabs";
import { UserPicker } from "../../components/UserPicker";
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
  const [transferring, setTransferring] = createSignal<{ id: string; name: string; ownerId: string }>();
  const [newOwner, setNewOwner] = createSignal("");
  const [makingDefault, setMakingDefault] = createSignal<SkillRow>();
  const [defaultCheck] = createResource(() => makingDefault()?.id, (id) => checkSkillDefault(id).catch(() => ({ outsidePaths: [] })));
  const [agentTab, setAgentTab] = createSignal<string>();
  const userName = (id: string) => recipients.latest?.users?.find((user) => user.id === id)?.name ?? "Unknown user";
  const platformWide = (row: SkillRow) => row.shares.some((share) => share.kind === "all");
  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); await refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to update skill."); }
    finally { setBusy(false); }
  };
  const action = (icon: string, label: string) => <><i class={`fa-solid ${icon}`} aria-hidden="true" /><span class="admin-skills-action-label">{label}</span></>;
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
                  <td>{row.ownerName}<Show when={capabilities.multiUser && !row.ownerActive}> <span class="admin-skills-pill admin-skills-pill--warn">Owner inactive</span></Show></td>
                  <td><Show when={row.shares.length} fallback={<span class="admin-skills-muted">Private</span>}><ul class="admin-skills-access">
                    <For each={row.shares}>{(share) => <li>{share.kind === "all" ? <span class="admin-skills-pill">Everyone · view</span> : <>{userName(share.id)} <span class="admin-skills-muted">· {share.mode === "write" ? "edit" : "view"}</span></>}</li>}</For>
                  </ul></Show></td>
                  <td class="admin-skills-num">{row.enabledCount} {row.enabledCount === 1 ? "user" : "users"}</td>
                  <td class="admin-skills-muted admin-skills-nowrap">{formatDate(row.updatedAt)}</td>
                  <td class="admin-skills-actions"><div class="admin-skills-row-actions">
                    <Show when={capabilities.multiUser}><Button disabled={busy()} title="Transfer" aria-label={`Transfer ${row.name}`} onClick={() => { setError(""); setNewOwner(""); setTransferring(row); }}>{action("fa-right-left", "Transfer")}</Button></Show>
                    <Show when={row.disabledByAdmin || platformWide(row)}><Button disabled={busy()} title={row.disabledByAdmin ? "Restore" : "Disable"} aria-label={`${row.disabledByAdmin ? "Restore" : "Disable"} ${row.name}`} onClick={() => void run(async () => { await setSkillAdminDisabled(row.id, !row.disabledByAdmin); })}>{row.disabledByAdmin ? action("fa-rotate-left", "Restore") : action("fa-ban", "Disable")}</Button></Show>
                    <Show when={platformWide(row)}><Button data-tone="danger" disabled={busy()} title="Delete" aria-label={`Delete ${row.name}`} onClick={() => setDeleting(row)}>{action("fa-trash-can", "Delete")}</Button></Show>
                  </div></td>
                </tr>}</For></tbody>
              </table>
            </Show>
          </div>
        </section>
        <section class="admin-skills-section" aria-labelledby="admin-skills-agent">
          {header("admin-skills-agent", "Agent skills", result().agent.length, "Skills in agent workspaces. Only the agent that owns the workspace uses them. Mark a skill as System to hide it from the Skills page. Make default moves it to the default skills.")}
          <Show when={result().agent.length} fallback={<div class="admin-skills-panel"><p class="admin-skills-empty">No agent workspace skills.</p></div>}>
            <AgentSkillTabs rows={result().agent} selected={agentTab()} onSelect={setAgentTab} renderRow={(row) => <li class="admin-skills-agent-row">
              <div class="admin-skills-skill"><A href={`/skills/${encodeURIComponent(row.id)}`}>{row.name}</A><p title={row.description}>{row.description}</p></div>
              <div class="admin-skills-agent-actions">
                <Button disabled={busy()} title="Move to the default skills, for all agents" aria-label={`Make ${row.name} a default skill`} onClick={() => { setError(""); setMakingDefault(row); }}>{action("fa-share-nodes", "Make default")}</Button>
                <Show when={capabilities.multiUser}><label class="admin-skills-system-switch" title="Hide from the Skills page. The agent still uses it.">
                  <input type="checkbox" role="switch" checked={row.system === true} aria-label={`Mark ${row.name} as system`} disabled={busy()} onChange={() => void run(async () => { await setSkillSystem(row.id, !row.system); })} />System
                </label></Show>
              </div>
            </li>} />
          </Show>
        </section>
        <section class="admin-skills-section" aria-labelledby="admin-skills-system">
          {header("admin-skills-system", "System skills", result().system.length, "Always on for every user. Move an agent skill here with Make default, or add a folder in skill-library/default/.")}
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
      <Show when={transferring()}>{(row) => <ConfirmDialog title="Transfer skill" description={`Give ${row().name} to another user. The new owner can edit, share and delete it. The current owner loses access unless it is shared with them.`} confirmLabel="Transfer" error={error()} onCancel={() => setTransferring(undefined)} onConfirm={async () => { if (!newOwner()) { setError("Choose a new owner."); return; } await run(async () => { await transferSkillOwner(row().id, newOwner()); setTransferring(undefined); }); }}>
        <div class="admin-skills-owner-field"><span>New owner</span>
          <UserPicker class="admin-skills-owner-picker" value={newOwner()} onChange={setNewOwner}
            users={(recipients.latest?.users ?? []).filter((user) => user.id !== row().ownerId).map((user) => ({ id: user.id, label: `${user.name} (${user.email})`, name: user.name, image: user.image }))} />
        </div>
      </ConfirmDialog>}</Show>
      <Show when={makingDefault()}>{(row) => <ConfirmDialog title="Make default skill" description={`Move ${row().name} from ${row().agentName}'s workspace to the default skills? All agents and all users get it, always on. It is removed from the workspace.`} confirmLabel={defaultCheck.latest?.outsidePaths.length ? "Make default anyway" : "Make default"} error={error()} onCancel={() => setMakingDefault(undefined)} onConfirm={() => run(async () => { await makeSkillDefault(row().id); setMakingDefault(undefined); })}>
        <Show when={defaultCheck.loading}><p class="admin-skills-muted" role="status">Checking file paths…</p></Show>
        <Show when={!defaultCheck.loading && defaultCheck()?.outsidePaths.length}><div class="admin-skills-path-warning" role="alert">
          <p>This skill refers to files outside its folder. Other agents may not have these files:</p>
          <ul><For each={defaultCheck()?.outsidePaths.slice(0, 8)}>{(item) => <li><code>{item}</code></li>}</For></ul>
          <Show when={(defaultCheck()?.outsidePaths.length ?? 0) > 8}><p>And {(defaultCheck()?.outsidePaths.length ?? 0) - 8} more.</p></Show>
        </div></Show>
      </ConfirmDialog>}</Show>
      <Show when={deleting()}>{(row) => <ConfirmDialog title="Delete platform-wide skill" description={`Delete ${row().name} for its owner and everyone it is shared with? This cannot be undone.`} confirmLabel="Delete" danger error={error()} onCancel={() => setDeleting(undefined)} onConfirm={() => run(async () => { await deleteSkill(row().id); setDeleting(undefined); })} />}</Show>
    </Show>
    <style>{`
      .admin-skills-section { max-width: 1120px; }
      .admin-skills-section + .admin-skills-section { margin-top: 40px; }
      .admin-skills-section-header { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; margin-bottom: 12px; }
      .admin-skills-section-header h2 { margin: 0; font-size: 16px; font-weight: 600; color: var(--text-primary); }
      .admin-skills-section-header p { flex-basis: 100%; margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); }
      .admin-skills-count { padding: 1px 8px; border-radius: 999px; background: var(--bg-raised); color: var(--text-secondary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .admin-skills-panel { container-type: inline-size; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); overflow-x: auto; }
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
      .admin-skills-row-actions, .admin-skills-agent-actions { display: inline-flex; align-items: center; justify-content: flex-end; gap: 6px; flex-shrink: 0; }
      .admin-skills-row-actions .ui-button, .admin-skills-agent-actions .ui-button { padding: 4px 10px; font-size: 12.5px; color: var(--text-secondary); background: var(--bg-surface); }
      .admin-skills-row-actions .ui-button:hover:not(:disabled), .admin-skills-agent-actions .ui-button:hover:not(:disabled) { background: var(--bg-raised); color: var(--text-primary); }
      .admin-skills-row-actions .ui-button i, .admin-skills-agent-actions .ui-button i { font-size: 11px; }
      .admin-skills-actions [data-tone=danger] { color: var(--color-danger, #dc2626); }
      .admin-skills-system { list-style: none; margin: 0; padding: 0; }
      .admin-skills-system li { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
      .admin-skills-system li:last-child { border-bottom: 0; }
      .admin-skills-system-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; font-size: 13px; }
      .admin-skills-agent-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; font-size: 14px; }
      .admin-skills-agent-actions { gap: 16px; }
      .admin-skills-system-switch { display: inline-flex; align-items: center; gap: 8px; padding-left: 16px; border-left: 1px solid var(--border-subtle); font-size: 12.5px; color: var(--text-secondary); cursor: pointer; }
      .admin-skills-system-switch input { appearance: none; position: relative; flex: none; width: 30px; height: 18px; margin: 0; border: 1px solid var(--border-default); border-radius: 18px; background: var(--bg-raised); cursor: pointer; transition: background-color 150ms; }
      .admin-skills-system-switch input::before { content: ''; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; border-radius: 50%; background: var(--text-tertiary); transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms; }
      .admin-skills-system-switch input:checked { background: var(--accent, #3b82f6); border-color: transparent; }
      .admin-skills-system-switch input:checked::before { background: white; transform: translateX(12px); }
      .admin-skills-system-switch input:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 2px; }
      .admin-skills-system-switch:has(input:disabled) { opacity: .5; cursor: default; }
      .admin-skills-agent-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .admin-skills-agent-actions .ui-button { padding: 5px 10px; }
      .admin-skills-path-warning { margin: 12px 0 4px; padding: 10px 12px; border: 1px solid color-mix(in srgb, #d97706 40%, transparent); border-radius: 10px; background: color-mix(in srgb, #f59e0b 12%, transparent); font-size: 13px; color: var(--text-primary); }
      .admin-skills-path-warning p { margin: 0; }
      .admin-skills-path-warning ul { margin: 6px 0 0; padding-left: 18px; display: grid; gap: 2px; }
      .admin-skills-path-warning code { font-size: 12px; overflow-wrap: anywhere; }
      .admin-skills-owner-field { display: grid; gap: 6px; margin: 16px 0 4px; font-size: 13px; font-weight: 500; color: var(--text-secondary); }
      .admin-skills-owner-picker { border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-surface); font-size: 14px; font-weight: 400; color: var(--text-primary); }
      .admin-skills-empty { margin: 0; padding: 20px 16px; font-size: 14px; color: var(--text-secondary); }
      .admin-skills-notice { max-width: 1120px; margin: 0 0 16px; padding: 12px 16px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); color: var(--text-secondary); font-size: 14px; }
      .admin-skills-error { color: var(--text-primary); background: color-mix(in srgb, #ef4444 10%, var(--bg-surface)); }
      .admin-skills-link-button { border: 0; padding: 0; background: none; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
      .admin-skills-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      /* Only when the table does not fit (e.g. a zoomed-in browser): tighter cells and icon-only actions. */
      @container (max-width: 759px) {
        .admin-skills-table { min-width: 0; }
        .admin-skills-table th, .admin-skills-table td { padding-left: 10px; padding-right: 10px; }
        .admin-skills-table .admin-skills-action-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        .admin-skills-row-actions .ui-button { padding: 5px 8px; }
      }
      @media (max-width: 720px) { .admin-skills-system li { flex-direction: column; gap: 8px; } .admin-skills-system-meta { flex-direction: row; align-items: center; } }
    `}</style>
  </AdminLayout>;
}
