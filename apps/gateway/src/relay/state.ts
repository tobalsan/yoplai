import { createFileRemoteGatewayStore, type RemoteGateway } from "./store.js";

let enabled = false;
let fileStore: ReturnType<typeof createFileRemoteGatewayStore> | undefined;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/**
 * The local gateway holds the tokens of the remote gateways. So the relay
 * starts only on a loopback address with no multi-user mode. The store is
 * global to the gateway, so it is not safe for several users.
 */
export function configureRelay(host: string, multiUser: boolean): void {
  enabled = false;
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
