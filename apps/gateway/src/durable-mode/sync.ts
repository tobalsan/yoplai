import { createLinkedSync, readLinkedSetting, writeLinkedSetting, type ReconcileOptions } from "./linked-sync.js";
import { durableModeTime, type DurableMode, type DurableModeStore } from "./store.js";

const route = "/api/me/durable-mode";
const links = createLinkedSync();

export const durableModeSync = {
  pushToLinks(local: DurableMode) {
    return links.pushToLinks((gateway, signal) => writeLinkedSetting(gateway, route, local, signal));
  },
  reconcile(store: DurableModeStore, options?: ReconcileOptions) {
    return links.reconcile(async (gateway, signal) => {
      const local = await store.read();
      const remote = await readLinkedSetting(gateway, route, signal) as Partial<DurableMode> | null;
      signal.throwIfAborted();
      if (typeof remote?.enabled !== "boolean") throw new Error("Invalid remote Durable mode");
      const localTime = durableModeTime(local.updatedAt);
      const remoteTime = durableModeTime(remote.updatedAt);
      if (remoteTime > localTime) {
        await store.set(remote.enabled, remote.updatedAt);
      } else if (localTime > remoteTime) {
        await writeLinkedSetting(gateway, route, local, signal);
      }
    }, options);
  },
};
