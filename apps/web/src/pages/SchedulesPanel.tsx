import cronstrue from "cronstrue";
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { deleteSchedule, fetchSchedules, updateSchedule, type ScheduleJob } from "../api/schedules";
import { ScopeIcon } from "../components/CredentialScopeTabs";
import { useSession } from "../auth/client";

type CredentialMode = "owner" | "team";

const MODES: { mode: CredentialMode; label: string; title: string }[] = [
  { mode: "owner", label: "Mine", title: "Run with your own connections" },
  { mode: "team", label: "Team", title: "Run with team connections; visible to everyone on the agent" },
];

const STAFF_ROLES = ["admin", "superadmin"];

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
  const session = useSession();
  const [jobs, { refetch }] = createResource(() => props.agentId, fetchSchedules);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string>();
  // Optimistic on/off state while a toggle request is in flight.
  const [pending, setPending] = createSignal<Record<string, boolean>>({});
  // Single-user mode has no session: everyone manages every job (server enforces the same).
  const isAdmin = () => {
    const user = session().data?.user as { role?: string | string[] | null } | undefined;
    if (!user) return true;
    const roles = Array.isArray(user.role) ? user.role : (user.role ?? "").split(",");
    return roles.some((role) => STAFF_ROLES.includes(role.trim()));
  };

  const changeMode = async (job: ScheduleJob, credentialMode: CredentialMode) => {
    if (busy() || (job.credentialMode ?? "team") === credentialMode) return;
    setBusy(job.id);
    setError(null);
    try {
      await updateSchedule(props.agentId, job.id, { credentialMode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update scheduled job.");
    } finally {
      await refetch();
      setBusy(undefined);
    }
  };

  const toggleEnabled = async (job: ScheduleJob, enabled: boolean) => {
    if (job.id in pending()) return;
    setPending((current) => ({ ...current, [job.id]: enabled }));
    setError(null);
    try {
      await updateSchedule(props.agentId, job.id, { enabled });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update scheduled job.");
    } finally {
      await refetch();
      setPending(({ [job.id]: _done, ...rest }) => rest);
    }
  };

  const [confirming, setConfirming] = createSignal<ScheduleJob>();
  const [deleting, setDeleting] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);
  let deleteTrigger: HTMLButtonElement | undefined;

  const openDelete = (job: ScheduleJob, trigger: HTMLButtonElement) => {
    deleteTrigger = trigger;
    setDeleteError(null);
    setConfirming(job);
  };
  const closeDelete = () => {
    if (deleting()) return;
    setConfirming(undefined);
    deleteTrigger?.focus();
  };
  const confirmDelete = async () => {
    const job = confirming();
    if (!job || deleting()) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteSchedule(props.agentId, job.id);
      setConfirming(undefined);
      await refetch();
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : "Failed to delete scheduled job.");
    } finally {
      setDeleting(false);
    }
  };
  createEffect(() => {
    if (!confirming()) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeDelete(); };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });

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
            const enabled = () => pending()[job.id] ?? job.enabled !== false;
            const canToggle = () => mode() === "owner" || isAdmin();
            const deleteTitle = () => canToggle() ? `Delete ${job.name}` : "Only admins can delete Team jobs";
            const toggleTitle = () => canToggle()
              ? (enabled() ? "Pause this job" : "Resume this job")
              : "Only admins can pause or resume Team jobs";
            return (
              <li class="schedule" data-paused={enabled() ? undefined : ""}>
                <span class="schedule-mark" aria-hidden="true">
                  <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.5 1.75" /></svg>
                </span>
                <div class="schedule-main">
                  <div class="schedule-title">
                    <strong>{job.name}</strong>
                    <Show when={!enabled()}><span class="schedule-paused">Paused</span></Show>
                  </div>
                  <div class="schedule-when">
                    <span>{describeSchedule(job.schedule)}</span>
                    <Show when={job.schedule.tz}><span class="schedule-tz">{job.schedule.tz}</span></Show>
                  </div>
                  <Show when={jobSummary(job)}>
                    {(summary) => <p class="schedule-prompt" title={summary()}>{summary()}</p>}
                  </Show>
                  <Show when={mode() === "team" && job.createdByUserId && (job.createdByUserId === session().data?.user.id || job.createdByDisplayName)}>
                    <p class="schedule-prompt">Created by {job.createdByUserId === session().data?.user.id ? "you" : job.createdByDisplayName}</p>
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
                <div class="schedule-toggle">
                  <span class="schedule-mode-label" aria-hidden="true">{enabled() ? "On" : "Off"}</span>
                  <button
                    type="button"
                    role="switch"
                    class="schedule-switch"
                    aria-checked={enabled()}
                    aria-label={`Run ${job.name} on schedule`}
                    title={toggleTitle()}
                    disabled={!canToggle()}
                    aria-busy={job.id in pending()}
                    onClick={() => void toggleEnabled(job, !enabled())}
                  >
                    <span class="schedule-switch-thumb" aria-hidden="true">
                      <Show when={!canToggle()}>
                        <svg viewBox="0 0 12 12"><rect x="3" y="5.5" width="6" height="4.5" rx="1" /><path d="M4.25 5.5V4a1.75 1.75 0 0 1 3.5 0v1.5" /></svg>
                      </Show>
                    </span>
                  </button>
                </div>
                <button
                  type="button"
                  class="schedule-delete"
                  aria-label={`Delete ${job.name}`}
                  title={deleteTitle()}
                  disabled={!canToggle()}
                  onClick={(event) => openDelete(job, event.currentTarget)}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6h12M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.75 9v4M11.25 9v4" /></svg>
                </button>
              </li>
            );
          }}</For>
        </ul>
      </Show>
      <Show when={confirming()}>{(job) => (
        <div class="schedule-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDelete(); }}>
          <div class="schedule-dialog" role="alertdialog" aria-modal="true" aria-labelledby="schedule-delete-title" aria-describedby="schedule-delete-desc">
            <h3 id="schedule-delete-title">Delete “{job().name}”?</h3>
            <p id="schedule-delete-desc">
              {props.agentName} will stop running it {describeSchedule(job().schedule).replace(/^./, (c) => c.toLowerCase())}.
              {(job().credentialMode ?? "team") === "team" ? " It's a Team job, so this removes it for everyone." : ""}
              {" "}This can't be undone. To stop it temporarily, switch it off instead.
            </p>
            <Show when={deleteError()}>{(text) => <p class="schedules-error" role="alert">{text()}</p>}</Show>
            <div class="schedule-dialog-actions">
              <button type="button" class="schedule-dialog-cancel" ref={(el) => queueMicrotask(() => el.focus())} disabled={deleting()} onClick={closeDelete}>Cancel</button>
              <button type="button" class="schedule-dialog-danger" disabled={deleting()} onClick={() => void confirmDelete()}>
                {deleting() ? "Deleting…" : "Delete job"}
              </button>
            </div>
          </div>
        </div>
      )}</Show>
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
.schedule[data-paused] .schedule-when, .schedule[data-paused] .schedule-prompt { opacity: .6; }
.schedule-toggle {
  flex: 0 0 auto; display: flex; flex-direction: column; align-items: center; gap: 5px;
  padding-left: 14px; border-left: 1px solid var(--border-subtle, var(--border-default));
}
.schedule-toggle .schedule-mode-label { min-width: 3ch; text-align: center; }
.schedule-switch {
  position: relative; width: 36px; height: 22px; padding: 0; border: 0; border-radius: 999px; cursor: pointer;
  background: color-mix(in srgb, var(--text-secondary) 28%, transparent);
  transition: background-color .2s ease;
}
.schedule-switch[aria-checked="true"] { background: var(--accent, #1a73e8); }
.schedule-switch-thumb {
  position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%;
  display: grid; place-items: center; background: #fff; color: var(--text-secondary);
  box-shadow: 0 1px 2px color-mix(in srgb, #000 22%, transparent);
  transition: transform .2s cubic-bezier(.3, .7, .4, 1);
}
.schedule-switch[aria-checked="true"] .schedule-switch-thumb { transform: translateX(14px); }
.schedule-switch-thumb svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
.schedule-switch:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #1a73e8) 55%, transparent); outline-offset: 2px; }
.schedule-switch[aria-busy="true"] { cursor: progress; }
.schedule-switch:disabled { cursor: not-allowed; opacity: .55; }
.schedule-delete {
  flex: 0 0 auto; display: grid; place-items: center; width: 30px; height: 30px; margin-left: -4px; padding: 0;
  border: 0; border-radius: 8px; background: transparent; color: var(--text-secondary); cursor: pointer;
  transition: background-color .15s ease, color .15s ease;
}
.schedule-delete svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.schedule-delete:hover:not(:disabled) { color: var(--tone-error, #dc2626); background: color-mix(in srgb, var(--tone-error, #dc2626) 10%, transparent); }
.schedule-delete:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #1a73e8) 55%, transparent); outline-offset: 1px; }
.schedule-delete:disabled { cursor: not-allowed; opacity: .35; }
.schedule-dialog-backdrop {
  position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px;
  background: color-mix(in srgb, #000 40%, transparent); animation: schedule-fade .15s ease;
}
.schedule-dialog {
  width: min(420px, 100%); padding: 22px 22px 18px; border-radius: 14px;
  background: var(--bg-surface); border: 1px solid var(--border-default);
  box-shadow: 0 18px 48px color-mix(in srgb, #000 28%, transparent); animation: schedule-pop .18s cubic-bezier(.3, .7, .4, 1);
}
.schedule-dialog h3 { margin: 0 0 8px; color: var(--text-primary); font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.schedule-dialog p { margin: 0 0 14px; color: var(--text-secondary); font-size: 13px; line-height: 1.55; }
.schedule-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.schedule-dialog-actions button {
  padding: 7px 14px; border-radius: 8px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background-color .15s ease, filter .15s ease;
}
.schedule-dialog-actions button:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent, #1a73e8) 55%, transparent); outline-offset: 2px; }
.schedule-dialog-actions button:disabled { cursor: progress; opacity: .7; }
.schedule-dialog-cancel { border: 1px solid var(--border-default); background: transparent; color: var(--text-primary); }
.schedule-dialog-cancel:hover:not(:disabled) { background: color-mix(in srgb, var(--text-primary) 5%, transparent); }
.schedule-dialog-danger { border: 1px solid transparent; background: var(--tone-error, #dc2626); color: #fff; }
.schedule-dialog-danger:hover:not(:disabled) { filter: brightness(.92); }
@keyframes schedule-fade { from { opacity: 0; } }
@keyframes schedule-pop { from { opacity: 0; transform: translateY(6px) scale(.98); } }
@media (max-width: 640px) {
  .schedule { flex-wrap: wrap; }
  .schedule-mode { flex-direction: row; align-items: center; margin-left: 48px; }
  .schedule-toggle { flex-direction: row; padding-left: 0; border-left: 0; margin-left: auto; }
  .schedule-delete { margin-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .schedule, .schedule-mode-switch button, .schedule-switch, .schedule-switch-thumb, .schedule-delete { transition: none; }
  .schedule-dialog-backdrop, .schedule-dialog { animation: none; }
}
`;
