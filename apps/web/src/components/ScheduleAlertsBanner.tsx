import { For, Show, createMemo, createSignal } from "solid-js";
import { A } from "@solidjs/router";
import { refreshScheduleAlerts, scheduleAlerts } from "../lib/schedule-alerts";
import { updateSchedule } from "../api/schedules";
import { Button } from "./ui/Button";

export function ScheduleAlertsBanner(props: { agentId: string; schedulesAgentId?: string }) {
  const alerts = createMemo(() => scheduleAlerts().filter((alert) => alert.agentId === props.agentId));
  const [busy, setBusy] = createSignal<string>();
  const [error, setError] = createSignal<{ jobId: string; text: string }>();
  const resume = async (jobId: string) => {
    if (busy()) return;
    setBusy(jobId);
    setError(undefined);
    try {
      await updateSchedule(props.agentId, jobId, { enabled: true });
      await refreshScheduleAlerts();
    } catch (cause) {
      setError({ jobId, text: cause instanceof Error ? cause.message : "Failed to resume scheduled job. Try again." });
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Show when={alerts().length}>
      <div class="schedule-alerts" role="region" aria-label="Paused scheduled jobs">
        <For each={alerts().slice(0, 3)}>{(alert) => (
          <div class="schedule-alert-row">
            <span>{alert.jobName} is paused: reconnect {alert.pausedReason.integration}, then resume it.</span>
            <A href={alert.pausedReason.connectPath ?? `/agents/${encodeURIComponent(props.agentId)}/edit`}>Reconnect</A>
            <Button disabled={!!busy()} loading={busy() === alert.jobId} loadingLabel="Resuming…" onClick={() => void resume(alert.jobId)}>Resume</Button>
            <Show when={error()?.jobId === alert.jobId}><p class="schedule-alert-error" role="alert">{error()?.text}</p></Show>
          </div>
        )}</For>
        <Show when={alerts().length > 3}>
          <A href={`/agents/${encodeURIComponent(props.schedulesAgentId ?? props.agentId)}/edit?tab=schedules`} class="schedule-alert-more">+{alerts().length - 3} more, open Schedules</A>
        </Show>
      </div>
      <style>{`
        .schedule-alerts {
          flex-shrink: 0;
          padding: 12px 16px;
          background: color-mix(in srgb, var(--tone-error) 14%, var(--bg-surface));
          color: var(--tone-error);
          border-bottom: 1px solid color-mix(in srgb, var(--tone-error) 35%, transparent);
          font-size: 14px;
          line-height: 1.5;
        }
        .schedule-alert-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
        .schedule-alert-row + .schedule-alert-row { margin-top: 12px; }
        .schedule-alert-row > span { flex: 1 1 280px; overflow-wrap: anywhere; }
        .schedule-alert-error { flex-basis: 100%; margin: 0; }
        .schedule-alert-more { display: inline-block; margin-top: 12px; }
        .schedule-alerts a { color: inherit; text-underline-offset: 3px; }
        .schedule-alerts a:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
      `}</style>
    </Show>
  );
}
