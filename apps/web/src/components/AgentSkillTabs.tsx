import { For, Show, createResource, type JSX } from "solid-js";
import { fetchAgents } from "../api/agents";
import type { SkillRow } from "../api/skills";

// One tab per agent that owns workspace skills. The caller keeps the selected tab and renders each row as an <li>.
export function AgentSkillTabs(props: { rows: SkillRow[]; selected: string | undefined; onSelect: (agentId: string) => void; renderRow: (row: SkillRow) => JSX.Element }) {
  const [agents] = createResource(() => fetchAgents().catch(() => []));
  const avatarOf = (agentId: string) => agents.latest?.find((agent) => agent.id === agentId)?.avatar;
  const agentTabs = () => {
    const tabs = new Map<string, { id: string; name: string; count: number }>();
    for (const row of props.rows) {
      const id = row.agentId ?? "";
      const tab = tabs.get(id) ?? { id, name: row.agentName ?? id, count: 0 };
      tab.count += 1; tabs.set(id, tab);
    }
    return [...tabs.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const activeAgent = () => agentTabs().find((tab) => tab.id === props.selected)?.id ?? agentTabs()[0]?.id;
  const moveTab = (event: KeyboardEvent) => {
    const tabs = agentTabs(); const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step || !tabs.length) return;
    event.preventDefault();
    const next = tabs[(tabs.findIndex((tab) => tab.id === activeAgent()) + step + tabs.length) % tabs.length];
    props.onSelect(next.id);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-agent="${CSS.escape(next.id)}"]`)?.focus();
  };
  return <>
    <div class="skills-tabs" role="tablist" aria-label="Agents" onKeyDown={moveTab}><For each={agentTabs()}>{(tab) => <button type="button" role="tab" class="skills-tab" data-agent={tab.id} aria-selected={activeAgent() === tab.id} tabindex={activeAgent() === tab.id ? 0 : -1} onClick={() => props.onSelect(tab.id)}>
      <span class="skills-tab-avatar" aria-hidden="true"><Show when={avatarOf(tab.id)} fallback={tab.name.slice(0, 1).toUpperCase()}>{(avatar) => <Show when={avatar().startsWith("/") || /^https?:\/\//i.test(avatar())} fallback={avatar()}><img src={avatar()} alt="" /></Show>}</Show></span>
      {tab.name}<span class="skills-tab-count">{tab.count}</span></button>}</For></div>
    <div role="tabpanel" aria-label={agentTabs().find((tab) => tab.id === activeAgent())?.name}><ul class="skills-list"><For each={props.rows.filter((row) => (row.agentId ?? "") === activeAgent())}>{props.renderRow}</For></ul></div>
    <style>{`
      .skills-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 12px; box-shadow: inset 0 -1px 0 var(--border-subtle); }
      .skills-tab { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; padding: 8px 12px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--text-secondary); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; white-space: nowrap; transition: color 120ms, border-color 120ms; }
      .skills-tab:hover { color: var(--text-primary); }
      .skills-tab:focus-visible { outline: 2px solid var(--accent, #3b82f6); outline-offset: 2px; }
      .skills-tab[aria-selected=true] { border-bottom-color: var(--accent, #3b82f6); color: var(--text-primary); }
      .skills-tab-avatar { display: inline-grid; place-items: center; width: 22px; height: 22px; overflow: hidden; border-radius: 999px; background: var(--bg-raised); color: var(--text-secondary); font-size: 12px; font-weight: 700; }
      .skills-tab-avatar img { width: 100%; height: 100%; object-fit: cover; }
      .skills-tab-count { color: var(--text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
      .skills-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border-default); border-radius: 12px; background: var(--bg-surface); }
      .skills-list > li { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
      .skills-list > li:last-child { border-bottom: 0; }
    `}</style>
  </>;
}
