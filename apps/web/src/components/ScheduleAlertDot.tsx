import { Show } from "solid-js";
import { anyScheduleAlert, scheduleAlertsFor } from "../lib/schedule-alerts";

/**
 * The dot of one agent reads only the alerts of that agent's gateway, and compares the qualified agent ID.
 * The dot of the navigation has no agent and shows when the local gateway or any configured gateway has an alert.
 */
export function ScheduleAlertDot(props: { agentId?: string | null; gateway?: string }) {
  const visible = () => props.agentId === undefined
    ? anyScheduleAlert()
    : scheduleAlertsFor(props.gateway).some((alert) => alert.agentId === props.agentId);
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
