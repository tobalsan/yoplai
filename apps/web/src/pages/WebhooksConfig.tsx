import { A, useParams } from "@solidjs/router";
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import {
  fetchWebhooks,
  updateWebhook,
  type WebhookCredentials,
} from "../api/webhooks";
import { useSession } from "../auth/client";
import { LeftNavShell } from "../components/LeftNavShell";
import { ScopeIcon } from "../components/CredentialScopeTabs";
import { MODES, SCHEDULES_STYLES } from "./SchedulesPanel";

function WebhookUrl(props: { name: string; url: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.url);
      setCopied(true);
      clearTimeout(timer);
      timer = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div class="webhook-url">
      <input
        type="text"
        readonly
        value={props.url}
        aria-label={`Webhook URL for ${props.name}`}
        onFocus={(event) => event.currentTarget.select()}
      />
      <button
        type="button"
        aria-label={`Copy URL for ${props.name}`}
        onClick={() => void copy()}
      >
        {copied() ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function WebhooksConfigPage() {
  const params = useParams<{ agentId: string }>();
  const session = useSession();
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal<string[]>([]);
  // Optimistic on/off state while a toggle request is in flight.
  const [pending, setPending] = createSignal<Record<string, boolean>>({});
  const [loadError, setLoadError] = createSignal<string>();
  const [webhooks, { mutate, refetch }] = createResource(
    () => params.agentId,
    async (agentId) => {
      setLoadError(undefined);
      setError(undefined);
      setBusy([]);
      setPending({});
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
      const updated = await updateWebhook(agentId, webhook.name, {
        credentialMode,
      });
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

  const toggleEnabled = async (
    webhook: WebhookCredentials,
    enabled: boolean
  ) => {
    if (
      busy().includes(webhook.name) ||
      webhook.name in pending() ||
      isReadOnly(webhook)
    )
      return;
    const agentId = params.agentId;
    setError(undefined);
    setBusy((current) => [...current, webhook.name]);
    setPending((current) => ({ ...current, [webhook.name]: enabled }));
    try {
      const updated = await updateWebhook(agentId, webhook.name, { enabled });
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
    } finally {
      if (params.agentId === agentId) {
        setPending(({ [webhook.name]: _done, ...rest }) => rest);
        setBusy((current) => current.filter((name) => name !== webhook.name));
      }
    }
  };

  return (
    <LeftNavShell>
      <main class="webhooks-config">
        <style>{SCHEDULES_STYLES}</style>
        <style>{STYLES}</style>
        <A
          class="webhooks-back"
          href={`/agents/${encodeURIComponent(params.agentId)}/edit`}
        >
          Back to agent
        </A>
        <h1>Webhooks</h1>
        <p class="webhooks-description">
          Choose whose connections each webhook uses. Mine uses your personal
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
            Mine requires an authenticated user in multi-user mode.
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
          <ul class="schedule-list">
            <For each={webhooks()}>
              {(webhook) => {
                const readOnly = () => isReadOnly(webhook);
                const ownerOnlyTitle = "Only the owner can change this webhook";
                const enabled = () =>
                  pending()[webhook.name] ?? webhook.enabled;
                return (
                  <li
                    class="schedule"
                    data-paused={enabled() ? undefined : ""}
                    data-read-only={readOnly() ? "" : undefined}
                    aria-busy={busy().includes(webhook.name)}
                  >
                    <span class="schedule-mark" aria-hidden="true">
                      <svg viewBox="0 0 20 20">
                        <path d="M8 6h4M4 10h12M8 14h4M6 4L4 6l2 2M14 12l2 2-2 2" />
                      </svg>
                    </span>
                    <div class="schedule-main">
                      <div class="schedule-title">
                        <strong>{webhook.name}</strong>
                        <Show when={!enabled()}>
                          <span class="schedule-paused">Disabled</span>
                        </Show>
                      </div>
                      <WebhookUrl name={webhook.name} url={webhook.url} />
                      <Show when={webhook.credentialMode === "owner"}>
                        <p class="schedule-prompt">
                          {webhook.ownerUserId
                            ? `Owned by ${webhook.ownerUserId === session().data?.user.id ? "you" : webhook.ownerDisplayName || "another user"}`
                            : "Owner missing"}
                        </p>
                      </Show>
                    </div>
                    <div class="schedule-mode">
                      <span class="schedule-mode-label">Runs with</span>
                      <div
                        class="schedule-mode-switch"
                        role="radiogroup"
                        aria-label={`Credentials for ${webhook.name}`}
                      >
                        <For each={MODES}>
                          {(option) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={
                                webhook.credentialMode === option.mode
                              }
                              title={readOnly() ? ownerOnlyTitle : option.title}
                              disabled={
                                busy().includes(webhook.name) ||
                                readOnly() ||
                                (option.mode === "owner" &&
                                  !session().data?.user)
                              }
                              onClick={() =>
                                void changeMode(webhook, option.mode)
                              }
                            >
                              <ScopeIcon
                                scope={
                                  option.mode === "owner" ? "personal" : "team"
                                }
                                class="schedule-mode-icon"
                              />
                              {option.label}
                            </button>
                          )}
                        </For>
                      </div>
                    </div>
                    <div class="schedule-toggle">
                      <span class="schedule-mode-label" aria-hidden="true">
                        {enabled() ? "On" : "Off"}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        class="schedule-switch"
                        aria-checked={enabled()}
                        aria-label={`Enable ${webhook.name} webhook`}
                        title={
                          readOnly()
                            ? ownerOnlyTitle
                            : enabled()
                              ? "Disable this webhook"
                              : "Enable this webhook"
                        }
                        disabled={readOnly() || busy().includes(webhook.name)}
                        aria-busy={webhook.name in pending()}
                        onClick={() => void toggleEnabled(webhook, !enabled())}
                      >
                        <span class="schedule-switch-thumb" aria-hidden="true">
                          <Show when={readOnly()}>
                            <svg viewBox="0 0 12 12">
                              <rect
                                x="3"
                                y="5.5"
                                width="6"
                                height="4.5"
                                rx="1"
                              />
                              <path d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5" />
                            </svg>
                          </Show>
                        </span>
                      </button>
                    </div>
                  </li>
                );
              }}
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
.webhooks-retry:focus-visible, .webhooks-back:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.webhooks-note { margin: 0 0 16px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.webhook-url { display: flex; align-items: center; gap: 6px; min-width: 0; }
.webhook-url input { flex: 1; min-width: 0; padding: 3px 8px; border: 1px solid var(--border-subtle, var(--border-default)); border-radius: 6px; background: var(--bg-inset); color: var(--text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; }
.webhook-url button { flex: 0 0 auto; min-width: 56px; padding: 3px 10px; border: 1px solid var(--border-default); border-radius: 6px; background: var(--bg-surface); color: var(--text-primary); font: inherit; font-size: 12px; cursor: pointer; }
.webhook-url button:hover { background: var(--bg-inset); }
.webhook-url button:focus-visible, .webhook-url input:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.schedule[data-paused] .webhook-url { opacity: .6; }
@media (max-width: 768px) {
  .webhooks-config { padding: 72px 16px 24px; }
}
`;
