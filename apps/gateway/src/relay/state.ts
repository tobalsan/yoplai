import { isIP } from "node:net";
import { getAgent } from "../config/index.js";
import { removeGatewaySuffix } from "./agent-id.js";
import { createFileRemoteGatewayStore, type RemoteGateway } from "./store.js";

let enabled = false;
/** The address that the gateway listener really bound. The link callback needs `127.0.0.1` on this listener. */
let listener: { address: string; port: number } | undefined;
let fileStore: ReturnType<typeof createFileRemoteGatewayStore> | undefined;

const LOOPBACK_IPV4_RE = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || LOOPBACK_IPV4_RE.test(host);
}

export function isLoopbackAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  const value = address.replace(/^::ffff:/i, "");
  return value === "::1" || LOOPBACK_IPV4_RE.test(value);
}

function isTrustedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true;
  try {
    return isLoopbackHost(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** The UI proxy of Vite adds the real client address to `X-Forwarded-For`. */
export function isLoopbackForwardedFor(forwardedFor: string | null | undefined): boolean {
  if (!forwardedFor) return true;
  return forwardedFor
    .split(",")
    .every((entry) => isLoopbackAddress(entry.trim()));
}

/**
 * A request with no Origin header (CLI, curl) is trusted. A browser page sends
 * Origin, and the relay trusts only pages that load from a loopback host name.
 * A request that a proxy forwarded for a client outside loopback is not trusted.
 */
export function isTrustedRequest(
  origin: string | null | undefined,
  forwardedFor: string | null | undefined
): boolean {
  return isTrustedOrigin(origin) && isLoopbackForwardedFor(forwardedFor);
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
  tailscaleServe = false,
  uiHost = "127.0.0.1"
): void {
  enabled = false;
  if (tailscaleServe) {
    console.warn(
      "[relay] disabled: Tailscale serve exposes the gateway to the tailnet."
    );
    return;
  }
  if (!isLoopbackHost(uiHost)) {
    console.warn(
      `[relay] disabled: the UI listens on ${uiHost}, which is not a loopback address.`
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

export function isRelayEnabled(): boolean {
  return enabled;
}

/** Records the bound address of the gateway listener, or forgets it with `undefined`. */
export function setGatewayListener(address: { address: string; port: number } | undefined): void {
  listener = address;
}

export function getGatewayListener(): { address: string; port: number } | undefined {
  return listener;
}

/**
 * The port for the link callback `http://127.0.0.1:<port>/...`, or undefined. The callback uses the literal
 * `127.0.0.1`, so it works only while the relay is on and the listener really accepts that address. A listener
 * bound to `127.0.0.2` or `::1` still serves saved links, but it cannot receive the browser callback.
 */
export function getLinkCallbackPort(): number | undefined {
  return enabled && listener?.address === "127.0.0.1" ? listener.port : undefined;
}

export function getRemoteGatewayStore() {
  fileStore ??= createFileRemoteGatewayStore();
  return fileStore;
}

/** The linked gateways, or an empty list while the relay is disabled. */
export function getLinkedGateways(): RemoteGateway[] {
  return enabled ? getRemoteGatewayStore().list() : [];
}
