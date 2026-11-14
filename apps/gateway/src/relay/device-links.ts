import { getDeviceApprovals } from "./device-approvals.js";
import { DeviceExecutor } from "./device-exec.js";
import { DeviceLinkManager, type DeviceLinkState } from "./device-link-client.js";
import { getDeviceSettingsStore } from "./device-settings.js";
import { getLinkedGateways } from "./state.js";

let manager: DeviceLinkManager | undefined;

/** Starts the device links of the local gateway. Returns the function that stops them. */
export function startDeviceLinks(): () => void {
  manager?.stop();
  const started = new DeviceLinkManager({
    executor: new DeviceExecutor({ settings: getDeviceSettingsStore(), approvals: getDeviceApprovals() }),
    getGateways: getLinkedGateways,
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
