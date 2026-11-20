import { createEffect, createMemo, createSignal } from "solid-js";
import { isDesktopWindow } from "./lib/desktop-window";
import { readMigratedLocal } from "./lib/local-storage";

export type ThemeChoice = "light" | "dark" | "system";
declare global {
  interface Window {
    yoplaiDesktopTheme?: { save(choice: ThemeChoice): ThemeChoice | null };
  }
}

const desktopTheme = isDesktopWindow() ? window.yoplaiDesktopTheme : undefined;
const storageKey = "yoplai-theme";
const systemTheme = window.matchMedia?.("(prefers-color-scheme: light)");
const [systemLight, setSystemLight] = createSignal(systemTheme?.matches ?? false);

function parseChoice(value: string | null): ThemeChoice {
  return value === "light" || value === "dark" ? value : "system";
}

const storedChoice = readMigratedLocal(storageKey);
const prepaintChoice = desktopTheme ? document.documentElement.dataset.desktopThemeChoice : undefined;
const [themeChoice, setChoice] = createSignal(parseChoice(prepaintChoice ?? storedChoice));
const theme = createMemo(() => {
  const choice = themeChoice();
  return choice === "system" ? systemLight() ? "light" : "dark" : choice;
});

export { theme, themeChoice };

export function setThemeChoice(choice: ThemeChoice) {
  desktopTheme?.save(choice);
  setChoice(choice);
  try { localStorage.setItem(storageKey, choice); } catch { /* The current tab keeps the choice. */ }
}

const onSystemTheme = (event: MediaQueryListEvent) => setSystemLight(event.matches);
if (systemTheme?.addEventListener) systemTheme.addEventListener("change", onSystemTheme);
else systemTheme?.addListener?.(onSystemTheme);

function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (event.key === storageKey || event.key === null) {
    const choice = parseChoice(event.newValue);
    desktopTheme?.save(choice);
    setChoice(choice);
  }
}
window.addEventListener("storage", onStorage);

import.meta.hot?.dispose(() => {
  if (systemTheme?.removeEventListener) systemTheme.removeEventListener("change", onSystemTheme);
  else systemTheme?.removeListener?.(onSystemTheme);
  window.removeEventListener("storage", onStorage);
});

createEffect(() => {
  const resolved = theme();
  document.documentElement.dataset.theme = resolved;
  document.cookie = `yoplai-theme=${resolved}; Path=/; SameSite=Lax; Max-Age=31536000`;
});
