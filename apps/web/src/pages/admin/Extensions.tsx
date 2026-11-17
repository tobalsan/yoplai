import { For, Show, createComputed, createMemo, createResource, createSignal, onCleanup } from "solid-js";
import {
  fetchAdminTopExtensions,
  saveTopExtensions,
  type AdminTopExtensions,
  type TopExtensions,
} from "../../api/top-extensions";
import AdminLayout from "./AdminLayout";
import { McpIcon } from "../../components/McpExtensionCard";
import { capabilities } from "../../lib/capabilities";
import { gatewayKey } from "../../api/gateway";
import { missingGatewayText, useGatewayChoice } from "../../lib/gateway-choice";
import { RequesterFailure } from "../../lib/page-visit";
import { useRequester } from "../../lib/requester";
import { createResourceKey } from "../../lib/resource-key";
import { GatewaySelect } from "../../components/GatewaySelect";

/** Extension icon, or the generic puzzle piece the Edit-Agent list uses. */
function ExtensionIcon(props: { src?: string }) {
  return (
    <span class="edit-agent-ext-icon">
      <Show
        when={props.src}
        fallback={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <path
              d="M9 3.5a1.5 1.5 0 0 1 3 0V4h1.5A1.5 1.5 0 0 1 15 5.5V7h-1v2a2 2 0 1 1 0 4v2h1v1.5a1.5 1.5 0 0 1-1.5 1.5H13v-1a2 2 0 1 0-4 0v1H7.5A1.5 1.5 0 0 1 6 16.5V15h1v-2a2 2 0 1 0 0-4V7h1V5.5A1.5 1.5 0 0 1 9.5 4H9v-.5Z"
              stroke-linejoin="round"
            />
          </svg>
        }
      >
        {(src) => <img src={src()} alt="" class="edit-agent-ext-icon-img" />}
      </Show>
    </span>
  );
}

function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export default function AdminExtensionsPage() {
  // The explicit gateway choice. A gateway that is not configured makes no call and never means Local.
  const choice = useGatewayChoice();
  const gateway = choice.gateway;
  // The remote requester decides what the page offers. The local session and role never apply to a gateway.
  const requester = useRequester(gateway);
  const multiUser = () => (gateway() === undefined ? capabilities.multiUser : requester().multiUser);
  // Local keeps its old behavior: the gateway refuses what the role may not do. A gateway is read-only
  // until its requester is known, and a remote multi-user gateway allows only its superadmin.
  const canWrite = () => gateway() === undefined || (requester().ready && !requester().unknown && (!requester().multiUser || requester().isSuperadmin));
  const [loaded, { mutate, refetch }] = createResource(
    createResourceKey(() => (choice.ready() ? { gateway: gateway() } : null)),
    async (key): Promise<{ key: string; data: AdminTopExtensions }> => ({ key: gatewayKey(key.gateway), data: await fetchAdminTopExtensions(key.gateway) })
  );
  // Data of another gateway is never current data.
  const data = createMemo<AdminTopExtensions | undefined>(() => {
    if (loaded.error || !choice.ready()) return undefined;
    // `latest` keeps the last data while a read runs, and it does not suspend the page.
    const value = loaded.latest;
    return value?.key === gatewayKey(gateway()) ? value.data : undefined;
  });
  const [pending, setPending] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  // After an uncertain write the remote may hold the change although the answer failed. Every switch stays off
  // until a read of the same gateway works, so the next write starts from a fresh snapshot.
  const [unknown, setUnknown] = createSignal(false);
  // Each visit to a gateway has its own number. A save that started in an older visit, also one of the same
  // gateway, changes nothing. The page closing ends the visit too.
  let visit = 0;
  createComputed(() => {
    void choice.chosen();
    void gateway();
    visit++;
    setPending(null);
    setError(null);
    setUnknown(false);
  });
  onCleanup(() => { visit++; });

  async function toggle(kind: "extensions" | "mcp", value: string, system = false) {
    const current = data();
    const host = gateway();
    if (!current || !choice.ready() || !canWrite() || unknown()) return;
    const mine = visit;
    const live = () => visit === mine;
    const next: TopExtensions = {
      extensions: current.extensions,
      mcp: current.mcp,
      system: current.system,
    };
    if (system) next.system = { ...current.system, [kind]: toggled(current.system[kind], value) };
    else next[kind] = toggled(current[kind], value);
    setPending(`${kind}:${value}`);
    setError(null);
    let failed = false;
    try {
      const saved = await saveTopExtensions(next, host);
      if (live()) mutate({ key: gatewayKey(host), data: { ...current, ...saved } });
    } catch (cause) {
      failed = true;
      if (live()) setError(cause instanceof Error ? cause.message : "Save failed.");
    }
    // The remote can commit a write before its answer fails. Read the same gateway before another write.
    if (failed && live()) await settleRead(live);
    if (live()) setPending(null);
  }

  /** Reads the flags of the gateway of this visit again. A failed read keeps the unknown state. */
  async function settleRead(live: () => boolean) {
    try { await refetch(); } catch { /* The error state of the resource tells the result. */ }
    if (live()) setUnknown(Boolean(loaded.error));
  }
  async function retryRead() {
    const mine = visit;
    const live = () => visit === mine;
    setPending("read");
    await settleRead(live);
    if (live()) setPending(null);
  }

  const star = (kind: "extensions" | "mcp", value: string, label: string) => {
    const on = () => data()?.[kind].includes(value) === true;
    return (
      <button
        type="button"
        class="top-star"
        classList={{ on: on() }}
        aria-pressed={on()}
        aria-label={`${on() ? "Unmark" : "Mark"} ${label} as top`}
        title={on() ? "Top: shown first and prompted to users" : "Mark as top"}
        disabled={pending() !== null || !canWrite() || unknown()}
        onClick={() => void toggle(kind, value)}
      >
        {on() ? "★" : "☆"}
      </button>
    );
  };

  const systemToggle = (kind: "extensions" | "mcp", value: string, label: string) => {
    const on = () => data()?.system[kind].includes(value) === true;
    return (
      <Show when={multiUser()}>
        <button
          type="button"
          role="switch"
          class="top-system"
          aria-checked={on()}
          aria-label={`${on() ? "Unmark" : "Mark"} ${label} as system`}
          disabled={pending() !== null || !canWrite() || unknown()}
          onClick={() => void toggle(kind, value, true)}
        >
          System
        </button>
      </Show>
    );
  };

  const missing = () => { const selection = choice.selection(); return selection.state === "missing" ? selection : undefined; };
  return (
    <AdminLayout
      title="Extensions"
      gateway={gateway()}
      description={multiUser()
        ? "Star Top extensions and MCP servers to promote them. Mark system items to hide them from users and admins on agent configuration pages."
        : "Star the extensions and MCP servers your team should connect first. They sort first and users are prompted to connect them."}
    >
      <GatewaySelect value={choice.chosen()} names={choice.names()} onChange={choice.choose} />
      <Show when={missing()}>{(selection) => <p class="top-error" role="alert">{missingGatewayText(selection())}</p>}</Show>
      <Show when={gateway() !== undefined && requester().ready && requester().unknown}>
        <RequesterFailure requester={requester} class="top-error">Could not read your permissions on {gateway()}. The controls stay off.</RequesterFailure>
      </Show>
      <Show when={gateway() !== undefined && requester().ready && !requester().unknown && requester().multiUser && !requester().isSuperadmin}>
        <p class="top-empty" role="status">Only the superadmin of {gateway()} can change these flags.</p>
      </Show>
      <Show when={error()}>{(message) => <p class="top-error">{message()}</p>}</Show>
      <Show when={unknown()}>
        <p class="top-error" role="alert">The flags could not be read after the error, and the change may have happened. Read the flags before you change them again. <button type="button" disabled={pending() !== null} onClick={() => void retryRead()}>Read list</button></p>
      </Show>
      <Show when={choice.ready() && loaded.error}>
        <p class="top-error">{loaded.error instanceof Error ? loaded.error.message : "Failed to load."}</p>
      </Show>
      <Show when={data()} fallback={<Show when={choice.selection().state === "loading" || (choice.ready() && loaded.loading)}><div class="top-empty">Loading…</div></Show>}>
        {(loaded) => (
          <>
            <h2 class="top-heading">Extensions</h2>
            <div class="top-panel">
              <Show when={loaded().candidates.extensions.length > 0} fallback={<div class="top-empty">No extensions.</div>}>
                <For each={loaded().candidates.extensions}>
                  {(ext) => (
                    <div class="top-row" data-extension={ext.id}>
                      {star("extensions", ext.id, ext.displayName)}
                      {systemToggle("extensions", ext.id, ext.displayName)}
                      <ExtensionIcon src={ext.iconDataUri} />
                      <div class="top-info">
                        <span class="top-name">{ext.displayName}</span>
                        <span class="top-sub">{ext.description}</span>
                      </div>
                    </div>
                  )}
                </For>
              </Show>
            </div>
            <h2 class="top-heading">MCP servers</h2>
            <div class="top-panel">
              <Show when={loaded().candidates.mcp.length > 0} fallback={<div class="top-empty">No HTTP MCP servers configured.</div>}>
                <For each={loaded().candidates.mcp}>
                  {(server) => (
                    <div class="top-row" data-mcp={server.url}>
                      {star("mcp", server.url, server.displayName)}
                      {systemToggle("mcp", server.url, server.displayName)}
                      <McpIcon src={server.iconUrl} />
                      <div class="top-info">
                        <span class="top-name">{server.displayName}</span>
                        <span class="top-sub">{server.url}</span>
                      </div>
                      <span class="top-count">
                        used by {server.agentCount} {server.agentCount === 1 ? "agent" : "agents"}
                      </span>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </>
        )}
      </Show>
      <style>{`
        .top-heading { margin: 24px 0 10px; font-size: 1rem; color: var(--text-primary); }
        .top-panel {
          border: 1px solid var(--border-default);
          border-radius: 18px;
          background: color-mix(in srgb, var(--bg-surface) 92%, transparent);
          overflow: hidden;
        }
        .top-row {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 12px 18px;
          border-bottom: 1px solid var(--border-default);
        }
        .top-row:last-child { border-bottom: none; }
        .top-row .edit-agent-ext-icon {
          flex-shrink: 0;
          width: 36px;
          height: 36px;
          border-radius: 8px;
          background: #fff;
          padding: 5px;
          border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
          color: var(--text-tertiary);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .top-row .edit-agent-ext-icon svg { width: 20px; height: 20px; }
        .top-row .edit-agent-ext-icon-img { width: 100%; height: 100%; object-fit: contain; }
        .top-row .mcp-ext-icon-filled { padding: 0; }
        .top-row .mcp-ext-icon-filled .edit-agent-ext-icon-img { object-fit: cover; }
        .top-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
        .top-name { color: var(--text-primary); font-weight: 600; }
        .top-sub {
          color: var(--text-secondary);
          font-size: 0.82rem;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .top-count { color: var(--text-secondary); font-size: 0.82rem; white-space: nowrap; }
        .top-star {
          border: none;
          background: none;
          color: var(--text-secondary);
          font-size: 1.3rem;
          line-height: 1;
          cursor: pointer;
        }
        .top-star.on { color: var(--warning, #f59e0b); }
        .top-system { border: 1px solid var(--border-default); border-radius: 6px; padding: 4px 8px; background: var(--bg-surface); color: var(--text-secondary); cursor: pointer; }
        .top-system[aria-checked="true"] { background: var(--accent, #3b82f6); color: #fff; }
        .top-empty { padding: 16px 18px; color: var(--text-secondary); }
        .top-error { color: var(--error, #ef4444); }
      `}</style>
    </AdminLayout>
  );
}
