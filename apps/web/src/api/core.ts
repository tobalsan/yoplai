import { createContext, onCleanup, untrack, useContext, type Accessor } from "solid-js";

export const API_BASE = "/api";

export const PageNavigationContext = createContext<Accessor<boolean>>();

export function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const navigating = useContext(PageNavigationContext);
  const request = input instanceof Request ? input : undefined;
  const method = init?.method ?? request?.method ?? "GET";
  if (!navigating || !untrack(navigating) || method.toUpperCase() !== "GET") {
    return globalThis.fetch(input, { ...init, credentials: "include" });
  }

  // Solid waits for reads started in a transition. Disposing a superseded page
  // must settle its requests so they cannot hold up the next destination.
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const existing = init?.signal ?? request?.signal;
  const signal = existing ? AbortSignal.any([existing, controller.signal]) : controller.signal;
  return globalThis.fetch(input, { ...init, credentials: "include", signal });
}
