import type { CapabilitiesResponse } from "../api/types";
import { fetchCapabilities } from "../api";
import { batch, createSignal } from "solid-js";
import { createStore } from "solid-js/store";

const defaultCapabilities: CapabilitiesResponse = {
  apps: { available: false },
  version: 2,
  extensions: {},
  agents: [],
  multiUser: false,
  desktopSetup: false,
  enableCronMonitoring: false,
  relayLink: { available: false },
};

const [capabilities, setCapabilities] =
  createStore<CapabilitiesResponse>({ ...defaultCapabilities });
const [capabilitiesReady, setCapabilitiesReady] = createSignal(false);
// The last read of the local capabilities failed for a reason other than a sign-in refusal.
const [capabilitiesFailed, setCapabilitiesFailed] = createSignal(false);

let loadPromise: Promise<CapabilitiesResponse> | null = null;

export async function loadCapabilities(): Promise<CapabilitiesResponse> {
  if (loadPromise) return loadPromise;
  // The read is cleared before the answer is published, so a Retry from the failure joins no finished read.
  loadPromise = fetchCapabilities()
    .finally(() => {
      loadPromise = null;
    })
    .then((data) => {
      // A store merge keeps a field that the new answer omits, so each optional link field is set on every load.
      setCapabilities({
        ...data,
        desktopSetup: data.desktopSetup === true,
        apps: data.apps ?? { available: false },
        enableCronMonitoring: data.enableCronMonitoring ?? false,
        relayLink: data.relayLink ?? { available: false },
        gatewayLink: data.gatewayLink,
      });
      batch(() => {
        setCapabilitiesFailed(false);
        setCapabilitiesReady(true);
      });
      return data;
    })
    .catch((error) => {
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : undefined;
      const refused = status === 401 || status === 403;
      // A refusal means a multi-user gateway. Any other failure keeps the last known capabilities and is
      // reported as a failed read, never as a single-user gateway.
      batch(() => {
        if (refused) setCapabilities({ ...defaultCapabilities, multiUser: true, gatewayLink: undefined });
        setCapabilitiesFailed(!refused);
        setCapabilitiesReady(true);
      });
      return refused
        ? { ...defaultCapabilities, multiUser: true }
        : Promise.reject(error);
    });
  return loadPromise;
}

let queuedReload: Promise<CapabilitiesResponse> | null = null;

/**
 * Reads the capabilities after a local write. A read already in flight may have started before the write,
 * so one more read is queued behind it. Writes that finish meanwhile share that one queued read.
 */
export function reloadCapabilities(): Promise<CapabilitiesResponse> {
  if (!loadPromise) return loadCapabilities();
  queuedReload ??= loadPromise
    .catch(() => undefined)
    .then(() => {
      queuedReload = null;
      return loadCapabilities();
    });
  return queuedReload;
}

export function resetCapabilitiesForTests(): void {
  setCapabilities({ ...defaultCapabilities, gatewayLink: undefined });
  setCapabilitiesReady(false);
  setCapabilitiesFailed(false);
  loadPromise = null;
  queuedReload = null;
}

export function setCapabilitiesForTests(
  value: Partial<CapabilitiesResponse>
): void {
  setCapabilities({
    apps: value.apps ?? { available: false },
    version: value.version ?? defaultCapabilities.version,
    extensions: value.extensions ?? defaultCapabilities.extensions,
    agents: value.agents ?? defaultCapabilities.agents,
    multiUser: value.multiUser ?? defaultCapabilities.multiUser,
    desktopSetup: value.desktopSetup === true,
    authMethods: value.authMethods,
    enableCronMonitoring: value.enableCronMonitoring ?? defaultCapabilities.enableCronMonitoring,
    relayLink: value.relayLink ?? defaultCapabilities.relayLink,
    gatewayLink: value.gatewayLink,
    user: value.user,
  });
  setCapabilitiesReady(true);
}

export function isExtensionEnabled(id: string): boolean {
  return capabilities.extensions[id] === true;
}

export { capabilities, capabilitiesFailed, capabilitiesReady };

export function appsAvailable(): boolean | undefined {
  return capabilitiesReady() ? capabilities.apps?.available === true : undefined;
}
