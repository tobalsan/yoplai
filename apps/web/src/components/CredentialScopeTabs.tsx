import { For, Show, type JSX } from "solid-js";

export type CredentialScope = "personal" | "team";

const TABS: { scope: CredentialScope; label: string; caption: string }[] = [
  { scope: "personal", label: "Just me", caption: "Only your requests" },
  { scope: "team", label: "Whole team", caption: "Fallback for everyone" },
];

function ScopeIcon(props: { scope: CredentialScope }) {
  return (
    <svg class="cred-tab-icon" viewBox="0 0 20 20" aria-hidden="true">
      <Show
        when={props.scope === "team"}
        fallback={
          <>
            <circle cx="10" cy="6.5" r="3.25" />
            <path d="M3.75 17c.6-3.2 3.1-5.25 6.25-5.25S15.65 13.8 16.25 17" />
          </>
        }
      >
        <circle cx="7.5" cy="6.75" r="2.75" />
        <path d="M2 16.5c.5-2.8 2.6-4.5 5.5-4.5s5 1.7 5.5 4.5" />
        <circle cx="14" cy="7.25" r="2.25" />
        <path d="M14.5 11.6c2 .3 3.2 1.8 3.5 4.4" />
      </Show>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg class="cred-tab-lock" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5.25a2.5 2.5 0 0 1 5 0V7" />
    </svg>
  );
}

/** Tabbed box separating personal ("Just me") from shared ("Whole team") credentials. */
export function CredentialScopeTabs(props: {
  value: CredentialScope;
  onChange: (scope: CredentialScope) => void;
  /** Personal credentials need a signed-in user. */
  personalDisabled?: boolean;
  /** Team credentials are visible but managed by an admin. */
  teamLocked?: boolean;
  disabled?: boolean;
  children: JSX.Element;
}) {
  const enabled = (scope: CredentialScope) =>
    !props.disabled && !(scope === "personal" && props.personalDisabled);

  const select = (scope: CredentialScope) => {
    if (scope !== props.value && enabled(scope)) props.onChange(scope);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = props.value === "personal" ? "team" : "personal";
    if (!enabled(next)) return;
    select(next);
    (event.currentTarget as HTMLElement)
      .querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)
      ?.focus();
  };

  return (
    <div class="cred-tabs" data-active={props.value}>
      <style>{CREDENTIAL_SCOPE_TABS_STYLES}</style>
      <div class="cred-tabs-list" role="tablist" aria-label="Credentials for" onKeyDown={onKeyDown}>
        <For each={TABS}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              class="cred-tab"
              data-scope={tab.scope}
              aria-selected={props.value === tab.scope}
              tabIndex={props.value === tab.scope ? 0 : -1}
              disabled={!enabled(tab.scope)}
              title={tab.scope === "personal" && props.personalDisabled ? "Sign in to use your own credentials" : undefined}
              onClick={() => select(tab.scope)}
            >
              <ScopeIcon scope={tab.scope} />
              <span class="cred-tab-text">
                <span class="cred-tab-label">
                  {tab.label}
                  <Show when={tab.scope === "team" && props.teamLocked}>
                    <span class="cred-tab-admin" title="Managed by an admin">
                      <LockIcon />
                      Admin only
                    </span>
                  </Show>
                </span>
                <span class="cred-tab-caption">{tab.caption}</span>
              </span>
            </button>
          )}
        </For>
      </div>
      <div class="cred-tabs-panel" role="tabpanel">
        {props.children}
      </div>
    </div>
  );
}

export const CREDENTIAL_SCOPE_TABS_STYLES = `
.cred-tabs { --cred-accent: var(--accent, #1a73e8); --cred-radius: 14px; }
.cred-tabs-list { display: flex; gap: 6px; position: relative; z-index: 1; }
.cred-tab {
  position: relative; display: flex; align-items: center; gap: 10px; min-width: 0;
  margin-bottom: -1px; padding: 10px 16px 11px 13px;
  border: 1px solid transparent; border-bottom: 0; border-radius: 11px 11px 0 0;
  background: transparent; color: var(--text-secondary); font: inherit; text-align: left; cursor: pointer;
  transition: background-color .16s ease, color .16s ease, border-color .16s ease;
}
.cred-tab::before {
  content: ""; position: absolute; left: 12px; right: 12px; top: -1px; height: 2px; border-radius: 0 0 2px 2px;
  background: var(--cred-accent); transform: scaleX(0); transition: transform .22s cubic-bezier(.2,.7,.2,1);
}
.cred-tab:hover:not(:disabled):not([aria-selected="true"]) {
  color: var(--text-primary); background: color-mix(in srgb, var(--text-primary) 4%, transparent);
}
.cred-tab[aria-selected="true"] {
  background: var(--bg-surface); border-color: var(--border-default); color: var(--text-primary); cursor: default;
}
.cred-tab[aria-selected="true"]::before { transform: scaleX(1); }
.cred-tab:focus-visible { outline: 2px solid color-mix(in srgb, var(--cred-accent) 55%, transparent); outline-offset: 2px; }
.cred-tab:disabled { opacity: .45; cursor: not-allowed; }
.cred-tab-icon {
  flex: 0 0 auto; width: 30px; height: 30px; padding: 6px; border-radius: 9px;
  fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round;
  background: color-mix(in srgb, var(--text-secondary) 10%, transparent);
  transition: background-color .16s ease, color .16s ease;
}
.cred-tab[aria-selected="true"] .cred-tab-icon {
  color: var(--cred-accent); background: color-mix(in srgb, var(--cred-accent) 12%, transparent);
}
.cred-tab-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cred-tab-label { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; line-height: 1.25; }
.cred-tab-caption { font-size: 12px; line-height: 1.3; color: var(--text-secondary); white-space: nowrap; }
.cred-tab-admin {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px 1px 4px; border-radius: 999px;
  font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
  color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 12%, transparent);
}
.cred-tab-lock { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.6; }
.cred-tabs-panel {
  border: 1px solid var(--border-default); border-radius: var(--cred-radius); background: var(--bg-surface); padding: 20px;
}
.cred-tabs[data-active="personal"] .cred-tabs-panel { border-top-left-radius: 0; }
@media (prefers-reduced-motion: reduce) {
  .cred-tab, .cred-tab::before, .cred-tab-icon { transition: none; }
}
`;
