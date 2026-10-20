import { For, Show, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import { A, useNavigate, useParams } from "@solidjs/router";
import { fetchSkills, fetchSkill, setSkillEnabled, uploadSkill, fetchSkillRecipients, saveSkillShares, deleteSkill, SkillRequestError, type SkillRow } from "../api/skills";
import { capabilities } from "../lib/capabilities";
import { Button } from "../components/ui/Button";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { DashboardAccessDialog } from "../components/DashboardAccessDialog";
import { SkillImportDialog } from "../components/SkillImportDialog";
import { SkillVersionsDialog } from "../components/SkillVersionsDialog";
import { renderMarkdown } from "../lib/markdown";
import { fetchMainAgentOptions } from "../api/main-agent";
import { startNewChat } from "../api/chat";
import type { Agent } from "../api/types";
import { Modal } from "../components/ui/Modal";

// Show YAML front matter as a code block, not as Markdown headings.
const skillMarkdown = (text: string) => text.replace(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/, (_match, yaml: string) => "```yaml\n" + yaml + "\n```\n\n");

const CREATE_SKILL_PROMPT = "Help me create a skill. Let's start with you interviewing me to understand what the skill should do.";

export function Skills() {
  const params = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const [skills, { refetch: refetchList }] = createResource(() => !params.id, fetchSkills);
  const [detail, { refetch: refetchDetail }] = createResource(() => params.id && decodeURIComponent(params.id), fetchSkill); // the router keeps %3A etc. encoded
  // `.latest` keeps background refetches from suspending the route and blanking the page.
  const listData = () => skills.error ? undefined : skills.latest;
  const detailData = () => detail.error ? undefined : detail.latest;
  const refetch = () => Promise.all([refetchList(), refetchDetail()]);
  onMount(() => {
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      void refetch().catch(() => undefined).finally(() => { refreshing = false; });
    };
    const timer = window.setInterval(refresh, 4_000);
    window.addEventListener("focus", refresh);
    onCleanup(() => { window.clearInterval(timer); window.removeEventListener("focus", refresh); });
  });
  const [search, setSearch] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal<string>();
  const [adding, setAdding] = createSignal(false);
  const [openActions, setOpenActions] = createSignal<string>();
  const [replacement, setReplacement] = createSignal<{ id: string; files: File[]; folder: boolean }>();
  const [replaceTarget, setReplaceTarget] = createSignal<string>();
  const [choosingReplacement, setChoosingReplacement] = createSignal<SkillRow>();
  const [managing, setManaging] = createSignal<SkillRow>();
  const [importing, setImporting] = createSignal(false);
  const [versions, setVersions] = createSignal<SkillRow>();
  const [deleting, setDeleting] = createSignal<SkillRow>();
  const [createAgents, setCreateAgents] = createSignal<Agent[]>();
  createEffect(on(() => params.id, () => { setOpenActions(undefined); setAdding(false); }, { defer: true }));
  let zipInput: HTMLInputElement | undefined;
  let addControl: HTMLDivElement | undefined;
  onMount(() => {
    const closeMenus = (event: Event) => {
      const target = event.target as Element;
      if (adding() && !addControl?.contains(target)) setAdding(false);
      if (openActions() && !target.closest?.(".skill-actions")) setOpenActions(undefined);
    };
    document.addEventListener("pointerdown", closeMenus);
    onCleanup(() => document.removeEventListener("pointerdown", closeMenus));
  });
  let folderInput: HTMLInputElement | undefined;
  const rows = (items: SkillRow[] | undefined) => (items ?? []).filter((row) => `${row.name} ${row.description} ${row.ownerName ?? ""} ${row.agentName ?? ""}`.toLowerCase().includes(search().toLowerCase()));
  const toggle = async (row: SkillRow, enabled: boolean) => {
    setBusy(row.id); setError("");
    try { await setSkillEnabled(row.id, enabled); await refetch(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to change skill."); }
    finally { setBusy(undefined); }
  };
  const upload = async (files: File[], folder: boolean, id?: string) => {
    if (!files.length) return;
    setBusy("upload"); setError("");
    try { await uploadSkill(files, folder, id); setReplacement(undefined); await refetch(); }
    catch (cause) {
      if (cause instanceof SkillRequestError && cause.code === "skill_exists" && cause.skillId) setReplacement({ id: cause.skillId, files, folder });
      else setError(cause instanceof Error ? cause.message : "Unable to upload skill.");
    } finally { setBusy(undefined); }
  };
  const selected = (event: Event, folder: boolean) => {
    const input = event.currentTarget as HTMLInputElement;
    void upload(Array.from(input.files ?? []), folder, replaceTarget());
    input.value = ""; setReplaceTarget(undefined);
  };
  const createChat = (agentId: string) => {
    startNewChat(agentId);
    navigate(`/chat/${encodeURIComponent(agentId)}`, { state: { initialMessage: CREATE_SKILL_PROMPT } });
  };
  const createSkill = async () => {
    setAdding(false); setBusy("create"); setError("");
    try {
      const options = await fetchMainAgentOptions(capabilities.forkedAgents === true);
      const agents = options.agents.filter((agent) => (agent.sdk ?? "pi") === "pi");
      if (options.preference.accessible && agents.some((agent) => agent.id === options.preference.mainAgentId)) createChat(options.preference.mainAgentId!);
      else setCreateAgents(agents);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load agents."); }
    finally { setBusy(undefined); }
  };
  const owner = (row: SkillRow) => row.kind === "builtin" ? "Built-in" : row.kind === "default" ? "Default" : row.kind === "agent" ? `${row.agentName} workspace` : row.canManage ? "You" : row.ownerName;
  const group = (title: string, items: SkillRow[] | undefined, description?: string, empty?: string) => <section class="skills-section" aria-label={title}>
    <Show when={description}><header class="skills-section-header"><h2>{title}</h2><Show when={items}><span class="skills-count">{rows(items).length}</span></Show><p>{description}</p></header></Show>
    <ul class="skills-list"><For each={rows(items)} fallback={<li class="skills-empty">{search() ? `No skills match "${search()}".` : empty ?? "No skills found."}</li>}>{(row) => <li class="skill-row">
    <div class="skill-copy"><Show when={!params.id}><A href={`/skills/${encodeURIComponent(row.id)}`}>{row.name}</A></Show><p title={row.description}>{row.description}</p><div class="skill-meta"><span>{owner(row)}</span><Show when={row.canManage && row.shares?.length}><span class="skill-pill">Shared</span></Show><Show when={row.mode === "read" && row.kind === "user"}><span>Can view</span></Show><Show when={row.mode === "write" && !row.canManage}><span>Can edit</span></Show><Show when={row.shadowed}><span class="skill-pill skill-pill--warn" title="Another enabled skill with the same name loads instead.">Not loaded: same name as another skill</span></Show><Show when={row.disabledByAdmin}><span class="skill-pill skill-pill--warn">Disabled by admin</span></Show></div></div>
    <Show when={row.kind !== "agent"}><Show when={!row.locked} fallback={<span class="skill-locked" aria-label="Always on"><i class="fa-solid fa-lock" aria-hidden="true" /> Always on</span>}><input type="checkbox" role="switch" aria-label={`Enable ${row.name}`} checked={row.enabled} disabled={!!busy() || row.disabledByAdmin} onChange={(event) => void toggle(row, event.currentTarget.checked)} /></Show></Show>
    <Show when={row.kind === "user" && (row.canWrite || row.canManage)}><details class="skill-actions" open={openActions() === row.id} onClick={(event) => { if ((event.target as HTMLElement).closest("button")) setOpenActions(undefined); }}><summary role="button" aria-label={`Actions for ${row.name}`} aria-expanded={openActions() === row.id} onClick={(event) => { event.preventDefault(); setOpenActions(openActions() === row.id ? undefined : row.id); }}><i class="fa-solid fa-ellipsis" aria-hidden="true" /></summary><div class="skill-action-menu">
    <Show when={row.canWrite && row.kind === "user"}><button aria-label={`Replace ${row.name}`} onClick={() => setChoosingReplacement(row)}>Replace</button></Show>
    <Show when={row.canManage && capabilities.multiUser}><button aria-label={`Manage access for ${row.name}`} onClick={() => setManaging(row)}>Manage access</button></Show>
    <Show when={row.canWrite && row.kind === "user"}><button aria-label={`Versions of ${row.name}`} onClick={() => setVersions(row)}>Versions</button></Show>
    <Show when={row.canManage}><button aria-label={`Delete ${row.name}`} onClick={() => { setError(""); setDeleting(row); }}>Delete</button></Show>
    </div></details></Show>
  </li>}</For></ul></section>;
  const formatSize = (size: number) => size < 1024 ? `${size} bytes` : `${(size / 1024).toFixed(1)} KB`;
  return <main class="skills-page"><div class="skills-shell">
    <Show when={params.id}><A class="skills-back" href="/skills"><i class="fa-solid fa-arrow-left" aria-hidden="true" /> All skills</A></Show>
    <header class="skills-header"><div><h1>{params.id ? detailData()?.name ?? "Skill" : "Skills"}</h1><Show when={!params.id}><p>Skills enabled on this page become available to all your agents.</p></Show></div>
    <Show when={!params.id}>
    <div class="skills-add-control" ref={addControl}><Button variant="primary" icon="fa-solid fa-plus" onClick={() => setAdding(!adding())} disabled={!!busy()} aria-expanded={adding()}>Add skill <i class="fa-solid fa-chevron-down skills-chevron" aria-hidden="true" /></Button>
    <Show when={adding()}><div class="skills-add" role="menu"><button role="menuitem" onClick={() => { setAdding(false); setReplaceTarget(undefined); zipInput?.click(); }}><i class="fa-regular fa-file-zipper" aria-hidden="true" />Upload zip</button><button role="menuitem" onClick={() => { setAdding(false); setReplaceTarget(undefined); folderInput?.click(); }}><i class="fa-regular fa-folder-open" aria-hidden="true" />Upload folder</button><button role="menuitem" disabled={busy() === "create"} onClick={() => void createSkill()}><i class="fa-regular fa-comments" aria-hidden="true" />Create skill</button><button role="menuitem" onClick={() => { setAdding(false); setImporting(true); }}><i class="fa-solid fa-arrow-right-to-bracket" aria-hidden="true" />Import from Claude or ChatGPT</button></div></Show>
    </div></Show></header>
    <input ref={zipInput} aria-label="Skill zip file" type="file" accept=".zip" hidden onChange={(event) => selected(event, false)} />
    <input ref={(element) => { folderInput = element; element.setAttribute("webkitdirectory", ""); }} aria-label="Skill folder files" type="file" multiple hidden onChange={(event) => selected(event, true)} />
    <Show when={replacement()}>{(item) => <ConfirmDialog title="Replace existing skill" description="Replace the content of your skill? Sharing and enable settings will be kept, and the current content saved in version history." confirmLabel="Replace" error={error()} onCancel={() => setReplacement(undefined)} onConfirm={() => upload(item().files, item().folder, item().id)} />}</Show>
    <Show when={choosingReplacement()}>{(row) => <Modal title={`Replace ${row().name}`} onClose={() => setChoosingReplacement(undefined)}><p>Upload a replacement with the same skill name. Sharing and enable settings stay the same.</p><Button onClick={() => { setReplaceTarget(row().id); setChoosingReplacement(undefined); zipInput?.click(); }}>Replace from zip</Button><Button onClick={() => { setReplaceTarget(row().id); setChoosingReplacement(undefined); folderInput?.click(); }}>Replace from folder</Button></Modal>}</Show>
    <Show when={managing()}>{(row) => <DashboardAccessDialog dashboard={{ id: row().id, title: row().name, shares: row().shares }} loadRecipients={fetchSkillRecipients} saveShares={saveSkillShares} platformReadOnly note="People with access can turn this skill on for their own agents. Editors can change its content. Only you can share or delete it." onClose={() => setManaging(undefined)} onSaved={async () => { await refetch(); }} />}</Show>
    <Show when={importing()}><SkillImportDialog onClose={() => setImporting(false)} /></Show>
    <Show when={createAgents()}>{(agents) => <Modal title="Create skill: choose an agent" onClose={() => setCreateAgents(undefined)} footer={<Button onClick={() => setCreateAgents(undefined)}>Cancel</Button>}><p>Who do you want to create this skill with?</p><For each={agents()} fallback={<p>No agents with skill support are available. Ask your operator for an agent that supports skills, or upload or import a skill instead.</p>}>{(agent) => <Button onClick={() => createChat(agent.id)}>{agent.name}</Button>}</For></Modal>}</Show>
    <Show when={versions()}>{(row) => <SkillVersionsDialog skill={row()} onClose={() => setVersions(undefined)} onRestored={async () => { await refetch(); }} />}</Show>
    <Show when={deleting()}>{(row) => <ConfirmDialog title="Delete skill" description={`Delete ${row().name}, its saved versions and all shares? This cannot be undone.`} confirmLabel="Delete" danger error={error()} onCancel={() => setDeleting(undefined)} onConfirm={async () => { try { await deleteSkill(row().id); setDeleting(undefined); if (params.id) navigate("/skills"); else await refetch(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to delete skill."); } }} />}</Show>
    <Show when={!params.id}><label class="skills-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true" /><input type="search" aria-label="Search skills" placeholder="Search skills" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></label></Show>
    <Show when={skills.error || detail.error || error()}><p class="skills-notice skills-notice--error" role="alert">{error() || "Unable to load skills."} <button class="skills-link-button" onClick={() => void refetch()}>Retry</button></p></Show>
    <Show when={skills.state === "pending" || detail.state === "pending"}><p class="skills-notice" role="status">Loading skills…</p></Show>
    <Show when={params.id ? detailData() : undefined}>{(row) => <>{group("Skill", [row()])}
      <section class="skills-section"><header class="skills-section-header"><h2>Instructions</h2><p>The SKILL.md file the agent reads.</p></header><div aria-label="Skill instructions" class="skill-instructions" innerHTML={renderMarkdown(skillMarkdown(row().skillMd), { stripFrontmatter: false })} /></section>
      <section class="skills-section"><header class="skills-section-header"><h2>Files</h2><span class="skills-count">{row().files.length}</span></header><ul class="skills-list skills-files"><For each={row().files}>{(file) => <li><i class="fa-regular fa-file-lines" aria-hidden="true" /><span class="skills-file-path">{file.path}</span><small>{formatSize(file.size)}</small></li>}</For></ul></section></>}</Show>
    <Show when={!params.id && listData()}>
    {group("Mine", listData()?.mine, "Skills you upload, create or import. New skills start off.", "No skills yet. Use Add skill to upload, create or import one.")}<Show when={capabilities.multiUser}>{group("Shared with me", listData()?.sharedWithMe, "Skills other people share with you.", "Nobody shares a skill with you yet.")}</Show>{group("Agent skills", listData()?.agent, "Read-only skills from agent workspaces. The agent always loads them.", "No agent workspace skills.")}
    </Show>
    </div>
    <style>{`
      .skills-page { flex: 1; min-width: 0; overflow: auto; padding: 40px 32px 64px; color: var(--text-primary); }
      .skills-shell { max-width: 960px; margin: 0 auto; }
      .skills-back { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 16px; font-size: 13px; color: var(--text-secondary); text-decoration: none; }
      .skills-back:hover { color: var(--text-primary); }
      .skills-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
      .skills-header h1 { margin: 0; font-size: 26px; font-weight: 650; letter-spacing: -0.015em; overflow-wrap: anywhere; }
      .skills-header p { margin: 6px 0 0; max-width: 60ch; font-size: 14px; line-height: 1.5; color: var(--text-secondary); }
      .skills-add-control { position: relative; flex-shrink: 0; }
      .skills-add-control .ui-button { height: 36px; padding: 0 14px; font-weight: 500; }
      .skills-chevron { margin-left: 2px; font-size: 10px; opacity: .7; }
      .skills-add, .skill-action-menu { position: absolute; z-index: 10; min-width: 220px; padding: 4px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-overlay, var(--bg-surface)); box-shadow: 0 12px 32px var(--shadow-md); transform-origin: top right; animation: skills-menu-in 140ms cubic-bezier(0.23, 1, 0.32, 1); }
      .skills-add { top: calc(100% + 6px); right: 0; min-width: 260px; }
      .skills-add button, .skill-action-menu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border: 0; border-radius: 6px; background: transparent; color: var(--text-primary); font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
      .skills-add button i { width: 16px; text-align: center; color: var(--text-tertiary); }
      .skills-add button:hover, .skill-action-menu button:hover, .skills-add button:focus-visible, .skill-action-menu button:focus-visible { background: var(--bg-raised); outline: none; }
      .skills-add button:disabled { opacity: .5; cursor: default; }
      .skill-action-menu button[aria-label^="Delete"] { color: var(--color-danger, #dc2626); }
      @keyframes skills-menu-in { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
      .skills-search { position: relative; display: block; max-width: 360px; margin-bottom: 8px; }
      .skills-search i { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); font-size: 13px; color: var(--text-tertiary); pointer-events: none; }
      .skills-search input { width: 100%; height: 36px; box-sizing: border-box; padding: 0 12px 0 34px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-input, var(--bg-surface)); color: var(--text-primary); font: inherit; font-size: 14px; }
      .skills-search input:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 1px; border-color: transparent; }
      .skills-section { margin-top: 36px; }
      .skills-section-header { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; margin-bottom: 12px; }
      .skills-section-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
      .skills-section-header p { flex-basis: 100%; margin: 4px 0 0; font-size: 13px; color: var(--text-secondary); }
      .skills-count { padding: 1px 8px; border-radius: 999px; background: var(--bg-raised); color: var(--text-secondary); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .skills-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); }
      .skills-list > li { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
      .skills-list > li:last-child { border-bottom: 0; }
      .skills-list > li:first-child { border-radius: 11px 11px 0 0; }
      .skills-list > li:last-child { border-radius: 0 0 11px 11px; }
      .skills-list > li:only-child { border-radius: 11px; }
      .skills-empty { font-size: 14px; color: var(--text-secondary); }
      .skill-row { display: flex; align-items: center; gap: 16px; transition: background-color 120ms; }
      .skill-row:hover { background: color-mix(in srgb, var(--bg-raised) 40%, transparent); }
      .skill-copy { flex: 1; min-width: 0; }
      .skill-copy a { font-weight: 600; font-size: 14px; color: var(--text-primary); overflow-wrap: anywhere; text-decoration: none; }
      .skill-copy a:hover { text-decoration: underline; }
      .skill-copy p { margin: 3px 0 0; font-size: 13px; line-height: 1.45; color: var(--text-secondary); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .skill-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 8px; font-size: 12px; color: var(--text-tertiary); }
      .skill-meta > span:not(.skill-pill) + span:not(.skill-pill)::before { content: "·"; margin-right: 10px; }
      .skill-pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border-default); color: var(--text-secondary); }
      .skill-pill--warn { border-color: color-mix(in srgb, #d97706 40%, transparent); background: color-mix(in srgb, #f59e0b 12%, transparent); color: var(--text-primary); }
      .skill-locked { display: inline-flex; align-items: center; gap: 6px; color: var(--text-tertiary); font-size: 12px; white-space: nowrap; }
      .skill-actions { position: relative; }
      .skill-actions summary { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; cursor: pointer; list-style: none; color: var(--text-secondary); }
      .skill-actions summary::-webkit-details-marker { display: none; }
      .skill-actions summary:hover, .skill-actions[open] summary { background: var(--bg-raised); color: var(--text-primary); }
      .skill-action-menu { right: 0; top: calc(100% + 4px); min-width: 180px; }
      .skill-row input[role=switch] { appearance: none; position: relative; flex: none; width: 34px; height: 20px; margin: 0; border: 1px solid var(--border-default); border-radius: 20px; background: var(--bg-raised); cursor: pointer; transition: background-color 150ms, border-color 150ms; }
      .skill-row input[role=switch]::before { content: ''; position: absolute; width: 14px; height: 14px; left: 2px; top: 2px; border-radius: 50%; background: var(--text-tertiary); transition: transform 150ms cubic-bezier(0.23, 1, 0.32, 1), background-color 150ms; }
      .skill-row input[role=switch]:checked { background: var(--accent, #3b82f6); border-color: transparent; }
      .skill-row input[role=switch]:checked::before { background: white; transform: translateX(14px); }
      .skill-row input[role=switch]:disabled { opacity: .5; cursor: default; }
      .skills-page button:focus-visible, .skill-actions summary:focus-visible, .skill-row input:focus-visible, .skill-copy a:focus-visible, .skills-back:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 2px; }
      .skill-instructions { padding: 24px 28px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); font-size: 14px; line-height: 1.65; overflow-wrap: anywhere; }
      .skill-instructions > :first-child { margin-top: 0; }
      .skill-instructions > :last-child { margin-bottom: 0; }
      .skill-instructions pre { overflow: auto; padding: 12px 14px; background: var(--bg-inset, var(--bg-raised)); border-radius: 8px; font-size: 13px; }
      .skill-instructions pre, .skill-instructions code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .skill-instructions img { max-width: 100%; }
      .skills-files > li { display: flex; align-items: center; gap: 10px; padding: 10px 16px; font-size: 13px; }
      .skills-files i { color: var(--text-tertiary); }
      .skills-file-path { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
      .skills-files small { color: var(--text-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .skills-notice { margin: 16px 0 0; padding: 12px 16px; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); color: var(--text-secondary); font-size: 14px; }
      .skills-notice--error { color: var(--text-primary); background: color-mix(in srgb, #ef4444 10%, var(--bg-surface)); }
      .skills-link-button { border: 0; padding: 0; background: none; color: inherit; font: inherit; text-decoration: underline; cursor: pointer; }
      @media (prefers-reduced-motion: reduce) { .skills-add, .skill-action-menu { animation: none; } }
      @media (max-width: 600px) { .skills-page { padding: 64px 16px 48px; } .skills-header { flex-direction: column; gap: 16px; } .skill-row { gap: 10px; } .skills-search { max-width: none; } }
    `}</style>
  </main>;
}
