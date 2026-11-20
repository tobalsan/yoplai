import { For, Show, createComputed, createMemo, createResource, createSignal, onCleanup, type JSX } from "solid-js";
import type { ReleaseCatalogRow, ReleaseCatalogView } from "@yoplai/shared";
import { changeReleaseCatalog, fetchReleaseCatalog, releaseCatalogChanged } from "../../api/release-catalog";
import { gatewayKey, type GatewayName } from "../../api/gateway";
import { createResourceKey } from "../../lib/resource-key";

const badge = (entry: ReleaseCatalogRow) => ({ available: "Available", installed: "Installed", update: "Update available",
  manual: "Managed by hand", incompatible: `Needs Yoplai ${entry.minYoplai}` })[entry.state];
const label = (entry: ReleaseCatalogRow) => entry.name ?? entry.id;
const usage = (entry: ReleaseCatalogRow) => `Used by ${entry.usedByAgents} ${entry.usedByAgents === 1 ? "agent" : "agents"}`;

export function ReleaseCatalog(props: {
  gateway: GatewayName; ready: boolean; canWrite: boolean; icon: (url?: string) => JSX.Element; onChange: () => void;
}) {
  const [catalog, { refetch, mutate }] = createResource(
    createResourceKey(() => props.ready ? { gateway: props.gateway } : null),
    async ({ gateway }, info): Promise<{ key: string; data: ReleaseCatalogView | undefined }> => ({ key: gatewayKey(gateway), data: await fetchReleaseCatalog(gateway, info.refetching === "refresh") }),
  );
  const data = createMemo(() => {
    if (!props.ready || catalog.error) return undefined;
    const snapshot = catalog.latest;
    return snapshot?.key === gatewayKey(props.gateway) ? snapshot.data : undefined;
  });
  const [search, setSearch] = createSignal("");
  const [category, setCategory] = createSignal<string>();
  const [selected, setSelected] = createSignal<string>();
  const [confirm, setConfirm] = createSignal<string>();
  const [pending, setPending] = createSignal<Record<string, boolean>>({});
  const [errors, setErrors] = createSignal<Record<string, string | undefined>>({});
  let visit = 0;
  createComputed(() => {
    void [props.gateway, props.ready];
    visit++;
    setSelected(undefined);
    setConfirm(undefined);
    setCategory(undefined);
    setPending({});
    setErrors({});
  });
  onCleanup(() => { visit++; });
  const categories = createMemo(() => Array.from(new Set(data()?.entries.flatMap((entry) => entry.category ? [entry.category] : []))).sort());
  const entries = createMemo(() => data()?.entries.filter((entry) =>
    (!category() || entry.category === category()) &&
    [entry.id, entry.name, entry.tagline].some((text) => text?.toLowerCase().includes(search().trim().toLowerCase()))) ?? []);
  async function change(item: ReleaseCatalogRow, remove: boolean) {
    if (!props.ready || !props.canWrite || pending()[item.id]) return;
    const gateway = props.gateway;
    const mine = visit;
    setConfirm(undefined);
    setPending((all) => ({ ...all, [item.id]: true }));
    setErrors((all) => ({ ...all, [item.id]: undefined }));
    try {
      const entry = await changeReleaseCatalog(gateway, item.id, remove);
      window.dispatchEvent(new CustomEvent(releaseCatalogChanged, { detail: gateway }));
      if (mine !== visit) return;
      const previous = data();
      if (previous && entry) mutate({ key: gatewayKey(gateway), data: { ...previous, entries: previous.entries.map((old) => old.id === entry.id ? entry : old) } });
      props.onChange();
      await refetch();
    } catch (error) {
      if (mine === visit) setErrors((all) => ({ ...all, [item.id]: error instanceof Error ? error.message : "The extension operation failed." }));
    } finally {
      if (mine === visit) setPending((all) => ({ ...all, [item.id]: false }));
    }
  }

  return <Show when={props.ready && (data() || catalog.error)}>
    <section aria-label="Catalog" class="release-catalog">
      <h2 class="top-heading">Catalog</h2>
      <Show when={catalog.error || data()?.stale}>
        <p role="status">{catalog.error instanceof Error ? catalog.error.message : data()?.fetchedAt
          ? `Catalog not reachable. Showing the copy from ${new Date(data()!.fetchedAt!).toLocaleString()}.` : "Catalog not reachable."}{" "}
          <button type="button" disabled={catalog.loading} onClick={() => void refetch(props.canWrite ? "refresh" : true)}>Retry</button>
        </p>
      </Show>
      <Show when={data()}>
        <div class="release-catalog-filters">
          <label>Search the catalog <input type="search" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} /></label>
          <Show when={props.canWrite}><button type="button" disabled={catalog.loading} onClick={() => void refetch("refresh")}>Refresh</button></Show>
        </div>
        <div class="release-catalog-filters" aria-label="Categories" role="group">
          <button type="button" aria-pressed={!category()} onClick={() => setCategory(undefined)}>All categories</button>
          <For each={categories()}>{(name) => <button type="button" aria-pressed={category() === name} onClick={() => setCategory(name)}>{name}</button>}</For>
        </div>
        <div class="top-panel">
          <For each={entries()} fallback={<p class="top-empty">No extensions match.</p>}>{(entry) => (
            <article class="release-catalog-row" aria-label={label(entry)}>
              <div class="top-row">
                {props.icon(entry.iconUrl)}
                <div class="top-info">
                  <button type="button" class="release-catalog-title" aria-expanded={selected() === entry.id}
                    onClick={() => setSelected(selected() === entry.id ? undefined : entry.id)}>{label(entry)}</button>
                  <span class="top-sub">{entry.tagline}</span>
                  <span class="top-sub">{[entry.category, entry.version ?? entry.installedVersion].filter(Boolean).join(" · ")}</span>
                </div>
                <span class="release-catalog-badge">{badge(entry)}</span>
                <Show when={props.canWrite}>
                  <Show when={entry.state === "available" || entry.state === "update"}>
                    <button type="button" disabled={pending()[entry.id]} onClick={() => void change(entry, false)}>{entry.state === "update" ? "Update" : "Install"}</button>
                  </Show>
                  <Show when={entry.installedVersion && entry.state !== "manual"}>
                    <button type="button" disabled={pending()[entry.id]} onClick={() => setConfirm(entry.id)}>Remove</button>
                  </Show>
                </Show>
              </div>
              <Show when={selected() === entry.id}>
                <div class="release-catalog-detail">
                  <p>{entry.description}</p>
                  <p>{usage(entry)}</p>
                  <Show when={entry.docsUrl && /^https?:\/\//i.test(entry.docsUrl)}><a href={entry.docsUrl} target="_blank" rel="noreferrer">Documentation</a></Show>
                </div>
              </Show>
              <Show when={confirm() === entry.id}>
                <div class="release-catalog-detail" role="group" aria-label={`Remove ${label(entry)}`}>
                  <p>{usage(entry)}. Remove {label(entry)}?</p>
                  <button type="button" onClick={() => void change(entry, true)}>Confirm removal</button>{" "}
                  <button type="button" onClick={() => setConfirm(undefined)}>Cancel</button>
                </div>
              </Show>
              <Show when={pending()[entry.id]}><p class="release-catalog-detail" role="status">Operation in progress.</p></Show>
              <Show when={errors()[entry.id]}><p class="release-catalog-detail top-error" role="alert">{errors()[entry.id]}</p></Show>
            </article>
          )}</For>
        </div>
      </Show>
    </section>
    <style>{`
      .release-catalog-filters { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:10px 0; }
      .release-catalog button[aria-pressed="true"] { background:var(--accent); color:white; }
      .release-catalog-row + .release-catalog-row { border-top:1px solid var(--border-default); }
      .release-catalog-title { align-self:start; border:0; padding:0; background:none; color:var(--text-primary); font-weight:600; cursor:pointer; }
      .release-catalog-badge { border:1px solid var(--border-default); border-radius:12px; padding:3px 8px; }
      .release-catalog-detail { padding:0 18px 12px; }
      @media (max-width:600px) { .release-catalog .top-row { flex-wrap:wrap; } }
    `}</style>
  </Show>;
}
