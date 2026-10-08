import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { useParams } from "@solidjs/router";
import {
  fetchAgentExtensions,
  patchAgentExtension,
  removeTeamExtensionCredentials,
  type ExtensionCatalogEntry,
} from "../api/extensions";
import { disconnectAgentConnection } from "../api/connections";
import {
  buildAutoFormFields,
  REDACTED_SECRET_VALUE,
  splitAutoFormValues,
  type AutoFormField,
  type AutoFormValues,
} from "../lib/auto-form-schema";
import { CredentialScopeTabs, preferredScope, type ScopeStatus } from "../components/CredentialScopeTabs";

const CONFIGURED: ScopeStatus = { tone: "ok", label: "Configured" };
const NOT_SET_UP: ScopeStatus = { tone: "off", label: "Not set up" };

/**
 * Schema-driven auto-form renderer (ALG-355). Builds a per-agent config form
 * from an extension's config JSON-schema and `requiredSecrets`, then submits
 * through the extension write path: secrets become `$env:` refs in agent.yaml
 * with the value stored in the agent's `.env`, non-secrets are written verbatim
 * into agent.yaml, and the extension is enabled. Rendered inside the extension
 * details page (`/agents/:agentId/extensions/:extensionId`, also served at the
 * legacy `.../config` path), which owns the back link and heading and passes
 * the catalog entry it already loaded.
 */
function WarningIcon() {
  return (
    <svg class="ext-config-warning-icon" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M8.6 3.3a1.6 1.6 0 0 1 2.8 0l6.2 11.1a1.6 1.6 0 0 1-1.4 2.4H3.8a1.6 1.6 0 0 1-1.4-2.4Z" />
      <path d="M10 8v3.5M10 14.2v.1" />
    </svg>
  );
}

/** Lets the OAuth card save pending settings itself when Connect is clicked before Save. */
export type ConnectSettingsActions = {
  hasUnsaved: () => boolean;
  /** Saves the pending settings and returns the OAuth scopes the selected tab now needs. */
  save: () => Promise<string[]>;
};

export function ExtensionConfigForm(props: {
  entry: ExtensionCatalogEntry;
  /** Selected tab for OAuth extensions, which share the OAuth card's Just me / Whole team tabs. */
  scope?: "personal" | "team";
  /** Called with the catalog returned by each successful save. */
  onSaved?: (extensions: ExtensionCatalogEntry[]) => void;
  registerConnectActions?: (actions: ConnectSettingsActions) => void;
}) {
  const params = useParams<{ agentId: string; extensionId: string }>();

  // Updated in place after saving, from the PATCH response.
  const [entry, setEntry] = createSignal<ExtensionCatalogEntry>(props.entry);

  const fields = createMemo(() => {
    const current = entry();
    if (!current) return [];
    return buildAutoFormFields(
      current.configJsonSchema,
      current.requiredSecrets,
      current.advancedConfigFields
    );
  });
  const baseFields = createMemo(() =>
    fields().filter((field) => !field.advanced)
  );
  const advancedFields = createMemo(() =>
    fields().filter((field) => field.advanced)
  );

  const [values, setValues] = createSignal<AutoFormValues>({});
  // What the selected tab currently has saved, to tell unsaved edits apart.
  const [savedValues, setSavedValues] = createSignal<AutoFormValues>({});
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [tabScope, setCredentialScope] = createSignal<"personal" | "team">("team");
  const credentialScope = () => props.scope ?? tabScope();
  // OAuth extensions without credential fields have no tabs of their own; the OAuth card owns them.
  const oauthScoped = () => !!entry().oauth && entry().personalSecretFields === undefined;
  let scopeInitialized = false;
  createEffect(() => {
    const current = entry();
    if (!current || scopeInitialized) return;
    scopeInitialized = true;
    if (current.personalSecretFields !== undefined) setCredentialScope(preferredScope(scopeStatus()));
  });

  // Non-admins may view, but not change, the admin-managed team credentials.
  const teamReadOnly = () => {
    const current = entry();
    return credentialScope() === "team" && (current?.personalSecretFields !== undefined || !!current?.oauth) && current?.canConfigureTeam === false;
  };
  const teamConfigured = () => {
    const current = entry();
    return !!current && fields().some((field) => field.secret && current.configValues[field.name] != null);
  };
  const scopeStatus = () => ({
    personal: entry()?.personalSecretFields?.length ? CONFIGURED : NOT_SET_UP,
    team: teamConfigured() ? CONFIGURED : NOT_SET_UP,
  });

  const personalTab = () => credentialScope() === "personal" && entry()?.personalSecretFields !== undefined;
  const hasCredentials = () => {
    const current = entry();
    if (!personalTab()) return teamConfigured();
    return !!current?.personalSecretFields?.length || Object.keys(current?.personalConfigValues ?? {}).length > 0;
  };

  const [confirmingRemove, setConfirmingRemove] = createSignal(false);
  const removeQuestion = () => personalTab()
    ? "Remove your personal credentials? Your requests will use the team credentials, if any."
    : "Remove the team credentials? Everyone without personal credentials loses access until they are set up again.";

  const removeCredentials = async () => {
    const personal = personalTab();
    setConfirmingRemove(false);
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = personal
        ? (await disconnectAgentConnection(params.agentId, "extension", params.extensionId), await fetchAgentExtensions(params.agentId))
        : await removeTeamExtensionCredentials(params.agentId, params.extensionId);
      const refreshed = updated.find((extension) => extension.id === params.extensionId);
      if (refreshed) setEntry(refreshed);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to remove credentials.");
    } finally {
      setSaving(false);
    }
  };

  const setValue = (name: string, value: string | number | boolean) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setSaved(false);
  };

  // Team setting values: the baseline personal overrides are compared against.
  const teamValues = createMemo(() => {
    const current = entry();
    const team: AutoFormValues = {};
    for (const field of fields()) {
      const value = current?.configValues[field.name];
      if (!field.secret && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
        team[field.name] = value;
      }
    }
    return team;
  });

  createEffect(() => {
    const current = entry();
    if (!current) return;
    const next: AutoFormValues = {};
    for (const field of fields()) {
      const value = oauthScoped() && credentialScope() === "personal" && field.type === "boolean"
        ? current.personalConfigValues?.[field.name] === true
        : credentialScope() === "personal"
        ? current.personalConfigValues?.[field.name] ?? current.configValues[field.name]
        : current.configValues[field.name];
      if (field.secret) {
        if (credentialScope() === "personal" ? current.personalSecretFields?.includes(field.name) : value !== undefined && value !== null) {
          next[field.name] = REDACTED_SECRET_VALUE;
        }
        continue;
      }
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        next[field.name] = value;
      }
    }
    setValues(next);
    setSavedValues(next);
  });

  const renderField = (field: AutoFormField) => (
    <div class="ext-config-field" classList={{ "ext-config-field-boolean": field.type === "boolean" }}>
      <Show when={field.type !== "boolean"}>
        <label class="ext-config-label" for={`ext-field-${field.name}`}>
          {field.label}
          <Show when={field.required}>
            <span class="ext-config-req"> *</span>
          </Show>
        </label>
      </Show>
      <Show when={field.type === "boolean"}>
        <label class="ext-config-checkbox-label">
          <input
            id={`ext-field-${field.name}`}
          type="checkbox"
          disabled={saving() || teamReadOnly()}
            checked={Boolean(values()[field.name])}
            onChange={(e) => setValue(field.name, e.currentTarget.checked)}
          />
          {field.label}
        </label>
      </Show>
      <Show when={field.type === "secret"}>
        <input
          id={`ext-field-${field.name}`}
          class="ext-config-input"
          type="password"
          disabled={saving() || teamReadOnly()}
          autocomplete="off"
          value={String(values()[field.name] ?? "")}
          onInput={(e) => setValue(field.name, e.currentTarget.value)}
        />
      </Show>
      <Show when={field.type === "number"}>
        <input
          id={`ext-field-${field.name}`}
          class="ext-config-input"
          type="number"
          disabled={saving() || teamReadOnly()}
          value={String(values()[field.name] ?? "")}
          onInput={(e) => setValue(field.name, e.currentTarget.value)}
        />
      </Show>
      <Show when={field.type === "text"}>
        <input
          id={`ext-field-${field.name}`}
          class="ext-config-input"
          type="text"
          disabled={saving() || teamReadOnly()}
          value={String(values()[field.name] ?? "")}
          onInput={(e) => setValue(field.name, e.currentTarget.value)}
        />
      </Show>
      <Show when={field.secret && entry()?.personalSecretFields === undefined}>
        <span class="ext-config-hint">Shared with the whole team.</span>
      </Show>
      <Show when={field.description}>
        {(text) => <span class="ext-config-hint">{text()}</span>}
      </Show>
    </div>
  );

  /** Validates and saves the form; returns the refreshed catalog entry. Throws with a user-facing message. */
  const submit = async (): Promise<ExtensionCatalogEntry | undefined> => {
    const current = entry();
    if (!current) return undefined;

    const formFields = fields();
    // Guard required fields client-side so a blank required secret doesn't
    // silently submit an empty patch. (The server also re-validates.)
    const missing = formFields.filter((field) => {
      if (credentialScope() === "team" && current.personalSecretFields !== undefined && field.secret) return false;
      if (!field.required) return false;
      const value = values()[field.name];
      if (field.type === "boolean") return false;
      return value === undefined || value === "" || value === null;
    });
    if (missing.length > 0) {
      throw new Error(`Fill in required field: ${missing.map((f) => f.label).join(", ")}`);
    }

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { config: submitted, secrets } = splitAutoFormValues(formFields, values());
      // Send only settings that differ from the team: keeps `$env:` refs intact, and
      // personal fields left at the team value keep following it. Personal OAuth
      // settings never follow the team value, so they are sent in full.
      const team = splitAutoFormValues(formFields, teamValues()).config;
      const personalOAuth = oauthScoped() && credentialScope() === "personal";
      const config = personalOAuth ? submitted : Object.fromEntries(Object.entries(submitted).filter(([name, value]) => team[name] !== value));
      const updated = await patchAgentExtension(params.agentId, params.extensionId, {
        ...(current.personalSecretFields !== undefined || oauthScoped() ? { credentialScope: credentialScope() } : {}),
        ...(credentialScope() === "team" ? { enabled: true } : {}),
        config,
        secrets,
      });
      const refreshed = updated.find((extension) => extension.id === params.extensionId);
      if (refreshed && (current.personalSecretFields !== undefined || oauthScoped())) setEntry(refreshed);
      props.onSaved?.(updated);
      setValues((previous) => Object.fromEntries(Object.entries(previous).map(([name, value]) => [name, value !== "" && formFields.some((field) => field.name === name && field.secret) ? REDACTED_SECRET_VALUE : value])));
      setSavedValues(values());
      setSaved(true);
      return refreshed;
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (saving()) return;
    try {
      await submit();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to save configuration."
      );
    }
  };

  // Editable settings the selected tab has not saved yet.
  const hasUnsaved = () => !teamReadOnly() && fields().some((field) =>
    !field.secret && (field.type === "boolean"
      ? Boolean(values()[field.name]) !== Boolean(savedValues()[field.name])
      : values()[field.name] !== savedValues()[field.name]));
  props.registerConnectActions?.({
    hasUnsaved,
    save: async () => {
      // Capture the tab before awaiting: the user may switch tabs while saving.
      const scope = credentialScope();
      const refreshed = await submit();
      const oauth = refreshed?.oauth;
      return (scope === "personal" ? oauth?.personalScopes ?? oauth?.scopes : oauth?.scopes) ?? [];
    },
  });

  const formBody = () => (
    <>
    <Show when={!teamReadOnly() || teamConfigured() || !!entry().oauth}>
    <For each={baseFields()}>{renderField}</For>

    <Show when={advancedFields().length > 0}>
      <div class="ext-config-advanced">
        <button
          type="button"
          class="ext-config-advanced-toggle"
          onClick={() => setAdvancedOpen((open) => !open)}
        >
          {advancedOpen()
            ? "Hide advanced settings"
            : "See advanced settings"}
        </button>
        <Show when={advancedOpen()}>
          <div class="ext-config-advanced-fields">
            <p class="ext-config-advanced-note">
              These are advanced settings and should only be
              edited if you know exactly what you're doing.
            </p>
            <For each={advancedFields()}>{renderField}</For>
          </div>
        </Show>
      </div>
    </Show>

    </Show>
    <Show when={!teamReadOnly()}>
    <Show when={confirmingRemove() && hasCredentials()}>
      <div class="ext-config-remove-confirm" role="alertdialog" aria-label="Confirm removing credentials">
        <WarningIcon />
        <p>{removeQuestion()}</p>
        <div class="ext-config-remove-confirm-actions">
          <button type="button" class="ext-config-remove-cancel" onClick={() => setConfirmingRemove(false)}>
            Cancel
          </button>
          <button type="button" class="ext-config-remove-confirm-button" disabled={saving()} onClick={() => void removeCredentials()}>
            Remove
          </button>
        </div>
      </div>
    </Show>
    <div class="ext-config-actions">
      <Show when={hasCredentials() && !confirmingRemove()}>
        <button
          type="button"
          class="ext-config-remove"
          disabled={saving()}
          onClick={() => setConfirmingRemove(true)}
        >
          <WarningIcon />
          {personalTab() ? "Remove my credentials" : "Remove team credentials"}
        </button>
      </Show>
      <Show when={saved()}>
        <span class="ext-config-saved">Saved ✓</span>
      </Show>
      <button
        type="submit"
        class="ext-config-save"
        disabled={saving()}
      >
        {saving() ? "Saving…" : "Save configuration"}
      </button>
    </div>
    </Show>
    <Show when={teamReadOnly() && entry().oauth}>
      <p class="ext-config-scope-note">These settings are managed by an admin.</p>
    </Show>
    <Show when={error()}>
      {(message) => (
        <p class="ext-config-form-error">{message()}</p>
      )}
    </Show>
    </>
  );

  return (
    <>
      <div class="ext-config">
        <Show when={entry()}>
          {(ext) => (
            <>
              <Show when={fields().length > 0}>
                <form class="ext-config-form" classList={{ "ext-config-panel": ext().personalSecretFields === undefined }} onSubmit={handleSubmit}>
                  <Show when={ext().personalSecretFields !== undefined} fallback={formBody()}>
                    <CredentialScopeTabs
                      value={credentialScope()}
                      teamLocked={!ext().canConfigureTeam}
                      status={scopeStatus()}
                      disabled={saving()}
                      onChange={(next) => { setCredentialScope(next); setSaved(false); setError(null); setConfirmingRemove(false); }}
                    >
                      <p class="ext-config-scope-note">
                        {credentialScope() === "personal"
                          ? "Your own credentials and settings, stored encrypted and used only for your requests. Fields left at the team value keep following it."
                          : teamReadOnly()
                            ? teamConfigured()
                              ? "Whole team credentials are managed by an admin. They are used when you have no credentials of your own."
                              : "Whole team credentials are not set up. An admin must configure them."
                            : "Shared with everyone on this agent who has no credentials of their own."}
                      </p>
                      {formBody()}
                    </CredentialScopeTabs>
                  </Show>
                </form>
              </Show>
            </>
          )}
        </Show>
      </div>

      <style>{`
        .ext-config-form {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .ext-config-panel {
          margin-top: 16px;
          padding: 20px;
          border: 1px solid var(--border-default);
          border-radius: 14px;
          background: var(--bg-surface);
        }
        .ext-config-form .cred-tabs-panel {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .ext-config-scope-note {
          margin: 0;
          font-size: 13px;
          line-height: 1.5;
          color: var(--text-secondary);
        }
        .ext-config-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ext-config-label {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .ext-config-req {
          color: #e55;
        }
        .ext-config-input {
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-raised);
          color: var(--text-primary);
          font-size: 14px;
        }
        .ext-config-checkbox-label {
          display: flex;
          align-items: center;
          gap: 10px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .ext-config-checkbox-label input {
          width: 16px;
          height: 16px;
          margin: 0;
          accent-color: var(--accent, #3b82f6);
        }
        .ext-config-hint {
          font-size: 12px;
          color: var(--text-tertiary);
        }
        .ext-config-field-boolean .ext-config-hint {
          padding-left: 26px;
          line-height: 1.5;
        }
        .ext-config-advanced {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .ext-config-advanced-toggle {
          align-self: flex-start;
          padding: 0;
          border: 0;
          background: transparent;
          color: var(--accent, #3b82f6);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .ext-config-advanced-fields {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .ext-config-advanced-note {
          margin: 0;
          font-size: 13px;
          color: #e55;
        }
        .ext-config-actions {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 4px;
        }
        .ext-config-save {
          margin-left: auto;
          padding: 8px 16px;
          border-radius: 6px;
          border: none;
          background: var(--accent, #3b82f6);
          color: #fff;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
        }
        .ext-config-save:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .ext-config-remove {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 0;
          border: 0;
          background: none;
          color: #dc2626;
          font: inherit;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
        }
        .ext-config-remove:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 3px; }
        .ext-config-remove:focus-visible { outline: 2px solid color-mix(in srgb, #dc2626 50%, transparent); outline-offset: 3px; border-radius: 3px; }
        .ext-config-remove:disabled { opacity: 0.5; cursor: not-allowed; }
        .ext-config-warning-icon { width: 15px; height: 15px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
        .ext-config-remove-confirm {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 10px 12px;
          margin-top: 4px;
          padding: 12px 14px;
          border: 1px solid color-mix(in srgb, #dc2626 35%, transparent);
          border-radius: 10px;
          background: color-mix(in srgb, #dc2626 6%, transparent);
          color: #dc2626;
        }
        .ext-config-remove-confirm p { flex: 1 1 260px; margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.45; }
        .ext-config-remove-confirm-actions { display: flex; gap: 8px; margin-left: auto; }
        .ext-config-remove-cancel, .ext-config-remove-confirm-button {
          padding: 6px 12px; border-radius: 6px; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
        }
        .ext-config-remove-cancel { border: 1px solid var(--border-default); background: var(--bg-surface); color: var(--text-primary); }
        .ext-config-remove-confirm-button { border: 1px solid #dc2626; background: #dc2626; color: #fff; }
        .ext-config-remove-confirm-button:disabled { opacity: 0.5; cursor: not-allowed; }
        .ext-config-saved {
          margin-left: auto;
          font-size: 13px;
          color: #16a34a;
          font-weight: 600;
        }
        .ext-config-saved + .ext-config-save { margin-left: 0; }
        .ext-config-form-error {
          font-size: 13px;
          color: #e55;
          margin: 0;
        }
      `}</style>
    </>
  );
}
