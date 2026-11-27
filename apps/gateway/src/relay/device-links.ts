import { CONFIG_DIR } from "../config/index.js";
import { DurableModeStore } from "../durable-mode/store.js";
import { durableModeSync } from "../durable-mode/sync.js";
import { getDeviceApprovals } from "./device-approvals.js";
import { DeviceExecutor } from "./device-exec.js";
import { DeviceLinkManager, type DeviceLinkState } from "./device-link-client.js";
import { getDeviceSettingsStore } from "./device-settings.js";
import { getLinkedGateways, isRelayEnabled } from "./state.js";

let manager: DeviceLinkManager | undefined;

/** Starts the device links of the local gateway. Returns the function that stops them. */
export function startDeviceLinks(): () => void {
  manager?.stop();
  const durableMode = new DurableModeStore(CONFIG_DIR);
  const started = new DeviceLinkManager({
    executor: new DeviceExecutor({ settings: getDeviceSettingsStore(), approvals: getDeviceApprovals() }),
    getGateways: getLinkedGateways,
    isRelayEnabled,
    onConnected: (gateway) => {
      void durableModeSync.reconcile(durableMode, { gateway, force: true }).catch(() => undefined);
    },
  });
  manager = started;
  started.start();
  return () => {
    started.stop();
    if (manager === started) manager = undefined;
  };
}

export function getDeviceLinkStates(): DeviceLinkState[] {
  return manager?.states() ?? [];
}
