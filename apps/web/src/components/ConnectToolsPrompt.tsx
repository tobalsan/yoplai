import { A, useLocation } from "@solidjs/router";
import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup } from "solid-js";
import { normalizeMcpServerUrl } from "@yoplai/shared/mcp-url";
import { fetchAgents } from "../api/agents";
import { clearConnectPromptRequest, connectPromptRequest, tourStep } from "../onboarding/state";
import { TOUR_STEPS } from "../onboarding/steps";
import { fetchConnectPrompt, markConnectPromptSeen } from "../api/connect-prompt";
import {
  fetchAgentExtensions,
  fetchOAuthScopeState,
  patchAgentExtension,
  type ExtensionCatalogEntry,
  type OAuthScopeState,
} from "../api/extensions";
import { fetchMcpServers, mcpDisplayName, type McpServer } from "../api/mcp-servers";
import { fetchTopExtensions, type TopExtensions } from "../api/top-extensions";
import { capabilities, capabilitiesReady } from "../lib/capabilities";
import { stripBase } from "../lib/path";
import { ExtensionConfigForm } from "../pages/ExtensionConfigForm";

export type ConnectRowState = "connected" | "team" | "enable" | "connect" | "setup";

export type ConnectRow = {
  key: string;
  kind: "extension" | "mcp";
  /** Extension id or MCP server key. */
  id: string;
  name: string;
  description?: string;
  iconDataUri?: string;
  state: ConnectRowState;
  /** Extension OAuth provider and personal scopes, for the Connect popup. */
  oauth?: { provider: string; scopes: string[] };
  /** The requester's own setting overrides, resent on a personal enable so they survive. */
  personalConfig?: Record<string, unknown>;
  /** Catalog entry, for setting up personal credentials inside the prompt. */
  entry?: ExtensionCatalogEntry;
};

export type OAuthStates = Record<string, { personal: OAuthScopeState; team: OAuthScopeState }>;

/**
 * Runtime resolves personal -> team, but an unusable personal grant asks for a
 * reconnect instead of falling back, so it counts as not connected.
 */
function credentialSource(personal: OAuthScopeState | undefined, team: OAuthScopeState | undefined) {
  if (personal === "connected") return "personal";
  if (personal === "needs_reconnect") return null;
  return team === "connected" ? "team" : null;
}

const isActionable = (state: ConnectRowState) => state !== "connected" && state !== "team";

/** Connectable Top items for one agent with their status. `oauthStates` is keyed by OAuth provider. */
export function buildConnectRows(input: {
  top: TopExtensions;
  extensions: ExtensionCatalogEntry[];
  servers: McpServer[];
  oauthStates: OAuthStates;
}): ConnectRow[] {
  const topIds = new Set(input.top.extensions);
  const topUrls = new Set(input.top.mcp);
  const rows: ConnectRow[] = [];
  for (const ext of input.extensions) {
    if (ext.id === "mcp" || !topIds.has(ext.id)) continue;
    const secrets = ext.requiredSecrets ?? [];
    if (!ext.oauth && secrets.length === 0) continue;
    let source: "personal" | "team" | null;
    if (ext.oauth) {
      const states = input.oauthStates[ext.oauth.provider];
      source = credentialSource(states?.personal, states?.team);
    } else {
      // `configured` is requester-effective (personal over team) but only checked once enabled;
      // before that, every required secret must have a personal or team value.
      const personalFields = ext.personalSecretFields ?? [];
      const usable = ext.enabled
        ? ext.configured
        : secrets.every((field) => personalFields.includes(field) || ext.configValues?.[field] != null);
      source = !usable ? null : personalFields.length > 0 ? "personal" : "team";
    }
    let state: ConnectRowState;
    if (!source) state = ext.oauth ? "connect" : "setup";
    else if (!ext.enabled) state = "enable";
    else state = source === "personal" ? "connected" : "team";
    rows.push({
      key: `ext:${ext.id}`,
      kind: "extension",
      id: ext.id,
      name: ext.displayName,
      description: ext.description,
      iconDataUri: ext.iconDataUri,
      state,
      oauth: ext.oauth ? { provider: ext.oauth.provider, scopes: ext.oauth.personalScopes ?? ext.oauth.scopes } : undefined,
      personalConfig: ext.personalConfigValues,
      entry: ext,
    });
  }
  for (const server of input.servers) {
    if (server.auth !== "oauth" || !server.url) continue;
    const url = normalizeMcpServerUrl(server.url);
    if (!url || !topUrls.has(url)) continue;
    const source = credentialSource(server.personalState, server.teamState);
    const state: ConnectRowState = source === "personal" ? "connected" : source === "team" ? "team" : "connect";
    rows.push({
      key: `mcp:${server.name}`,
      kind: "mcp",
      id: server.name,
      name: mcpDisplayName(server.name, server.title),
      description: server.description,
      iconDataUri: server.iconUrl,
      state,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

async function loadRows(agentId: string): Promise<ConnectRow[]> {
  const [top, extensions, mcp] = await Promise.all([
    fetchTopExtensions(),
    fetchAgentExtensions(agentId).catch(() => [] as ExtensionCatalogEntry[]),
    fetchMcpServers(agentId).catch(() => ({ servers: [] as McpServer[] })),
  ]);
  const topIds = new Set(top.extensions);
  const providers = new Set<string>();
  for (const ext of extensions) {
    if (ext.id !== "mcp" && topIds.has(ext.id) && ext.oauth && ext.oauthConnected) providers.add(ext.oauth.provider);
  }
  const oauthStates: OAuthStates = {};
  const scopeState = (provider: string, scope: "personal" | "team") =>
    fetchOAuthScopeState(agentId, provider, scope).catch((): OAuthScopeState => "disconnected");
  await Promise.all(
    [...providers].map(async (provider) => {
      const [personal, team] = await Promise.all([scopeState(provider, "personal"), scopeState(provider, "team")]);
      oauthStates[provider] = { personal, team };
    })
  );
  return buildConnectRows({ top, extensions, servers: mcp.servers, oauthStates });
}

function chatAgentId(pathname: string): string | null {
  const match = stripBase(pathname).match(/^\/chat\/([^/?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const STATE_LABEL: Partial<Record<ConnectRowState, string>> = {
  connected: "Connected",
  team: "Already connected for the team",
};

export function ConnectToolsPrompt() {
  const location = useLocation();
  const [shownFor, setShownFor] = createSignal<string | null>(null);
  const [rows, setRows] = createSignal<ConnectRow[]>([]);
  const [busyKey, setBusyKey] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  // Row whose personal credentials form replaces the list.
  const [configuring, setConfiguring] = createSignal<ConnectRow | null>(null);
  const [error, setError] = createSignal<string>();
  const routeAgentId = createMemo(() => chatAgentId(location.pathname));
  // The tour can be pending on another page (e.g. a new user landing straight in
  // a chat while its first step waits on home); only a step shown here blocks the prompt.
  const tourShownHere = createMemo(() => {
    const step = tourStep();
    return step !== null && !!TOUR_STEPS[step]?.route.test(stripBase(location.pathname));
  });
  const eligible = () =>
    capabilitiesReady() && capabilities.multiUser === true && Boolean(capabilities.user);

  const [agents] = createResource(
    () => (shownFor() ? true : null),
    () => fetchAgents().catch(() => [])
  );
  const agentName = () => agents()?.find((a) => a.id === shownFor())?.name ?? shownFor() ?? "";

  // Row whose OAuth popup is open; enabled for the agent once its grant lands.
  let connecting: string | null = null;

  const refresh = async (agentId: string) => {
    try {
      const next = await loadRows(agentId);
      if (shownFor() !== agentId) return;
      setRows(next);
      const connected = next.find((row) => row.key === connecting && row.kind === "extension" && row.state === "enable");
      if (connected) {
        connecting = null;
        await enable(agentId, connected);
      }
    } catch {
      // Keep the rows already shown.
    } finally {
      if (shownFor() === agentId) setLoading(false);
    }
  };

  // Auto-open: no tour step on this page, never seen, something needs action.
  createEffect(
    on(
      () => [eligible(), routeAgentId(), tourShownHere()] as const,
      ([ok, agentId, tourHere]) => {
        if (!ok || !agentId || tourHere || shownFor()) return;
        let stale = false;
        onCleanup(() => {
          stale = true;
        });
        void (async () => {
          try {
            const prompt = await fetchConnectPrompt(agentId);
            if (!prompt.supported || prompt.seen) return;
            const next = await loadRows(agentId);
            if (stale || !next.some((row) => isActionable(row.state))) return;
            setRows(next);
            setError(undefined);
            setShownFor(agentId);
          } catch {
            // Prompt is optional; stay hidden on failure.
          }
        })();
      }
    )
  );

  // Never alongside the tour: a step showing here closes the prompt without marking it seen.
  createEffect(
    on(tourShownHere, (tourHere) => {
      if (tourHere) setShownFor(null);
    })
  );

  // Manual open from the sidebar button.
  createEffect(() => {
    const request = connectPromptRequest();
    if (!request) return;
    clearConnectPromptRequest();
    if (tourShownHere()) return;
    setRows([]);
    setError(undefined);
    setLoading(true);
    setConfiguring(null);
    setShownFor(request.agentId);
    void refresh(request.agentId);
  });

  const close = () => {
    const agentId = shownFor();
    setShownFor(null);
    setConfiguring(null);
    if (agentId) void markConnectPromptSeen(agentId).catch(() => undefined);
  };

  createEffect(() => {
    if (!shownFor()) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onReturn = () => {
      const agentId = shownFor();
      if (agentId) void refresh(agentId);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.data && typeof event.data === "object" && ["yoplai-oauth", "aihub-oauth"].includes(event.data.type)) onReturn();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onReturn);
    onCleanup(() => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onReturn);
    });
  });

  const connect = (agentId: string, row: ConnectRow) => {
    // Popup opens synchronously in the click handler so browsers don't block it.
    const url =
      row.kind === "mcp"
        ? `/api/mcp/oauth/authorize?agent=${encodeURIComponent(agentId)}&server=${encodeURIComponent(row.id)}&scope=personal`
        : `/api/oauth/${encodeURIComponent(row.oauth!.provider)}/authorize?${new URLSearchParams({
            agent: agentId,
            ...(row.oauth!.scopes.length ? { scopes: row.oauth!.scopes.join(",") } : {}),
            scope: "personal",
          }).toString()}`;
    connecting = row.key;
    window.open(url, "yoplai-oauth", "width=520,height=640");
  };

  const enable = async (agentId: string, row: ConnectRow) => {
    setBusyKey(row.key);
    setError(undefined);
    try {
      // Personal scope enables for members too; resending own overrides keeps them.
      await patchAgentExtension(agentId, row.id, { credentialScope: "personal", config: row.personalConfig ?? {} });
      await refresh(agentId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to enable extension.");
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <Show when={tourShownHere() ? null : shownFor()} keyed>
      {(agentId) => (
        <>
          <div class="connect-prompt-backdrop" onClick={close}>
            <div
              class="connect-prompt"
              role="dialog"
              aria-modal="true"
              aria-labelledby="connect-prompt-title"
              onClick={(event) => event.stopPropagation()}
            >
              <button type="button" class="connect-prompt-close" aria-label="Close" onClick={close}>
                ×
              </button>
              <h2 id="connect-prompt-title">Connect {agentName()} to your tools</h2>
              <p class="connect-prompt-sub">
                These are the recommended extensions for {agentName()}.
                <br />
                Connect the ones you use so the agent can work with them.
              </p>
              <Show when={error()}>{(message) => <p class="connect-prompt-error">{message()}</p>}</Show>
              <Show when={configuring()?.entry ? configuring() : null} keyed>
                {(row) => (
                  <div class="connect-prompt-setup">
                    <button type="button" class="connect-prompt-back" onClick={() => setConfiguring(null)}>
                      ← Back
                    </button>
                    <h3>Set up {row.name}</h3>
                    <ExtensionConfigForm
                      entry={row.entry!}
                      agentId={agentId}
                      personalOnly
                      onSaved={(updated) => {
                        // Back to the list right away, marked from the save response;
                        // the full reload (MCP status is slow) corrects it in the background.
                        const saved = updated.find((extension) => extension.id === row.id);
                        if (saved?.enabled && saved.configured) {
                          setRows((current) => current.map((r) => (r.key === row.key ? { ...r, state: "connected", entry: saved } : r)));
                        }
                        setConfiguring(null);
                        void refresh(agentId);
                      }}
                    />
                  </div>
                )}
              </Show>
              <Show when={!configuring()}>
              <Show when={loading()}>
                <div class="connect-prompt-loading" role="status">
                  <span class="connect-prompt-spinner" aria-hidden="true" />
                  Loading extensions…
                </div>
              </Show>
              <ul class="connect-prompt-list">
                <For each={rows()}>
                  {(row) => (
                    <li class="connect-prompt-row" data-state={row.state} data-row={row.key}>
                      <div class="connect-prompt-icon">
                        <Show when={row.iconDataUri} fallback={<span>{row.name.charAt(0).toUpperCase()}</span>}>
                          <img src={row.iconDataUri} alt="" />
                        </Show>
                      </div>
                      <div class="connect-prompt-info">
                        <span class="connect-prompt-name">{row.name}</span>
                        <span class="connect-prompt-hint">Recommended by your admin</span>
                      </div>
                      <Show
                        when={isActionable(row.state)}
                        fallback={
                          <span class="connect-prompt-status">
                            <span aria-hidden="true">✓</span> {STATE_LABEL[row.state]}
                          </span>
                        }
                      >
                        <Show when={row.state === "connect"}>
                          <button type="button" class="connect-prompt-action" onClick={() => connect(agentId, row)}>
                            Connect
                          </button>
                        </Show>
                        <Show when={row.state === "enable"}>
                          <button
                            type="button"
                            class="connect-prompt-action"
                            disabled={busyKey() === row.key}
                            onClick={() => void enable(agentId, row)}
                          >
                            Enable
                          </button>
                        </Show>
                        <Show when={row.state === "setup"}>
                          <button type="button" class="connect-prompt-action" onClick={() => setConfiguring(row)}>
                            Set up
                          </button>
                        </Show>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <p class="connect-prompt-browse">
                Want to see more?{" "}
                <A href={`/agents/${encodeURIComponent(agentId)}/edit`} onClick={close}>
                  Browse all connectors or add a custom one
                </A>
              </p>
              <div class="connect-prompt-footer">
                <button type="button" class="connect-prompt-continue" onClick={close}>
                  Continue
                </button>
              </div>
              </Show>
            </div>
          </div>
          <style>{CONNECT_PROMPT_STYLES}</style>
        </>
      )}
    </Show>
  );
}

const CONNECT_PROMPT_STYLES = `
  .connect-prompt-backdrop {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgba(0, 0, 0, 0.45);
  }
  .connect-prompt {
    position: relative;
    width: min(520px, 100%);
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 28px 28px 22px;
    border: 1px solid var(--border-default);
    border-radius: 18px;
    background: var(--bg-surface);
    color: var(--text-primary);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
  }
  .connect-prompt h2 { margin: 0 0 6px; padding: 0 28px; font-size: 1.3rem; text-align: center; }
  .connect-prompt-sub { margin: 0 0 18px; color: var(--text-secondary); font-size: 0.92rem; text-align: center; }
  .connect-prompt-close {
    position: absolute;
    top: 12px;
    right: 14px;
    border: none;
    background: none;
    color: var(--text-secondary);
    font-size: 1.4rem;
    line-height: 1;
    cursor: pointer;
  }
  .connect-prompt-error { color: var(--error, #ef4444); font-size: 0.85rem; margin: 0 0 10px; }
  .connect-prompt-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 120px;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }
  .connect-prompt-spinner {
    width: 18px;
    height: 18px;
    border: 2px solid var(--border-default);
    border-top-color: var(--text-secondary);
    border-radius: 50%;
    animation: connect-prompt-spin 0.8s linear infinite;
  }
  @keyframes connect-prompt-spin { to { transform: rotate(360deg); } }
  .connect-prompt-setup h3 { margin: 6px 0 12px; font-size: 1.05rem; }
  .connect-prompt-back {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: 0.88rem;
    cursor: pointer;
  }
  .connect-prompt-back:hover { color: var(--text-primary); }
  .connect-prompt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .connect-prompt-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--border-default);
    border-radius: 12px;
  }
  .connect-prompt-icon {
    width: 32px;
    height: 32px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    background: var(--bg-primary);
    color: var(--text-secondary);
    font-weight: 600;
  }
  .connect-prompt-icon img { width: 20px; height: 20px; object-fit: contain; }
  .connect-prompt-info { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .connect-prompt-name { font-weight: 600; }
  .connect-prompt-hint { color: var(--text-secondary); font-size: 0.75rem; }
  .connect-prompt-status { color: var(--success, #22c55e); font-size: 0.85rem; font-weight: 600; white-space: nowrap; }
  .connect-prompt-action {
    padding: 6px 14px;
    border: 1px solid var(--border-default);
    border-radius: 8px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 0.85rem;
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
  }
  .connect-prompt-action:hover { border-color: var(--accent, #60a5fa); }
  .connect-prompt-browse { margin: 16px 0 0; color: var(--text-secondary); font-size: 0.85rem; }
  .connect-prompt-browse a { color: var(--accent, #60a5fa); }
  .connect-prompt-footer { display: flex; justify-content: flex-end; margin-top: 18px; }
  .connect-prompt-continue {
    padding: 8px 20px;
    border: none;
    border-radius: 10px;
    background: var(--accent, #60a5fa);
    color: #fff;
    font-weight: 600;
    cursor: pointer;
  }
`;
