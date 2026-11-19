import { type Accessor, createComputed, createMemo, createResource, createSignal, onCleanup, Show } from "solid-js";
import { A, useParams } from "@solidjs/router";
import {
  fetchAgentExtensions,
  patchAgentExtension,
  type ExtensionCatalogEntry,
} from "../api/extensions";
import { OAuthConnectCard } from "../components/OAuthConnectCard";
import type { CredentialScope } from "../components/CredentialScopeTabs";
import { ExtensionConfigForm, type ConnectSettingsActions } from "./ExtensionConfigForm";
import { decodeRouteParam } from "../lib/path";
import { useAgentTarget } from "../lib/agent-target";
import { useRequester, type Requester } from "../lib/requester";
import { gatewayKey, qualifyAgentRoute } from "../api/gateway";

/**
 * Details page for one extension on one agent, reached by clicking an
 * extension card on the Edit-Agent hub (`/agents/:agentId/extensions/:extensionId`;
 * the legacy `.../config` path renders the same page). Shows the extension's
 * OAuth connection or schema-driven settings inline, so one click reaches them.
 */
export function ExtensionDetails(props: {
  extensionId?: string;
  /** A config route that falls back to this page passes its own requester, so Retry reads the capabilities that the route uses. */
  requester?: Accessor<Requester>;
}) {
  const routeParams = useParams<{ agentId: string; extensionId: string }>();
  // Router params keep the raw path segment, so a qualified remote ID needs decoding.
  const params = {
    get agentId() { return decodeRouteParam(routeParams.agentId); },
    // A config route that falls back to this page passes the extension, because its path has no `:extensionId`.
    get extensionId() { return props.extensionId ?? decodeRouteParam(routeParams.extensionId); },
  };
  const { target, retry } = useAgentTarget(() => params.agentId);
  const gateway = () => { const current = target(); return current.state === "ready" ? current.gateway : undefined; };
  const requester = props.requester ?? useRequester(gateway);

  // The identity of this page: the gateway and the agent. The catalog, the form drafts, and every
  // mutation belong to one identity. A new identity drops them all, so no old permission carries over.
  const targetKey = createMemo(() => { const current = target(); return current.state === "ready" ? gatewayKey(current.gateway, current.agentId) : undefined; });
  // The form, its drafts, and its actions belong to one extension of one agent. The catalog stays agent-wide.
  const formKey = createMemo(() => { const key = targetKey(); return key === undefined ? undefined : JSON.stringify([key, params.extensionId]); });
  const [extensions, { mutate }] = createResource(
    () => { const current = target(); return current.state === "ready" ? current : null; },
    async (current) => ({ key: gatewayKey(current.gateway, current.agentId), list: await fetchAgentExtensions(current.agentId, current.gateway) })
  );
  const [busy, setBusy] = createSignal(false);
  // The OAuth card's selected tab also selects which settings the form edits.
  const [scope, setScope] = createSignal<CredentialScope>("personal");
  let settingsActions: ConnectSettingsActions | undefined;
  const [toggleError, setToggleError] = createSignal<string | null>(null);
  // Each change of the form key starts a new generation. A late result checks both before it changes the page.
  let generation = 0;
  createComputed(() => {
    void formKey();
    generation++;
    setBusy(false);
    setToggleError(null);
  });
  onCleanup(() => { generation++; });
  // Only the catalog of the resolved target counts. A failed lookup leaves no catalog, so no mutation control.
  const catalog = createMemo(() => {
    if (extensions.error) return undefined;
    const loaded = extensions();
    return loaded && loaded.key === targetKey() ? loaded.list : undefined;
  });
  const entry = createMemo(() => catalog()?.find((candidate) => candidate.id === params.extensionId));
  const bespokeBlocked = (ext: ExtensionCatalogEntry) => bespokeHref(ext) !== null && !requester().isExtensionEnabled(ext.id);
  const bespokeHref = (ext: ExtensionCatalogEntry) =>
    ext.tier === "bespoke-route" && ext.configRoutePath ? qualifyAgentRoute(ext.configRoutePath, params.agentId, gateway()) ?? null : null;

  /** A form of an older identity can finish after the page moved on. Its catalog is dropped. */
  const saved = (catalogKey: string, form: string, mine: number, list: ExtensionCatalogEntry[]) => {
    if (generation === mine && formKey() === form) mutate({ key: catalogKey, list });
  };

  /** Runs one mutation for the exact target that is shown now. Results of an older target change nothing. */
  const mutateExtension = async (ext: ExtensionCatalogEntry, patch: Parameters<typeof patchAgentExtension>[2], failure: string) => {
    const key = targetKey();
    const form = formKey();
    const current = target();
    if (!key || !form || current.state !== "ready" || entry()?.id !== ext.id) return;
    const mine = generation;
    const live = () => generation === mine && formKey() === form;
    setBusy(true);
    setToggleError(null);
    try {
      const list = await patchAgentExtension(current.agentId, ext.id, patch, current.gateway);
      if (live()) mutate({ key, list });
    } catch (cause) {
      if (live()) setToggleError(cause instanceof Error ? cause.message : failure);
    } finally {
      if (live()) setBusy(false);
    }
  };

  // Extensions without settings are a plain on/off, flipped here.
  const toggle = (ext: ExtensionCatalogEntry) => mutateExtension(ext, { enabled: !ext.enabled }, "Failed to update extension.");
  // Whoever connects turns the extension on for the agent. Signed-in users go
  // through their own scope, which any agent member may write (a team-scope
  // enable is admin-only); resending their overrides keeps them.
  const enableAfterConnect = (ext: ExtensionCatalogEntry) => {
    // The requester must belong to the gateway of this page. Another gateway's rights do not apply.
    const asked = requester();
    if (asked.gateway !== gateway()) return Promise.resolve();
    return mutateExtension(
      ext,
      asked.multiUser && asked.user
        ? { credentialScope: "personal", config: ext.personalConfigValues ?? {} }
        : { enabled: true },
      "Failed to enable extension."
    );
  };

  const backHref = createMemo(
    () => `/agents/${encodeURIComponent(params.agentId)}/edit`
  );

  return (
    <>
      <div class="ext-details">
        <A href={backHref()} class="ext-details-back" data-tour="back-to-agent">
          ← Back to agent
        </A>

        <Show when={target().state === "missing"}>
          <div class="ext-details-status ext-details-error" role="alert">
            This agent is unavailable. Check that its gateway is online.{" "}
            <button type="button" onClick={retry}>Retry</button>
          </div>
        </Show>
        <Show when={target().state === "loading" || extensions.loading}>
          <div class="ext-details-status">Loading extension…</div>
        </Show>
        <Show when={extensions.error}>
          <div class="ext-details-status ext-details-error">
            Failed to load extension.
          </div>
        </Show>
        <Show when={target().state === "ready" && !extensions.loading && !extensions.error && !entry()}>
          <div class="ext-details-status ext-details-error">
            Extension not found.
          </div>
        </Show>

        <Show when={formKey()} keyed>
          {(form) => {
          // A new identity remounts everything below: form drafts, saved permissions, and the sign-in card.
          const mine = generation;
          const catalogKey = targetKey()!;
          // The registered actions belong to this form. They end with it.
          onCleanup(() => { settingsActions = undefined; });
          return (
          <Show when={entry()}>
          {(ext) => (
            <>
              <div class="ext-details-heading">
                <div class="ext-details-icon">
                  <Show
                    when={ext().iconDataUri}
                    fallback={
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        aria-hidden="true"
                      >
                        <path
                          d="M9 3.5a1.5 1.5 0 0 1 3 0V4h1.5A1.5 1.5 0 0 1 15 5.5V7h-1v2a2 2 0 1 1 0 4v2h1v1.5a1.5 1.5 0 0 1-1.5 1.5H13v-1a2 2 0 1 0-4 0v1H7.5A1.5 1.5 0 0 1 6 16.5V15h1v-2a2 2 0 1 0 0-4V7h1V5.5A1.5 1.5 0 0 1 9.5 4H9v-.5Z"
                          stroke-linejoin="round"
                        />
                      </svg>
                    }
                  >
                    {(src) => (
                      <img src={src()} alt="" class="ext-details-icon-img" />
                    )}
                  </Show>
                </div>
                <h1 class="ext-details-name">{ext().displayName}</h1>
              </div>
              <p class="ext-details-desc">{ext().description}</p>

              <Show when={ext().oauth}>
                {(oauth) => (
                  <OAuthConnectCard
                    agentId={params.agentId}
                    gateway={gateway()}
                    requester={requester}
                    provider={oauth().provider}
                    scopes={oauth().scopes}
                    personalScopes={oauth().personalScopes}
                    scope={scope()}
                    onScopeChange={setScope}
                    hasUnsavedSettings={() => settingsActions?.hasUnsaved() ?? false}
                    saveSettings={async () => settingsActions?.save()}
                    label={ext().displayName}
                    onStatus={(connected) => {
                      // A connection in either scope turns the extension on.
                      if (generation !== mine || formKey() !== form) return;
                      if (connected && !ext().enabled && !busy() && !ext().managedAtRoot && ext().configurable !== false) void enableAfterConnect(ext());
                    }}
                  >
                    <Show when={ext().tier === "auto-form"}>
                      <ExtensionConfigForm
                        entry={ext()}
                        agentId={params.agentId}
                        gateway={gateway()}
                        scope={scope()}
                        onSaved={(list) => saved(catalogKey, form, mine, list)}
                        registerConnectActions={(actions) => { settingsActions = actions; }}
                      />
                    </Show>
                  </OAuthConnectCard>
                )}
              </Show>

              <Show when={ext().tier === "auto-form" && !ext().oauth}>
                <ExtensionConfigForm
                  entry={ext()}
                  agentId={params.agentId}
                  gateway={gateway()}
                  onSaved={(list) => saved(catalogKey, form, mine, list)}
                  registerConnectActions={(actions) => { settingsActions = actions; }}
                />
              </Show>

              {/* The bespoke page opens only where the gateway of the agent loads the extension. The route wrapper uses the
                  same test. Without it, the link would lead back to this page, so the page shows the state instead. */}
              <Show
                when={bespokeBlocked(ext())}
                fallback={
                  <Show
                    when={bespokeHref(ext())}
                    fallback={
                      <Show when={!ext().oauth && ext().tier !== "auto-form"}>
                        <button
                          type="button"
                          class="ext-details-configure"
                          disabled={
                            busy() ||
                            ext().managedAtRoot ||
                            ext().canConfigureTeam === false ||
                            (!ext().enabled && ext().configurable === false)
                          }
                          title={
                            ext().managedAtRoot
                              ? "Configured in agent.yaml — edit the file to change."
                              : ext().canConfigureTeam === false
                              ? "Ask an agent manager"
                              : !ext().enabled && ext().configurable === false
                              ? "The agent must be assigned to a team to enable this extension"
                              : undefined
                          }
                          onClick={() => void toggle(ext())}
                        >
                          {ext().enabled ? "Disable" : "Enable"}
                        </button>
                        <Show when={toggleError()}>
                          {(message) => (
                            <p class="ext-details-error">{message()}</p>
                          )}
                        </Show>
                      </Show>
                    }
                  >
                    {(href) => (
                      <A href={href()} class="ext-details-configure">
                        Configure →
                      </A>
                    )}
                  </Show>
                }
              >
                <Show
                  when={requester().unknown}
                  fallback={
                    <Show when={requester().ready}>
                      <p class="ext-details-error" role="status">
                        This extension is not available on {gateway() === undefined ? "this gateway" : "the gateway of this agent"}, so its page cannot open.
                      </p>
                    </Show>
                  }
                >
                  <p class="ext-details-error" role="alert">
                    Unable to read what the gateway of this agent offers.{" "}
                    <button type="button" class="ext-details-configure" onClick={() => requester().retry()}>Retry</button>
                  </p>
                </Show>
              </Show>
            </>
          )}
        </Show>
          );
          }}
        </Show>
      </div>

      <style>{EXTENSION_DETAILS_STYLES}</style>
    </>
  );
}

export const EXTENSION_DETAILS_STYLES = `
        .ext-details-heading { display: contents; }

        .ext-details {
          padding: 24px;
          max-width: 520px;
        }

        .ext-details-back {
          display: inline-block;
          margin-bottom: 20px;
          font-size: 14px;
          color: var(--text-secondary);
          text-decoration: none;
        }

        .ext-details-back:hover {
          color: var(--text-primary);
        }

        .ext-details-status {
          padding: 12px 0;
          font-size: 14px;
          color: var(--text-tertiary);
        }

        .ext-details-error {
          color: #e55;
        }

        .ext-details-icon {
          width: 64px;
          height: 64px;
          border-radius: 12px;
          background: #fff;
          padding: 10px;
          border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.06));
          color: var(--text-tertiary);
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          margin-bottom: 16px;
        }

        .ext-details-icon svg {
          width: 32px;
          height: 32px;
        }

        .ext-details-icon-img {
          width: 100%;
          height: 100%;
          object-fit: contain;
        }

        .ext-details-name {
          margin: 0;
          font-size: 22px;
          font-weight: 700;
          color: var(--text-primary);
        }

        .ext-details-desc {
          margin: 6px 0 20px;
          font-size: 14px;
          color: var(--text-tertiary);
        }

        .ext-details-settings {
          padding: 16px;
          border-radius: 8px;
          border: 1px dashed var(--border-default);
          background: var(--bg-sunken, rgba(120, 120, 120, 0.06));
          color: var(--text-tertiary);
          font-size: 13px;
        }

        .ext-details-configure {
          display: inline-block;
          padding: 10px 18px;
          border-radius: 8px;
          background: var(--bg-raised);
          color: var(--text-primary);
          text-decoration: none;
          font-size: 14px;
          font-weight: 500;
          transition: background 0.2s ease;
        }

        button.ext-details-configure {
          border: none;
          cursor: pointer;
        }

        button.ext-details-configure:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .ext-details-configure:hover {
          background: var(--border-default);
        }

        @media (max-width: 768px) {
          .ext-details { padding-top: 72px; }
          .ext-details-heading { display: flex; align-items: center; gap: 14px; }
          .ext-details-heading .ext-details-icon { flex: none; margin-bottom: 0; }
          .ext-details-name { min-width: 0; overflow-wrap: anywhere; }
        }
      `;
