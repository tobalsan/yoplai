import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { useParams } from "@solidjs/router";
import {
  patchAgentExtension,
  type ExtensionCatalogEntry,
} from "../api/extensions";
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
export function ExtensionConfigForm(props: { entry: ExtensionCatalogEntry }) {
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
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  const [credentialScope, setCredentialScope] = createSignal<"personal" | "team">("team");
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
    return credentialScope() === "team" && current?.personalSecretFields !== undefined && !current.canConfigureTeam;
  };
  const teamConfigured = () => {
    const current = entry();
    return !!current && fields().some((field) => field.secret && current.configValues[field.name] != null);
  };
  const scopeStatus = () => ({
    personal: entry()?.personalSecretFields?.length ? CONFIGURED : NOT_SET_UP,
    team: teamConfigured() ? CONFIGURED : NOT_SET_UP,
  });

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
      const value = credentialScope() === "personal"
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
  });

  const renderField = (field: AutoFormField) => (
    <div class="ext-config-field">
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

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (saving()) return;
    const current = entry();
    if (!current) return;

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
      setError(`Fill in required field: ${missing.map((f) => f.label).join(", ")}`);
      return;
    }

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { config: submitted, secrets } = splitAutoFormValues(formFields, values());
      // Send only settings that differ from the team: keeps `$env:` refs intact, and
      // personal fields left at the team value keep following it.
      const team = splitAutoFormValues(formFields, teamValues()).config;
      const config = Object.fromEntries(Object.entries(submitted).filter(([name, value]) => team[name] !== value));
      const updated = await patchAgentExtension(params.agentId, params.extensionId, {
        ...(current.personalSecretFields !== undefined ? { credentialScope: credentialScope() } : {}),
        ...(credentialScope() === "team" ? { enabled: true } : {}),
        config,
        secrets,
      });
      const refreshed = updated.find((extension) => extension.id === params.extensionId);
      if (refreshed && current.personalSecretFields !== undefined) setEntry(refreshed);
      setValues((previous) => Object.fromEntries(Object.entries(previous).map(([name, value]) => [name, value !== "" && formFields.some((field) => field.name === name && field.secret) ? REDACTED_SECRET_VALUE : value])));
      setSaved(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to save configuration."
      );
    } finally {
      setSaving(false);
    }
  };

  const formBody = () => (
    <>
    <Show when={!teamReadOnly() || teamConfigured()}>
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
    <div class="ext-config-actions">
      <button
        type="submit"
        class="ext-config-save"
        disabled={saving()}
      >
        {saving() ? "Saving…" : "Save configuration"}
      </button>
      <Show when={saved()}>
        <span class="ext-config-saved">Saved ✓</span>
      </Show>
    </div>
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
                <form class="ext-config-form" onSubmit={handleSubmit}>
                  <Show when={ext().personalSecretFields !== undefined} fallback={formBody()}>
                    <CredentialScopeTabs
                      value={credentialScope()}
                      teamLocked={!ext().canConfigureTeam}
                      status={scopeStatus()}
                      disabled={saving()}
                      onChange={(next) => { setCredentialScope(next); setSaved(false); setError(null); }}
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
          gap: 8px;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .ext-config-hint {
          font-size: 12px;
          color: var(--text-tertiary);
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
        .ext-config-saved {
          font-size: 13px;
          color: #16a34a;
          font-weight: 600;
        }
        .ext-config-form-error {
          font-size: 13px;
          color: #e55;
          margin: 0;
        }
      `}</style>
    </>
  );
}
