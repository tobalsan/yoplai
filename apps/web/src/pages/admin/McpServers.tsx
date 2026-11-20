import { For, Show, createComputed, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import {
  addMcpCatalogServer,
  fetchMcpCatalog,
  mcpDisplayName,
  removeMcpCatalogServer,
  iconRefreshOutcome,
  refreshMcpCatalogIcon,
  updateMcpCatalogServer,
  type McpCatalogServer,
} from "../../api/mcp-servers";
import AdminLayout from "./AdminLayout";
import { McpIcon } from "../../components/McpExtensionCard";
import { gatewayKey } from "../../api/gateway";
import { missingGatewayText, useGatewayChoice } from "../../lib/gateway-choice";
import { RequesterFailure } from "../../lib/page-visit";
import { useRequester } from "../../lib/requester";
import { createResourceKey } from "../../lib/resource-key";
import { GatewaySelect } from "../../components/GatewaySelect";

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

export default function AdminMcpServersPage() {
  // The explicit gateway choice. A gateway that is not configured makes no call and never means Local.
  const choice = useGatewayChoice();
  const gateway = choice.gateway;
  // The remote requester decides what the page offers. The local session and role never apply to a gateway.
  const requester = useRequester(gateway);
  // Local keeps its old behavior: the gateway refuses what the role may not do. A gateway is read-only
  // until its requester is known, and a remote multi-user gateway allows only its superadmin.
  const canWrite = () => gateway() === undefined || (requester().ready && !requester().unknown && (!requester().multiUser || requester().isSuperadmin));
  // The catalog needs the mcp extension on the gateway. A failed capability read is not "not installed".
  const capabilityKnown = () => choice.ready() && requester().ready && !requester().unknown;
  const mcpOn = () => capabilityKnown() && requester().isExtensionEnabled("mcp");
  const mcpOff = () => capabilityKnown() && !requester().isExtensionEnabled("mcp");
  const [result, { mutate, refetch }] = createResource(
    createResourceKey(() => (mcpOn() ? { gateway: gateway() } : null)),
    async (key): Promise<{ key: string; servers: McpCatalogServer[] }> => ({ key: gatewayKey(key.gateway), servers: await fetchMcpCatalog(key.gateway) })
  );
  // The catalog of another gateway is never current data. Server names repeat across gateways.
  const servers = createMemo<McpCatalogServer[] | undefined>(() => {
    if (result.error || !choice.ready()) return undefined;
    // `latest` keeps the last data while a read runs, and it does not suspend the page.
    const value = result.latest;
    return value?.key === gatewayKey(gateway()) ? value.servers : undefined;
  });
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [editing, setEditing] = createSignal<string>();
  const [editName, setEditName] = createSignal("");
  const [editDescription, setEditDescription] = createSignal("");
  const [confirming, setConfirming] = createSignal<string>();
  const [iconResults, setIconResults] = createSignal<Record<string, { busy?: boolean; message?: string; error?: string }>>({});
  // After an uncertain write error the list read failed too. Another write stays off until a read works.
  const [listUnknown, setListUnknown] = createSignal(false);
  // Each visit to a gateway has its own number. An answer of an older visit, also one of the same gateway,
  // changes nothing. The page closing ends the visit too. A visit change also drops the forms and the open
  // dialogs, so no draft or confirmation reaches another gateway.
  let visit = 0;
  const iconAttempts = new Map<string, number>();
  createComputed(() => {
    void choice.chosen();
    void gateway();
    visit++;
    iconAttempts.clear();
    setError(undefined);
    setBusy(false);
    setUrl("");
    setName("");
    setDescription("");
    setEditing(undefined);
    setConfirming(undefined);
    setIconResults({});
    setListUnknown(false);
  });
  onCleanup(() => { visit++; });

  /** Reads the list of the exact gateway again. A failed read keeps the unknown state. */
  const settleList = async (live: () => boolean) => {
    if (!live()) return;
    try { await refetch(); } catch { /* The error state of the resource tells the result. */ }
    if (live()) setListUnknown(Boolean(result.error));
  };
  const retryRead = async () => {
    const mine = visit;
    const live = () => visit === mine;
    setBusy(true);
    await settleList(live);
    if (live()) setBusy(false);
  };

  const refreshIcon = async (server: McpCatalogServer) => {
    if (!canWrite() || !choice.ready()) return;
    const host = gateway();
    const mine = visit;
    const key = server.name;
    const attempt = (iconAttempts.get(key) ?? 0) + 1;
    iconAttempts.set(key, attempt);
    const live = () => visit === mine && iconAttempts.get(key) === attempt;
    setIconResults((results) => ({ ...results, [key]: { busy: true } }));
    try {
      const outcome = await refreshMcpCatalogIcon(key, host);
      if (!live()) return;
      mutate((value) => value && value.key === gatewayKey(host) ? { ...value, servers: value.servers.map((item) => item.name === key ? { ...item, iconUrl: outcome.server.iconUrl } : item) } : value);
      setIconResults((results) => ({ ...results, [key]: iconRefreshOutcome(outcome, "This server needs sign-in; its own icon is captured the next time an agent connects.") }));
    } catch (cause) {
      // Any failed answer leaves the outcome uncertain: the browser deadline, the relay answer
      // `502 gateway_offline` after its own 30 second deadline, and a refusal that follows a commit all look alike.
      // The page reads the same catalog before another change, and keeps the catalog controls off during that read.
      if (attempt === iconAttempts.get(key) && visit === mine) setIconResults((results) => ({ ...results, [key]: { error: message(cause, "Failed to refresh MCP server icon.") } }));
      if (visit !== mine) return;
      setBusy(true);
      await settleList(() => visit === mine);
      if (visit === mine) setBusy(false);
    }
  };

  /** Runs one write for the gateway that is shown now. `uncertain` writes read the list again after an error. */
  async function run(action: (host: string | undefined, live: () => boolean) => Promise<void>, fallback: string, uncertain = true) {
    if (!choice.ready() || !canWrite() || listUnknown()) return;
    const host = gateway();
    const mine = visit;
    const live = () => visit === mine;
    setBusy(true);
    setError(undefined);
    let failed = false;
    try { await action(host, live); }
    catch (cause) { failed = true; if (live()) setError(message(cause, fallback)); }
    // The remote can apply a write before its answer fails, so the list settles before another write.
    if (failed && uncertain) await settleList(live);
    if (live()) setBusy(false);
  }

  const add = (event: Event) => {
    event.preventDefault();
    void run(async (host, live) => {
      await addMcpCatalogServer({ url: url().trim(), displayName: name(), description: description() }, host);
      if (!live()) return;
      setUrl(""); setName(""); setDescription("");
      await refetch();
    }, "Failed to add MCP server.");
  };
  const startEdit = (server: McpCatalogServer) => {
    setEditing(server.name);
    setEditName(server.displayName ?? "");
    setEditDescription(server.description ?? "");
  };
  const saveEdit = (server: McpCatalogServer) => run(async (host, live) => {
    const saved = await updateMcpCatalogServer(server.name, { displayName: editName(), description: editDescription() }, host);
    if (!live()) return;
    mutate((value) => value && value.key === gatewayKey(host) ? { ...value, servers: value.servers.map((item) => (item.name === server.name ? { ...item, displayName: saved.displayName, description: saved.description } : item)) } : value);
    setEditing(undefined);
  }, "Failed to save MCP server.");
  const remove = (server: McpCatalogServer) => run(async (host, live) => {
    await removeMcpCatalogServer(server.name, host);
    if (!live()) return;
    mutate((value) => value && value.key === gatewayKey(host) ? { ...value, servers: value.servers.filter((item) => item.name !== server.name) } : value);
    setConfirming(undefined);
  }, "Failed to remove MCP server.");

  const missing = () => { const selection = choice.selection(); return selection.state === "missing" ? selection : undefined; };
  const writeOff = () => busy() || !canWrite() || listUnknown();

  return (
    <AdminLayout
      title="MCP servers"
      gateway={gateway()}
      description="Shared remote MCP servers every agent can enable from its extensions page. Users connect their own account; nothing is connected here."
    >
      <GatewaySelect value={choice.chosen()} names={choice.names()} onChange={choice.choose} />
      <Show when={missing()}>{(selection) => <p class="mcps-error" role="alert">{missingGatewayText(selection())}</p>}</Show>
      <Show when={gateway() !== undefined && requester().ready && requester().unknown}>
        <RequesterFailure requester={requester} class="mcps-error">Could not read your permissions on {gateway()}. The controls stay off.</RequesterFailure>
      </Show>
      <Show when={gateway() !== undefined && requester().ready && !requester().unknown && requester().multiUser && !requester().isSuperadmin}>
        <p class="mcps-empty" role="status">Only the superadmin of {gateway()} can change this catalog.</p>
      </Show>
      <Show when={mcpOff()}>
        <p class="mcps-empty" role="status">The MCP extension is not installed on this gateway.</p>
      </Show>
      <Show when={mcpOn()}>
      <form class="mcps-add" onSubmit={add}>
        <input type="url" required aria-label="Server URL" placeholder="https://mcp.example.com/mcp" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} />
        <input type="text" maxLength={100} aria-label="Name (optional)" placeholder="Display name, e.g. Atlassian" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        <input type="text" maxLength={500} aria-label="Description (optional)" placeholder="What this server gives agents access to" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
        <button type="submit" disabled={writeOff() || !choice.ready()}>Add server</button>
      </form>
      </Show>
      <Show when={error()}>{(text) => <p class="mcps-error" role="alert">{text()}</p>}</Show>
      <Show when={listUnknown()}>
        <p class="mcps-error" role="alert">The server list could not be read after the error, and the change may have happened. Read the list before you change it again. <button type="button" disabled={busy()} onClick={() => void retryRead()}>Read list</button></p>
      </Show>
      <Show when={choice.ready() && result.error}><p class="mcps-error" role="alert">{message(result.error, "Failed to load MCP servers.")}</p></Show>
      <div>
        <Show when={servers()} fallback={<Show when={choice.selection().state === "loading" || (choice.ready() && result.loading)}><div class="mcps-empty">Loading…</div></Show>}>
          {(list) => (
            <Show when={list().length > 0} fallback={<div class="mcps-empty">No shared MCP servers yet.</div>}>
              <div class="mcps-grid">
              <For each={list()}>
                {(server) => (
                  <div class="mcps-row" data-server={server.name}>
                    <McpIcon src={server.iconUrl} />
                    <div class="mcps-info">
                      <Show when={editing() === server.name} fallback={
                        <>
                          <span class="mcps-name">{mcpDisplayName(server.name, server.displayName)}</span>
                          <span class="mcps-sub">{server.url}</span>
                          <Show when={server.description}>{(text) => <span class="mcps-sub">{text()}</span>}</Show>
                        </>
                      }>
                        <input type="text" maxLength={100} aria-label={`Name for ${server.name}`} placeholder="Display name, e.g. Atlassian" value={editName()} onInput={(event) => setEditName(event.currentTarget.value)} />
                        <input type="text" maxLength={500} aria-label={`Description for ${server.name}`} placeholder="What this server gives agents access to" value={editDescription()} onInput={(event) => setEditDescription(event.currentTarget.value)} />
                      </Show>
                    </div>
                    <div class="mcps-actions">
                      <Show when={confirming() === server.name} fallback={
                        <Show when={editing() === server.name} fallback={
                          <>
                            <button type="button" disabled={writeOff() || iconResults()[server.name]?.busy} onClick={() => void refreshIcon(server)}>{iconResults()[server.name]?.busy ? "Refreshing…" : "Refresh icon"}</button>
                            <button type="button" disabled={writeOff()} onClick={() => startEdit(server)}>Edit</button>
                            <button type="button" disabled={writeOff()} onClick={() => setConfirming(server.name)}>Remove</button>
                          </>
                        }>
                          <button type="button" disabled={writeOff()} onClick={() => void saveEdit(server)}>Save</button>
                          <button type="button" disabled={busy()} onClick={() => setEditing(undefined)}>Cancel</button>
                        </Show>
                      }>
                        <span role="alert" class="mcps-sub">Remove for every agent{gateway() !== undefined ? ` on ${gateway()}` : ""}?</span>
                        <button type="button" disabled={writeOff()} onClick={() => void remove(server)}>Confirm remove</button>
                        <button type="button" disabled={busy()} onClick={() => setConfirming(undefined)}>Cancel</button>
                      </Show>
                    </div>
                    <Show when={iconResults()[server.name]?.message}>{(text) => <span class="mcps-sub" role="status">{text()}</span>}</Show>
                    <Show when={iconResults()[server.name]?.error}>{(text) => <span class="mcps-error" role="alert">{text()}</span>}</Show>
                  </div>
                )}
              </For>
              </div>
            </Show>
          )}
        </Show>
      </div>
      <style>{`
        .mcps-add { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
        .mcps-add input, .mcps-info input { flex: 1; min-width: 160px; padding: 8px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-base); color: var(--text-primary); }
        .mcps-add button, .mcps-actions button { border: 1px solid var(--border-default); border-radius: 7px; padding: 6px 10px; color: var(--text-primary); background: var(--bg-raised); cursor: pointer; font: inherit; font-size: 13px; }
        .mcps-add button:disabled, .mcps-actions button:disabled { opacity: .5; cursor: default; }
        .mcps-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .mcps-row { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 14px; border: 1px solid var(--border-default); border-radius: 10px; background: var(--bg-raised); }
        .mcps-row > .edit-agent-ext-icon { align-self: flex-start; }
        .mcps-actions { flex-wrap: wrap; }
        @media (max-width: 720px) { .mcps-grid { grid-template-columns: minmax(0, 1fr); } }
        .mcps-row .edit-agent-ext-icon { flex-shrink: 0; width: 36px; height: 36px; border-radius: 8px; background: #fff; padding: 5px; border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06)); color: var(--text-tertiary); display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .mcps-row .edit-agent-ext-icon svg { width: 20px; height: 20px; }
        .mcps-row .edit-agent-ext-icon-img { width: 100%; height: 100%; object-fit: contain; }
        .mcps-row .mcp-ext-icon-filled { padding: 0; }
        .mcps-row .mcp-ext-icon-filled .edit-agent-ext-icon-img { object-fit: cover; }
        .mcps-info { width: 100%; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .mcps-name { color: var(--text-primary); font-weight: 600; }
        .mcps-sub { color: var(--text-secondary); font-size: 0.82rem; overflow-wrap: anywhere; }
        .mcps-actions { display: flex; align-items: center; gap: 8px; }
        .mcps-empty { padding: 16px 18px; color: var(--text-secondary); }
        .mcps-error { color: var(--error, #ef4444); }
      `}</style>
    </AdminLayout>
  );
}
