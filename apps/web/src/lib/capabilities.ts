import type { CapabilitiesResponse } from "../api/types";
import { fetchCapabilities } from "../api";
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";

const defaultCapabilities: CapabilitiesResponse = {
  version: 2,
  extensions: {},
  agents: [],
  multiUser: false,
  forkedAgents: false,
  agentFab: false,
};

const [capabilities, setCapabilities] =
  createStore<CapabilitiesResponse>(defaultCapabilities);
const [capabilitiesReady, setCapabilitiesReady] = createSignal(false);

let loadPromise: Promise<CapabilitiesResponse> | null = null;

export async function loadCapabilities(): Promise<CapabilitiesResponse> {
  if (loadPromise) return loadPromise;
  loadPromise = fetchCapabilities()
    .then((data) => {
      setCapabilities(data);
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
          ? { ...defaultCapabilities, multiUser: true }
          : defaultCapabilities
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
  setCapabilities(defaultCapabilities);
  setCapabilitiesReady(false);
  loadPromise = null;
}

export function setCapabilitiesForTests(
  value: Partial<CapabilitiesResponse>
): void {
  setCapabilities({
    version: value.version ?? defaultCapabilities.version,
    extensions: value.extensions ?? defaultCapabilities.extensions,
    agents: value.agents ?? defaultCapabilities.agents,
    multiUser: value.multiUser ?? defaultCapabilities.multiUser,
    authMethods: value.authMethods,
    forkedAgents: value.forkedAgents ?? defaultCapabilities.forkedAgents,
    agentFab: value.agentFab ?? defaultCapabilities.agentFab,
    user: value.user,
  });
  setCapabilitiesReady(true);
}

export function isExtensionEnabled(id: string): boolean {
  return capabilities.extensions[id] === true;
}

export { capabilities, capabilitiesReady };
