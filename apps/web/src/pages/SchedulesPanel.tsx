import cronstrue from "cronstrue";
import { createResource, createSignal, For, Show } from "solid-js";
import { fetchSchedules, updateSchedule, type ScheduleJob } from "../api/schedules";
import { ScopeIcon } from "../components/CredentialScopeTabs";

type CredentialMode = "owner" | "team";

const MODES: { mode: CredentialMode; label: string; title: string }[] = [
  { mode: "owner", label: "Mine", title: "Run with your own connections" },
  { mode: "team", label: "Team", title: "Run with the team connections" },
];

const use24Hour = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hour12 === false;

/** Plain-language recurrence, e.g. "Every day at 05:45" or "Monday and Thursday at 07:30". */
export function describeSchedule(schedule: ScheduleJob["schedule"]): string {
  if (schedule.runAt) {
    const when = new Date(schedule.runAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return `Once, ${when}`;
  }
  const cron = schedule.cron ?? "";
  let text: string;
  try {
    text = cronstrue.toString(cron, { use24HourTimeFormat: use24Hour, throwExceptionOnParseError: true });
  } catch {
    return cron;
  }
  // cronstrue leads with the time ("At 07:30, only on Monday"); lead with the days instead.
  const match = /^At ([^,]+)(?:, (.+))?$/.exec(text);
  if (!match) return text;
  const [, time, days] = match;
  if (!days) return `Every day at ${time}`;
  const rest = days.replace(/^only on /, "");
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)} at ${time}`;
}

function jobSummary(job: ScheduleJob): string | undefined {
  if (job.payload.message) return job.payload.message;
  if (job.payload.script) return `Runs ${job.payload.script}`;
  return undefined;
}

export function SchedulesPanel(props: { agentId: string; agentName: string }) {
  const [jobs, { refetch }] = createResource(() => props.agentId, fetchSchedules);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string>();

  const changeMode = async (job: ScheduleJob, credentialMode: CredentialMode) => {
    if (busy() || (job.credentialMode ?? "team") === credentialMode) return;
    setBusy(job.id);
    setError(null);
    try {
      await updateSchedule(props.agentId, job.id, credentialMode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update scheduled job.");
    } finally {
      await refetch();
      setBusy(undefined);
    }
  };

  return (
    <section class="schedules" role="tabpanel">
      <style>{SCHEDULES_STYLES}</style>
      <header class="schedules-head">
        <h2>Scheduled jobs</h2>
        <p>Jobs this agent runs on its own. Ask it in chat to change or remove one.</p>
      </header>
      <Show when={error()}>{(text) => <p class="schedules-error" role="alert">{text()}</p>}</Show>
      <Show when={jobs.loading}><p class="schedules-note">Loading scheduled jobs…</p></Show>
      <Show when={jobs.error}><p class="schedules-error">Failed to load scheduled jobs.</p></Show>
      <Show when={!jobs.loading && !jobs.error && jobs()?.length === 0}>
        <p class="schedules-note">No scheduled jobs yet.</p>
      </Show>
      <Show when={(jobs()?.length ?? 0) > 0}>
        <ul class="schedule-list">
          <For each={jobs() ?? []}>{(job) => {
            const mode = () => job.credentialMode ?? "team";
            return (
              <li class="schedule" data-paused={job.enabled === false ? "" : undefined}>
                <span class="schedule-mark" aria-hidden="true">
                  <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 1.75" /></svg>
                </span>
                <div class="schedule-main">
                  <div class="schedule-title">
                    <strong>{job.name}</strong>
                    <Show when={job.enabled === false}><span class="schedule-paused">Paused</span></Show>
                  </div>
                  <div class="schedule-when">
                    <span>{describeSchedule(job.schedule)}</span>
                    <Show when={job.schedule.tz}><span class="schedule-tz">{job.schedule.tz}</span></Show>
                  </div>
                  <Show when={jobSummary(job)}>
                    {(summary) => <p class="schedule-prompt" title={summary()}>{summary()}</p>}
                  </Show>
                </div>
                <div class="schedule-mode">
                  <span class="schedule-mode-label">Runs with</span>
                  <div class="schedule-mode-switch" role="radiogroup" aria-label={`Credentials for ${job.name}`}>
                    <For each={MODES}>{(option) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={mode() === option.mode}
                        title={option.title}
                        disabled={busy() !== undefined}
                        onClick={() => void changeMode(job, option.mode)}
                      >
                        <ScopeIcon scope={option.mode === "owner" ? "personal" : "team"} class="schedule-mode-icon" />
                        {option.label}
                      </button>
                    )}</For>
                  </div>
                </div>
              </li>
            );
          }}</For>
        </ul>
      </Show>
      <Show when={!jobs.loading && !jobs.error}>
        <p class="schedules-hint">If you want to add a new job, just ask {props.agentName}!</p>
      </Show>
    </section>
  );
}

const SCHEDULES_STYLES = `
.schedules { max-width: 860px; margin-top: 28px; }
.schedules-head h2 { margin: 0 0 4px; color: var(--text-primary); font-size: 18px; font-weight: 650; letter-spacing: -0.01em; }
.schedules-head p { margin: 0 0 18px; color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
.schedules-note { margin: 0 0 12px; color: var(--text-secondary); font-size: 13px; }
.schedules-hint { margin: 14px 2px 0; color: var(--text-secondary); font-size: 13px; }
.schedules-error { margin: 0 0 12px; color: var(--tone-error, #dc2626); font-size: 13px; }
.schedule-list {
  margin: 0; padding: 0; list-style: none; overflow: hidden;
  border: 1px solid var(--border-default); border-radius: 14px; background: var(--bg-surface);
}
.schedule { display: flex; align-items: center; gap: 14px; padding: 14px 18px; transition: background-color .15s ease; }
.schedule + .schedule { border-top: 1px solid var(--border-subtle, var(--border-default)); }
.schedule:hover { background: color-mix(in srgb, var(--text-primary) 2.5%, transparent); }
.schedule-mark {
  flex: 0 0 auto; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
  color: var(--accent, #1a73e8); background: color-mix(in srgb, var(--accent, #1a73e8) 10%, transparent);
}
.schedule[data-paused] .schedule-mark { color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 10%, transparent); }
.schedule-mark svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.schedule-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.schedule-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.schedule-title strong { color: var(--text-primary); font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.schedule[data-paused] .schedule-title strong { color: var(--text-secondary); }
.schedule-paused {
  flex: 0 0 auto; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600;
  color: var(--text-secondary); background: color-mix(in srgb, var(--text-secondary) 12%, transparent);
}
.schedule-when { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--text-primary); font-size: 13px; }
.schedule-tz {
  padding: 1px 7px; border-radius: 6px; font-size: 11px; font-variant-numeric: tabular-nums;
  color: var(--text-secondary); background: var(--bg-inset, color-mix(in srgb, var(--text-primary) 5%, transparent));
}
.schedule-prompt {
  margin: 1px 0 0; color: var(--text-tertiary, var(--text-secondary)); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.schedule-mode { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; }
.schedule-mode-label { color: var(--text-secondary); font-size: 11px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; }
.schedule-mode-switch {
  display: inline-flex; padding: 2px; gap: 2px; border-radius: 9px;
  background: var(--bg-inset, color-mix(in srgb, var(--text-primary) 6%, transparent));
  border: 1px solid var(--border-subtle, var(--border-default));
}
.schedule-mode-switch button {
  display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px 4px 7px; border: 0; border-radius: 7px;
  background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer;
  transition: background-color .15s ease, color .15s ease, box-shadow .15s ease;
}
.schedule-mode-switch button:hover:not(:disabled):not([aria-checked="true"]) { color: var(--text-primary); }
.schedule-mode-switch button[aria-checked="true"] {
  background: var(--bg-surface); color: var(--text-primary); font-weight: 600;
  box-shadow: 0 1px 2px color-mix(in srgb, #000 12%, transparent);
}
.schedule-mode-switch button:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #1a73e8) 55%, transparent); outline-offset: 1px; }
.schedule-mode-switch button:disabled { cursor: progress; }
.schedule-mode-icon { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; }
.schedule-mode-switch button[aria-checked="true"] .schedule-mode-icon { color: var(--accent, #1a73e8); }
@media (max-width: 640px) {
  .schedule { flex-wrap: wrap; }
  .schedule-mode { flex-direction: row; align-items: center; margin-left: 48px; }
}
@media (prefers-reduced-motion: reduce) {
  .schedule, .schedule-mode-switch button { transition: none; }
}
`;
