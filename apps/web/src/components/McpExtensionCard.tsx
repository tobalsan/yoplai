import { A } from "@solidjs/router";
import { createEffect, createSignal, Show } from "solid-js";
import { mcpDisplayName, type McpServer } from "../api/mcp-servers";

export function McpIcon(props: { src?: string }) {
  const [broken, setBroken] = createSignal(false);
  createEffect(() => { void props.src; setBroken(false); });
  return (
    <span class="edit-agent-ext-icon" classList={{ "mcp-ext-icon-filled": !!props.src && !broken() }}>
      <Show when={props.src && !broken()} fallback={
        <svg viewBox="0 0 24 24" fill="currentColor" aria-label="Model Context Protocol" role="img">
          <path d="M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245" />
        </svg>
      }>
        <img src={props.src} alt="" class="edit-agent-ext-icon-img" onError={() => setBroken(true)} />
      </Show>
    </span>
  );
}

/** OAuth servers are set up when a personal or team connection exists; others when the live connection listed tools. */
export function isMcpServerSetUp(server: McpServer): boolean {
  return server.auth === "oauth"
    ? server.personalState === "connected" || server.teamState === "connected"
    : server.state === "connected";
}

export function mcpServerPath(agentId: string, name: string): string {
  return `/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(name)}`;
}

export function McpExtensionCard(props: { server: McpServer; agentId: string }) {
  const href = () => mcpServerPath(props.agentId, props.server.name);
  return (
    <li class="edit-agent-ext-item" data-tour="ext-card" data-tour-ext={`mcp:${props.server.name}`}>
      <A href={href()} class="edit-agent-ext-open">
        <McpIcon src={props.server.iconUrl} />
        <div class="edit-agent-ext-body">
          <div class="edit-agent-ext-main">
            <span class="edit-agent-ext-name">{mcpDisplayName(props.server.name, props.server.title)}</span>
            <span class="edit-agent-ext-desc">{props.server.description ?? props.server.url ?? "Local MCP server"}</span>
          </div>
        </div>
      </A>
      <Show when={isMcpServerSetUp(props.server)} fallback={
        <A href={href()} class="edit-agent-ext-add" aria-label={`Set up ${props.server.name}`} title={`Set up ${props.server.name}`}>+</A>
      }>
        <span class="edit-agent-ext-check" role="img" aria-label={`${props.server.name} connected`} title="Connected">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round" /></svg>
        </span>
      </Show>
    </li>
  );
}

export const MCP_EXTENSION_STYLES = `
.edit-agent-ext-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.edit-agent-ext-head h2 { margin: 0; }
.edit-agent-ext-icon.mcp-ext-icon-filled { padding: 0; }
.mcp-ext-icon-filled .edit-agent-ext-icon-img { object-fit: cover; }
.mcp-ext-add-button, .mcp-ext-dialog button { border: 1px solid var(--border-default); border-radius: 7px; padding: 6px 9px; color: var(--text-primary); background: var(--bg-raised); cursor: pointer; font: inherit; font-size: 12px; }
.mcp-ext-dialog button:disabled { opacity: .5; cursor: default; }
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
