import { createMemo, createResource, createSignal, Show } from "solid-js";
import { A, useParams } from "@solidjs/router";
import {
  fetchAgentExtensions,
  patchAgentExtension,
  type ExtensionCatalogEntry,
} from "../api/extensions";
import { OAuthConnectCard } from "../components/OAuthConnectCard";
import type { CredentialScope } from "../components/CredentialScopeTabs";
import { ExtensionConfigForm, type ConnectSettingsActions } from "./ExtensionConfigForm";

/**
 * Details page for one extension on one agent, reached by clicking an
 * extension card on the Edit-Agent hub (`/agents/:agentId/extensions/:extensionId`;
 * the legacy `.../config` path renders the same page). Shows the extension's
 * OAuth connection or schema-driven settings inline, so one click reaches them.
 */
export function ExtensionDetails() {
  const params = useParams<{ agentId: string; extensionId: string }>();

  const [extensions, { mutate }] = createResource(() =>
    fetchAgentExtensions(params.agentId)
  );
  const [busy, setBusy] = createSignal(false);
  // The OAuth card's selected tab also selects which settings the form edits.
  const [scope, setScope] = createSignal<CredentialScope>("personal");
  let settingsActions: ConnectSettingsActions | undefined;
  const [toggleError, setToggleError] = createSignal<string | null>(null);

  // Extensions without settings are a plain on/off, flipped here.
  const toggle = async (ext: ExtensionCatalogEntry) => {
    setBusy(true);
    setToggleError(null);
    try {
      mutate(
        await patchAgentExtension(params.agentId, ext.id, {
          enabled: !ext.enabled,
        })
      );
    } catch (cause) {
      setToggleError(
        cause instanceof Error ? cause.message : "Failed to update extension."
      );
    } finally {
      setBusy(false);
    }
  };
  const entry = createMemo(() =>
    (extensions() ?? []).find((candidate) => candidate.id === params.extensionId)
  );

  const backHref = createMemo(
    () => `/agents/${encodeURIComponent(params.agentId)}/edit`
  );

  return (
    <>
      <div class="ext-details">
        <A href={backHref()} class="ext-details-back" data-tour="back-to-agent">
          ← Back to agent
        </A>

        <Show when={extensions.loading}>
          <div class="ext-details-status">Loading extension…</div>
        </Show>
        <Show when={extensions.error}>
          <div class="ext-details-status ext-details-error">
            Failed to load extension.
          </div>
        </Show>
        <Show when={!extensions.loading && !extensions.error && !entry()}>
          <div class="ext-details-status ext-details-error">
            Extension not found.
          </div>
        </Show>

        <Show when={entry()}>
          {(ext) => (
            <>
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
              <p class="ext-details-desc">{ext().description}</p>

              <Show when={ext().oauth}>
                {(oauth) => (
                  <OAuthConnectCard
                    agentId={params.agentId}
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
                      if (connected && !ext().enabled && !busy() && !ext().managedAtRoot && ext().configurable !== false) void toggle(ext());
                    }}
                  >
                    <Show when={ext().tier === "auto-form"}>
                      <ExtensionConfigForm
                        entry={ext()}
                        scope={scope()}
                        onSaved={mutate}
                        registerConnectActions={(actions) => { settingsActions = actions; }}
                      />
                    </Show>
                  </OAuthConnectCard>
                )}
              </Show>

              <Show when={ext().tier === "auto-form" && !ext().oauth}>
                <ExtensionConfigForm
                  entry={ext()}
                  onSaved={mutate}
                  registerConnectActions={(actions) => { settingsActions = actions; }}
                />
              </Show>

              <Show
                when={
                  ext().tier === "bespoke-route" && ext().configRoutePath
                    ? ext().configRoutePath
                    : null
                }
                fallback={
                  <Show when={!ext().oauth && ext().tier !== "auto-form"}>
                    <button
                      type="button"
                      class="ext-details-configure"
                      disabled={
                        busy() ||
                        ext().managedAtRoot ||
                        (!ext().enabled && ext().configurable === false)
                      }
                      title={
                        ext().managedAtRoot
                          ? "Configured in agent.yaml — edit the file to change."
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
            </>
          )}
        </Show>
      </div>

      <style>{EXTENSION_DETAILS_STYLES}</style>
    </>
  );
}

export const EXTENSION_DETAILS_STYLES = `
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
      `;
