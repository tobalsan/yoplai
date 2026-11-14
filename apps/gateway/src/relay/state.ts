import { getAgent } from "../config/index.js";
import { removeGatewaySuffix } from "./agent-id.js";
import { createFileRemoteGatewayStore, type RemoteGateway } from "./store.js";

let enabled = false;
let fileStore: ReturnType<typeof createFileRemoteGatewayStore> | undefined;

const LOOPBACK_IPV4_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || LOOPBACK_IPV4_RE.test(host);
}

/**
 * A request with no Origin header (CLI, curl) is trusted. A browser page sends
 * Origin, and the relay trusts only pages that load from a loopback host name.
 */
export function isTrustedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** A local agent with exactly this ID always wins over a gateway suffix. */
export function resolveRemoteAgent(
  agentId: string,
  gateways: readonly RemoteGateway[]
): { agentId: string; gateway?: string } {
  if (getAgent(agentId)) return { agentId };
  return removeGatewaySuffix(agentId, gateways.map((gateway) => gateway.name));
}

/**
 * The local gateway holds the tokens of the remote gateways. So the relay
 * starts only on a loopback address with no multi-user mode. The store is
 * global to the gateway, so it is not safe for several users.
 */
export function configureRelay(
  host: string,
  multiUser: boolean,
  tailscaleServe = false
): void {
  enabled = false;
  if (tailscaleServe) {
    console.warn(
      "[relay] disabled: Tailscale serve exposes the gateway to the tailnet."
    );
    return;
  }
  if (!isLoopbackHost(host) && !multiUser) {
    console.warn(
      `[relay] disabled: the gateway listens on ${host}, which is not a loopback address, and multi-user mode is off.`
    );
    return;
  }
  if (multiUser) {
    console.warn(
      "[relay] disabled: linked remote gateways do not support multi-user mode yet."
    );
    return;
  }
  enabled = true;
}

export function getRemoteGatewayStore() {
  fileStore ??= createFileRemoteGatewayStore();
  return fileStore;
}

/** The linked gateways, or an empty list while the relay is disabled. */
export function getLinkedGateways(): RemoteGateway[] {
  return enabled ? getRemoteGatewayStore().list() : [];
}
