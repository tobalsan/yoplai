import { Show } from "solid-js";
import { scheduleAlerts } from "../lib/schedule-alerts";

export function ScheduleAlertDot(props: { agentId?: string | null }) {
  const visible = () => props.agentId === undefined
    ? scheduleAlerts().length > 0
    : scheduleAlerts().some((alert) => alert.agentId === props.agentId);
  return (
    <Show when={visible()}>
      <span class="schedule-alert-dot" role="img" aria-label="Jobs paused for credentials" title="Jobs paused for credentials" />
      <style>{`
        .schedule-alert-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          flex-shrink: 0;
          margin-left: 8px;
          border-radius: 50%;
          background: var(--tone-error);
          vertical-align: middle;
        }
      `}</style>
    </Show>
  );
}
