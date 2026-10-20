import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { fetchAgents } from "../api/agents";
import { deleteDashboard, fetchDashboards, setDashboardPinned, type DashboardRow } from "../api/dashboards";
import { DashboardAccessDialog } from "../components/DashboardAccessDialog";
import { DashboardListRow } from "../components/DashboardListRow";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";

export function Dashboards() {
  const [dashboards, { refetch }] = createResource(fetchDashboards);
  const [agents] = createResource(() => fetchAgents().catch(() => []));
  const avatarOf = (agentId: string) => agents()?.find((agent) => agent.id === agentId)?.avatar;
  const [managing, setManaging] = createSignal<DashboardRow>();
  const [deleting, setDeleting] = createSignal<DashboardRow>();
  const [deleteError, setDeleteError] = createSignal<string>();
  const [pinError, setPinError] = createSignal<string>();
  const [pendingPins, setPendingPins] = createSignal(new Set<string>());
  const [pinOverrides, setPinOverrides] = createSignal(new Map<string, boolean>());
  const data = createMemo(() => {
    const current = dashboards.error ? undefined : dashboards();
    if (!current) return undefined;
    const applyPins = (rows: DashboardRow[]) => rows.map((row) => pinOverrides().has(row.id)
      ? { ...row, pinned: pinOverrides().get(row.id) } : row);
    return { owned: applyPins(current.owned), shared: applyPins(current.shared) };
  });
  const pinned = createMemo(() => [...data()?.owned ?? [], ...data()?.shared ?? []].filter((row) => row.pinned));
  const shared = createMemo(() => (data()?.shared ?? []).filter((row) => !row.pinned));
  const updatePinned = (id: string, pinned: boolean) => setPinOverrides((current) => new Map(current).set(id, pinned));
  const togglePin = async (dashboard: DashboardRow) => {
    if (pendingPins().has(dashboard.id)) return;
    const previous = !!dashboard.pinned;
    setPinError(undefined);
    setPendingPins((ids) => new Set([...ids, dashboard.id]));
    updatePinned(dashboard.id, !previous);
    try {
      const result = await setDashboardPinned(dashboard.id, !previous);
      updatePinned(dashboard.id, result.pinned);
    } catch (cause) {
      updatePinned(dashboard.id, previous);
      setPinError(cause instanceof Error ? cause.message : "Unable to update pin. Try again.");
    } finally {
      setPendingPins((ids) => { const next = new Set(ids); next.delete(dashboard.id); return next; });
    }
  };
  const groups = createMemo(() => {
    const result = new Map<string, { id: string; name: string; rows: DashboardRow[] }>();
    for (const row of data()?.owned ?? []) {
      if (row.pinned) continue;
      const group = result.get(row.agentId) ?? { id: row.agentId, name: row.agentName, rows: [] };
      group.rows.push(row);
      result.set(row.agentId, group);
    }
    return [...result.values()];
  });
  const row = (dashboard: DashboardRow, showAgent = false) => (
    <li><DashboardListRow dashboard={dashboard} onManage={() => setManaging(dashboard)}
      showAgent={showAgent} reserveDelete onPin={() => void togglePin(dashboard)} pinPending={pendingPins().has(dashboard.id)}
      onDelete={() => { setDeleteError(undefined); setDeleting(dashboard); }} /></li>
  );
  return (
    <main class="dashboards-page">
      <h1>Dashboards</h1>
      <Show when={dashboards.error}><p role="alert">Unable to load dashboards. <button onClick={() => window.location.reload()}>Retry</button></p></Show>
      <Show when={dashboards.loading}><p>Loading dashboards…</p></Show>
      <Show when={pinError()}>{(error) => <p role="alert">{error()}</p>}</Show>
      <Show when={pinned().length > 0}>
        <section><h2>Pinned</h2><ul class="dashboards-list"><For each={pinned()}>{(dashboard) => row(dashboard, true)}</For></ul></section>
      </Show>
      <Show when={!data()?.owned.length || groups().length > 0}><section><h2>My dashboards</h2>
        <For each={groups()} fallback={<Show when={!dashboards.loading && !dashboards.error}><p>You do not own any dashboards yet.</p></Show>}>{(group) => (
          <section class="dashboards-group">
            <h3>
              <span class="dashboards-group__avatar" aria-hidden="true">
                <Show when={avatarOf(group.id)} fallback={group.name.slice(0, 1).toUpperCase()}>
                  {(avatar) => <Show when={avatar().startsWith("/") || /^https?:\/\//i.test(avatar())} fallback={avatar()}><img src={avatar()} alt="" /></Show>}
                </Show>
              </span>
              {group.name}
            </h3>
            <ul class="dashboards-list"><For each={group.rows}>{(dashboard) => row(dashboard)}</For></ul>
          </section>
        )}</For>
      </section></Show>
      <Show when={managing()}>{(dashboard) => <DashboardAccessDialog dashboard={dashboard()} onClose={() => setManaging(undefined)} onSaved={async () => { await refetch(); }} />}</Show>
      <Show when={deleting()}>{(dashboard) => <ConfirmDialog title="Delete dashboard" description={`Delete ${dashboard().title} and its published HTML and history? Shared databases are retained.`} confirmLabel="Delete" danger error={deleteError()} onCancel={() => setDeleting(undefined)} onConfirm={async () => {
        try { await deleteDashboard(dashboard().id); await refetch(); setDeleting(undefined); }
        catch (cause) { setDeleteError(cause instanceof Error ? cause.message : "Unable to delete dashboard."); }
      }} />}</Show>
      <Show when={!data()?.shared.length || shared().length > 0}><section><h2>Shared with me</h2>
        <ul class="dashboards-list"><For each={shared()} fallback={<Show when={!dashboards.loading && !dashboards.error}><li>No dashboards have been shared with you.</li></Show>}>{(dashboard) => row(dashboard, true)}</For></ul>
      </section></Show>
      <style>{`
        .dashboards-page { flex: 1; min-width: 0; overflow: auto; padding: 32px; color: var(--text-primary); }
        .dashboards-page > section { margin-top: 48px; }
        .dashboards-page h1 { font-size: 24px; }
        .dashboards-page h2 { margin: 0 0 16px; font-size: 19px; }
        .dashboards-group + .dashboards-group { margin-top: 24px; }
        .dashboards-page h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
        .dashboards-group__avatar { display: inline-grid; place-items: center; width: 20px; height: 20px; flex-shrink: 0; overflow: hidden; border-radius: 999px; background: var(--accent-bg, rgba(59, 130, 246, 0.14)); color: var(--accent, #3b82f6); font-size: 11px; font-weight: 700; }
        .dashboards-group__avatar img { width: 100%; height: 100%; object-fit: cover; }
        .dashboards-page ul { list-style: none; padding: 0; margin: 0; }
        .dashboards-page .dashboards-list { padding: 0 16px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-surface); }
        .dashboards-list > li:last-child .dashboard-list-row { border-bottom: 0; }
        .dashboards-list > li:only-child:not(:has(.dashboard-list-row)) { padding: 12px 0; color: var(--text-secondary); }
      `}</style>
    </main>
  );
}
