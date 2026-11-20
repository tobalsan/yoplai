import type { CapabilitiesResponse } from "../api/types";
import { fetchCapabilities } from "../api";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

const defaultCapabilities: CapabilitiesResponse = {
  apps: { available: false },
  version: 2,
  extensions: {},
  agents: [],
  multiUser: false,
  desktopSetup: false,
  forkedAgents: false,
  enableCronMonitoring: false,
  relayLink: { available: false },
};

const [capabilities, setCapabilities] =
  createStore<CapabilitiesResponse>({ ...defaultCapabilities });
const [capabilitiesReady, setCapabilitiesReady] = createSignal(false);

let loadPromise: Promise<CapabilitiesResponse> | null = null;

export async function loadCapabilities(): Promise<CapabilitiesResponse> {
  if (loadPromise) return loadPromise;
  loadPromise = fetchCapabilities()
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
      setCapabilitiesReady(true);
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
      setCapabilities(
        status === 401 || status === 403
          ? { ...defaultCapabilities, multiUser: true, gatewayLink: undefined }
          : { ...defaultCapabilities, gatewayLink: undefined }
      );
      setCapabilitiesReady(true);
      return status === 401 || status === 403
        ? { ...defaultCapabilities, multiUser: true }
        : Promise.reject(error);
    })
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

export function resetCapabilitiesForTests(): void {
  setCapabilities({ ...defaultCapabilities, gatewayLink: undefined });
  setCapabilitiesReady(false);
  loadPromise = null;
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
    forkedAgents: value.forkedAgents ?? defaultCapabilities.forkedAgents,
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

export { capabilities, capabilitiesReady };

export function appsAvailable(): boolean | undefined {
  return capabilitiesReady() ? capabilities.apps?.available === true : undefined;
}
