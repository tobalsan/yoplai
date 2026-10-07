import { createEffect, createSignal, Show } from "solid-js";
import type { McpScope, McpServer } from "../api/mcp-servers";

function McpIcon(props: { src?: string }) {
  const [broken, setBroken] = createSignal(false);
  createEffect(() => { void props.src; setBroken(false); });
  return (
    <span class="edit-agent-ext-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
        <path d="M12 3.5v5m0 7v5M3.5 12h5m7 0h5M8.5 8.5l-3-3m10 10 3 3m0-13-3 3m-7 7-3 3" stroke-linecap="round" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
      <Show when={props.src && !broken()}>
        <img src={props.src} alt="" class="edit-agent-ext-icon-img mcp-ext-app-icon" onError={() => setBroken(true)} />
      </Show>
    </span>
  );
}

export function McpExtensionCard(props: {
  server: McpServer;
  canConfigureTeam: boolean;
  personalAvailable: boolean;
  busy: boolean;
  onConnect: (server: McpServer, scope: McpScope) => void;
  onDisconnect: (server: McpServer, scope: McpScope) => void;
  onRemove: (server: McpServer) => void;
}) {
  const [scope, setScope] = createSignal<McpScope>(props.personalAvailable ? "personal" : "team");
  const scopedState = () => scope() === "personal" ? props.server.personalState : props.server.teamState;
  return (
    <li class="edit-agent-ext-item mcp-ext-card" data-tour="ext-card" data-tour-ext={`mcp:${props.server.name}`}>
      <div class="mcp-ext-main">
        <McpIcon src={props.server.iconUrl} />
        <div class="edit-agent-ext-body">
          <span class="edit-agent-ext-name">{props.server.name}</span>
          <span class="edit-agent-ext-desc">{props.server.url ?? "Local MCP server"}</span>
          <Show when={props.server.readOnly}><span class="edit-agent-ext-desc">Configuration managed in mcp.json</span></Show>
        </div>
        <Show when={props.server.state === "connected"} fallback={
          <span class="edit-agent-ext-add mcp-ext-status" role="img" aria-label={`${props.server.name} not connected`}>+</span>
        }>
          <span class="edit-agent-ext-check" role="img" aria-label={`${props.server.name} connected`} title="Connected">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </span>
        </Show>
      </div>
      <div class="mcp-ext-actions">
        <Show when={props.server.auth === "oauth"}>
          <label class="mcp-ext-scope-label">
            Connection
            <select aria-label={`${props.server.name} connection scope`} value={scope()} onChange={(event) => setScope(event.currentTarget.value as McpScope)}>
              <option value="personal" disabled={!props.personalAvailable}>Just me</option>
              <option value="team" disabled={!props.canConfigureTeam}>Whole team</option>
            </select>
          </label>
          <Show when={scopedState() === "connected"} fallback={
            <button type="button" disabled={props.busy || (scope() === "team" && !props.canConfigureTeam)} onClick={() => props.onConnect(props.server, scope())}>
              {scopedState() === "needs_reconnect" ? "Reconnect" : "Connect"}
            </button>
          }>
            <button type="button" disabled={props.busy || (scope() === "team" && !props.canConfigureTeam)} onClick={() => props.onDisconnect(props.server, scope())}>Disconnect</button>
          </Show>
        </Show>
        <button type="button" class="mcp-ext-remove" disabled={props.busy} onClick={() => props.onRemove(props.server)}>Remove</button>
      </div>
    </li>
  );
}

export const MCP_EXTENSION_STYLES = `
.edit-agent-ext-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.edit-agent-ext-head h2 { margin: 0; }
.mcp-ext-card { flex-direction: column; justify-content: space-between; }
.mcp-ext-main { display: flex; align-items: flex-start; gap: 10px; width: 100%; }
.mcp-ext-main .edit-agent-ext-body { overflow: hidden; }
.mcp-ext-main .edit-agent-ext-desc { overflow-wrap: anywhere; }
.mcp-ext-app-icon { position: absolute; inset: 6px; width: calc(100% - 12px); height: calc(100% - 12px); background: #fff; }
.mcp-ext-card .edit-agent-ext-icon { position: relative; }
.mcp-ext-card .edit-agent-ext-check, .mcp-ext-card .edit-agent-ext-add { margin-left: auto; }
.mcp-ext-status { cursor: default; }
.mcp-ext-actions { display: flex; gap: 7px; align-items: end; flex-wrap: wrap; width: 100%; }
.mcp-ext-actions button, .mcp-ext-add-button, .mcp-ext-dialog button { border: 1px solid var(--border-default); border-radius: 7px; padding: 6px 9px; color: var(--text-primary); background: var(--bg-raised); cursor: pointer; font: inherit; font-size: 12px; }
.mcp-ext-actions button:disabled, .mcp-ext-dialog button:disabled { opacity: .5; cursor: default; }
.mcp-ext-actions .mcp-ext-remove { margin-left: auto; color: #c5221f; }
.mcp-ext-scope-label { display: flex; flex-direction: column; gap: 2px; color: var(--text-secondary); font-size: 11px; }
.mcp-ext-scope-label select { border: 1px solid var(--border-default); border-radius: 7px; padding: 5px; color: var(--text-primary); background: var(--bg-raised); font: inherit; font-size: 12px; }
.mcp-ext-dialog-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0,0,0,.45); }
.mcp-ext-dialog { width: min(440px, calc(100vw - 32px)); border: 1px solid var(--border-default); border-radius: 12px; padding: 20px; color: var(--text-primary); background: var(--bg-raised); }
.mcp-ext-dialog::backdrop { background: rgba(0,0,0,.45); }
.mcp-ext-dialog form { display: grid; gap: 14px; }
.mcp-ext-dialog h2 { margin: 0; font-size: 18px; }
.mcp-ext-dialog label { display: grid; gap: 5px; font-size: 13px; }
.mcp-ext-dialog input[type=url] { width: 100%; box-sizing: border-box; border: 1px solid var(--border-default); border-radius: 7px; padding: 9px; color: var(--text-primary); background: var(--bg-base); }
.mcp-ext-dialog fieldset { border: 0; padding: 0; margin: 0; display: flex; gap: 16px; }
.mcp-ext-dialog fieldset label { display: flex; align-items: center; gap: 5px; }
.mcp-ext-dialog-actions { display: flex; justify-content: end; gap: 8px; }
.mcp-ext-error { color: #c5221f; font-size: 12px; margin: 0; }
`;
