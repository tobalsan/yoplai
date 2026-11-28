import { getAgent } from "../config/index.js";
import { getLinkedGateways } from "../relay/state.js";
import type { RemoteGateway } from "../relay/store.js";
import { createLinkedSync, readLinkedSetting, writeLinkedSetting, type ReconcileOptions } from "./linked-sync.js";
import { sidebarOrderSchema, type SidebarOrder, type SidebarOrderStore } from "./sidebar-order-store.js";
import { mergeGatewayOrder, projectForGateway } from "./sidebar-ordering.js";
import { durableModeTime } from "./store.js";

const route = "/api/me/sidebar-order";
const links = createLinkedSync();
const isLocal = (id: string) => getAgent(id) !== undefined;

function writeRemoteOrder(gateway: RemoteGateway, local: SidebarOrder, signal: AbortSignal) {
  return writeLinkedSetting(gateway, route, {
    agentIds: projectForGateway(local.agentIds, gateway.name, isLocal),
    updatedAt: local.updatedAt,
  }, signal);
}

export const sidebarOrderSync = {
  async pushToLinks(local: SidebarOrder): Promise<void> {
    await links.pushToLinks((gateway, signal) => writeRemoteOrder(gateway, local, signal));
  },

  async reconcile(store: SidebarOrderStore, options?: ReconcileOptions): Promise<void> {
    await links.reconcile(async (gateway, signal) => {
      const remote = sidebarOrderSchema.parse(await readLinkedSetting(gateway, route, signal));
      const remoteTime = durableModeTime(remote.updatedAt);
      const isStillLinked = () => getLinkedGateways().some(({ name, generation }) =>
        name === gateway.name && generation === gateway.generation);
      const local = await store.update((current) => {
        signal.throwIfAborted();
        if (remoteTime <= durableModeTime(current.updatedAt) || !isStillLinked()) return current;
        // Keep the device stamp so this peer cannot mask changes from another link.
        const agentIds = mergeGatewayOrder(current.agentIds, gateway.name, remote.agentIds, isLocal);
        if (agentIds.length === current.agentIds.length && agentIds.every((id, index) => id === current.agentIds[index])) return current;
        return { ...current, agentIds };
      });
      if (durableModeTime(local.updatedAt) > remoteTime && isStillLinked()) {
        await writeRemoteOrder(gateway, local, signal);
      }
    }, options);
  },
};
