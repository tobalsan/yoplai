import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { ScheduleAlert } from "@yoplai/shared/types";
import { fetchScheduleAlerts } from "../api/schedules";
import { capabilities, capabilitiesReady, isExtensionEnabled } from "./capabilities";
import { onOAuthReturn } from "./oauth-popup";

const [scheduleAlerts, setScheduleAlerts] = createSignal<ScheduleAlert[]>([]);
let revision = 0;

export async function refreshScheduleAlerts(): Promise<void> {
  const request = ++revision;
  try {
    const alerts = await fetchScheduleAlerts();
    if (request === revision) setScheduleAlerts(alerts);
  } catch (error) {
    if (request === revision && error instanceof Error && "status" in error && (error.status === 401 || error.status === 403)) {
      setScheduleAlerts([]);
    }
    // Keep the current alerts during a transient outage; the next trigger retries.
  }
}

/** Mount once in the app shell; every alert surface reads the same list. */
export function useScheduleAlerts(enabled: Accessor<boolean>, chatAgentId: Accessor<string | null>): void {
  let owner: string | undefined;
  createEffect(() => {
    const userId = capabilities.multiUser ? capabilities.user?.id : "local";
    const active = capabilitiesReady() && enabled() && isExtensionEnabled("scheduler") ? userId : undefined;
    chatAgentId();
    if (owner !== active) {
      revision++;
      setScheduleAlerts([]);
      owner = active;
    }
    if (!active) return;
    const refresh = () => { void refreshScheduleAlerts(); };
    refresh();
    onCleanup(onOAuthReturn(refresh));
  });
  onCleanup(() => { revision++; setScheduleAlerts([]); });
}

export { scheduleAlerts };
