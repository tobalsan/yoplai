import { For, Show, createComputed, createMemo, createSignal, onCleanup } from "solid-js";
import { A } from "@solidjs/router";
import { refreshScheduleAlerts, scheduleAlertsFor } from "../lib/schedule-alerts";
import { updateSchedule } from "../api/schedules";
import { qualifyAgentRoute } from "../api/gateway";
import { Button } from "./ui/Button";

/** `gateway` is the resolved gateway of the agent. Alerts and actions stay on that gateway. */
export function ScheduleAlertsBanner(props: { agentId: string; schedulesAgentId?: string; gateway?: string }) {
  const alerts = createMemo(() => scheduleAlertsFor(props.gateway).filter((alert) => alert.agentId === props.agentId));
  const editPath = () => `/agents/${encodeURIComponent(props.agentId)}/edit`;
  // A remote path names the raw remote agent. It must keep the gateway, or fall back to the edit page.
  const connectHref = (path: string | undefined) => (path ? qualifyAgentRoute(path, props.agentId, props.gateway) : undefined) ?? editPath();
  const [busy, setBusy] = createSignal<string>();
  const [error, setError] = createSignal<{ jobId: string; text: string }>();
  // A new agent or gateway drops the pending action and the message of the old one.
  // Each visit has its own number, so returning to the same agent never accepts an older answer.
  let visit = 0;
  createComputed(() => { void props.agentId; void props.gateway; visit++; setBusy(undefined); setError(undefined); });
  onCleanup(() => { visit++; });
  const resume = async (jobId: string) => {
    if (busy()) return;
    // A late answer of another gateway or agent changes nothing.
    const { agentId, gateway } = props;
    const mine = visit;
    const same = () => visit === mine && props.agentId === agentId && props.gateway === gateway;
    setBusy(jobId);
    setError(undefined);
    try {
      await updateSchedule(agentId, jobId, { enabled: true }, gateway);
      await refreshScheduleAlerts(gateway);
    } catch (cause) {
      if (same()) setError({ jobId, text: cause instanceof Error ? cause.message : "Failed to resume scheduled job. Try again." });
    } finally {
      if (same()) setBusy(undefined);
    }
  };
  return (
    <Show when={alerts().length}>
      <div class="schedule-alerts" role="region" aria-label="Paused scheduled jobs">
        <For each={alerts().slice(0, 3)}>{(alert) => (
          <div class="schedule-alert-row">
            <span>{alert.jobName} is paused: reconnect {alert.pausedReason.integration}, then resume it.</span>
            <A href={connectHref(alert.pausedReason.connectPath)}>Reconnect</A>
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
