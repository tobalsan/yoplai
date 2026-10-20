import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
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
  let zipInput: HTMLInputElement | undefined;
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
  const group = (title: string, items: SkillRow[] | undefined) => <section><h2>{title}</h2><ul class="skills-list"><For each={rows(items)} fallback={<li>No skills found.</li>}>{(row) => <li class="skill-row">
    <div class="skill-copy"><A href={`/skills/${encodeURIComponent(row.id)}`}>{row.name}</A><p>{row.description}</p><small>{row.kind === "builtin" ? "Built-in" : row.kind === "default" ? "Default" : row.kind === "agent" ? `Workspace · ${row.agentName}` : row.canManage ? "You" : row.ownerName}<Show when={row.shares?.length}> <span class="skill-pill">Shared</span></Show><Show when={row.mode === "read"}> · Can view</Show><Show when={row.mode === "write" && !row.canManage}> · Can edit</Show><Show when={row.shadowed}> · Shadowed by another enabled skill</Show><Show when={row.disabledByAdmin}> <span class="skill-pill">Disabled by admin</span></Show></small></div>
    <Show when={row.kind !== "agent"}><Show when={!row.locked} fallback={<span class="skill-locked" aria-label="Always on"><i class="fa-solid fa-lock" aria-hidden="true" /> Always on</span>}><input type="checkbox" role="switch" aria-label={`Enable ${row.name}`} checked={row.enabled} disabled={!!busy() || row.disabledByAdmin} onChange={(event) => void toggle(row, event.currentTarget.checked)} /></Show></Show>
    <Show when={row.kind === "user" && (row.canWrite || row.canManage)}><details class="skill-actions" open={openActions() === row.id} onClick={(event) => { if ((event.target as HTMLElement).closest("button")) setOpenActions(undefined); }}><summary role="button" aria-label={`Actions for ${row.name}`} aria-expanded={openActions() === row.id} onClick={(event) => { event.preventDefault(); setOpenActions(openActions() === row.id ? undefined : row.id); }}><i class="fa-solid fa-ellipsis" aria-hidden="true" /></summary><div class="skill-action-menu">
    <Show when={row.canWrite && row.kind === "user"}><button aria-label={`Replace ${row.name}`} onClick={() => setChoosingReplacement(row)}>Replace</button></Show>
    <Show when={row.canManage && capabilities.multiUser}><button aria-label={`Manage access for ${row.name}`} onClick={() => setManaging(row)}>Manage access</button></Show>
    <Show when={row.canWrite && row.kind === "user"}><button aria-label={`Versions of ${row.name}`} onClick={() => setVersions(row)}>Versions</button></Show>
    <Show when={row.canManage}><button aria-label={`Delete ${row.name}`} onClick={() => { setError(""); setDeleting(row); }}>Delete</button></Show>
    </div></details></Show>
  </li>}</For></ul></section>;
  return <main class="skills-page"><Show when={params.id}><A href="/skills">← Skills</A></Show><h1>{params.id ? detailData()?.name ?? "Skill" : "Skills"}</h1>
    <Show when={!params.id}>
    <div class="skills-add-control"><Button onClick={() => setAdding(!adding())} disabled={!!busy()} aria-expanded={adding()}>Add skill <i class="fa-solid fa-chevron-down" aria-hidden="true" /></Button>
    <Show when={adding()}><div class="skills-add"><button onClick={() => { setAdding(false); setReplaceTarget(undefined); zipInput?.click(); }}>Upload zip</button><button onClick={() => { setAdding(false); setReplaceTarget(undefined); folderInput?.click(); }}>Upload folder</button><button disabled={busy() === "create"} onClick={() => void createSkill()}>Create skill</button><button onClick={() => { setAdding(false); setImporting(true); }}>Import from Claude or ChatGPT</button></div></Show>
    </div></Show>
    <input ref={zipInput} aria-label="Skill zip file" type="file" accept=".zip" hidden onChange={(event) => selected(event, false)} />
    <input ref={(element) => { folderInput = element; element.setAttribute("webkitdirectory", ""); }} aria-label="Skill folder files" type="file" multiple hidden onChange={(event) => selected(event, true)} />
    <Show when={replacement()}>{(item) => <ConfirmDialog title="Replace existing skill" description="Replace the content of your skill? Sharing and enable settings will be kept, and the current content saved in version history." confirmLabel="Replace" error={error()} onCancel={() => setReplacement(undefined)} onConfirm={() => upload(item().files, item().folder, item().id)} />}</Show>
    <Show when={choosingReplacement()}>{(row) => <Modal title={`Replace ${row().name}`} onClose={() => setChoosingReplacement(undefined)}><p>Upload a replacement with the same skill name. Sharing and enable settings stay the same.</p><Button onClick={() => { setReplaceTarget(row().id); setChoosingReplacement(undefined); zipInput?.click(); }}>Replace from zip</Button><Button onClick={() => { setReplaceTarget(row().id); setChoosingReplacement(undefined); folderInput?.click(); }}>Replace from folder</Button></Modal>}</Show>
    <Show when={managing()}>{(row) => <DashboardAccessDialog dashboard={{ id: row().id, title: row().name, shares: row().shares }} loadRecipients={fetchSkillRecipients} saveShares={saveSkillShares} platformReadOnly note="People can enable this skill on their own turns. Editors can update its content; only you control sharing and deletion." onClose={() => setManaging(undefined)} onSaved={async () => { await refetch(); }} />}</Show>
    <Show when={importing()}><SkillImportDialog onClose={() => setImporting(false)} /></Show>
    <Show when={createAgents()}>{(agents) => <Modal title="Create skill: choose an agent" onClose={() => setCreateAgents(undefined)} footer={<Button onClick={() => setCreateAgents(undefined)}>Cancel</Button>}><p>Who do you want to create this skill with?</p><For each={agents()} fallback={<p>No agents with skill support are available. Ask your operator to add a Pi agent, or upload or import a skill instead.</p>}>{(agent) => <Button onClick={() => createChat(agent.id)}>{agent.name}</Button>}</For></Modal>}</Show>
    <Show when={versions()}>{(row) => <SkillVersionsDialog skill={row()} onClose={() => setVersions(undefined)} onRestored={async () => { await refetch(); }} />}</Show>
    <Show when={deleting()}>{(row) => <ConfirmDialog title="Delete skill" description={`Delete ${row().name}, its saved versions and all shares? This cannot be undone.`} confirmLabel="Delete" danger error={error()} onCancel={() => setDeleting(undefined)} onConfirm={async () => { try { await deleteSkill(row().id); setDeleting(undefined); if (params.id) navigate("/skills"); else await refetch(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to delete skill."); } }} />}</Show>
    <Show when={!params.id}><input type="search" aria-label="Search skills" placeholder="Search skills" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></Show>
    <Show when={skills.error || detail.error || error()}><p role="alert">{error() || "Unable to load skills."}<button onClick={() => void refetch()}>Retry</button></p></Show>
    <Show when={skills.state === "pending" || detail.state === "pending"}><p role="status">Loading skills…</p></Show>
    <Show when={params.id ? detailData() : undefined}>{(row) => <>{group("Skill", [row()])}<section aria-label="Skill instructions" class="skill-instructions" innerHTML={renderMarkdown(row().skillMd, { stripFrontmatter: false })} /><section><h2>Files</h2><ul class="skills-list"><For each={row().files}>{(file) => <li>{file.path} <small>{file.size} bytes</small></li>}</For></ul></section></>}</Show>
    <Show when={!params.id}>
    {group("Mine", listData()?.mine)}<Show when={capabilities.multiUser}>{group("Shared with me", listData()?.sharedWithMe)}</Show>{group("Agent skills", listData()?.agent)}
    </Show>
    <style>{`
      .skills-page { flex: 1; min-width: 0; overflow: auto; padding: 32px; color: var(--text-primary); }
      .skills-page h1 { font-size: 24px; margin: 0 0 24px; }
      .skills-page section { margin-top: 32px; }
      .skills-page h2 { font-size: 18px; margin: 0 0 12px; }
      .skills-page input[type=search] { width: min(100%, 480px); padding: 10px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-surface); color: var(--text-primary); font: inherit; }
      .skills-add-control { position: relative; display: inline-block; margin: 0 12px 12px 0; vertical-align: top; }
      .skills-add, .skill-action-menu { position: absolute; z-index: 10; min-width: 220px; padding: 6px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-surface); box-shadow: 0 8px 24px var(--shadow-md); }
      .skills-add { top: calc(100% + 4px); left: 0; }
      .skills-add button, .skill-action-menu button { display: block; width: 100%; padding: 9px 10px; border: 0; border-radius: 5px; background: transparent; color: var(--text-primary); font: inherit; text-align: left; cursor: pointer; }
      .skills-add button:hover, .skill-action-menu button:hover { background: var(--bg-raised); }
      .skills-list { list-style: none; margin: 0; padding: 0 16px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-surface); }
      .skills-list > li { padding: 16px 0; }
      .skill-row { display: flex; align-items: center; gap: 16px; border-bottom: 1px solid var(--border-subtle); }
      .skill-row:last-child { border-bottom: 0; }
      .skill-copy { flex: 1; min-width: 0; }
      .skill-copy a { font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; text-decoration: none; }
      .skill-copy a:hover { text-decoration: underline; }
      .skill-copy p { margin: 6px 0; color: var(--text-secondary); overflow-wrap: anywhere; }
      .skill-copy small, .skill-locked { color: var(--text-tertiary); font-size: 12px; }
      .skill-pill { display: inline-block; padding: 2px 7px; margin-left: 6px; border-radius: 20px; border: 1px solid var(--border-subtle); color: var(--text-secondary); }
      .skill-actions { position: relative; }
      .skill-actions summary { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 6px; cursor: pointer; list-style: none; color: var(--text-secondary); }
      .skill-actions summary::-webkit-details-marker { display: none; }
      .skill-actions summary:hover { background: var(--bg-raised); }
      .skill-action-menu { right: 0; top: calc(100% + 4px); }
      .skill-row input[role=switch] { appearance: none; position: relative; flex: none; width: 36px; height: 21px; margin: 0; border: 1px solid var(--border-default); border-radius: 20px; background: var(--bg-raised); cursor: pointer; }
      .skill-row input[role=switch]::before { content: ''; position: absolute; width: 15px; height: 15px; left: 2px; top: 2px; border-radius: 50%; background: var(--text-tertiary); transition: transform 120ms; }
      .skill-row input[role=switch]:checked { background: var(--accent, #3b82f6); border-color: transparent; }
      .skill-row input[role=switch]:checked::before { background: white; transform: translateX(15px); }
      .skill-row input[role=switch]:disabled { opacity: .5; cursor: default; }
      .skills-page button:focus-visible, .skill-actions summary:focus-visible, .skill-row input:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 3px; }
      .skill-instructions { padding: 24px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-surface); line-height: 1.6; overflow-wrap: anywhere; }
      .skill-instructions pre { overflow: auto; padding: 12px; background: var(--bg-raised); border-radius: 6px; }
      .skill-instructions img { max-width: 100%; }
      @media (max-width: 600px) { .skills-page { padding: 20px 16px; } .skill-row { gap: 10px; } .skill-locked { max-width: 56px; } .skills-page input[type=search] { width: 100%; box-sizing: border-box; } }
    `}</style>
  </main>;
}
