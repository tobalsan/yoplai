import { A, useParams } from "@solidjs/router";
import { createResource, createSignal, For, Show } from "solid-js";
import {
  fetchWebhooks,
  updateWebhook,
  type WebhookCredentials,
} from "../api/webhooks";
import { useSession } from "../auth/client";
import { LeftNavShell } from "../components/LeftNavShell";
import { ScopeIcon } from "../components/CredentialScopeTabs";

const MODES = [
  { mode: "team", label: "Team" },
  { mode: "owner", label: "Me" },
] as const;

export default function WebhooksConfigPage() {
  const params = useParams<{ agentId: string }>();
  const session = useSession();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal<string[]>([]);
  const [loadError, setLoadError] = createSignal<string>();
  const [webhooks, { mutate, refetch }] = createResource(
    () => params.agentId,
    async (agentId) => {
      setLoadError(undefined);
      setError(undefined);
      setBusy([]);
      try {
        return await fetchWebhooks(agentId);
      } catch (cause) {
        if (params.agentId === agentId)
          setLoadError(
            cause instanceof Error
              ? cause.message
              : "Failed to load webhooks. Try again."
          );
        return [];
      }
    }
  );

  const isReadOnly = (webhook: WebhookCredentials) =>
    webhook.credentialMode === "owner" &&
    (!webhook.ownerUserId || webhook.ownerUserId !== session().data?.user.id);

  const changeMode = async (
    webhook: WebhookCredentials,
    credentialMode: WebhookCredentials["credentialMode"]
  ) => {
    if (
      busy().includes(webhook.name) ||
      (credentialMode === "owner" && !session().data?.user) ||
      isReadOnly(webhook) ||
      webhook.credentialMode === credentialMode
    )
      return;
    const agentId = params.agentId;
    setError(undefined);
    setBusy((current) => [...current, webhook.name]);
    try {
      const updated = await updateWebhook(
        agentId,
        webhook.name,
        credentialMode
      );
      if (params.agentId !== agentId) return;
      mutate((current) =>
        current?.map((item) => (item.name === webhook.name ? updated : item))
      );
    } catch (cause) {
      if (params.agentId !== agentId) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to update webhook. Try again."
      );
      mutate((current) =>
        current?.map((item) =>
          item.name === webhook.name ? { ...item } : item
        )
      );
    } finally {
      if (params.agentId === agentId)
        setBusy((current) => current.filter((name) => name !== webhook.name));
    }
  };

  return (
    <LeftNavShell>
      <main class="webhooks-config">
        <style>{STYLES}</style>
        <A
          class="webhooks-back"
          href={`/agents/${encodeURIComponent(params.agentId)}/edit`}
        >
          Back to agent
        </A>
        <h1>Webhooks</h1>
        <p class="webhooks-description">
          Choose whose connections each webhook uses. Me uses your personal
          connections, with team connections as a fallback.
        </p>
        <Show when={error()}>
          {(message) => (
            <p class="webhooks-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
        <Show when={!session().data?.user}>
          <p class="webhooks-note">
            Me requires an authenticated user in multi-user mode.
          </p>
        </Show>
        <Show when={webhooks.loading}>
          <p class="webhooks-note" role="status">
            Loading webhooks…
          </p>
        </Show>
        <Show when={loadError()}>
          {(message) => (
            <div class="webhooks-error" role="alert">
              {message()}{" "}
              <button
                type="button"
                class="webhooks-retry"
                onClick={() => void refetch()}
              >
                Retry
              </button>
            </div>
          )}
        </Show>
        <Show
          when={!webhooks.loading && !loadError() && webhooks()?.length === 0}
        >
          <p class="webhooks-note">No webhooks configured for this agent.</p>
        </Show>
        <Show when={(webhooks()?.length ?? 0) > 0}>
          <ul class="webhooks-list">
            <For each={webhooks()}>
              {(webhook) => (
                <li
                  class="webhook-row"
                  aria-busy={busy().includes(webhook.name)}
                >
                  <div class="webhook-info">
                    <h2>{webhook.name}</h2>
                    <Show when={webhook.credentialMode === "owner"}>
                      <p>
                        {webhook.ownerUserId
                          ? `Owned by ${webhook.ownerUserId === session().data?.user.id ? "you" : webhook.ownerDisplayName || "another user"}`
                          : "Owner missing"}
                      </p>
                    </Show>
                  </div>
                  <fieldset
                    class="webhook-mode"
                    aria-label={`Run as for ${webhook.name}`}
                  >
                    <legend>Run as</legend>
                    <div class="webhook-mode-switch">
                      <For each={MODES}>
                        {(option) => (
                          <label>
                            <input
                              type="radio"
                              name={`run-as-${webhook.name}`}
                              value={option.mode}
                              disabled={
                                busy().includes(webhook.name) ||
                                isReadOnly(webhook) ||
                                (option.mode === "owner" &&
                                  !session().data?.user)
                              }
                              title={
                                isReadOnly(webhook)
                                  ? "Only the owner can change this webhook"
                                  : undefined
                              }
                              checked={webhook.credentialMode === option.mode}
                              onChange={() =>
                                void changeMode(webhook, option.mode)
                              }
                            />
                            <span>
                              <ScopeIcon
                                scope={
                                  option.mode === "owner" ? "personal" : "team"
                                }
                                class="webhook-mode-icon"
                              />
                              {option.label}
                            </span>
                          </label>
                        )}
                      </For>
                    </div>
                    <Show when={busy().includes(webhook.name)}>
                      <p class="webhook-saving" role="status">
                        Saving…
                      </p>
                    </Show>
                  </fieldset>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </main>
    </LeftNavShell>
  );
}

const STYLES = `
.webhooks-config { max-width: 860px; margin: 0 auto; padding: 32px 24px; }
.webhooks-back { color: var(--text-secondary); font-size: 13px; text-decoration: none; }
.webhooks-back:hover { color: var(--text-primary); text-decoration: underline; }
.webhooks-config h1 { margin: 24px 0 8px; color: var(--text-primary); font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
.webhooks-description { max-width: 70ch; margin: 0 0 24px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.webhooks-error { margin: 0 0 16px; color: var(--tone-error); font-size: 13px; }
.webhooks-retry { margin-left: 8px; padding: 8px 12px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-surface); color: var(--text-primary); font: inherit; cursor: pointer; }
.webhooks-retry:hover { background: var(--bg-inset); }
.webhooks-retry:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.webhooks-note { margin: 0 0 16px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.webhooks-list { margin: 0; padding: 0; list-style: none; border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface); }
.webhook-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 16px 20px; }
.webhook-row + .webhook-row { border-top: 1px solid var(--border-subtle, var(--border-default)); }
.webhook-info { min-width: 0; }
.webhook-info h2 { margin: 0; overflow-wrap: anywhere; color: var(--text-primary); font-size: 14px; font-weight: 600; }
.webhook-info p { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; }
.webhook-mode { flex: 0 0 auto; margin: 0; padding: 0; border: 0; }
.webhook-mode legend { margin-bottom: 4px; padding: 0; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.webhook-mode-switch { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border-subtle, var(--border-default)); border-radius: 9px; background: var(--bg-inset); }
.webhook-mode-switch label { position: relative; cursor: pointer; }
.webhook-mode-switch input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.webhook-mode-switch span { display: flex; align-items: center; justify-content: center; gap: 4px; min-height: 40px; padding: 0 12px; border-radius: 7px; color: var(--text-secondary); font-size: 12px; }
.webhook-mode-switch input:checked + span { background: var(--bg-surface); color: var(--text-primary); font-weight: 600; }
.webhook-mode-switch label:hover span { color: var(--text-primary); }
.webhook-mode-switch input:focus-visible + span, .webhooks-back:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.webhook-saving { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; }
.webhook-mode-icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
.webhook-mode-switch input:disabled + span { opacity: .55; cursor: not-allowed; }
.webhook-mode-switch input:checked + span .webhook-mode-icon { color: var(--accent); }
@media (max-width: 768px) {
  .webhooks-config { padding: 72px 16px 24px; }
}
@media (max-width: 480px) {
  .webhook-row { flex-wrap: wrap; gap: 12px; padding: 16px; }
  .webhook-info { flex-basis: 100%; }
}
`;
