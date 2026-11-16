import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { ScheduleAlert } from "@yoplai/shared/types";
import { fetchScheduleAlerts } from "../api/schedules";
import { fetchGatewayList } from "../api/gateway";
import { capabilities, capabilitiesReady, isExtensionEnabled } from "./capabilities";
import { onOAuthReturn } from "./oauth-popup";

/** Alerts per gateway. The local gateway uses the empty name. Rows of one gateway never reach another. */
const [alertsByGateway, setAlertsByGateway] = createSignal<Record<string, ScheduleAlert[]>>({});
/** Gateways whose last read failed. A failed read keeps the known alerts and is not an empty list. */
const [failedGateways, setFailedGateways] = createSignal<Record<string, boolean>>({});
/** The configured gateway names, also a link with no visible agent or a gateway that is offline. */
const [configured, setConfigured] = createSignal<string[]>([]);
const revisions = new Map<string, number>();
const LOCAL = "";

const bump = (gateway: string) => {
  const next = (revisions.get(gateway) ?? 0) + 1;
  revisions.set(gateway, next);
  return next;
};
const store = (gateway: string, alerts: ScheduleAlert[]) =>
  setAlertsByGateway((current) => ({ ...current, [gateway]: alerts }));
const markFailed = (gateway: string, failed: boolean) =>
  setFailedGateways((current) => (current[gateway] === failed ? current : { ...current, [gateway]: failed }));

/** Alerts of one gateway. Omit the name for the local gateway. */
export function scheduleAlertsFor(gateway?: string): ScheduleAlert[] {
  return alertsByGateway()[gateway ?? LOCAL] ?? [];
}

/** Alerts of the local gateway. */
export const scheduleAlerts = () => scheduleAlertsFor();

/** True when any alert exists on the local gateway or on a configured gateway. */
export function anyScheduleAlert(): boolean {
  return scheduleAlertsFor().length > 0 || configured().some((name) => scheduleAlertsFor(name).length > 0);
}

/** True when the last read of this gateway failed. The shown alerts are then the last known ones. */
export function scheduleAlertReadFailed(gateway?: string): boolean {
  return failedGateways()[gateway ?? LOCAL] === true;
}

export async function refreshScheduleAlerts(gateway?: string): Promise<void> {
  const key = gateway ?? LOCAL;
  const request = bump(key);
  try {
    const alerts = await fetchScheduleAlerts(gateway);
    if (request === revisions.get(key)) { store(key, alerts); markFailed(key, false); }
  } catch (error) {
    if (request !== revisions.get(key)) return;
    if (error instanceof Error && "status" in error && (error.status === 401 || error.status === 403)) {
      // A denied scope shows no alert and no failure.
      store(key, []);
      markFailed(key, false);
      return;
    }
    // Keep the current alerts during a transient outage, and record that the read failed.
    markFailed(key, true);
  }
}

/** Drops the alerts of a gateway that is no longer configured, and ends its pending reads. */
function forget(gateway: string) {
  bump(gateway);
  const without = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== gateway));
  setAlertsByGateway(without);
  setFailedGateways(without);
}

/**
 * Mount once in the app shell; every alert surface reads the same lists.
 * Local alerts follow the local scheduler. Every configured gateway also loads its alerts, whatever its agents
 * or health. The remote scheduler decides which alerts a requester sees, so the local scheduler flag does not gate
 * a remote read. `chatGateway` joins the list when the configured list cannot be read.
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
      markFailed(LOCAL, false);
      owner = active;
    }
    if (!active) return;
    const refresh = () => { void refreshScheduleAlerts(); };
    refresh();
    onCleanup(onOAuthReturn(refresh));
  });
  createEffect(() => {
    if (!enabled()) return;
    let live = true;
    const fromChat = chatGateway();
    const names = () => [...new Set([...configured(), ...(fromChat === undefined ? [] : [fromChat])])];
    const refreshAll = () => { for (const name of names()) void refreshScheduleAlerts(name); };
    const readList = async () => {
      try {
        const list = await fetchGatewayList();
        if (!live) return;
        const next = list.state === "ready" ? list.names : [];
        for (const old of configured()) if (!next.includes(old)) forget(old);
        setConfigured(next);
      } catch {
        // The configured list stays as it was. The next trigger reads it again.
      }
      if (live) refreshAll();
    };
    void readList();
    onCleanup(onOAuthReturn(() => { void readList(); }));
    onCleanup(() => { live = false; });
  });
  onCleanup(() => {
    for (const key of [...revisions.keys()]) bump(key);
    setAlertsByGateway({});
    setFailedGateways({});
    setConfigured([]);
  });
}
