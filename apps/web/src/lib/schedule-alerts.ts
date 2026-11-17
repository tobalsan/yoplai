import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { ScheduleAlert } from "@yoplai/shared/types";
import { fetchScheduleAlerts } from "../api/schedules";
import { capabilities, capabilitiesReady, isExtensionEnabled } from "./capabilities";
import { onOAuthReturn } from "./oauth-popup";

/** Alerts per gateway. The local gateway uses the empty name. Rows of one gateway never reach another. */
const [alertsByGateway, setAlertsByGateway] = createSignal<Record<string, ScheduleAlert[]>>({});
const revisions = new Map<string, number>();
const LOCAL = "";

const bump = (gateway: string) => {
  const next = (revisions.get(gateway) ?? 0) + 1;
  revisions.set(gateway, next);
  return next;
};
const store = (gateway: string, alerts: ScheduleAlert[]) =>
  setAlertsByGateway((current) => ({ ...current, [gateway]: alerts }));

/** Alerts of one gateway. Omit the name for the local gateway. */
export function scheduleAlertsFor(gateway?: string): ScheduleAlert[] {
  return alertsByGateway()[gateway ?? LOCAL] ?? [];
}

/** Alerts of the local gateway. */
export const scheduleAlerts = () => scheduleAlertsFor();

export async function refreshScheduleAlerts(gateway?: string): Promise<void> {
  const key = gateway ?? LOCAL;
  const request = bump(key);
  try {
    const alerts = await fetchScheduleAlerts(gateway);
    if (request === revisions.get(key)) store(key, alerts);
  } catch (error) {
    if (request === revisions.get(key) && error instanceof Error && "status" in error && (error.status === 401 || error.status === 403)) {
      store(key, []);
    }
    // Keep the current alerts during a transient outage; the next trigger retries.
  }
}

/**
 * Mount once in the app shell; every alert surface reads the same lists.
 * `chatGateway` is the resolved gateway of the open chat agent. A remote chat
 * also loads the alerts of that gateway, and a failed read keeps no stale rows.
 */
export function useScheduleAlerts(enabled: Accessor<boolean>, chatAgentId: Accessor<string | null>, chatGateway: Accessor<string | undefined> = () => undefined): void {
  let owner: string | undefined;
  createEffect(() => {
    const userId = capabilities.multiUser ? capabilities.user?.id : "local";
    const active = capabilitiesReady() && enabled() && isExtensionEnabled("scheduler") ? userId : undefined;
    chatAgentId();
    if (owner !== active) {
      bump(LOCAL);
      store(LOCAL, []);
      owner = active;
    }
    if (!active) return;
    const refresh = () => { void refreshScheduleAlerts(); };
    refresh();
    onCleanup(onOAuthReturn(refresh));
  });
  createEffect(() => {
    const gateway = chatGateway();
    if (gateway === undefined || !enabled()) return;
    const refresh = () => { void refreshScheduleAlerts(gateway); };
    refresh();
    onCleanup(onOAuthReturn(refresh));
    onCleanup(() => { bump(gateway); store(gateway, []); });
  });
  onCleanup(() => { for (const key of [...revisions.keys()]) bump(key); setAlertsByGateway({}); });
}
