import { createMemo, createResource } from "solid-js";
import { useSearchParams } from "@solidjs/router";
import { fetchGatewayList, type GatewayList } from "../api/gateway";

/**
 * The gateway that a global page works on. The choice stays in the address (`?gateway=<name>`), so links,
 * reloads, and Back keep it. Local is the default. A name that the configured list does not hold is an error:
 * it never means Local, and the page makes no call for it.
 */
export type GatewaySelection =
  | { state: "local" }
  | { state: "loading"; gateway: string }
  | { state: "ready"; gateway: string }
  | { state: "missing"; gateway: string; reason: "unknown" | "unavailable" | "failed" };

export function useGatewayChoice() {
  const [search, setSearch] = useSearchParams();
  const named = () => (typeof search.gateway === "string" && search.gateway ? search.gateway : undefined);
  const [list, { refetch }] = createResource<GatewayList | { state: "failed" }>(async () => {
    try { return await fetchGatewayList(); }
    catch { return { state: "failed" as const }; }
  });
  const loaded = () => (list.state === "ready" || list.state === "refreshing" ? list() : undefined);
  /** Configured names, also links with no visible agent. The named gateway stays in the list so the select shows it. */
  const names = createMemo(() => {
    const current = loaded();
    const configured = current?.state === "ready" ? current.names : [];
    const chosen = named();
    return chosen !== undefined && !configured.includes(chosen) ? [...configured, chosen] : configured;
  });
  const selection = createMemo<GatewaySelection>(() => {
    const gateway = named();
    if (gateway === undefined) return { state: "local" };
    const current = loaded();
    if (!current) return { state: "loading", gateway };
    if (current.state === "failed") return { state: "missing", gateway, reason: "failed" };
    if (current.state === "unavailable") return { state: "missing", gateway, reason: "unavailable" };
    return current.names.includes(gateway) ? { state: "ready", gateway } : { state: "missing", gateway, reason: "unknown" };
  });
  /** The gateway to call, or undefined for Local. Only meaningful when `ready()` is true. */
  const gateway = () => { const current = selection(); return current.state === "ready" ? current.gateway : undefined; };
  /** True when a call may start: Local, or a named gateway that the configured list holds. */
  const ready = () => { const current = selection(); return current.state === "local" || current.state === "ready"; };
  const choose = (name: string | undefined) => setSearch({ gateway: name });
  return { selection, gateway, chosen: named, ready, names, choose, retry: () => void refetch() };
}

export function missingGatewayText(selection: Extract<GatewaySelection, { state: "missing" }>): string {
  if (selection.reason === "unknown") return `The gateway "${selection.gateway}" is not linked.`;
  if (selection.reason === "unavailable") return "Linked gateways are not available on this gateway.";
  return "Could not read the linked gateways.";
}
