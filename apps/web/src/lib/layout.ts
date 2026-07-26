import { createSignal } from "solid-js";
import { readMigratedLocal } from "./local-storage";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "yoplai:sidebar-collapsed";
export const RIGHT_PANEL_COLLAPSED_STORAGE_KEY = "yoplai:right-panel-collapsed";
export const ZEN_MODE_STORAGE_KEY = "yoplai:zen-mode";

function readStoredBoolean(key: string): boolean {
  return readMigratedLocal(key) === "true";
}

function persistBoolean(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, String(value));
}

export const [sidebarCollapsed, setSidebarCollapsed] = createSignal(
  readStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY)
);

export const [zenMode, setZenMode] = createSignal(
  readStoredBoolean(ZEN_MODE_STORAGE_KEY)
);

export function setSidebarCollapsedPersistent(value: boolean): void {
  setSidebarCollapsed(value);
  persistBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, value);
}

export function toggleSidebarCollapsed(): void {
  setSidebarCollapsedPersistent(!sidebarCollapsed());
}

export function setZenModePersistent(value: boolean): void {
  setZenMode(value);
  persistBoolean(ZEN_MODE_STORAGE_KEY, value);
}

export function toggleZenMode(): void {
  setZenModePersistent(!zenMode());
}

export const [rightPanelCollapsed, setRightPanelCollapsed] = createSignal(
  readStoredBoolean(RIGHT_PANEL_COLLAPSED_STORAGE_KEY)
);

export function setRightPanelCollapsedPersistent(value: boolean): void {
  setRightPanelCollapsed(value);
  persistBoolean(RIGHT_PANEL_COLLAPSED_STORAGE_KEY, value);
}

export function toggleRightPanelCollapsed(): void {
  setRightPanelCollapsedPersistent(!rightPanelCollapsed());
}
