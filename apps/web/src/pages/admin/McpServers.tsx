import { For, Show, createResource, createSignal } from "solid-js";
import {
  addMcpCatalogServer,
  fetchMcpCatalog,
  mcpDisplayName,
  removeMcpCatalogServer,
  updateMcpCatalogServer,
  type McpCatalogServer,
} from "../../api/mcp-servers";
import AdminLayout from "./AdminLayout";
import { McpIcon } from "../../components/McpExtensionCard";

const message = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

export default function AdminMcpServersPage() {
  const [servers, { mutate, refetch }] = createResource(fetchMcpCatalog);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [editing, setEditing] = createSignal<string>();
  const [editName, setEditName] = createSignal("");
  const [editDescription, setEditDescription] = createSignal("");
  const [confirming, setConfirming] = createSignal<string>();

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (cause) { setError(message(cause, fallback)); }
    finally { setBusy(false); }
  }

  const add = (event: Event) => {
    event.preventDefault();
    void run(async () => {
      await addMcpCatalogServer({ url: url().trim(), displayName: name(), description: description() });
      setUrl(""); setName(""); setDescription("");
      await refetch();
    }, "Failed to add MCP server.");
  };
  const startEdit = (server: McpCatalogServer) => {
    setEditing(server.name);
    setEditName(server.displayName ?? "");
    setEditDescription(server.description ?? "");
  };
  const saveEdit = (server: McpCatalogServer) => run(async () => {
    const saved = await updateMcpCatalogServer(server.name, { displayName: editName(), description: editDescription() });
    mutate((list) => list?.map((item) => (item.name === server.name ? { ...item, displayName: saved.displayName, description: saved.description } : item)));
    setEditing(undefined);
  }, "Failed to save MCP server.");
  const remove = (server: McpCatalogServer) => run(async () => {
    await removeMcpCatalogServer(server.name);
    mutate((list) => list?.filter((item) => item.name !== server.name));
    setConfirming(undefined);
  }, "Failed to remove MCP server.");

  return (
    <AdminLayout
      title="MCP servers"
      description="Shared remote MCP servers every agent can enable from its extensions page. Users connect their own account; nothing is connected here."
    >
      <form class="mcps-add" onSubmit={add}>
        <input type="url" required aria-label="Server URL" placeholder="https://mcp.example.com/mcp" value={url()} onInput={(event) => setUrl(event.currentTarget.value)} />
        <input type="text" maxLength={100} aria-label="Name (optional)" placeholder="Display name, e.g. Atlassian" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        <input type="text" maxLength={500} aria-label="Description (optional)" placeholder="What this server gives agents access to" value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
        <button type="submit" disabled={busy()}>Add server</button>
      </form>
      <Show when={error()}>{(text) => <p class="mcps-error" role="alert">{text()}</p>}</Show>
      <Show when={servers.error}><p class="mcps-error" role="alert">{message(servers.error, "Failed to load MCP servers.")}</p></Show>
      <div>
        <Show when={!servers.error && servers()} fallback={<Show when={servers.loading}><div class="mcps-empty">Loading…</div></Show>}>
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
                            <button type="button" disabled={busy()} onClick={() => startEdit(server)}>Edit</button>
                            <button type="button" disabled={busy()} onClick={() => setConfirming(server.name)}>Remove</button>
                          </>
                        }>
                          <button type="button" disabled={busy()} onClick={() => void saveEdit(server)}>Save</button>
                          <button type="button" disabled={busy()} onClick={() => setEditing(undefined)}>Cancel</button>
                        </Show>
                      }>
                        <span role="alert" class="mcps-sub">Remove for every agent?</span>
                        <button type="button" disabled={busy()} onClick={() => void remove(server)}>Confirm remove</button>
                        <button type="button" disabled={busy()} onClick={() => setConfirming(undefined)}>Cancel</button>
                      </Show>
                    </div>
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
