import { createResource, createSignal, For, Show } from "solid-js";
import { createSchedule, fetchSchedules, updateSchedule, type ScheduleJob } from "../api/schedules";

export function SchedulesPanel(props: { agentId: string; defaultMode: "owner" | "team" }) {
  const [jobs, { refetch }] = createResource(() => props.agentId, fetchSchedules);
  const [name, setName] = createSignal("");
  const [cron, setCron] = createSignal("0 8 * * *");
  const [tz, setTz] = createSignal(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [message, setMessage] = createSignal("");
  const [mode, setMode] = createSignal<"owner" | "team">(props.defaultMode);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [modeBusy, setModeBusy] = createSignal(false);

  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await createSchedule({
        agentId: props.agentId,
        name: name(),
        schedule: { cron: cron(), tz: tz() },
        payload: { message: message() },
        credentialMode: mode(),
      });
      setName("");
      setMessage("");
      await refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create scheduled job.");
    } finally {
      setBusy(false);
    }
  };

  const changeMode = async (job: ScheduleJob, credentialMode: "owner" | "team", select: HTMLSelectElement) => {
    if (modeBusy()) {
      select.value = job.credentialMode ?? "team";
      return;
    }
    setModeBusy(true);
    setError(null);
    try {
      await updateSchedule(props.agentId, job.id, credentialMode);
      await refetch();
    } catch (cause) {
      select.value = job.credentialMode ?? "team";
      setError(cause instanceof Error ? cause.message : "Failed to update scheduled job.");
      await refetch();
    } finally {
      setModeBusy(false);
    }
  };

  return (
    <section class="edit-agent-schedules" role="tabpanel">
      <h2 class="edit-agent-section-title">Scheduled jobs</h2>
      <Show when={jobs.loading}><p>Loading scheduled jobs…</p></Show>
      <Show when={jobs.error}><p>Failed to load scheduled jobs.</p></Show>
      <Show when={!jobs.loading && !jobs.error && jobs()?.length === 0}><p>No scheduled jobs yet.</p></Show>
      <ul class="edit-agent-schedule-list">
        <For each={jobs() ?? []}>{(job) => (
          <li class="edit-agent-schedule-item">
            <div>
              <strong>{job.name}</strong>
              <span>{job.schedule.runAt ?? `${job.schedule.cron} · ${job.schedule.tz}`}</span>
              <span>Owner: {job.ownerUserId ? "Your account" : "None"}</span>
            </div>
            <label>
              Credentials
              <select
                aria-label={`Credentials for ${job.name}`}
                value={job.credentialMode ?? "team"}
                disabled={busy() || modeBusy()}
                onChange={(event) => void changeMode(job, event.currentTarget.value as "owner" | "team", event.currentTarget)}
              >
                <option value="owner">Owner</option>
                <option value="team">Team</option>
              </select>
            </label>
          </li>
        )}</For>
      </ul>
      <form class="edit-agent-schedule-form" onSubmit={(event) => void create(event)}>
        <h3>Create scheduled job</h3>
        <label>Name<input required value={name()} onInput={(event) => setName(event.currentTarget.value)} /></label>
        <label>Prompt<textarea required value={message()} onInput={(event) => setMessage(event.currentTarget.value)} /></label>
        <div class="edit-agent-schedule-fields">
          <label>Cron<input required value={cron()} onInput={(event) => setCron(event.currentTarget.value)} /></label>
          <label>Time zone<input required value={tz()} onInput={(event) => setTz(event.currentTarget.value)} /></label>
          <label>Credentials<select value={mode()} onChange={(event) => setMode(event.currentTarget.value as "owner" | "team")}>
            <option value="owner">Owner</option><option value="team">Team</option>
          </select></label>
        </div>
        <button type="submit" disabled={busy() || !name().trim() || !message().trim()}>{busy() ? "Saving…" : "Create job"}</button>
      </form>
      <Show when={error()}>{(text) => <p class="edit-agent-schedule-error" role="alert">{text()}</p>}</Show>
    </section>
  );
}
