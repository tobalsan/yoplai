import { addGatewaySuffix, splitGatewaySuffix } from "@yoplai/shared/agent-id-wire";
import type { CapabilitiesResponse } from "./types";
import { apiFetch } from "./core";

/**
 * Gateway context of a configuration call. `undefined` selects the local
 * gateway. A name selects one linked remote gateway through the narrow relay
 * routes. A page never derives the name from an object ID.
 */
export type GatewayName = string | undefined;

/** The relay route of one linked gateway. `path` starts with `/api/`. */
export function gatewayApiPath(gateway: GatewayName, path: string): string {
  return gateway === undefined ? path : `/api/relay/gateways/${encodeURIComponent(gateway)}${path}`;
}

/** Cache and request key that keeps equal object IDs of different gateways apart. */
export function gatewayKey(gateway: GatewayName, ...parts: string[]): string {
  return JSON.stringify([gateway ?? null, ...parts]);
}

/** The ID that the chat pages use for a raw remote agent ID. */
export function qualifiedAgentId(rawId: string, gateway: GatewayName): string {
  return gateway === undefined ? rawId : addGatewaySuffix(rawId, gateway);
}

/** The raw remote ID of a qualified agent ID of this gateway. */
export function rawAgentId(agentId: string, gateway: GatewayName): string {
  return gateway === undefined ? agentId : splitGatewaySuffix(agentId, [gateway]).agentId;
}

/**
 * Moves the agent segment of a remote route path (`/agents/<raw>/...`) to the
 * qualified agent ID. A path that names another agent stays unusable.
 */
export function qualifyAgentRoute(path: string, agentId: string, gateway: GatewayName): string | undefined {
  if (gateway === undefined) return path;
  const prefix = `/agents/${encodeURIComponent(rawAgentId(agentId, gateway))}/`;
  return path.startsWith(prefix) ? `/agents/${encodeURIComponent(agentId)}/${path.slice(prefix.length)}` : undefined;
}

/** Remote requester context. The result never replaces the local capabilities. */
export async function fetchGatewayCapabilities(gateway: string, signal?: AbortSignal): Promise<CapabilitiesResponse> {
  const response = await apiFetch(gatewayApiPath(gateway, "/api/capabilities"), { signal });
  if (!response.ok) throw Object.assign(new Error("Failed to fetch gateway capabilities"), { status: response.status });
  return response.json();
}

/** The configured gateway links. `unavailable` means that the local relay is off, as in local multi-user mode. */
export type GatewayList = { state: "ready"; names: string[] } | { state: "unavailable" };

/**
 * Reads the redacted list of configured gateway names. It holds no URL or token. A link with no visible
 * agent or a gateway that is offline still appears. A failed read throws: it is not an empty list.
 */
export async function fetchGatewayList(signal?: AbortSignal): Promise<GatewayList> {
  const response = await apiFetch("/api/relay/gateways", { signal });
  // A disabled relay answers 403. A gateway that does not know the route answers 404. Both mean no linked gateways.
  if (response.status === 403 || response.status === 404) return { state: "unavailable" };
  if (!response.ok) throw new Error(`Failed to read linked gateways (${response.status})`);
  const body = (await response.json()) as { gateways?: { name?: unknown }[] };
  return { state: "ready", names: (body.gateways ?? []).flatMap((item) => (typeof item.name === "string" ? [item.name] : [])) };
}
